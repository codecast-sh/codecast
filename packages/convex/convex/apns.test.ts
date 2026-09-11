import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { sendApns, type ApnsSendArgs } from "./apns";
import { APNS_TOKEN_REFRESH_MS, get, retain } from "./apnsProviderToken";

const originalEnv = { ...process.env };
let publicKey: CryptoKey;
let pem: string;
const restores: Array<() => void> = [];

beforeAll(async () => {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  publicKey = keys.publicKey;
  const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(bytes).toString("base64")}\n-----END PRIVATE KEY-----`;
});

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  for (const key of ["APNS_KEY_ID", "APNS_TEAM_ID", "APNS_AUTH_KEY"]) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

function setup() {
  process.env.APNS_KEY_ID = "test-key";
  process.env.APNS_TEAM_ID = "test-team";
  process.env.APNS_AUTH_KEY = pem;
  let now = 1_800_000_000_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  restores.push(() => clock.mockRestore());
  const sent: string[] = [];
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    sent.push(new Headers(init?.headers).get("authorization")!);
    return new Response(null, { status: 200 });
  });
  restores.push(() => fetcher.mockRestore());
  const rows = new Map<string, any>();
  let queued = Promise.resolve();
  const db = {
    query: () => ({
      withIndex: (_index: string, build: (q: any) => unknown) => {
        let key = "";
        build({ eq: (_field: string, value: string) => { key = value; } });
        return { unique: async () => rows.get(key) ?? null };
      },
    }),
    insert: async (_table: string, row: any) => { rows.set(row.key, { _id: row.key, ...row }); return row.key; },
    patch: async (id: string, patch: any) => { Object.assign(rows.get(id), patch); },
  };
  const context = () => ({
    runQuery: async (_ref: unknown, args: any) => (get as any)._handler({ db }, args),
    runMutation: async (_ref: unknown, args: any) => {
      const result = queued.then(() => (retain as any)._handler({ db }, args));
      queued = result.then(() => undefined);
      return result;
    },
  }) as any;
  const args: ApnsSendArgs = {
    token: "test-device", topic: "test-app.push-type.liveactivity", pushType: "liveactivity", priority: 5, payload: { aps: {} },
  };
  return { context, args, rows, sent, advance: (ms: number) => { now += ms; } };
}

describe("APNs provider token reuse", () => {
  test("separate action invocations and push types reuse one valid signed token", async () => {
    const s = setup();
    expect(await sendApns(s.context(), s.args)).toEqual({ ok: true, status: 200 });
    s.advance(60_000);
    await sendApns(s.context(), { ...s.args, pushType: "voip", topic: "test-app.voip" });
    expect(s.sent[1]).toBe(s.sent[0]);
    const [header, claims, signature] = s.sent[0].slice("bearer ".length).split(".");
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({ iss: "test-team", iat: 1_800_000_000 });
    expect(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, publicKey,
      Buffer.from(signature, "base64url"), new TextEncoder().encode(`${header}.${claims}`),
    )).toBe(true);
  });

  test("concurrent cold sends all use the token retained by the first writer", async () => {
    const s = setup();
    await Promise.all(Array.from({ length: 8 }, () => sendApns(s.context(), s.args)));
    expect(s.sent).toHaveLength(8);
    expect(new Set(s.sent).size).toBe(1);
    expect(s.rows.size).toBe(1);
  });

  test("renews after 50 minutes and reuses the renewed token", async () => {
    const s = setup();
    await sendApns(s.context(), s.args);
    s.advance(APNS_TOKEN_REFRESH_MS - 1);
    await sendApns(s.context(), s.args);
    expect(s.sent[1]).toBe(s.sent[0]);
    s.advance(1);
    await Promise.all([sendApns(s.context(), s.args), sendApns(s.context(), s.args)]);
    expect(s.sent[2]).not.toBe(s.sent[0]);
    expect(s.sent[3]).toBe(s.sent[2]);
  });

  test("a rotated signing key gets its own token", async () => {
    const s = setup();
    await sendApns(s.context(), s.args);
    process.env.APNS_KEY_ID = "rotated-key";
    await sendApns(s.context(), s.args);
    expect(s.sent[1]).not.toBe(s.sent[0]);
    expect(s.rows.size).toBe(2);
  });
});
