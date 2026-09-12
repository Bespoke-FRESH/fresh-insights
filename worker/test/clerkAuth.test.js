import { describe, it, expect, beforeAll } from "vitest";
import { createJwksCache, verifyClerkJWT } from "../src/clerkAuth.js";
import { generateTestKeyPair, exportJwks, signTestJWT, makeFakeJwksFetch } from "./helpers.js";

const ISSUER = "https://crisp-scorpion-5272.clerk.accounts.dev";
const JWKS_URL = ISSUER + "/.well-known/jwks.json";
const KID = "test-kid-1";

describe("verifyClerkJWT", () => {
  let keyPair, jwks, nowSec;

  beforeAll(async () => {
    keyPair = await generateTestKeyPair();
    jwks = await exportJwks(keyPair.publicKey, KID);
    nowSec = Math.floor(Date.now() / 1000);
  });

  function baseClaims(overrides = {}) {
    return {
      iss: ISSUER,
      sub: "user_abc123",
      exp: nowSec + 3600,
      nbf: nowSec - 10,
      iat: nowSec - 10,
      ...overrides,
    };
  }

  it("accepts a validly signed, unexpired token from the right issuer", async () => {
    const token = await signTestJWT(keyPair.privateKey, KID, baseClaims());
    const fetchImpl = makeFakeJwksFetch(jwks);
    const cache = createJwksCache();

    const result = await verifyClerkJWT(token, {
      issuer: ISSUER,
      jwksUrl: JWKS_URL,
      jwksCache: cache,
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    expect(result.sub).toBe("user_abc123");
    expect(fetchImpl.calls).toBe(1);
  });

  it("caches the JWKS across calls instead of refetching every time", async () => {
    const token1 = await signTestJWT(keyPair.privateKey, KID, baseClaims());
    const token2 = await signTestJWT(keyPair.privateKey, KID, baseClaims({ sub: "user_other" }));
    const fetchImpl = makeFakeJwksFetch(jwks);
    const cache = createJwksCache();

    await verifyClerkJWT(token1, { issuer: ISSUER, jwksUrl: JWKS_URL, jwksCache: cache, fetchImpl });
    const second = await verifyClerkJWT(token2, { issuer: ISSUER, jwksUrl: JWKS_URL, jwksCache: cache, fetchImpl });

    expect(second.ok).toBe(true);
    expect(fetchImpl.calls).toBe(1); // second call was a cache hit
  });

  it("rejects an expired token", async () => {
    const token = await signTestJWT(keyPair.privateKey, KID, baseClaims({ exp: nowSec - 60 }));
    const cache = createJwksCache();
    const result = await verifyClerkJWT(token, {
      issuer: ISSUER, jwksUrl: JWKS_URL, jwksCache: cache, fetchImpl: makeFakeJwksFetch(jwks),
    });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a token not yet valid (nbf in the future)", async () => {
    const token = await signTestJWT(keyPair.privateKey, KID, baseClaims({ nbf: nowSec + 600 }));
    const cache = createJwksCache();
    const result = await verifyClerkJWT(token, {
      issuer: ISSUER, jwksUrl: JWKS_URL, jwksCache: cache, fetchImpl: makeFakeJwksFetch(jwks),
    });
    expect(result).toEqual({ ok: false, reason: "not_yet_valid" });
  });

  it("rejects the wrong issuer", async () => {
    const token = await signTestJWT(keyPair.privateKey, KID, baseClaims({ iss: "https://evil.example" }));
    const cache = createJwksCache();
    const result = await verifyClerkJWT(token, {
      issuer: ISSUER, jwksUrl: JWKS_URL, jwksCache: cache, fetchImpl: makeFakeJwksFetch(jwks),
    });
    expect(result).toEqual({ ok: false, reason: "bad_issuer" });
  });

  it("does not refetch an unknown kid within the throttle window right after a refresh", async () => {
    const token = await signTestJWT(keyPair.privateKey, "some-other-kid", baseClaims());
    let t = 1_000_000;
    const cache = createJwksCache(undefined, { clock: () => t });
    const fetchImpl = makeFakeJwksFetch(jwks); // jwks only has KID, never "some-other-kid"

    // First call is a cold cache: it fetches once, learns the JWKS genuinely doesn't have
    // this kid, and — since that fetch was just now — must not spend a second one chasing it.
    const result = await verifyClerkJWT(token, {
      issuer: ISSUER, jwksUrl: JWKS_URL, jwksCache: cache, fetchImpl,
    });

    expect(result).toEqual({ ok: false, reason: "unknown_kid" });
    expect(fetchImpl.calls).toBe(1); // throttled: no wasted second fetch this soon after one

    // Still within the window a little later: same result, still no extra fetch.
    t += 5_000;
    const second = await verifyClerkJWT(token, {
      issuer: ISSUER, jwksUrl: JWKS_URL, jwksCache: cache, fetchImpl,
    });
    expect(second).toEqual({ ok: false, reason: "unknown_kid" });
    expect(fetchImpl.calls).toBe(1);
  });

  it("refetches an unknown kid once the throttle window has elapsed, picking up a rotated key", async () => {
    const newKeyPair = await generateTestKeyPair();
    const newKid = "rotated-kid";
    const token = await signTestJWT(newKeyPair.privateKey, newKid, baseClaims());

    // Cache starts warm with only the old key (simulating a cache populated before rotation).
    let t = 1_000_000;
    const cache = createJwksCache(undefined, { clock: () => t });
    const staleFetch = makeFakeJwksFetch(jwks);
    await cache.getKey(KID, JWKS_URL, staleFetch); // warm the cache with the old key only

    // Past the throttle window: the fake fetch now serves the *new* JWKS document, so the
    // unknown-kid refetch should find it.
    t += 61_000;
    const rotatedJwks = await exportJwks(newKeyPair.publicKey, newKid);
    const rotatedFetch = makeFakeJwksFetch(rotatedJwks);

    const result = await verifyClerkJWT(token, {
      issuer: ISSUER, jwksUrl: JWKS_URL, jwksCache: cache, fetchImpl: rotatedFetch,
    });

    expect(result.ok).toBe(true);
    expect(rotatedFetch.calls).toBe(1); // the one throttle-window-elapsed refetch
  });

  it("rejects a JWK whose kty is not RSA before ever attempting to import it", async () => {
    const weirdJwks = { keys: [{ kid: KID, kty: "EC", crv: "P-256", x: "abc", y: "def" }] };
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    // Header/payload are well-formed; the signature is garbage, but the kty check must reject
    // before signature verification is ever attempted.
    const token = `${enc({ alg: "RS256", typ: "JWT", kid: KID })}.${enc(baseClaims())}.deadbeef`;
    const cache = createJwksCache();
    const result = await verifyClerkJWT(token, {
      issuer: ISSUER, jwksUrl: JWKS_URL, jwksCache: cache, fetchImpl: makeFakeJwksFetch(weirdJwks),
    });
    expect(result).toEqual({ ok: false, reason: "bad_key" });
  });

  it("rejects a tampered signature", async () => {
    const token = await signTestJWT(keyPair.privateKey, KID, baseClaims());
    const [h, p, s] = token.split(".");
    // Flip the payload without re-signing.
    const tamperedPayload = Buffer.from(JSON.stringify(baseClaims({ sub: "user_hacked" })))
      .toString("base64url");
    const tampered = `${h}.${tamperedPayload}.${s}`;

    const cache = createJwksCache();
    const result = await verifyClerkJWT(tampered, {
      issuer: ISSUER, jwksUrl: JWKS_URL, jwksCache: cache, fetchImpl: makeFakeJwksFetch(jwks),
    });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a malformed token", async () => {
    const cache = createJwksCache();
    const result = await verifyClerkJWT("not.a.jwt.at.all", {
      issuer: ISSUER, jwksUrl: JWKS_URL, jwksCache: cache, fetchImpl: makeFakeJwksFetch(jwks),
    });
    expect(result).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects an unsupported alg", async () => {
    const header = { alg: "none", typ: "JWT", kid: KID };
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const token = `${enc(header)}.${enc(baseClaims())}.`;
    const cache = createJwksCache();
    const result = await verifyClerkJWT(token, {
      issuer: ISSUER, jwksUrl: JWKS_URL, jwksCache: cache, fetchImpl: makeFakeJwksFetch(jwks),
    });
    expect(result).toEqual({ ok: false, reason: "unsupported_alg" });
  });

  it("propagates a JWKS fetch failure as a clean rejection, not a throw", async () => {
    const token = await signTestJWT(keyPair.privateKey, KID, baseClaims());
    const cache = createJwksCache();
    const result = await verifyClerkJWT(token, {
      issuer: ISSUER, jwksUrl: JWKS_URL, jwksCache: cache, fetchImpl: makeFakeJwksFetch(jwks, { fail: true }),
    });
    expect(result).toEqual({ ok: false, reason: "jwks_unavailable" });
  });
});
