// Device keys (deviceKeys.ts): a P-256 key the desktop app or the phone holds
// signs challenges directly. It sets up by signing its register challenge,
// answers a presence challenge with a grant the gate spends like a passkey's,
// stays out of WebAuthn options, and is refused for a wrong signature, another
// account, a stale purpose or a caller signed out. Pending challenges are
// listed for the person's other devices.
import { expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { deviceKeyMessage } from "@codecast/shared/contracts/secrets";

setDefaultTimeout(60_000);

const api = anyApi as any;
const ORIGIN = "https://codecast.sh";

async function seed() {
  const t = convexTest(schema, allModules);
  const [ana, ben] = await t.run(async (ctx) => [
    String(await ctx.db.insert("users", { name: "Ana", email: "ana@example.com" } as any)),
    String(await ctx.db.insert("users", { name: "Ben", email: "ben@example.com" } as any)),
  ]);
  const as = (u: string) => t.withIdentity({ subject: `${u}|test` });
  return { t, ana, ben, as };
}

async function deviceKey() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = isoBase64URL.fromBuffer(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const sign = async (purpose: "register" | "presence", challenge: string) =>
    isoBase64URL.fromBuffer(
      new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(deviceKeyMessage(purpose, challenge)))),
    );
  return { publicKey, sign };
}

async function setUp(as: any, key: Awaited<ReturnType<typeof deviceKey>>, grant?: string) {
  const begun = await as.action(api.passkeys.registrationBegin, { origin: ORIGIN, grant, from: "MacBook-Pro-2" });
  if (begun.error) return begun;
  return await as.action(api.deviceKeys.register, {
    challenge_id: begun.challenge_id,
    public_key: key.publicKey,
    signature: await key.sign("register", begun.options.challenge),
    name: "Codecast app on MacBook-Pro-2",
  });
}

test("a device key sets up by signing its challenge, and its grant passes the gate once", async () => {
  const { t, ana, as } = await seed();
  const key = await deviceKey();
  const stored = await setUp(as(ana), key);
  expect(stored.first).toBe(true);
  const list = await as(ana).query(api.passkeys.list, {});
  expect(list[0].device_key).toBe(stored.credential_id);

  const begun = await as(ana).action(api.passkeys.presenceBegin, { action: "add_passkey", origin: ORIGIN });
  expect(begun.device_keys).toEqual([stored.credential_id]);
  expect(begun.webauthn).toBe(false);
  expect(begun.options.allowCredentials).toEqual([]);
  const finished = await as(ana).action(api.deviceKeys.confirm, {
    challenge_id: begun.challenge_id,
    credential_id: stored.credential_id,
    signature: await key.sign("presence", begun.options.challenge),
  });
  expect(finished.granted).toBe(true);
  // The grant is a real add_passkey grant: a second credential spends it.
  const second = await setUp(as(ana), await deviceKey(), begun.grant);
  expect(second.first).toBe(false);
  expect(await setUp(as(ana), await deviceKey(), begun.grant)).toHaveProperty("error");
});

test("a wrong signature, a register signature on presence, another account and a signed-out caller are refused", async () => {
  const { t, ana, ben, as } = await seed();
  const key = await deviceKey();
  const stored = await setUp(as(ana), key);
  const begun = await as(ana).action(api.passkeys.presenceBegin, { action: "add_passkey", origin: ORIGIN });
  const args = (signature: string) => ({ challenge_id: begun.challenge_id, credential_id: stored.credential_id, signature });

  const other = await deviceKey();
  expect(await as(ana).action(api.deviceKeys.confirm, args(await other.sign("presence", begun.options.challenge)))).toHaveProperty("error");
  expect(await as(ana).action(api.deviceKeys.confirm, args(await key.sign("register", begun.options.challenge)))).toHaveProperty("error");
  const good = args(await key.sign("presence", begun.options.challenge));
  expect(await as(ben).action(api.deviceKeys.confirm, good)).toHaveProperty("error");
  expect(await t.action(api.deviceKeys.confirm, good)).toHaveProperty("error");
  expect((await as(ana).action(api.deviceKeys.confirm, good)).granted).toBe(true);
  // Used once.
  expect(await as(ana).action(api.deviceKeys.confirm, good)).toHaveProperty("error");
});

test("pending presence challenges are listed for the person's other devices with the asker's device, never another person's", async () => {
  const { ana, ben, as } = await seed();
  const key = await deviceKey();
  await setUp(as(ana), key);
  const begun = await as(ana).action(api.passkeys.presenceBegin, { action: "add_passkey", origin: ORIGIN, from: "MacBook-Pro-2" });
  const waiting = await as(ana).query(api.passkeys.waiting, {});
  expect(waiting).toHaveLength(1);
  expect(waiting[0]).toMatchObject({ challenge_id: begun.challenge_id, action: "add_passkey", from: "MacBook-Pro-2" });
  expect(waiting[0]).not.toHaveProperty("grant");
  expect(await as(ben).query(api.passkeys.waiting, {})).toEqual([]);
});
