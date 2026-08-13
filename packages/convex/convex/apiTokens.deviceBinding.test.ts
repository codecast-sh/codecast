import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken, verifyApiToken, deviceBindingAllows } from "./apiTokens";

// A token today is bearer authority for a whole account: lift the file off a
// laptop and it works from anywhere. Binding closes that without a migration —
// the field is optional, so every token already in the wild keeps working, and
// only a token that names a device is checked against the device presenting it.
//
// Two properties carry the whole design and both are asserted here: an UNBOUND
// token still authenticates from anywhere (or this change logs everyone out),
// and verifyApiToken performs NO WRITES (or it reintroduces the shared-doc OCC
// stall that once froze the entire write path).

const USER = "u_owner" as any;
const BOUND = "bound-token";
const LEGACY = "legacy-token";
const THIS_DEVICE = "device-aaa";
const OTHER_DEVICE = "device-bbb";

async function tables() {
  return {
    users: [{ _id: USER, name: "Owner" }],
    api_tokens: [
      {
        _id: "tok_bound",
        user_id: USER,
        token_hash: await hashToken(BOUND),
        name: "macbook",
        created_at: 1,
        last_used_at: 1,
        device_id: THIS_DEVICE,
      },
      {
        // No device_id: this is the shape of every token minted before the
        // field existed, and the reason no backfill is needed.
        _id: "tok_legacy",
        user_id: USER,
        token_hash: await hashToken(LEGACY),
        name: "old",
        created_at: 1,
        last_used_at: 1,
      },
    ],
  };
}

function ctx(t: Record<string, any[]>) {
  return { db: makeFakeDb(t) } as any;
}

describe("verifyApiToken honours a device binding", () => {
  test("a bound token authenticates from the device it names", async () => {
    const auth = await verifyApiToken(ctx(await tables()), BOUND, false, THIS_DEVICE);
    expect(auth?.userId).toBe(USER);
  });

  test("a bound token is rejected from another device", async () => {
    const auth = await verifyApiToken(ctx(await tables()), BOUND, false, OTHER_DEVICE);
    expect(auth).toBeNull();
  });

  test("a bound token is rejected when no device is presented at all", async () => {
    // Otherwise the check is opt-out by omission and a thief simply stops
    // sending the field.
    expect(await verifyApiToken(ctx(await tables()), BOUND, false, undefined)).toBeNull();
  });

  test("a legacy token with no binding still authenticates from any device", async () => {
    const t = await tables();
    expect((await verifyApiToken(ctx(t), LEGACY, false, OTHER_DEVICE))?.userId).toBe(USER);
    expect((await verifyApiToken(ctx(t), LEGACY, false, undefined))?.userId).toBe(USER);
  });

  test("an unknown token is still unauthenticated, not a device error", async () => {
    expect(await verifyApiToken(ctx(await tables()), "nope", false, THIS_DEVICE)).toBeNull();
  });

  // The constraint that outranks the feature. verifyApiToken is read-only on
  // purpose: it once patched last_used_at on every authenticated call, and that
  // shared-doc write forced OCC conflicts across every concurrent write until
  // the write path stalled entirely. Binding must be a comparison.
  test("verifying performs no writes", async () => {
    const t = await tables();
    const c = ctx(t);
    await verifyApiToken(c, BOUND, false, THIS_DEVICE);
    await verifyApiToken(c, BOUND, false, OTHER_DEVICE);
    await verifyApiToken(c, LEGACY, false, undefined);
    expect(c.db._patched).toEqual([]);
    expect(c.db._inserted).toEqual([]);
    expect(c.db._replaced).toEqual([]);
    expect(c.db._deleted).toEqual([]);
  });
});

// `cliRoute` runs this once for every CLI endpoint — including /cli/spawn — so a
// new route cannot forget the check. That is the point: the route that gets
// forgotten is always the newest one.
describe("deviceBindingAllows gates every cliRoute", () => {
  const call = (t: Record<string, any[]>, api_token: string, device_id?: string) =>
    (deviceBindingAllows as any)._handler(ctx(t), { api_token, device_id });

  test("a device-bound token presented with another device_id is rejected", async () => {
    expect(await call(await tables(), BOUND, OTHER_DEVICE)).toBe(false);
  });

  test("the same token from its own device is allowed", async () => {
    expect(await call(await tables(), BOUND, THIS_DEVICE)).toBe(true);
  });

  test("a legacy token with no device_id still authenticates", async () => {
    expect(await call(await tables(), LEGACY, OTHER_DEVICE)).toBe(true);
    expect(await call(await tables(), LEGACY, undefined)).toBe(true);
  });

  test("an unknown token is allowed through to fail on authentication instead", async () => {
    // This answers only the device question. Rejecting here would report a bad
    // token as a device mismatch and send the reader down the wrong path.
    expect(await call(await tables(), "nope", THIS_DEVICE)).toBe(true);
  });

  test("the gate performs no writes either", async () => {
    const t = await tables();
    const c = ctx(t);
    await (deviceBindingAllows as any)._handler(c, { api_token: BOUND, device_id: OTHER_DEVICE });
    expect(c.db._patched).toEqual([]);
    expect(c.db._inserted).toEqual([]);
  });
});
