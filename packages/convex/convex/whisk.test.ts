// Connecting mail and calendar through Whisk (convex/whisk.ts) under
// convex-test, with Whisk faked at fetch: the connect URL, the return's state
// binding to the signed-in person, the server-side code exchange, the token
// sealed at rest, a reconnect, and a disconnect that ends the token at Whisk.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { allModules as modules } from "./testModules.testkit";
import schema from "./schema";
import { signStateWith, verifyStateWith } from "./lib/hmac";
import { openWhiskToken, whiskConnectUrl } from "./whisk";
import { WHISK_PROVIDER } from "./lib/whisk";

setDefaultTimeout(120_000);

const whisk = (anyApi as any).whisk;
const SECRET = "whisk-app-secret";
const ENV = {
  WHISK_APP_SECRET_CODECAST: SECRET,
  WHISK_CONVEX_URL: "https://fox.convex.cloud",
  SITE_URL: "https://codecast.sh",
};

type Seen = { url: string; body: any };
let seen: Seen[] = [];
let exchange: (body: any) => { status: number; json: unknown } = () => ({ status: 500, json: {} });
const realFetch = globalThis.fetch;
const before: Record<string, string | undefined> = {};

beforeEach(() => {
  seen = [];
  for (const [key, value] of Object.entries(ENV)) {
    before[key] = process.env[key];
    process.env[key] = value;
  }
  // Whisk, faked: the code exchange on its site host, and its functions.
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ url, body });
    if (url === "https://fox.convex.site/apps/token") {
      const out = exchange(body);
      return new Response(JSON.stringify(out.json), { status: out.status });
    }
    if (url.startsWith("https://fox.convex.cloud/api/")) {
      const value = body.path === "sync:getAccount" ? { accounts: [{ email: "me@example.com" }, { email: "me@work.example" }] } : { disconnected: true };
      return new Response(JSON.stringify({ status: "success", value }));
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [key, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const granted = (token: string) => () => ({
  status: 200,
  json: { token, user_id: "whisk-user-1", email: "me@example.com", scopes: ["mail.read", "mail.draft", "mail.send", "mail.organize", "calendar.read", "calendar.write"], connection_id: "conn-1" },
});

async function setup() {
  const t = convexTest(schema, modules);
  const me = await t.run((ctx) => ctx.db.insert("users", {}));
  const other = await t.run((ctx) => ctx.db.insert("users", {}));
  return { t, me, other, as: (user: string) => t.withIdentity({ subject: user }) };
}

const stateFor = (user: string, return_to = "/welcome", ts = Date.now()) => signStateWith(SECRET, { user_id: user, ts, return_to });
const rows = (t: Awaited<ReturnType<typeof setup>>["t"]) => t.run((ctx) => ctx.db.query("app_installations").collect());

describe("connect", () => {
  test("the connect URL goes to Whisk's connect page, returns to codecast, and carries a state naming the person", async () => {
    const { me, as } = await setup();
    const res = await as(me).action(whisk.getConnectUrl, { return_to: "/simple/connections" });
    expect(res.ok).toBe(true);
    const url = new URL(res.url);
    expect(`${url.origin}${url.pathname}`).toBe("https://whisk.email/connect");
    expect(url.searchParams.get("app")).toBe("codecast");
    expect(url.searchParams.get("return")).toBe("https://codecast.sh/connect/whisk");
    expect(await verifyStateWith(SECRET, url.searchParams.get("state")!)).toMatchObject({ user_id: me, return_to: "/simple/connections" });
    expect(whiskConnectUrl("https://whisk.email", "https://codecast.sh/connect/whisk", "s")).toBe(
      "https://whisk.email/connect?app=codecast&return=https%3A%2F%2Fcodecast.sh%2Fconnect%2Fwhisk&state=s",
    );
  });

  test("signed out, an unknown landing page, or no Whisk settings: no URL", async () => {
    const { t, me, as } = await setup();
    expect(await t.action(whisk.getConnectUrl, {})).toEqual({ ok: false, error: "signed_out" });
    expect((await as(me).action(whisk.getConnectUrl, { return_to: "/evil" })).ok).toBe(false);
    delete process.env.WHISK_CONVEX_URL;
    expect(await as(me).action(whisk.getConnectUrl, {})).toEqual({ ok: false, error: "whisk_not_configured" });
    expect(await t.query(whisk.connectAvailable, {})).toBe(false);
  });

  test("the return trades the code server to server and stores the token sealed, never in the clear", async () => {
    const { t, me, as } = await setup();
    exchange = granted("app-token-1");
    const res = await as(me).action(whisk.finishConnect, { state: await stateFor(me), code: "one-time" });
    expect(res).toEqual({ return_to: "/welcome", ok: true });
    expect(seen[0]).toEqual({ url: "https://fox.convex.site/apps/token", body: { app_id: "codecast", app_secret: SECRET, code: "one-time" } });
    const [row] = await rows(t);
    expect(row).toMatchObject({ provider: WHISK_PROVIDER, scope_user_id: me, account_label: "me@example.com", account_id: "whisk-user-1", config: { mailboxes: "me@example.com,me@work.example" } });
    expect(JSON.stringify(row)).not.toContain("app-token-1");
    expect(await openWhiskToken(row.access_token_enc, SECRET)).toBe("app-token-1");
    expect(await as(me).query(whisk.connection, {})).toMatchObject({
      connected: true,
      email: "me@example.com",
      mailboxes: ["me@example.com", "me@work.example"],
      can: { read_mail: true, modify_mail: true, send_mail: true, calendar: true },
    });
  });

  test("a return finished by someone other than the person the state names stores nothing and spends no code", async () => {
    const { t, me, other, as } = await setup();
    exchange = granted("stolen");
    expect(await as(other).action(whisk.finishConnect, { state: await stateFor(me), code: "c" })).toEqual({ return_to: "/welcome", ok: false, reason: "wrong_user" });
    expect(seen).toEqual([]);
    expect(await rows(t)).toEqual([]);
  });

  test("a forged, expired or missing state, a decline, or a refused code each say why and store nothing", async () => {
    const { t, me, as } = await setup();
    const forged = await signStateWith("not-the-secret", { user_id: me, ts: Date.now(), return_to: "/welcome" });
    expect(await as(me).action(whisk.finishConnect, { state: forged, code: "c" })).toMatchObject({ ok: false, reason: "bad_state", return_to: "/simple/connections" });
    const stale = await stateFor(me, "/welcome", Date.now() - 31 * 60_000);
    expect(await as(me).action(whisk.finishConnect, { state: stale, code: "c" })).toMatchObject({ ok: false, reason: "bad_state" });
    expect(await as(me).action(whisk.finishConnect, { code: "c" })).toMatchObject({ ok: false, reason: "bad_state" });
    expect(await as(me).action(whisk.finishConnect, { state: await stateFor(me), error: "access_denied" })).toEqual({ return_to: "/welcome", ok: false, reason: "access_denied" });
    exchange = () => ({ status: 400, json: { error: "invalid_grant" } });
    expect(await as(me).action(whisk.finishConnect, { state: await stateFor(me), code: "spent" })).toMatchObject({ ok: false, reason: "whisk_invalid_grant" });
    expect(await rows(t)).toEqual([]);
  });

  test("a reconnect replaces the row whole and ends the earlier token at Whisk", async () => {
    const { t, me, as } = await setup();
    exchange = granted("first");
    await as(me).action(whisk.finishConnect, { state: await stateFor(me), code: "a" });
    seen = [];
    exchange = granted("second");
    await as(me).action(whisk.finishConnect, { state: await stateFor(me), code: "b" });
    const all = await rows(t);
    expect(all).toHaveLength(1);
    expect(await openWhiskToken(all[0].access_token_enc, SECRET)).toBe("second");
    expect(seen.filter((s) => s.body?.path === "connect:disconnect").map((s) => s.body.args.token)).toEqual(["first"]);
  });
});

describe("disconnect", () => {
  test("the row goes, and the token is ended at Whisk", async () => {
    const { t, me, as } = await setup();
    exchange = granted("tok");
    await as(me).action(whisk.finishConnect, { state: await stateFor(me), code: "a" });
    seen = [];
    expect(await as(me).action(whisk.disconnect, {})).toEqual({ ok: true });
    expect(await rows(t)).toEqual([]);
    expect(seen).toEqual([{ url: "https://fox.convex.cloud/api/mutation", body: { path: "connect:disconnect", args: { token: "tok" }, format: "json" } }]);
    expect(await as(me).query(whisk.connection, {})).toEqual({ connected: false, whisk_url: "https://whisk.email" });
    expect(await t.query(whisk.connection, {})).toBeNull();
  });
});
