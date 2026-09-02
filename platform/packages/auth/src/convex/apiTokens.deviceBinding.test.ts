import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken, verifyApiToken, deviceBindingAllows } from "./apiTokens";

// A token today is bearer authority for a whole account: lift the file off a
// laptop and it works from anywhere. Binding closes that without a migration —
// the field is optional, so every token already in the wild keeps working, and
// only a token that names a device is checked against the device presenting it.
//
// The tests below drive the REQUEST PATH, not the two halves separately. That
// distinction is the point: a bound token has to clear the gate at the edge AND
// the handler's own authentication, and those two halves see different bodies
// because the edge strips device_id on the way through. Asserting each half
// alone passed while the composition rejected every bound token.

const USER = "u_owner" as any;
const BOUND = "bound-token";
const LEGACY = "legacy-token";
const EXPIRED = "expired-token";
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
      {
        _id: "tok_expired",
        user_id: USER,
        token_hash: await hashToken(EXPIRED),
        name: "stale",
        created_at: 1,
        last_used_at: 1,
        expires_at: 2,
        device_id: THIS_DEVICE,
      },
    ],
  };
}

function ctx(t: Record<string, any[]>) {
  return { db: makeFakeDb(t) } as any;
}

const gate = (c: any, api_token: string, device_id?: string) =>
  deviceBindingAllows(c, { api_token, device_id });

type Reply = { status: 403 } | { status: 401 } | { status: 200; userId: string };

// The real path a CLI request takes, mirrored from codecast`s `cliRoute` (http.ts) and the
// handler behind it (spawn.ts `getAuthenticatedUserId`). Two facts about it
// decide whether binding works at all: the edge asks the gate with the device
// the client sent, and it then DELETES device_id before the body reaches the
// handler, because the mutations behind these routes validate a closed v.object
// and reject an unrecognised field. So the handler authenticates with the token
// alone — it has no device to present.
async function cliSpawn(
  t: Record<string, any[]>,
  body: { api_token: string; device_id?: string },
): Promise<Reply> {
  const c = ctx(t);
  const allowed = await gate(
    c,
    body.api_token,
    typeof body.device_id === "string" ? body.device_id : undefined,
  );
  if (!allowed) return { status: 403 };

  const { device_id: _strippedAtTheEdge, ...forwarded } = body;
  const auth = await verifyApiToken(c, forwarded.api_token);
  return auth ? { status: 200, userId: auth.userId as any } : { status: 401 };
}

describe("device binding over the whole /cli/spawn request path", () => {
  test("a device-bound token presented with another device_id is rejected on /cli/spawn", async () => {
    expect(await cliSpawn(await tables(), { api_token: BOUND, device_id: OTHER_DEVICE })).toEqual({
      status: 403,
    });
  });

  test("a device-bound token presented with no device_id at all is rejected", async () => {
    // Otherwise the check is opt-out by omission and a thief simply stops
    // sending the field.
    expect(await cliSpawn(await tables(), { api_token: BOUND })).toEqual({ status: 403 });
  });

  test("a device-bound token still works from the machine it names", async () => {
    // The regression that matters most: the gate says yes, and then the handler
    // has to say yes too, on a body the edge has already stripped. A binding
    // check inside the handler's own auth sees "no device" here and locks the
    // owner out of their own CLI.
    expect(await cliSpawn(await tables(), { api_token: BOUND, device_id: THIS_DEVICE })).toEqual({
      status: 200,
      userId: USER,
    });
  });

  test("a legacy token with no device_id still authenticates", async () => {
    const t = await tables();
    expect(await cliSpawn(t, { api_token: LEGACY, device_id: OTHER_DEVICE })).toEqual({
      status: 200,
      userId: USER,
    });
    expect(await cliSpawn(t, { api_token: LEGACY })).toEqual({ status: 200, userId: USER });
  });

  test("an unknown token fails authentication, not the device gate", async () => {
    // 401, never 403: reporting a bad token as a device mismatch sends whoever
    // reads the error to the wrong machine.
    expect(await cliSpawn(await tables(), { api_token: "nope", device_id: THIS_DEVICE })).toEqual({
      status: 401,
    });
  });

  test("an expired bound token fails even from its own device", async () => {
    expect(await cliSpawn(await tables(), { api_token: EXPIRED, device_id: THIS_DEVICE })).toEqual({
      status: 401,
    });
  });
});

describe("the gate is the only place the binding is checked", () => {
  test("verifyApiToken accepts a bound token, because the edge already decided", async () => {
    // A fence, not a redundancy: re-adding a device check inside this function
    // rejects every bound token, since no caller here is given a device.
    const auth = await verifyApiToken(ctx(await tables()), BOUND);
    expect(auth?.userId).toBe(USER);
  });

  test("an unknown token passes the gate, to be refused by authentication", async () => {
    expect(await gate(ctx(await tables()), "nope", THIS_DEVICE)).toBe(true);
  });

  // The constraint that outranks the feature. Token auth is read-only on
  // purpose: it once patched last_used_at on every authenticated call, and that
  // shared-doc write forced OCC conflicts across every concurrent write until
  // the write path stalled entirely. Binding must stay a comparison.
  test("neither the gate nor the verify writes anything", async () => {
    const t = await tables();
    const c = ctx(t);
    await gate(c, BOUND, OTHER_DEVICE);
    await gate(c, LEGACY, undefined);
    await verifyApiToken(c, BOUND);
    await verifyApiToken(c, LEGACY);
    expect(c.db._patched).toEqual([]);
    expect(c.db._inserted).toEqual([]);
    expect(c.db._replaced).toEqual([]);
    expect(c.db._deleted).toEqual([]);
  });
});
