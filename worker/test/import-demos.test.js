// GET /import-demos/<sha256>.mp4 — the Import screen's demo loops from R2 by content hash.
//
// What must hold:
//   - a stored object is served as video/mp4 with the immutable Cache-Control, the hash as ETag,
//     Accept-Ranges: bytes and the Worker's CORS headers
//   - a Range request (a-b, a-, -n) is a 206 with Content-Range and exactly those bytes (iOS AVPlayer
//     needs this); an unsatisfiable one is a 416; a malformed one is ignored and the whole file served
//   - HEAD, a matching If-None-Match (304), a missing object (404), a bad name or a listing (404 before R2),
//     any other method (405)
//   - nothing ever lists, writes or deletes in the bucket
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index.js";
import { makeMockDB } from "./helpers.js";

const HASH = "132062b45c3a5fab4ee36bbda0c2d87cdc47ba2084643f946cd81f8aae28ddcc";
const OTHER = "8b1a923fa96c5f58a1bd60cf9eab72ab7d14057131eff5478e71f39104e85029";
const BYTES = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));
const KEY = `import-demos/${HASH}.mp4`;
const ORIGIN = "https://insights.freshfoodrecs.com";

function makeR2(objects = {}) {
  const store = new Map(Object.entries(objects));
  const calls = [];
  const meta = (key, v) => ({ key, size: v.byteLength });
  return {
    calls,
    async get(key, opts) {
      calls.push(["get", key, opts?.range ?? null]);
      const v = store.get(key);
      if (!v) return null;
      const r = opts?.range;
      const part = r ? v.slice(r.offset, r.offset + r.length) : v;
      return { ...meta(key, v), body: new Response(part).body };
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

const envWith = (r2) => ({ ALLOWED_ORIGINS: `${ORIGIN},http://localhost:8081`, DB: makeMockDB(), ...(r2 ? { RECIPE_PHOTOS: r2 } : {}) });
const req = (path, init = {}) => new Request("https://worker.example" + path, init);
const path = `/import-demos/${HASH}.mp4`;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input) => {
    throw new Error("unexpected fetch in test: " + (typeof input === "string" ? input : input.url));
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("GET /import-demos/<sha256>.mp4", () => {
  it("serves the whole file with the immutable headers", async () => {
    const r2 = makeR2({ [KEY]: BYTES });
    const res = await worker.fetch(req(path, { headers: { Origin: ORIGIN } }), envWith(r2));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("ETag")).toBe(`"${HASH}"`);
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Content-Length")).toBe("100");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
  });

  it("answers a Range a-b with a 206 and exactly those bytes", async () => {
    const r2 = makeR2({ [KEY]: BYTES });
    const res = await worker.fetch(req(path, { headers: { Range: "bytes=10-19" } }), envWith(r2));
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 10-19/100");
    expect(res.headers.get("Content-Length")).toBe("10");
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES.slice(10, 20));
  });

  it("answers open-ended and suffix ranges, and clamps an end past the file", async () => {
    const r2 = makeR2({ [KEY]: BYTES });
    const open = await worker.fetch(req(path, { headers: { Range: "bytes=90-" } }), envWith(r2));
    expect(open.status).toBe(206);
    expect(open.headers.get("Content-Range")).toBe("bytes 90-99/100");
    expect(new Uint8Array(await open.arrayBuffer())).toEqual(BYTES.slice(90));
    const suffix = await worker.fetch(req(path, { headers: { Range: "bytes=-5" } }), envWith(r2));
    expect(suffix.headers.get("Content-Range")).toBe("bytes 95-99/100");
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(BYTES.slice(95));
    const past = await worker.fetch(req(path, { headers: { Range: "bytes=0-9999" } }), envWith(r2));
    expect(past.headers.get("Content-Range")).toBe("bytes 0-99/100");
    const first = await worker.fetch(req(path, { headers: { Range: "bytes=0-1" } }), envWith(r2));
    expect(first.headers.get("Content-Range")).toBe("bytes 0-1/100");
  });

  it("is a 416 for a range that starts past the end, with the size", async () => {
    const r2 = makeR2({ [KEY]: BYTES });
    const res = await worker.fetch(req(path, { headers: { Range: "bytes=100-120" } }), envWith(r2));
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */100");
  });

  it("ignores a malformed or multi-part Range and serves the whole file", async () => {
    const r2 = makeR2({ [KEY]: BYTES });
    for (const Range of ["bytes=0-1,5-6", "items=0-1", "bytes=abc", "bytes=-"]) {
      const res = await worker.fetch(req(path, { headers: { Range } }), envWith(r2));
      expect(res.status, Range).toBe(200);
      expect(res.headers.get("Content-Length")).toBe("100");
    }
  });

  it("answers HEAD (with and without a Range) with no body", async () => {
    const r2 = makeR2({ [KEY]: BYTES });
    const res = await worker.fetch(req(path, { method: "HEAD" }), envWith(r2));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe("100");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.body).toBeNull();
    const ranged = await worker.fetch(req(path, { method: "HEAD", headers: { Range: "bytes=0-9" } }), envWith(r2));
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("Content-Range")).toBe("bytes 0-9/100");
    expect(ranged.body).toBeNull();
    expect(r2.calls.every((c) => c[0] === "head")).toBe(true);
  });

  it("is a 304 for a matching If-None-Match", async () => {
    const r2 = makeR2({ [KEY]: BYTES });
    for (const inm of [`"${HASH}"`, `W/"${HASH}"`, `"x", "${HASH}"`, "*"]) {
      const res = await worker.fetch(req(path, { headers: { "If-None-Match": inm } }), envWith(r2));
      expect(res.status, inm).toBe(304);
      expect(res.body).toBeNull();
    }
  });

  it("is a 404 for a missing object, and a bad name or a listing never reaches R2", async () => {
    const r2 = makeR2({ [KEY]: BYTES });
    const missing = await worker.fetch(req(`/import-demos/${OTHER}.mp4`), envWith(r2));
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
    const before = r2.calls.length;
    for (const p of [
      "/import-demos", "/import-demos/", "/import-demos/?list", "/import-demos/?prefix=", `/import-demos/${HASH.toUpperCase()}.mp4`,
      `/import-demos/${HASH}.webp`, `/import-demos/${HASH}`, `/import-demos/${HASH.slice(1)}.mp4`, `/import-demos/x/${HASH}.mp4`,
      `/import-demos/${HASH}.mp4/extra`, `/import-demos/../${HASH}.mp4`,
    ]) {
      const res = await worker.fetch(req(p), envWith(r2));
      expect(res.status, p).toBe(404);
    }
    expect(r2.calls.length).toBe(before);
  });

  it("is a 405 for other methods and a 503 without the binding", async () => {
    const r2 = makeR2({ [KEY]: BYTES });
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await worker.fetch(req(path, { method, body: method === "DELETE" ? undefined : "x" }), envWith(r2));
      expect(res.status, method).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    }
    const none = await worker.fetch(req(path), envWith(null));
    expect(none.status).toBe(503);
  });
});
