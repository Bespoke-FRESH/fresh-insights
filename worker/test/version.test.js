// Deployed-version stamp (X-Worker-Version / X-Worker-Deployed).
//
// Why this exists rather than a /api/version route: "is #38 live?" was unanswerable for three
// days, because this repo has no CI path that deploys the Worker — merged and shipped are
// independent facts — and /health returns {ok:true} without naming the code that produced it.
// A response header answers it off a call the caller already makes, costing no extra request.
//
// What must hold:
//   - present on an ordinary route, an upstream-backed route, AND an error route, because the
//     500 you are debugging is exactly when you need to know which build threw
//   - absent entirely when the binding is absent, rather than a guess or an empty header
//   - named in Access-Control-Expose-Headers, or browser JS cannot read either one
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index.js";
import { makeMockDB } from "./helpers.js";

const ASK_UPSTREAM = "https://fresh-assistant-api.fly.dev";
const VERSION = { id: "3ed622d5-9c11-4f0a-bc2e-7a1d0e4f8b32", timestamp: "2026-09-16T01:52:10.004Z" };

function envWith(meta, overrides = {}) {
  return {
    ALLOWED_ORIGINS: "https://insights.freshfoodrecs.com",
    ASK_UPSTREAM,
    ASK_TOKEN: "svc-ask-secret",
    DB: makeMockDB(),
    ...(meta ? { CF_VERSION_METADATA: meta } : {}),
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith(ASK_UPSTREAM)) {
        return new Response(JSON.stringify({ actions: [], reply: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error("unexpected fetch in test: " + url);
    })
  );
});

afterEach(() => vi.unstubAllGlobals());

const get = (path) => new Request("https://worker.example" + path);

describe("deployed-version stamp", () => {
  it("stamps id and timestamp on a plain route", async () => {
    const res = await worker.fetch(get("/health"), envWith(VERSION));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Worker-Version")).toBe(VERSION.id);
    expect(res.headers.get("X-Worker-Deployed")).toBe(VERSION.timestamp);
  });

  it("exposes both headers to browser JS", async () => {
    const res = await worker.fetch(get("/health"), envWith(VERSION));
    const expose = res.headers.get("Access-Control-Expose-Headers") || "";
    expect(expose).toContain("X-Worker-Version");
    expect(expose).toContain("X-Worker-Deployed");
  });

  it("stamps a 404 as well as a 200", async () => {
    const res = await worker.fetch(get("/nope"), envWith(VERSION));
    expect(res.status).toBe(404);
    expect(res.headers.get("X-Worker-Version")).toBe(VERSION.id);
  });

  it("stamps an upstream-backed response", async () => {
    const res = await worker.fetch(
      new Request("https://worker.example/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app: "fresh_app", q: "what is NOVA" }),
      }),
      envWith(VERSION)
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Worker-Version")).toBe(VERSION.id);
  });

  it("stamps a 500 — the case you most need it for", async () => {
    // A DB whose query throws drives the handler's catch, which returns the 500 body.
    const brokenDB = { prepare() { throw new Error("boom"); } };
    const res = await worker.fetch(get("/api/comments?page=/x"), envWith(VERSION, { DB: brokenDB }));
    expect(res.status).toBe(500);
    expect(res.headers.get("X-Worker-Version")).toBe(VERSION.id);
  });

  it("stamps nothing when the binding is absent", async () => {
    const res = await worker.fetch(get("/health"), envWith(null));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Worker-Version")).toBeNull();
    expect(res.headers.get("X-Worker-Deployed")).toBeNull();
    expect(res.headers.get("Access-Control-Expose-Headers")).toBeNull();
  });

  it("stamps nothing when the binding is present but has no id", async () => {
    const res = await worker.fetch(get("/health"), envWith({ timestamp: VERSION.timestamp }));
    expect(res.headers.get("X-Worker-Deployed")).toBeNull();
  });

  it("omits only the timestamp when the binding carries an id alone", async () => {
    const res = await worker.fetch(get("/health"), envWith({ id: VERSION.id }));
    expect(res.headers.get("X-Worker-Version")).toBe(VERSION.id);
    expect(res.headers.get("X-Worker-Deployed")).toBeNull();
  });
});
