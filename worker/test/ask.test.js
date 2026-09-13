import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index.js";
import { makeMockDB } from "./helpers.js";

// fresh_app issue #75, commitment 5: "no query text/food name/health content in any log
// (app logs, Worker D1, crash reports)". These tests guard the /api/ask handler's D1 write —
// the rate limiter must keep counting turns without ever persisting what was asked.

const ASK_UPSTREAM = "https://fresh-assistant-api.fly.dev";

function baseEnv(overrides = {}) {
  return {
    ALLOWED_ORIGINS: "https://insights.freshfoodrecs.com",
    ASK_UPSTREAM,
    ASK_TOKEN: "ask-secret-token",
    DB: makeMockDB(),
    ...overrides,
  };
}

let upstreamCalls, upstreamStatus, upstreamBody;

beforeEach(() => {
  upstreamCalls = [];
  upstreamStatus = 200;
  upstreamBody = { actions: [{ tool: "noop", input: {} }], reply: "here is a provisional line" };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init = {}) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith(ASK_UPSTREAM)) {
        upstreamCalls.push({ url, init });
        return new Response(JSON.stringify(upstreamBody), {
          status: upstreamStatus,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error("unexpected fetch in test: " + url);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function askReq(body) {
  return new Request("https://worker.example/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function findInsert(db) {
  return db.calls.find(c => /INSERT INTO ask_log/.test(c.sql));
}

describe("/api/ask privacy posture (fresh-insights#75)", () => {
  it("never writes the question text (or a prefix/truncation of it) into ask_log", async () => {
    const env = baseEnv();
    const q = "does my son's peanut allergy mean I should avoid this brand of granola bar?";
    const res = await worker.fetch(askReq({ q, app: "fresh_food_branded", page: "/foo/" }), env);
    expect(res.status).toBe(200);

    const insert = findInsert(env.DB);
    expect(insert).toBeTruthy();
    // The bound `q` value is a fixed empty string — not the question, not any substring of it.
    // args order: page, ip_hash, app, q_len_bucket, n_actions
    const [, , , qLenBucket] = insert.args;
    expect(insert.sql).toMatch(/VALUES \(\?1, \?2, \?3, '', \?4, \?5\)/);
    for (const arg of insert.args) {
      expect(String(arg)).not.toMatch(/peanut|allergy|granola/i);
    }
    expect(["short", "medium", "long"]).toContain(qLenBucket);
  });

  it("never writes context or history into ask_log", async () => {
    const env = baseEnv();
    const context = { tab: "explorer", subject: "a rare medical condition the reader has" };
    const history = [{ q: "what about my thyroid condition", r: "..." }];
    const res = await worker.fetch(
      askReq({ q: "a normal question", app: "fresh_food_branded", context, history }),
      env
    );
    expect(res.status).toBe(200);

    const insert = findInsert(env.DB);
    expect(insert.sql).not.toMatch(/context|history/i);
    for (const arg of insert.args) {
      expect(String(arg)).not.toMatch(/thyroid|medical condition/i);
    }

    // context/history are only ever used in the upstream fetch body, never in a DB call.
    expect(upstreamCalls.length).toBe(1);
    const sentBody = JSON.parse(upstreamCalls[0].init.body);
    expect(sentBody.context).toEqual(context);
    expect(sentBody.history).toEqual(history);
  });

  it("buckets question length instead of storing it exactly or verbatim", async () => {
    const env = baseEnv();
    await worker.fetch(askReq({ q: "hi", app: "x" }), env); // len 2 -> short
    await worker.fetch(askReq({ q: "x".repeat(120), app: "x" }), env); // -> medium
    await worker.fetch(askReq({ q: "x".repeat(400), app: "x" }), env); // -> long

    const inserts = env.DB.calls.filter(c => /INSERT INTO ask_log/.test(c.sql));
    expect(inserts.length).toBe(3);
    const buckets = inserts.map(c => c.args[3]);
    expect(buckets).toEqual(["short", "medium", "long"]);
  });

  it("still rate-limits per rotating IP hash without reading or needing question content", async () => {
    const env = baseEnv({ DB: makeMockDB({ countAll: 10 }) }); // at ASK_PER_HOUR
    const res = await worker.fetch(askReq({ q: "another question", app: "x" }), env);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "too many questions — try again later" });
    // Rejected before ever calling upstream or writing a row.
    expect(upstreamCalls.length).toBe(0);
    expect(findInsert(env.DB)).toBeFalsy();
  });

  it("allows a turn just under the ceiling and the count query never touches q", async () => {
    const env = baseEnv({ DB: makeMockDB({ countAll: 9 }) }); // one under ASK_PER_HOUR
    const res = await worker.fetch(askReq({ q: "one more question", app: "x" }), env);
    expect(res.status).toBe(200);
    expect(upstreamCalls.length).toBe(1);

    const rateCheck = env.DB.calls.find(c => /SELECT COUNT\(\*\).*FROM ask_log/s.test(c.sql));
    expect(rateCheck).toBeTruthy();
    expect(rateCheck.sql).not.toMatch(/\bq\b/); // counts rows, never filters/selects on content
  });

  it("400s on a too-short question, before any DB call", async () => {
    const env = baseEnv();
    const res = await worker.fetch(askReq({ q: "h", app: "x" }), env);
    expect(res.status).toBe(400);
    expect(env.DB.calls.length).toBe(0);
  });

  it("503s when ASK_UPSTREAM or ASK_TOKEN is unset, never touching the DB", async () => {
    const env = baseEnv({ ASK_TOKEN: undefined });
    const res = await worker.fetch(askReq({ q: "a real question", app: "x" }), env);
    expect(res.status).toBe(503);
    expect(env.DB.calls.length).toBe(0);
  });
});
