import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken, verifyApiToken, deviceBindingAllows } from "./apiTokens";
import { listDevices } from "./devices";
import { DEVICE_BOUND_TOKEN_PREFIX, presentToken } from "@platform/auth/convex";

// Codecast's twin of the platform suite (@platform/auth apiTokens.deviceBinding
// .test.ts owns the rule and the mint). This one drives the functions THIS
// deployment registers: the internal query cliRoute runs at the HTTP edge, and
// a public query a Convex client can call directly with api_token and nothing
// else. Both doors must refuse a bound token that does not carry its device.

const USER = "u_owner" as any;
const BOUND = `${DEVICE_BOUND_TOKEN_PREFIX}bound-secret`;
const LEGACY = "legacy-token";
const THIS_DEVICE = "device-aaa";
const OTHER_DEVICE = "device-bbb";

async function tables() {
  return {
    users: [{ _id: USER, name: "Owner" }],
    api_tokens: [
      { _id: "tok_bound", user_id: USER, token_hash: await hashToken(BOUND), name: "macbook", created_at: 1, last_used_at: 1, device_id: THIS_DEVICE },
      { _id: "tok_legacy", user_id: USER, token_hash: await hashToken(LEGACY), name: "old", created_at: 1, last_used_at: 1 },
    ],
    devices: [{ _id: "dev_1", user_id: USER, device_id: THIS_DEVICE, label: "macbook", platform: "darwin", last_seen: 1 }],
  };
}

// No browser session: every handler falls through to the token.
const ctx = (t: Record<string, any[]>) => ({ db: makeFakeDb(t), auth: { getUserIdentity: async () => null } }) as any;
const from = (secret: string, device?: string) => (device ? presentToken(secret, device) : secret);
const gate = (c: any, api_token: string) => (deviceBindingAllows as any)._handler(c, { api_token });

type Reply = { status: 403 } | { status: 401 } | { status: 200; userId: string };

// cliRoute (http.ts): gate on api_token as it arrived, strip any device_id body
// field, hand the body to the handler, which authenticates on api_token alone.
async function overHttp(t: Record<string, any[]>, body: { api_token: string; device_id?: string }): Promise<Reply> {
  const c = ctx(t);
  if (!(await gate(c, body.api_token))) return { status: 403 };
  const { device_id: _strippedAtTheEdge, ...forwarded } = body;
  const auth = await verifyApiToken(c, forwarded.api_token);
  return auth ? { status: 200, userId: auth.userId as any } : { status: 401 };
}

// A Convex client calling devices.listDevices directly: the real registered
// handler, which answers the roster for a good token and nothing otherwise.
const direct = (t: Record<string, any[]>, api_token: string) =>
  (listDevices as any)._handler(ctx(t), { api_token }) as Promise<Array<{ device_id: string }>>;

describe("a bound token at the HTTP edge (cliRoute)", () => {
  test("from another machine is a 403", async () => {
    expect(await overHttp(await tables(), { api_token: from(BOUND, OTHER_DEVICE) })).toEqual({ status: 403 });
  });
  test("with no device is a 403, and a device_id body field does not count", async () => {
    expect(await overHttp(await tables(), { api_token: BOUND })).toEqual({ status: 403 });
    expect(await overHttp(await tables(), { api_token: BOUND, device_id: THIS_DEVICE })).toEqual({ status: 403 });
  });
  test("from its own machine authenticates the handler behind the stripped body", async () => {
    expect(await overHttp(await tables(), { api_token: from(BOUND, THIS_DEVICE) })).toEqual({ status: 200, userId: USER });
  });
  test("an unknown token is a 401, never a 403", async () => {
    expect(await overHttp(await tables(), { api_token: from("nope", THIS_DEVICE) })).toEqual({ status: 401 });
  });
});

describe("a bound token on a direct call to a public function (devices.listDevices)", () => {
  test("with no device sees nothing", async () => {
    // The door the HTTP gate never saw. Before the device travelled inside the
    // token, the secret alone opened it.
    expect(await direct(await tables(), BOUND)).toEqual([]);
  });
  test("from another machine sees nothing", async () => {
    expect(await direct(await tables(), from(BOUND, OTHER_DEVICE))).toEqual([]);
  });
  test("from its own machine sees the roster", async () => {
    const rows = await direct(await tables(), from(BOUND, THIS_DEVICE));
    expect(rows.map((r) => r.device_id)).toEqual([THIS_DEVICE]);
  });
});

describe("an unbound token is unchanged on both doors", () => {
  test("authenticates with or without a presented device", async () => {
    const t = await tables();
    expect(await overHttp(t, { api_token: LEGACY })).toEqual({ status: 200, userId: USER });
    expect(await overHttp(t, { api_token: from(LEGACY, OTHER_DEVICE) })).toEqual({ status: 200, userId: USER });
    expect((await direct(t, LEGACY)).length).toBe(1);
    expect((await direct(t, from(LEGACY, OTHER_DEVICE))).length).toBe(1);
  });

  // Token auth is read-only on purpose: patching last_used_at on every call
  // once forced OCC conflicts across every concurrent write. Binding is a comparison.
  test("neither door writes anything", async () => {
    const c = ctx(await tables());
    await gate(c, from(BOUND, OTHER_DEVICE));
    await verifyApiToken(c, from(BOUND, THIS_DEVICE));
    await (listDevices as any)._handler(c, { api_token: BOUND });
    expect(c.db._patched).toEqual([]);
    expect(c.db._inserted).toEqual([]);
    expect(c.db._deleted).toEqual([]);
  });
});
