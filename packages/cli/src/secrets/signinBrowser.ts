// Saved sign-ins meet the agent browser (docs/architecture/vault.md "Saved
// sign-ins"): reading a site's cookies and localStorage out of it for
// `cast vault save-signin`, and on `cast browser open` putting a saved
// sign-in back in, then writing the browser's newer cookies back so the saved
// session stays alive. The decisions live in signin.ts; this is the CDP.
//
// localStorage has to be in place before the site's own script reads it, and
// CDP's DOMStorage domain only reaches an origin some frame already shows. So
// a scratch tab opens `<origin>/__cast_vault__`, Fetch answers that request
// with an empty page (nothing reaches the site, no cookie is sent), and the
// storage is read or written there, under the site's origin, before the real
// page loads.
//
// Values travel over the browser's loopback CDP socket and the HTTPS call to
// the backend, nowhere else: no line printed here names a cookie or a value.

import * as fs from "node:fs";
import * as path from "node:path";
import { browserCookies, localCookiesForHost } from "../browser/credentials.js";
import { CdpConnection, listTargetsVia, type CdpClient } from "../browser/cdp.js";
import { readState } from "../browser/instance.js";
import { keepsOwnLogin, listRealProfiles, chromeUserDataRoot } from "../browser/profile.js";
import { pickLaptopProfile } from "../cloud/browserSync.js";
import { cliFetch } from "../cliHttp.js";
import { defaultConfigDir } from "../config/configDir.js";
import { bearerFromStored } from "../bearerToken.js";
import { isRemoteDevice } from "../remote/device.js";
import type { SecretMeta, SecretNeedsApproval, SigninCookie, SigninPayload } from "@codecast/shared/contracts/secrets";
import { exitForApproval, isNeedsApproval } from "./approval.js";
import {
  accountHint,
  aliveCookies,
  boundedStorage,
  inSiteScope,
  jarIsNewer,
  needsSignin,
  pickSignin,
  readSigninState,
  rememberJar,
  signinSite,
  stillSignedIn,
  writeBackJar,
  writeSigninMemory,
} from "./signin.js";

type Storage = Record<string, Record<string, string>>;
/** A browser socket; a test stands in for Chrome with its own. */
export type BrowserConn = CdpClient;
export type Captured = { cookies: SigninCookie[]; local_storage?: Storage; account_hint?: string } | { error: string };

const SCRATCH_PATH = "/__cast_vault__";
const SCRATCH_PAGE = "<!doctype html><title>cast vault</title>";

// ── localStorage through a scratch document ─────────────────────────────────

async function withOriginDocument<T>(conn: BrowserConn, origin: string, fn: (evaluate: (expression: string) => Promise<any>) => Promise<T>): Promise<T> {
  const { targetId } = await conn.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", background: true }, undefined, 8_000);
  try {
    const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, undefined, 8_000);
    const url = `${origin}${SCRATCH_PATH}`;
    await conn.send("Fetch.enable", { patterns: [{ urlPattern: `${url}*` }] }, sessionId, 5_000);
    const off = conn.on((ev) => {
      if (ev.sessionId !== sessionId || ev.method !== "Fetch.requestPaused") return;
      void conn
        .send("Fetch.fulfillRequest", {
          requestId: ev.params.requestId,
          responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "text/html" }],
          body: Buffer.from(SCRATCH_PAGE).toString("base64"),
        }, sessionId, 5_000)
        .catch(() => {});
    });
    const evaluate = async (expression: string) =>
      (await conn.send<any>("Runtime.evaluate", { expression, returnByValue: true }, sessionId, 5_000)).result?.value;
    try {
      await conn.send("Page.navigate", { url }, sessionId, 10_000);
      for (let i = 0; i < 50; i++) {
        if ((await evaluate("location.origin + ' ' + document.readyState").catch(() => "")) === `${origin} complete`) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return await fn(evaluate);
    } finally {
      off();
    }
  } finally {
    await conn.send("Target.closeTarget", { targetId }, undefined, 5_000).catch(() => {});
  }
}

const READ_STORAGE = "JSON.stringify(Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])))";

async function readOriginStorage(conn: BrowserConn, origin: string): Promise<Record<string, string>> {
  try {
    return JSON.parse((await withOriginDocument(conn, origin, (evaluate) => evaluate(READ_STORAGE))) || "{}");
  } catch {
    return {};
  }
}

async function writeOriginStorage(conn: BrowserConn, origin: string, items: Record<string, string>): Promise<void> {
  const expression = `(() => { const items = ${JSON.stringify(items)}; for (const k of Object.keys(items)) localStorage.setItem(k, items[k]); return true; })()`;
  await withOriginDocument(conn, origin, (evaluate) => evaluate(expression));
}

/** The origins whose storage belongs to the sign-in: the site's own, and any covered origin a tab shows now. */
async function siteOrigins(conn: BrowserConn, sites: string[]): Promise<string[]> {
  const origins = new Set(sites.map((s) => `https://${s}`));
  for (const t of await listTargetsVia(conn).catch(() => [])) {
    try {
      const u = new URL(t.url);
      if ((u.protocol === "https:" || u.protocol === "http:") && inSiteScope(u.hostname, sites)) origins.add(u.origin);
    } catch { /* about:blank and friends */ }
  }
  return [...origins];
}

async function captureJar(conn: BrowserConn, sites: string[]): Promise<{ cookies: SigninCookie[]; local_storage?: Storage }> {
  const cookies = aliveCookies((await browserCookies(conn)).filter((c) => inSiteScope(c.domain, sites)), Date.now());
  const raw: Storage = {};
  for (const origin of await siteOrigins(conn, sites)) raw[origin] = await readOriginStorage(conn, origin);
  const local_storage = boundedStorage(raw);
  return { cookies, ...(local_storage ? { local_storage } : {}) };
}

// ── Capture ──────────────────────────────────────────────────────────────────

/** The site's sign-in as the agent browser on this machine holds it. */
export async function captureFromAgentBrowser(host: string): Promise<Captured> {
  const state = readState();
  const signIn = `sign in to ${host} in the agent browser (cast browser login ${host}), then run this again`;
  if (!state?.port) return { error: `No agent browser is running here: ${signIn}` };
  let conn: CdpConnection;
  try {
    conn = await CdpConnection.fromPort(state.port, 5_000);
  } catch {
    return { error: `The agent browser is not answering: ${signIn}` };
  }
  try {
    const jar = await captureJar(conn, [host]);
    if (!jar.cookies.length) return { error: `The agent browser has no cookies for ${host}: ${signIn}` };
    const hint = accountHint(jar.cookies);
    return { ...jar, ...(hint ? { account_hint: hint } : {}) };
  } finally {
    conn.close();
  }
}

/** The site's sign-in out of the person's own Chrome on this laptop: its cookies (Chrome keeps localStorage where we can't read it). */
export function captureFromChrome(host: string): Captured {
  if (isRemoteDevice()) return { error: "This is a cloud host, which has no Chrome of the person's: save the sign-in from a laptop" };
  const state = readState();
  const source = pickLaptopProfile(state, state?.sourceProfile ? [] : listRealProfiles("chrome"));
  const root = chromeUserDataRoot(source.channel);
  if (!root) return { error: "No Chrome profile on this machine: sign in through the agent browser instead (cast vault save-signin <site>)" };
  const read = localCookiesForHost(root, host, source.profileDir);
  if (read.reason) {
    return {
      error: /Keychain/.test(read.reason)
        ? "Chrome's cookies are locked behind the login Keychain on this Mac: run cast vault save-signin " + host + " --from-chrome once in a terminal there and click Always Allow"
        : `Chrome's cookies could not be read: ${read.reason}`,
    };
  }
  const cookies = read.cookies.filter((c) => inSiteScope(c.domain, [host]));
  if (!cookies.length) return { error: `Chrome on this machine is not signed in to ${host} (profile ${source.profileDir}): sign in there, then save again` };
  const hint = accountHint(cookies);
  return { cookies, ...(hint ? { account_hint: hint } : {}) };
}

// ── Use on open ──────────────────────────────────────────────────────────────

type Endpoint = { siteUrl: string; apiToken: string };

/** This machine's backend and token, or null when it is signed out. Never exits: `open` goes on either way. */
export function cliEndpoint(): Endpoint | null {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(defaultConfigDir(), "config.json"), "utf-8"));
    if (!cfg.auth_token || !cfg.convex_url) return null;
    return { siteUrl: cfg.convex_url.replace(".cloud", ".site"), apiToken: bearerFromStored(cfg.auth_token) };
  } catch {
    return null;
  }
}

/** A /cli/vault call with a short leash: `open` must not wait 45s on a slow backend. Throws the server's sentence. */
async function vaultPost(ep: Endpoint, route: string, body: Record<string, unknown>, timeoutMs = 8_000): Promise<any> {
  const res = await cliFetch(`${ep.siteUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_token: ep.apiToken, ...body }),
  }, { timeoutMs });
  const out = await res.json().catch(() => ({ error: `HTTP ${res.status} from ${route}` }));
  if (out?.error) throw new Error(String(out.error));
  return out;
}

export type SigninUseDeps = {
  /** The managed browser's CDP port. */
  port: number;
  endpoint?: () => Endpoint | null;
  /** The calling session, named in the audit trail. */
  conversation: () => string | null;
  log: (line: string) => void;
  now?: () => number;
  connect?: (port: number) => Promise<BrowserConn>;
  /** Where this machine's sign-in memory lives (signin.ts); tests point it elsewhere. */
  stateFile?: string;
};

/**
 * Before `open` navigates: when a saved sign-in the caller can read covers the
 * host and the agent browser is not signed in there, put the saved cookies and
 * localStorage in; when it is signed in with cookies newer than the ones this
 * machine last wrote, write them back. A courtesy like the Chrome carry: it
 * never fails the open, and it says one quiet line when it did something.
 * The one exception is Ask first: a read held for a person's approval is
 * returned, and the open stops there.
 *
 * A write-back names the row's updated_at this machine last saw. When the
 * saved jar moved on since (a person saved it again, another browser wrote
 * back), the write is refused; the saved jar is read again and the browser's
 * goes back only if it is still the newer session, else the browser takes the
 * saved one.
 *
 * The site policy already allowed the URL (runVerb refuses first), and the
 * cookies set are only the sign-in's own site's. Nothing here reads a
 * Keychain, so a cloud host runs it unchanged: the sign-in comes from the
 * backend.
 */
export async function useVaultSignin(rawUrl: string, deps: SigninUseDeps): Promise<SecretNeedsApproval | void> {
  const host = signinSite(rawUrl);
  if (!host || keepsOwnLogin(host)) return;
  const ep = (deps.endpoint ?? cliEndpoint)();
  if (!ep) return;
  const now = deps.now ?? Date.now;
  let rows: SecretMeta[];
  try {
    rows = await vaultPost(ep, "/cli/vault/list", {});
  } catch {
    return;
  }
  const meta = pickSignin(rows, host);
  if (!meta) return;
  const ref = meta.short_id || meta._id;
  const sites = meta.sites?.length ? meta.sites : [host];
  const remember = (cookies: SigninCookie[], from: SigninPayload, updatedAt?: number) =>
    writeSigninMemory(meta._id, rememberJar(meta.name, cookies, from, now(), updatedAt), deps.stateFile);
  let held: SecretNeedsApproval | undefined;
  /** The saved jar with the row's updated_at; undefined when there is none, or Ask first holds the read (`held`). */
  const readSaved = async (): Promise<{ payload: SigninPayload; updated_at?: number } | undefined> => {
    const conversation = deps.conversation();
    const res = await vaultPost(ep, "/cli/vault/read", { refs: [ref], purpose: "signin", ...(conversation ? { conversation } : {}) });
    if (isNeedsApproval(res)) held = res;
    const saved = res.secrets?.[0];
    return saved?.payload?.cookies?.length ? saved : undefined;
  };
  let conn: BrowserConn | null = null;
  try {
    conn = await (deps.connect ?? ((port) => CdpConnection.fromPort(port, 5_000)))(deps.port);
    const browser = conn;
    const putIn = async (saved: SigninPayload, cookies: SigninCookie[]) => {
      await browser.send("Storage.setCookies", { cookies }, undefined, 10_000);
      for (const [origin, items] of Object.entries(saved.local_storage ?? {})) await writeOriginStorage(browser, origin, items);
    };
    const present = (await browserCookies(conn)).filter((c) => inSiteScope(c.domain, sites));
    const memory = readSigninState(deps.stateFile)[meta._id];

    if (memory && stillSignedIn(memory, present)) {
      const fresh = writeBackJar(memory, aliveCookies(present, now()), now());
      if (!fresh) return;
      const jar = await captureJar(conn, sites);
      const payload: SigninPayload = { cookies: jar.cookies, captured_from: memory.captured_from, ...(jar.local_storage ? { local_storage: jar.local_storage } : {}), ...(memory.account_hint ? { account_hint: memory.account_hint } : {}) };
      const writeBack = (expected?: number) =>
        vaultPost(ep, "/cli/vault/refresh", { ref, payload, ...(expected !== undefined ? { expected_updated_at: expected } : {}) });
      let res = await writeBack(memory.updated_at);
      if (res.stale) {
        const saved = await readSaved();
        if (!saved) return held;
        if (!jarIsNewer(jar.cookies, saved.payload.cookies)) {
          const cookies = aliveCookies(saved.payload.cookies, now());
          await putIn(saved.payload, cookies);
          remember(cookies, saved.payload, saved.updated_at);
          deps.log(`signed in with vault sign-in ${meta.name}: it was saved again since this browser last used it`);
          return;
        }
        res = await writeBack(saved.updated_at);
        if (res.stale) return deps.log(`vault sign-in ${meta.name} changed again while writing back; left as saved`);
      }
      remember(jar.cookies, payload, res.updated_at);
      deps.log(`refreshed vault sign-in ${meta.name} with this browser's newer cookies`);
      return;
    }

    const saved = await readSaved();
    if (!saved) return held;
    const cookies = aliveCookies(saved.payload.cookies, now());
    if (needsSignin(cookies, present, now())) {
      await putIn(saved.payload, cookies);
      deps.log(`signed in with vault sign-in ${meta.name}${saved.payload.account_hint ? ` (${saved.payload.account_hint})` : ""}`);
    }
    remember(cookies, saved.payload, saved.updated_at);
  } catch (err) {
    deps.log(`vault sign-in ${meta.name} not used: ${(err as Error).message.split("\n")[0]}`);
  } finally {
    conn?.close();
  }
}

/**
 * The open hook as cliEngine calls it: the managed browser's port from its
 * state, nothing when there is none. A sign-in Ask first holds stops the open
 * with the decision to wait on (exit NEEDS_APPROVAL_EXIT), so the agent never
 * works the site signed out believing it was signed in.
 */
export async function signInOnOpen(url: string, conversation: () => string | null, log: (line: string) => void): Promise<void> {
  const state = readState();
  if (!state?.port) return;
  const held = await useVaultSignin(url, { port: state.port, conversation, log });
  if (held) exitForApproval(held);
}
