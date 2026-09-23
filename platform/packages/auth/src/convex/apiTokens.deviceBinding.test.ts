import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { hashToken, verifyApiToken, exchangeSetupTokenFor, createApiTokenDefinitions } from "./apiTokens";
import { DEVICE_BOUND_TOKEN_PREFIX, isDeviceBoundToken, presentToken, splitPresentedToken } from "../tokenFormat";

// A token used to be bearer authority for a whole account: lift the file off a
// laptop and it works from anywhere. Binding closes that without a migration.
// The row's device_id is optional, so every token already in the wild keeps
// working, and only a token that names a device is checked against the device
// presenting it.
//
// The device travels INSIDE the token (`<secret>.<device_id>`, tokenFormat.ts),
// so the check lives in verifyApiToken and holds on both doors into the
// backend: a direct Convex call, where the ~500 authenticated functions take
// `api_token` and nothing else, and an HTTP route through cliRoute, which
// strips every field its closed validators do not name and forwards api_token
// untouched. The tests below drive both doors through the real functions, not
// the halves separately: the composition is what a thief attacks.

const USER = "u_owner" as any;
const BOUND = `${DEVICE_BOUND_TOKEN_PREFIX}bound-secret`;
const LEGACY = "legacy-token";
const EXPIRED = `${DEVICE_BOUND_TOKEN_PREFIX}expired-secret`;
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

// What a machine puts in `api_token`: the secret alone, or the secret with the
// device it claims to be.
const from = (secret: string, device?: string) => (device ? presentToken(secret, device) : secret);

// The internal query cliRoute runs, from the same definition the app registers.
const gateDef = createApiTokenDefinitions().internalQueries.deviceBindingAllows;
const gate = (c: any, api_token: string) => gateDef.handler(c, { api_token });

type Reply = { status: 403 } | { status: 401 } | { status: 200; userId: string };

// The HTTP door, mirrored from `cliRoute` (http.ts) and the handler behind it
// (spawn.ts `getAuthenticatedUserId`): the edge asks the gate with the
// api_token as it arrived, deletes any stray device_id field because the
// mutations behind these routes validate a closed v.object, and hands the body
// on. The handler then authenticates with api_token alone.
async function overHttp(t: Record<string, any[]>, body: { api_token: string; device_id?: string }): Promise<Reply> {
  const c = ctx(t);
  if (!(await gate(c, body.api_token))) return { status: 403 };
  const { device_id: _strippedAtTheEdge, ...forwarded } = body;
  const auth = await verifyApiToken(c, forwarded.api_token);
  return auth ? { status: 200, userId: auth.userId as any } : { status: 401 };
}

// The direct door: a Convex client calling a public function with api_token.
// Nothing runs ahead of the handler, so this IS the handler's own check.
async function direct(t: Record<string, any[]>, api_token: string): Promise<Reply> {
  const auth = await verifyApiToken(ctx(t), api_token);
  return auth ? { status: 200, userId: auth.userId as any } : { status: 401 };
}

describe("a bound token over the HTTP door (cliRoute then handler)", () => {
  test("from another machine is refused at the edge with a 403", async () => {
    expect(await overHttp(await tables(), { api_token: from(BOUND, OTHER_DEVICE) })).toEqual({ status: 403 });
  });

  test("presented with no device at all is refused", async () => {
    // Otherwise the check is opt-out by omission and a thief simply stops
    // sending the device.
    expect(await overHttp(await tables(), { api_token: BOUND })).toEqual({ status: 403 });
  });

  test("a stray device_id body field is not a presentation", async () => {
    // The device must ride inside the credential. A body field is an argument
    // on the routes that forward it, and the edge deletes it everywhere else,
    // so it cannot be the thing the binding trusts.
    expect(await overHttp(await tables(), { api_token: BOUND, device_id: THIS_DEVICE })).toEqual({ status: 403 });
  });

  test("still works from the machine it names, through both halves", async () => {
    // The regression that matters most: the gate says yes, and then the
    // handler has to say yes too, on a body the edge has already stripped.
    expect(await overHttp(await tables(), { api_token: from(BOUND, THIS_DEVICE) })).toEqual({
      status: 200,
      userId: USER,
    });
  });
});

describe("a bound token over the direct door (a Convex client calling the function)", () => {
  test("from another machine is refused by the handler", async () => {
    expect(await direct(await tables(), from(BOUND, OTHER_DEVICE))).toEqual({ status: 401 });
  });

  test("presented with no device is refused by the handler", async () => {
    // This is the door the HTTP gate never saw. Before the device travelled
    // inside the token, a bound token here was accepted on the secret alone.
    expect(await direct(await tables(), BOUND)).toEqual({ status: 401 });
  });

  test("works from the machine it names", async () => {
    expect(await direct(await tables(), from(BOUND, THIS_DEVICE))).toEqual({ status: 200, userId: USER });
  });
});

describe("tokens that are not bound, on both doors", () => {
  test("a legacy token with no device_id authenticates however it is presented", async () => {
    const t = await tables();
    expect(await overHttp(t, { api_token: LEGACY })).toEqual({ status: 200, userId: USER });
    expect(await overHttp(t, { api_token: from(LEGACY, OTHER_DEVICE) })).toEqual({ status: 200, userId: USER });
    expect(await direct(t, LEGACY)).toEqual({ status: 200, userId: USER });
    expect(await direct(t, from(LEGACY, OTHER_DEVICE))).toEqual({ status: 200, userId: USER });
  });

  test("an unknown token fails authentication, not the device gate", async () => {
    // 401, never 403: reporting a bad token as a device mismatch sends whoever
    // reads the error to the wrong machine.
    expect(await overHttp(await tables(), { api_token: from("nope", THIS_DEVICE) })).toEqual({ status: 401 });
    expect(await direct(await tables(), "nope")).toEqual({ status: 401 });
  });

  test("an expired bound token fails even from its own device", async () => {
    expect(await overHttp(await tables(), { api_token: from(EXPIRED, THIS_DEVICE) })).toEqual({ status: 401 });
    expect(await direct(await tables(), from(EXPIRED, THIS_DEVICE))).toEqual({ status: 401 });
  });
});

describe("the mark on a bound secret cannot be shed", () => {
  test("the stored hash covers the prefix, so the bare secret is another token", async () => {
    const stripped = BOUND.slice(DEVICE_BOUND_TOKEN_PREFIX.length);
    expect(isDeviceBoundToken(stripped)).toBe(false);
    expect(await direct(await tables(), from(stripped, THIS_DEVICE))).toEqual({ status: 401 });
  });

  // The constraint that outranks the feature. Token auth is read-only on
  // purpose: it once patched last_used_at on every authenticated call, and that
  // shared-doc write forced OCC conflicts across every concurrent write until
  // the write path stalled entirely. Binding must stay a comparison.
  test("neither the gate nor the verify writes anything", async () => {
    const t = await tables();
    const c = ctx(t);
    await gate(c, from(BOUND, OTHER_DEVICE));
    await gate(c, LEGACY);
    await verifyApiToken(c, from(BOUND, THIS_DEVICE));
    await verifyApiToken(c, BOUND);
    await verifyApiToken(c, LEGACY);
    expect(c.db._patched).toEqual([]);
    expect(c.db._inserted).toEqual([]);
    expect(c.db._replaced).toEqual([]);
    expect(c.db._deleted).toEqual([]);
  });
});

describe("minting binds only when the machine names itself", () => {
  const signedIn = (t: Record<string, any[]>) =>
    ({ db: makeFakeDb(t), auth: { getUserIdentity: async () => ({ subject: `${USER}|session` }) } }) as any;
  const defs = () => createApiTokenDefinitions({ tables: { apiTokens: "api_tokens", users: "users" } } as any);

  test("the authorize page mint with a device stores it and marks the secret", async () => {
    const t = { users: [{ _id: USER }], api_tokens: [] as any[] };
    const { token } = await defs().mutations.createToken.handler(signedIn(t), { name: "laptop", device_id: THIS_DEVICE });
    expect(isDeviceBoundToken(token)).toBe(true);
    expect(t.api_tokens[0]).toMatchObject({ user_id: USER, name: "laptop", device_id: THIS_DEVICE });
    expect(await direct(t, from(token, THIS_DEVICE))).toEqual({ status: 200, userId: USER });
    expect(await direct(t, token)).toEqual({ status: 401 });
  });

  test("the authorize page mint without a device is unbound, as every older client expects", async () => {
    const t = { users: [{ _id: USER }], api_tokens: [] as any[] };
    const { token } = await defs().mutations.createToken.handler(signedIn(t), { name: "laptop" });
    expect(isDeviceBoundToken(token)).toBe(false);
    expect(t.api_tokens[0].device_id).toBeUndefined();
    expect(await direct(t, token)).toEqual({ status: 200, userId: USER });
  });

  test("a setup token exchange binds the new token to the redeeming machine", async () => {
    const SETUP = "setup-voucher";
    const t = {
      users: [{ _id: USER }],
      api_tokens: [{ _id: "tok_setup", user_id: USER, token_hash: await hashToken(SETUP), name: "setup-1", created_at: 1, last_used_at: 1, expires_at: Date.now() + 60_000 }] as any[],
    };
    const exchanged = await exchangeSetupTokenFor(ctx(t), SETUP, undefined, THIS_DEVICE);
    expect(isDeviceBoundToken(exchanged!.auth_token)).toBe(true);
    expect(t.api_tokens.find((r: any) => r._id !== "tok_setup")?.device_id).toBe(THIS_DEVICE);
    expect(await direct(t, from(exchanged!.auth_token, THIS_DEVICE))).toEqual({ status: 200, userId: USER });
    expect(await direct(t, from(exchanged!.auth_token, OTHER_DEVICE))).toEqual({ status: 401 });
  });

  test("a setup token exchange without a device stays unbound", async () => {
    const SETUP = "setup-voucher";
    const t = {
      users: [{ _id: USER }],
      api_tokens: [{ _id: "tok_setup", user_id: USER, token_hash: await hashToken(SETUP), name: "setup-1", created_at: 1, last_used_at: 1, expires_at: Date.now() + 60_000 }],
    };
    const exchanged = await exchangeSetupTokenFor(ctx(t), SETUP);
    expect(isDeviceBoundToken(exchanged!.auth_token)).toBe(false);
    expect(await direct(t, exchanged!.auth_token)).toEqual({ status: 200, userId: USER });
  });
});

describe("the wire grammar", () => {
  test("a presentation splits back into its secret and device", () => {
    expect(splitPresentedToken(presentToken("bound_abc", "dev1"))).toEqual({ secret: "bound_abc", deviceId: "dev1" });
    expect(splitPresentedToken("bare")).toEqual({ secret: "bare" });
    expect(splitPresentedToken("bound_abc.")).toEqual({ secret: "bound_abc" });
  });
});

describe("setup tokens are exchange vouchers, never bearers", () => {
  test("verifyApiToken refuses a live setup token; exchange still redeems it", async () => {
    const SETUP = "setup-voucher";
    const t = {
      users: [{ _id: USER, name: "Owner" }],
      api_tokens: [{ _id: "tok_setup", user_id: USER, token_hash: await hashToken(SETUP), name: "setup-1", created_at: 1, last_used_at: 1, expires_at: Date.now() + 60_000 }],
    };
    const c = ctx(t);
    expect(await verifyApiToken(c, SETUP)).toBeNull();
    const exchanged = await exchangeSetupTokenFor(c, SETUP);
    expect(exchanged?.user_id).toBe(USER);
    expect(await verifyApiToken(c, exchanged!.auth_token)).toMatchObject({ userId: USER });
    expect(await exchangeSetupTokenFor(c, SETUP)).toBeNull();
  });

  test("a rename never moves a token across the setup prefix", async () => {
    const t = {
      users: [{ _id: USER, name: "Owner" }],
      api_tokens: [
        { _id: "tok_setup", user_id: USER, token_hash: "h1", name: "setup-1", created_at: 1, last_used_at: 1, expires_at: Date.now() + 60_000 },
        { _id: "tok_cli", user_id: USER, token_hash: "h2", name: "CLI - 2026-09-01", created_at: 1, last_used_at: 1 },
      ],
    };
    const c = { db: makeFakeDb(t), auth: { getUserIdentity: async () => ({ subject: `${USER}|session` }) } } as any;
    const { renameToken } = createApiTokenDefinitions({ tables: { apiTokens: "api_tokens", users: "users" } } as any).mutations;
    await expect(renameToken.handler(c, { token_id: "tok_setup", name: "laptop" })).rejects.toThrow("cannot be renamed");
    await expect(renameToken.handler(c, { token_id: "tok_cli", name: "setup-2" })).rejects.toThrow("cannot be renamed");
    await renameToken.handler(c, { token_id: "tok_cli", name: "laptop" });
    expect(t.api_tokens[1].name).toBe("laptop");
  });
});
