// Test-only helpers: a locally generated RS256 key pair, a fake JWKS server, and a minimal
// JWT signer — so the auth tests never touch the real Clerk service.

function base64UrlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeString(str) {
  return base64UrlEncode(new TextEncoder().encode(str));
}

export async function generateTestKeyPair() {
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );
}

export async function exportJwks(publicKey, kid) {
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  return { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] };
}

export async function signTestJWT(privateKey, kid, claims) {
  const header = { alg: "RS256", typ: "JWT", kid };
  const headerB64 = base64UrlEncodeString(JSON.stringify(header));
  const payloadB64 = base64UrlEncodeString(JSON.stringify(claims));
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, signingInput);
  const sigB64 = base64UrlEncode(new Uint8Array(signature));
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

// A fake `fetch` that serves a fixed JWKS response and counts calls, so tests can assert on
// how many times the JWKS was actually fetched (cache hits vs. refetch-on-unknown-kid).
export function makeFakeJwksFetch(jwksDoc, { fail = false } = {}) {
  const fetchImpl = async () => {
    fetchImpl.calls++;
    if (fail) return new Response("nope", { status: 500 });
    return new Response(JSON.stringify(jwksDoc), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  fetchImpl.calls = 0;
  return fetchImpl;
}

// Drains a ReadableStream (e.g. the `body` a fetch stub captured) into one Uint8Array, so a
// test can assert on the exact bytes forwarded rather than a decoded string.
export async function readAllBytes(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// A mock D1 binding: prepare().bind().all()/run(), recording every call for assertions and
// letting tests script the count returned for rate-limit checks.
export function makeMockDB({ countAll = 0 } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() {
              calls.push({ sql, args });
              return { results: [{ n: countAll }] };
            },
            async run() {
              calls.push({ sql, args });
              return { success: true };
            },
          };
        },
      };
    },
  };
}
