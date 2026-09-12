// Clerk JWT verification for the engine proxy (/api/engine/*).
//
// Deliberately hand-rolled on Web Crypto rather than a library (e.g. `jose`): RS256 + JWKS
// verification is directly supported by `crypto.subtle.importKey('jwk', ...)` — no PEM
// conversion, no ASN.1 handling — so the extra dependency would buy nothing here. Revisit if
// a later route needs EdDSA/ES256 or refresh-token handling, where a library earns its keep.
//
// Cache shape: an in-memory Map of kid -> JWK, refreshed on a TTL and, separately, refetched
// on a presented kid that is not in the cache (handles Clerk rotating its signing key without
// us shipping a redeploy). That unknown-kid refetch is itself throttled to once per short
// window: without a throttle, a caller sending tokens with random kids forces one outbound
// JWKS fetch per request — an amplification path against Clerk's endpoint and a latency hole
// for us. Within the window an unknown kid just fails immediately; the TTL-stale refresh above
// is unaffected by this throttle.

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_UNKNOWN_KID_REFETCH_WINDOW_MS = 60 * 1000; // 60s

export function createJwksCache(ttlMs = DEFAULT_TTL_MS, opts = {}) {
  const {
    clock = () => Date.now(), // injectable for tests; never mock global timers around crypto
    unknownKidRefetchWindowMs = DEFAULT_UNKNOWN_KID_REFETCH_WINDOW_MS,
  } = opts;
  let keys = new Map();
  let fetchedAt = 0;
  let inflight = null; // de-dupe concurrent refreshes within one isolate

  async function refresh(jwksUrl, fetchImpl) {
    if (inflight) return inflight;
    inflight = (async () => {
      const res = await fetchImpl(jwksUrl);
      if (!res.ok) throw new Error(`jwks_fetch_failed_${res.status}`);
      const data = await res.json();
      const next = new Map();
      for (const jwk of Array.isArray(data.keys) ? data.keys : []) {
        if (jwk && jwk.kid) next.set(jwk.kid, jwk);
      }
      keys = next;
      fetchedAt = clock();
    })();
    try {
      await inflight;
    } finally {
      inflight = null;
    }
  }

  return {
    async getKey(kid, jwksUrl, fetchImpl = fetch) {
      const stale = clock() - fetchedAt > ttlMs;
      if (keys.size === 0 || stale) {
        await refresh(jwksUrl, fetchImpl);
      }
      if (!keys.has(kid) && clock() - fetchedAt > unknownKidRefetchWindowMs) {
        // Unknown kid and our data isn't fresh-fresh: could be rotation. Refetch once, then
        // give up — never loop. If we *just* refreshed, skip straight to giving up instead —
        // the kid genuinely isn't ours, and refetching again this soon would only be free
        // amplification for whoever is sending it.
        await refresh(jwksUrl, fetchImpl);
      }
      return keys.get(kid) || null;
    },
    // test/debug only
    _size: () => keys.size,
  };
}

function base64UrlToBytes(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const bin = atob(padded + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64UrlToString(str) {
  return new TextDecoder().decode(base64UrlToBytes(str));
}

async function importVerifyKey(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
}

/**
 * Verify a Clerk session JWT (RS256) against the instance JWKS.
 *
 * @param {string} token - the raw JWT (no "Bearer " prefix)
 * @param {object} opts
 * @param {string} opts.issuer - expected `iss` claim
 * @param {string} opts.jwksUrl
 * @param {ReturnType<typeof createJwksCache>} opts.jwksCache
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.now] - ms epoch, for tests
 * @returns {Promise<{ok: true, sub: string, claims: object} | {ok: false, reason: string}>}
 */
export async function verifyClerkJWT(token, opts) {
  const { issuer, jwksUrl, jwksCache, fetchImpl = fetch, now = Date.now() } = opts;

  if (typeof token !== "string" || !token) return { ok: false, reason: "missing_token" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headerB64, payloadB64, sigB64] = parts;

  let header, payload;
  try {
    header = JSON.parse(base64UrlToString(headerB64));
    payload = JSON.parse(base64UrlToString(payloadB64));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (header.alg !== "RS256") return { ok: false, reason: "unsupported_alg" };
  if (!header.kid) return { ok: false, reason: "no_kid" };

  let jwk;
  try {
    jwk = await jwksCache.getKey(header.kid, jwksUrl, fetchImpl);
  } catch {
    return { ok: false, reason: "jwks_unavailable" };
  }
  if (!jwk) return { ok: false, reason: "unknown_kid" };
  if (jwk.kty !== "RSA") return { ok: false, reason: "bad_key" };

  let key;
  try {
    key = await importVerifyKey(jwk);
  } catch {
    return { ok: false, reason: "bad_key" };
  }

  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64UrlToBytes(sigB64),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad_signature" };

  const nowSec = Math.floor(now / 1000);
  if (typeof payload.exp !== "number" || nowSec >= payload.exp) return { ok: false, reason: "expired" };
  if (typeof payload.nbf === "number" && nowSec < payload.nbf) return { ok: false, reason: "not_yet_valid" };
  if (payload.iss !== issuer) return { ok: false, reason: "bad_issuer" };
  if (typeof payload.sub !== "string" || !payload.sub) return { ok: false, reason: "no_sub" };

  return { ok: true, sub: payload.sub, claims: payload };
}
