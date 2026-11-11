// `cast auth` registered requests (F34/F51/F80): the CLI registers its nonce
// with the hash of a verifier before opening the browser. A relayed token goes
// only to a claim carrying that verifier, a registered request takes one fresh
// deposit, the desktop exchange refuses registered nonces, and the Authorize
// page reads the device and network the server recorded. Unregistered nonces
// (older CLIs, the desktop app) keep the legacy relay. Runs the real HTTP
// routes and mutations under convex-test.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "crypto";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { CLI_AUTH_REQUEST_TTL_MS } from "./cliAuth";

setDefaultTimeout(120_000);

const NONCE = "a1".repeat(32);
const VERIFIER = "c3".repeat(32);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function setup() {
  const t = convexTest(schema, allModules);
  const victim = await t.run((ctx) => ctx.db.insert("users", { name: "Vic", email: "vic@corp.dev" } as any));
  const asVictim = t.withIdentity({ subject: `${victim}|session` });
  const post = (path: string, body: unknown, ip = "203.0.113.9") =>
    t.fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    });
  const register = (nonce = NONCE, verifier = VERIFIER) =>
    post("/cli/auth-request", { nonce, verifier_hash: sha(verifier), device_name: "attacker-box" });
  const claim = async (body: Record<string, unknown>) => (await post("/cli/claim-auth", body)).json();
  // What the page does on Authorize: mint, then relay (the localhost POST fails).
  const authorize = async (nonce = NONCE, urlDevice = "Codecast Desktop") => {
    const { token } = await asVictim.mutation(api.apiTokens.createToken, { name: urlDevice });
    await asVictim.mutation(api.cliAuth.deposit, { nonce, token, device_name: urlDevice });
    return token;
  };
  return { t, victim, asVictim, post, register, claim, authorize };
}

describe("registered cast auth requests", () => {
  test("the relayed token goes only to the holder of the verifier", async () => {
    const { victim, register, claim, authorize } = await setup();
    expect((await register()).status).toBe(200);
    const token = await authorize();

    // The nonce alone (a leaked URL) reads as "not yet" and consumes nothing.
    expect(await claim({ nonce: NONCE })).toEqual({ pending: true });
    expect(await claim({ nonce: NONCE, verifier: "d4".repeat(32) })).toEqual({ pending: true });

    expect(await claim({ nonce: NONCE, verifier: VERIFIER })).toEqual({ user_id: victim, auth_token: token });
    // Single use.
    expect(await claim({ nonce: NONCE, verifier: VERIFIER })).toEqual({ pending: true });
  });

  test("the desktop exchange cannot redeem a registered request", async () => {
    const { t, register, authorize } = await setup();
    await register();
    await authorize();
    expect(await t.mutation(internal.cliAuth.claimForDesktop, { nonce: NONCE })).toBeNull();
  });

  test("a registered request takes one deposit, and only while fresh", async () => {
    const { t, register, authorize } = await setup();
    await register();
    await authorize();
    await expect(authorize()).rejects.toThrow(/already used/);

    const other = "e5".repeat(32);
    await register(other);
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("cli_auth_registrations").collect()).find((r) => r.authorized_at === undefined)!;
      await ctx.db.patch(row._id, { created_at: Date.now() - CLI_AUTH_REQUEST_TTL_MS - 1 });
    });
    await expect(authorize(other)).rejects.toThrow(/expired/);
  });

  test("the Authorize page reads the registered device and network, not the URL", async () => {
    const { t, asVictim, register, authorize } = await setup();
    await register();
    const info = await asVictim.query(api.cliAuth.requestInfo, { nonce: NONCE });
    expect(info).toMatchObject({ device_name: "attacker-box", ip: "203.0.113.9", used: false });
    // Signed-out callers learn nothing.
    expect(await t.query(api.cliAuth.requestInfo, { nonce: NONCE })).toBeNull();

    await authorize(NONCE, "Codecast Desktop");
    const relayRow = await t.run(async (ctx) => (await ctx.db.query("cli_auth_requests").first())!);
    expect(relayRow.device_name).toBe("attacker-box");
    expect((await asVictim.query(api.cliAuth.requestInfo, { nonce: NONCE }))?.used).toBe(true);
  });

  test("a nonce registers once, and malformed requests are refused", async () => {
    const { post, register } = await setup();
    expect((await register()).status).toBe(200);
    expect((await register(NONCE, "f6".repeat(32))).status).toBe(400);
    expect((await post("/cli/auth-request", { nonce: "short", verifier_hash: sha(VERIFIER) })).status).toBe(400);
    expect((await post("/cli/auth-request", { nonce: "b2".repeat(32), verifier_hash: "nothex" })).status).toBe(400);
  });

  test("an unregistered nonce keeps the legacy relay for older CLIs", async () => {
    const { victim, claim, authorize } = await setup();
    const token = await authorize();
    expect(await claim({ nonce: NONCE })).toEqual({ user_id: victim, auth_token: token });
  });

  test("the legacy desktop sign-in still redeems an unregistered nonce", async () => {
    const { t, victim, authorize } = await setup();
    await authorize();
    expect(await t.mutation(internal.cliAuth.claimForDesktop, { nonce: NONCE })).toEqual({ userId: victim });
  });

  test("the sweep removes stale registrations", async () => {
    const { t, register } = await setup();
    await register();
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("cli_auth_registrations").first())!;
      await ctx.db.patch(row._id, { created_at: Date.now() - 3 * CLI_AUTH_REQUEST_TTL_MS });
    });
    await t.mutation(internal.cliAuth.sweepExpired, {});
    expect(await t.run((ctx) => ctx.db.query("cli_auth_registrations").collect())).toEqual([]);
  });
});
