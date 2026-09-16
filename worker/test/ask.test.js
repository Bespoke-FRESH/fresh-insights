// /api/ask trace-id pass-through (fresh_app#97, companion to the fresh-assistant-api PR).
//
// This Worker makes NO gating decision about designated-test-account tracing — that allowlist
// (TRACE_ACCOUNTS) lives only on fresh-assistant-api. All this route does is carry
// account_id/conversation_id through when the caller sent one, and always contribute a
// request_id (minting one when the caller sent none or something illegal-shaped), so a
// walkthrough can be threaded as one id chain from the app through this Worker to the
// assistant service. What must hold:
//   - a valid id supplied by the caller travels through verbatim
//   - an id that fails the charset check is dropped, not forwarded raw (defense in depth even
//     though the assistant service also validates on its side)
//   - request_id is ALWAYS present in the forwarded body, minted here when absent
//   - none of this reaches ask_log — that table stays exactly as content-free as it is today
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index.js";
import { makeMockDB } from "./helpers.js";

const ASK_UPSTREAM = "https://fresh-assistant-api.fly.dev";

function baseEnv(overrides = {}) {
  return {
    ALLOWED_ORIGINS: "https://insights.freshfoodrecs.com",
    ASK_UPSTREAM,
    ASK_TOKEN: "svc-ask-secret",
    DB: makeMockDB(),
    ...overrides,
  };
}

let askCalls, askStatus, askBody;

beforeEach(() => {
  askCalls = [];
  askStatus = 200;
  askBody = { actions: [], reply: "ok", model: "claude-sonnet-5" };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init = {}) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith(ASK_UPSTREAM)) {
        askCalls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
        return new Response(JSON.stringify(askBody), {
          status: askStatus,
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

function askRequest(body) {
  return new Request("https://worker.example/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/ask — trace-id pass-through", () => {
  it("forwards a valid account_id and conversation_id verbatim", async () => {
    const res = await worker.fetch(
      askRequest({ app: "fresh_food", q: "what is NOVA", account_id: "acct_josh_test1", conversation_id: "conv-abc-123" }),
      baseEnv()
    );
    expect(res.status).toBe(200);
    expect(askCalls.length).toBe(1);
    expect(askCalls[0].body.account_id).toBe("acct_josh_test1");
    expect(askCalls[0].body.conversation_id).toBe("conv-abc-123");
  });

  it("mints a request_id when the caller sends none", async () => {
    await worker.fetch(askRequest({ app: "fresh_food", q: "what is NOVA" }), baseEnv());
    const sent = askCalls[0].body;
    expect(typeof sent.request_id).toBe("string");
    expect(sent.request_id.length).toBeGreaterThan(0);
  });

  it("forwards a valid caller-supplied request_id instead of minting a new one", async () => {
    await worker.fetch(
      askRequest({ app: "fresh_food", q: "what is NOVA", request_id: "app-minted-req-1" }),
      baseEnv()
    );
    expect(askCalls[0].body.request_id).toBe("app-minted-req-1");
  });

  it("drops an illegal-shaped account_id rather than forwarding it raw", async () => {
    await worker.fetch(
      askRequest({ app: "fresh_food", q: "what is NOVA", account_id: "../../etc/passwd" }),
      baseEnv()
    );
    expect(askCalls[0].body.account_id).toBeUndefined();
  });

  it("drops an illegal-shaped conversation_id rather than forwarding it raw", async () => {
    await worker.fetch(
      askRequest({ app: "fresh_food", q: "what is NOVA", conversation_id: "not/a/safe/id" }),
      baseEnv()
    );
    expect(askCalls[0].body.conversation_id).toBeUndefined();
  });

  it("omits account_id/conversation_id from the upstream body when the caller sent none — no fabricated identity", async () => {
    await worker.fetch(askRequest({ app: "fresh_food", q: "what is NOVA" }), baseEnv());
    const sent = askCalls[0].body;
    expect(sent.account_id).toBeUndefined();
    expect(sent.conversation_id).toBeUndefined();
  });

  it("never writes account_id/conversation_id/request_id into ask_log — production telemetry stays content-free and unchanged", async () => {
    const db = makeMockDB();
    await worker.fetch(
      askRequest({ app: "fresh_food", q: "what is NOVA", account_id: "acct_josh_test1", conversation_id: "conv-abc-123" }),
      baseEnv({ DB: db })
    );
    const insert = db.calls.find((c) => /INSERT INTO ask_log/.test(c.sql));
    expect(insert).toBeTruthy();
    expect(insert.sql).toMatch(/\(page, ip_hash, app, q, n_actions\)/);
    expect(insert.sql).not.toMatch(/account_id|conversation_id|request_id/);
    // The 5 bound values are exactly (page, ip_hash, app, q, n_actions) — no 6th value smuggled in.
    expect(insert.args.length).toBe(5);
  });

  it("still 503s when ASK_UPSTREAM/ASK_TOKEN are unset, before any of this matters", async () => {
    const res = await worker.fetch(
      askRequest({ app: "fresh_food", q: "what is NOVA", account_id: "acct_josh_test1" }),
      baseEnv({ ASK_TOKEN: undefined })
    );
    expect(res.status).toBe(503);
    expect(askCalls.length).toBe(0);
  });

  it("passes the assistant's response straight through, including whatever request_id/conversation_id it echoes back", async () => {
    askBody = { actions: [], reply: "ok", request_id: "upstream-req-1", conversation_id: "conv-abc-123" };
    const res = await worker.fetch(
      askRequest({ app: "fresh_food", q: "what is NOVA", account_id: "acct_josh_test1", conversation_id: "conv-abc-123" }),
      baseEnv()
    );
    expect(await res.json()).toEqual(askBody);
  });
});

describe("/api/ask — tool_results pass-through", () => {
  // fresh_app#141: the app executes `get_food_assessment` against its own store and carries the
  // values back on the SAME turn so the assistant answers from them. Before this, the Worker
  // rebuilt the upstream body from a fixed field list and `tool_results` was never read off it at
  // all, so the loop could not complete through production however correct both ends were.
  const RESULT = {
    tool: "get_food_assessment",
    call_id: "c1",
    ok: true,
    food: { code: "51101000", description: "Bread, white" },
    drop: { producer_version: "panel_viewer@2026-09-01" },
    systems: [{ key: "fc", label: "FCS v2.0", score: 11, percentile: 12.3, edition: "food_compass/2.0@2024-11" }],
  };

  it("forwards tool_results to the assistant", async () => {
    await worker.fetch(
      askRequest({ app: "fresh_app", q: "what does Food Compass give white bread", tool_results: [RESULT] }),
      baseEnv()
    );
    expect(askCalls[0].body.tool_results).toEqual([RESULT]);
  });

  it("omits the key entirely when the caller sent none — an absent read is not an empty one", async () => {
    // The assistant service derives its one-round cap from whether tool_results ARRIVED, so
    // sending [] on a first turn would misreport that turn as the second half of a round.
    await worker.fetch(askRequest({ app: "fresh_app", q: "what is Food Compass" }), baseEnv());
    expect("tool_results" in askCalls[0].body).toBe(false);
  });

  it("omits a non-array tool_results rather than forwarding it raw", async () => {
    await worker.fetch(
      askRequest({ app: "fresh_app", q: "hello", tool_results: { tool: "get_food_assessment" } }),
      baseEnv()
    );
    expect("tool_results" in askCalls[0].body).toBe(false);
  });

  it("caps at 4 entries, keeping the earliest — the assistant's own MAX_TOOL_RESULTS", async () => {
    const six = [1, 2, 3, 4, 5, 6].map((n) => ({ ...RESULT, call_id: "c" + n }));
    await worker.fetch(askRequest({ app: "fresh_app", q: "hello", tool_results: six }), baseEnv());
    const sent = askCalls[0].body.tool_results;
    expect(sent.length).toBe(4);
    expect(sent.map((r) => r.call_id)).toEqual(["c1", "c2", "c3", "c4"]);
  });

  it("drops the whole field when oversized rather than trimming it, and still answers", async () => {
    // Trimming would hand the assistant a PARTIAL round: its stateless one-round cap would then
    // read a turn it cannot classify. Whole or nothing, and the question still gets an answer —
    // the same drop-not-reject rule context/history already follow.
    const fat = [{ ...RESULT, filler: "x".repeat(30000) }, { ...RESULT, filler: "y".repeat(30000) }];
    const res = await worker.fetch(
      askRequest({ app: "fresh_app", q: "hello", tool_results: fat }),
      baseEnv()
    );
    expect(res.status).toBe(200);
    expect("tool_results" in askCalls[0].body).toBe(false);
  });

  it("applies no normalisation of its own — a string form survives and numbers are unchanged", async () => {
    // The Worker must not round, re-render or coerce a value: these are scores, percentiles and
    // editions read out of the app's own drop. It can only preserve what the caller sent, which is
    // why a caller needing an exact rendered form sends that form as a string.
    const shaped = {
      ...RESULT,
      systems: [{ key: "fc", label: "FCS v2.0", score: 11, percentile: 12.3, printed: "11.0" }],
    };
    await worker.fetch(askRequest({ app: "fresh_app", q: "hello", tool_results: [shaped] }), baseEnv());
    const sent = askCalls[0].body.tool_results[0].systems[0];
    expect(sent.printed).toBe("11.0");
    expect(sent.percentile).toBe(12.3);
    expect(sent.score).toBe(11);
  });

  it("never writes tool_results into ask_log — that table stays content-free (fresh_app#75 commitment 5)", async () => {
    const db = makeMockDB();
    await worker.fetch(
      askRequest({ app: "fresh_app", q: "hello", tool_results: [RESULT] }),
      baseEnv({ DB: db })
    );
    const insert = db.calls.find((c) => /INSERT INTO ask_log/.test(c.sql));
    expect(insert.sql).not.toMatch(/tool_results/);
    expect(insert.args.length).toBe(5);
    expect(JSON.stringify(insert.args)).not.toMatch(/get_food_assessment|51101000/);
  });
});
