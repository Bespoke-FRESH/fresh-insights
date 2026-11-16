// GET /recipe-photos/<sha256>.webp — catalog recipe photos from R2 by content hash (fresh_app plan row P8).
//
// What must hold:
//   - a stored object is served with its bytes, image/webp, the immutable year-long Cache-Control,
//     the hash as ETag, and the Worker's usual CORS headers
//   - HEAD answers the same headers with no body; a matching If-None-Match is a 304
//   - a missing object, a bad name and every listing attempt are 404; other methods are 405
//   - nothing ever lists the bucket: the R2 double below throws on list(), and a bad path never
//     reaches R2 at all
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index.js";
import { makeMockDB } from "./helpers.js";

const HASH = "132062b45c3a5fab4ee36bbda0c2d87cdc47ba2084643f946cd81f8aae28ddcc";
const OTHER = "8b1a923fa96c5f58a1bd60cf9eab72ab7d14057131eff5478e71f39104e85029";
const BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
const ORIGIN = "https://insights.freshfoodrecs.com";

// A minimal R2 binding: get/head over a Map; list (and any write) throws so a test fails if the
// route ever calls it. Records every call.
function makeR2(objects = {}) {
  const store = new Map(Object.entries(objects));
  const calls = [];
  const meta = (key, v) => ({
    key,
    size: v.bytes.byteLength,
    httpMetadata: v.contentType === undefined ? {} : { contentType: v.contentType },
  });
  return {
    calls,
    async get(key) {
      calls.push(["get", key]);
      const v = store.get(key);
      if (!v) return null;
      return { ...meta(key, v), body: new Response(v.bytes).body };
    },
    async head(key) {
      calls.push(["head", key]);
      const v = store.get(key);
      return v ? meta(key, v) : null;
    },
    async list() { calls.push(["list"]); throw new Error("list must never be called"); },
    async put() { calls.push(["put"]); throw new Error("put must never be called"); },
    async delete() { calls.push(["delete"]); throw new Error("delete must never be called"); },
  };
}

function envWith(r2, overrides = {}) {
  return {
    ALLOWED_ORIGINS: `${ORIGIN},http://localhost:8081`,
    DB: makeMockDB(),
    ...(r2 ? { RECIPE_PHOTOS: r2 } : {}),
    ...overrides,
  };
}

const req = (path, init = {}) => new Request("https://worker.example" + path, init);

beforeEach(() => {
  // The route must not call out anywhere.
  vi.stubGlobal("fetch", vi.fn(async (input) => {
    throw new Error("unexpected fetch in test: " + (typeof input === "string" ? input : input.url));
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("GET /recipe-photos/<sha256>.webp", () => {
  it("serves a stored object with its bytes and the immutable headers", async () => {
    const r2 = makeR2({ [`${HASH}.webp`]: { bytes: BYTES, contentType: "image/webp" } });
    const res = await worker.fetch(req(`/recipe-photos/${HASH}.webp`, { headers: { Origin: ORIGIN } }), envWith(r2));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("ETag")).toBe(`"${HASH}"`);
    expect(res.headers.get("Content-Length")).toBe(String(BYTES.byteLength));
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(res.headers.get("Vary")).toBe("Origin");
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("ETag");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
    expect(r2.calls).toEqual([["get", `${HASH}.webp`]]);
  });

  it("always serves image/webp with nosniff, whatever content type was stored", async () => {
    const stored = { image_svg: "image/svg+xml", text_html: "text/html", image_png: "image/png", none: undefined };
    for (const [name, contentType] of Object.entries(stored)) {
      const r2 = makeR2({ [`${HASH}.webp`]: { bytes: BYTES, contentType } });
      for (const method of ["GET", "HEAD"]) {
        const res = await worker.fetch(req(`/recipe-photos/${HASH}.webp`, { method }), envWith(r2));
        expect(res.status, `${method} ${name}`).toBe(200);
        expect(res.headers.get("Content-Type"), `${method} ${name}`).toBe("image/webp");
        expect(res.headers.get("X-Content-Type-Options"), `${method} ${name}`).toBe("nosniff");
      }
    }
  });

  it("ignores a query string on a good name", async () => {
    const r2 = makeR2({ [`${HASH}.webp`]: { bytes: BYTES, contentType: "image/webp" } });
    const res = await worker.fetch(req(`/recipe-photos/${HASH}.webp?list&prefix=`), envWith(r2));
    expect(res.status).toBe(200);
    expect(r2.calls).toEqual([["get", `${HASH}.webp`]]);
  });

  it("is a 404 for a missing object", async () => {
    const r2 = makeR2({ [`${HASH}.webp`]: { bytes: BYTES, contentType: "image/webp" } });
    const res = await worker.fetch(req(`/recipe-photos/${OTHER}.webp`), envWith(r2));
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "not found" });
    expect(r2.calls).toEqual([["get", `${OTHER}.webp`]]);
  });

  it("answers HEAD with the same headers and no body", async () => {
    const r2 = makeR2({ [`${HASH}.webp`]: { bytes: BYTES, contentType: "image/webp" } });
    const res = await worker.fetch(req(`/recipe-photos/${HASH}.webp`, { method: "HEAD" }), envWith(r2));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    expect(res.headers.get("ETag")).toBe(`"${HASH}"`);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(res.body).toBeNull();
    expect(r2.calls).toEqual([["head", `${HASH}.webp`]]);
    const missing = await worker.fetch(req(`/recipe-photos/${OTHER}.webp`, { method: "HEAD" }), envWith(r2));
    expect(missing.status).toBe(404);
  });

  it("answers a matching If-None-Match with a 304 and no body", async () => {
    const r2 = makeR2({ [`${HASH}.webp`]: { bytes: BYTES, contentType: "image/webp" } });
    for (const inm of [`"${HASH}"`, `W/"${HASH}"`, `"x", "${HASH}"`, "*"]) {
      const res = await worker.fetch(req(`/recipe-photos/${HASH}.webp`, { headers: { "If-None-Match": inm } }), envWith(r2));
      expect(res.status).toBe(304);
      expect(res.body).toBeNull();
      expect(res.headers.get("ETag")).toBe(`"${HASH}"`);
    }
    const stale = await worker.fetch(req(`/recipe-photos/${HASH}.webp`, { headers: { "If-None-Match": `"${OTHER}"` } }), envWith(r2));
    expect(stale.status).toBe(200);
  });

  it("is a 404, not a 304, for a missing object whatever the validator", async () => {
    const r2 = makeR2({});
    const res = await worker.fetch(req(`/recipe-photos/${HASH}.webp`, { headers: { "If-None-Match": `"${HASH}"` } }), envWith(r2));
    expect(res.status).toBe(404);
  });

  it("is a 404 for every bad name, without touching R2", async () => {
    const r2 = makeR2({ [`${HASH}.webp`]: { bytes: BYTES, contentType: "image/webp" } });
    const bad = [
      `/recipe-photos/${HASH.toUpperCase()}.webp`,       // uppercase hex
      `/recipe-photos/${HASH.slice(1)}.webp`,            // 63 hex
      `/recipe-photos/${HASH}0.webp`,                    // 65 hex
      `/recipe-photos/${HASH}`,                          // no extension
      `/recipe-photos/${HASH}.png`,                      // wrong extension
      `/recipe-photos/${HASH}.webp/`,                    // trailing slash
      `/recipe-photos/${HASH}.webp.webp`,
      `/recipe-photos/x/${HASH}.webp`,                   // extra segment
      `/recipe-photos/${HASH.slice(0, 60)}zzzz.webp`,    // non-hex
      `/recipe-photos/%2e%2e/${HASH}.webp`,
      `/recipe-photos/usda_pear-rabbit.webp`,            // a file name, not a hash
    ];
    for (const p of bad) {
      const res = await worker.fetch(req(p), envWith(r2));
      expect(res.status, p).toBe(404);
    }
    expect(r2.calls).toEqual([]);
  });

  it("never lists: the bare prefix, a trailing slash and list-style queries are 404", async () => {
    const r2 = makeR2({ [`${HASH}.webp`]: { bytes: BYTES, contentType: "image/webp" } });
    const listing = [
      "/recipe-photos",
      "/recipe-photos/",
      "/recipe-photos/?list",
      "/recipe-photos/?list-type=2",
      "/recipe-photos/?prefix=&delimiter=/",
      "/recipe-photos?list",
      "/recipe-photos/*",
      "/recipe-photos/index.html",
    ];
    for (const p of listing) {
      for (const method of ["GET", "HEAD"]) {
        const res = await worker.fetch(req(p, { method }), envWith(r2));
        expect(res.status, `${method} ${p}`).toBe(404);
        if (method === "GET") expect(await res.text(), p).not.toContain(HASH);
      }
    }
    expect(r2.calls).toEqual([]);
  });

  it("is a 405 for a method other than GET, HEAD or OPTIONS", async () => {
    const r2 = makeR2({ [`${HASH}.webp`]: { bytes: BYTES, contentType: "image/webp" } });
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await worker.fetch(req(`/recipe-photos/${HASH}.webp`, { method, body: method === "DELETE" ? undefined : "x" }), envWith(r2));
      expect(res.status, method).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    }
    expect(r2.calls).toEqual([]);
  });

  it("answers OPTIONS like every other route", async () => {
    const r2 = makeR2({});
    const res = await worker.fetch(req(`/recipe-photos/${HASH}.webp`, { method: "OPTIONS", headers: { Origin: "http://localhost:8081" } }), envWith(r2));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:8081");
    expect(r2.calls).toEqual([]);
  });

  it("fails closed with a 503 when the binding is absent", async () => {
    const res = await worker.fetch(req(`/recipe-photos/${HASH}.webp`), envWith(null));
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("stamps the deployed version and keeps ETag exposed beside it", async () => {
    const r2 = makeR2({ [`${HASH}.webp`]: { bytes: BYTES, contentType: "image/webp" } });
    const env = envWith(r2, { CF_VERSION_METADATA: { id: "v1", timestamp: "2026-11-16T00:00:00Z" } });
    const res = await worker.fetch(req(`/recipe-photos/${HASH}.webp`), env);
    expect(res.headers.get("X-Worker-Version")).toBe("v1");
    const exposed = res.headers.get("Access-Control-Expose-Headers");
    expect(exposed).toContain("ETag");
    expect(exposed).toContain("X-Worker-Version");
  });

  it("no route anywhere calls list on the bucket", async () => {
    const r2 = makeR2({ [`${HASH}.webp`]: { bytes: BYTES, contentType: "image/webp" } });
    const env = envWith(r2);
    for (const p of ["/", "/health", "/recipe-photos/", "/api/recipe-photos", "/admin/recipe-photos", `/recipe-photos/${HASH}.webp`]) {
      await worker.fetch(req(p), env);
    }
    expect(r2.calls.filter(([op]) => op !== "get" && op !== "head")).toEqual([]);
  });
});
