// Passkeys in tests. softAuthenticator is an ES256 key pair in memory that
// answers registration and assertion options with real, verifiable responses
// (fmt "none", user present and verified); seedPresence writes the grant a
// verified assertion leaves and answers the grant string that spends it, for
// suites about what a gate guards rather than
// the ceremony (passkeys.test.ts covers that). The file name carries two dots
// so the Convex bundler skips it.
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";
import { PRESENCE_TTL_MS, type PresenceAction } from "@codecast/shared/contracts/secrets";
import { sha256Hex } from "./lib/hash";
import { grantString } from "./lib/presence";

const b64u = (bytes: Uint8Array | ArrayBuffer) => isoBase64URL.fromBuffer(new Uint8Array(bytes));
const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

// WebAuthn carries ECDSA signatures DER encoded; web crypto signs raw r || s.
function derSignature(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.slice(i);
    const body = v[0] & 0x80 ? concat(new Uint8Array([0]), v) : v;
    return concat(new Uint8Array([0x02, body.length]), body);
  };
  const seq = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, seq.length]), seq);
}

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

export type SoftAuthenticator = {
  credentialId: string;
  /** The signature count the next assertion signs; set it back to fake a copied key. */
  counter: number;
  register(options: { challenge: string; rp: { id?: string } }, origin: string): Promise<any>;
  assert(options: { challenge: string; rpId?: string }, origin: string): Promise<any>;
};

export async function softAuthenticator(): Promise<SoftAuthenticator> {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const credentialRaw = crypto.getRandomValues(new Uint8Array(32));
  const cose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, isoBase64URL.toBuffer(jwk.x!)],
      [-3, isoBase64URL.toBuffer(jwk.y!)],
    ]),
  );
  const clientData = (type: string, challenge: string, origin: string) =>
    new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));

  const auth: SoftAuthenticator = {
    credentialId: b64u(credentialRaw),
    counter: 0,
    async register(options, origin) {
      const rpIdHash = await sha256(new TextEncoder().encode(options.rp.id!));
      const attested = concat(new Uint8Array(16), new Uint8Array([0, credentialRaw.length]), credentialRaw, cose);
      const authData = concat(rpIdHash, new Uint8Array([UP | UV | AT]), u32(auth.counter), attested);
      const attestationObject = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]) as any);
      return {
        id: auth.credentialId,
        rawId: auth.credentialId,
        type: "public-key",
        response: {
          clientDataJSON: b64u(clientData("webauthn.create", options.challenge, origin)),
          attestationObject: b64u(attestationObject),
          transports: ["internal"],
        },
        clientExtensionResults: {},
      };
    },
    async assert(options, origin) {
      auth.counter += 1;
      const rpIdHash = await sha256(new TextEncoder().encode(options.rpId!));
      const authData = concat(rpIdHash, new Uint8Array([UP | UV]), u32(auth.counter));
      const data = clientData("webauthn.get", options.challenge, origin);
      const signed = concat(authData, await sha256(data));
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, signed));
      return {
        id: auth.credentialId,
        rawId: auth.credentialId,
        type: "public-key",
        response: {
          clientDataJSON: b64u(data),
          authenticatorData: b64u(authData),
          signature: b64u(derSignature(raw)),
        },
        clientExtensionResults: {},
      };
    },
  };
  return auth;
}

export async function seedPresence(t: any, userId: string, action: PresenceAction, target: string): Promise<string> {
  const now = Date.now();
  const secret = `seeded-${crypto.randomUUID()}`;
  const grantHash = await sha256Hex(secret);
  const id = await t.run((ctx: any) =>
    ctx.db.insert("passkey_challenges", {
      user_id: userId,
      purpose: "presence",
      action,
      target,
      challenge: "seeded",
      rp_id: "codecast.sh",
      status: "granted",
      grant_hash: grantHash,
      created_at: now,
      expires_at: now + PRESENCE_TTL_MS,
    }),
  );
  return grantString(String(id), secret);
}
