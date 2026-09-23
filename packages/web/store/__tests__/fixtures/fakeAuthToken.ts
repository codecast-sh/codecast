// An unsigned token shaped like Convex Auth's (`sub` is `<user>|<session>`,
// RS256 header, `aud` convex). The client parses the principal out of it
// without verifying; the server is what authorizes anything.
import { AUTH_JWT_STORAGE_KEY } from "../../../lib/localAuth";

export { AUTH_JWT_STORAGE_KEY };

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function issueFakeToken(principalId: string, sessionId = "s1"): string {
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ sub: `${principalId}|${sessionId}`, iss: "https://fake.convex.site", aud: "convex", iat: 1, exp: 2 })}.sig`;
}

/** A Map-backed Storage for tests with no DOM. */
export function mapStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => { m.clear(); },
  } as Storage;
}
