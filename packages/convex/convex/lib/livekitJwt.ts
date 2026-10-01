// LiveKit access tokens, signed with Web Crypto HMAC-SHA256 and no server SDK.
// The media server trusts any JWT signed with LIVEKIT_API_SECRET, so whoever
// calls this has already decided the bearer may hold the grant.

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function signLivekitJwt(opts: {
  apiKey: string;
  apiSecret: string;
  identity: string;
  name: string;
  room: string;
  metadata?: string;
  ttlSeconds?: number;
  nowSeconds?: number;
  // The grant beyond the room name; a participant's join grant by default.
  grant?: Record<string, boolean>;
}): Promise<string> {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: opts.apiKey,
    sub: opts.identity,
    nbf: now - 10,
    exp: now + (opts.ttlSeconds ?? 6 * 3600),
    name: opts.name,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
    video: {
      room: opts.room,
      ...(opts.grant ?? { roomJoin: true, canPublish: true, canSubscribe: true }),
    },
  };
  const enc = new TextEncoder();
  const signingInput = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(
    enc.encode(JSON.stringify(payload)),
  )}`;
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(opts.apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(signingInput)),
  );
  return `${signingInput}.${b64url(sig)}`;
}
