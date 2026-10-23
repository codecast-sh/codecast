// `cast vault save-signin <site>`: store a site's sign-in in the Vault, from
// the agent browser a person just signed in through, or (`--from-chrome`)
// from the person's own Chrome on this laptop. The web's Save sign-in runs the
// second through the `vault_capture_signin` daemon command, so the cookies go
// from this machine straight into the encrypted row and only the outcome
// (counts, an account name, or why not) travels back.
//
// One name per site and workspace: saving again rotates it, and saving under
// an open request's name fills that request. With no --name, an open sign-in
// request for the site is filled whatever it is called. A name already saved
// for another site is refused rather than rotated: its sites would no longer
// say whose cookies it holds.

import { apiPost, type PublishDeps } from "../castApi.js";
import { keepsOwnLogin } from "../browser/profile.js";
import { OWN_LOGIN_REASON } from "../browser/credentials.js";
import { refuseNavigation } from "../browser/siteGuard.js";
import { SESSION_ENV_KEYS } from "../processEnv.js";
import { sessionIdFromEnv } from "../sessionIdentity.js";
import { siteProblem, validatePayload, type SecretMeta, type SigninPayload } from "@codecast/shared/contracts/secrets";
import { captureFromAgentBrowser, captureFromChrome, type Captured } from "./signinBrowser.js";
import { captureSigninArgv, coversHost, defaultSigninName, parseCaptureSigninArgs, rememberJar, signinSite, writeSigninMemory } from "./signin.js";

export type SavedSignin = {
  ok: true;
  action: "created" | "rotated" | "filled";
  short_id: string;
  name: string;
  host: string;
  cookies: number;
  account_hint?: string;
};

/** What `--check` found in Chrome without storing anything: 0 cookies means Chrome is not signed in there. */
export type CheckedSignin = { ok: true; check: true; host: string; cookies: number; account_hint?: string };

export class SigninRefused extends Error {}

/**
 * Which row a save of `host` writes: a new one, the open request it fills, or
 * the sign-in it replaces. Without an explicit name (`named` false) an open
 * sign-in request for the site wins over the default name. Refuses a name
 * held by another kind, or by a sign-in for another site.
 */
export function saveTarget(
  rows: readonly SecretMeta[],
  name: string,
  where: { team_id: string } | { personal: true },
  host: string,
  named = true,
): { action: SavedSignin["action"]; row?: SecretMeta } {
  const inWorkspace = (r: SecretMeta) => ("team_id" in where ? r.workspace === `team:${where.team_id}` : r.workspace.startsWith("user:"));
  const mine = rows.filter(inWorkspace);
  const asked = named ? undefined : mine.find((r) => r.kind === "signin" && r.status === "requested" && coversHost(r.sites ?? [], host));
  const row = asked ?? mine.find((r) => r.name === name);
  if (!row) return { action: "created" };
  if (row.kind !== "signin") throw new SigninRefused(`${name} is already a ${row.kind} in this vault (${row.short_id}): save the sign-in under another name with --name`);
  if (row.sites?.length && !coversHost(row.sites, host)) {
    throw new SigninRefused(`${row.name} (${row.short_id}) is the sign-in for ${row.sites.join(", ")}, not ${host}: save it under another name with --name`);
  }
  return { action: row.status === "requested" ? "filled" : "rotated", row };
}

/**
 * The host a save names, refused the way `cast browser open` refuses it: not
 * a site, Google's own login, a public suffix, or a host the site policy
 * keeps the browser off (the refusal lands on the browser's audit trail).
 */
function signinHost(site: string): string {
  const host = signinSite(site);
  if (!host) throw new SigninRefused(`${site} is not a site: name it like github.com`);
  if (keepsOwnLogin(host)) throw new SigninRefused(`${host} is never saved: ${OWN_LOGIN_REASON}`);
  const broad = siteProblem(host);
  if (broad) throw new SigninRefused(broad);
  const deny = refuseNavigation(host, sessionIdFromEnv(), "sync");
  if (deny) throw new SigninRefused(`${deny.message}${deny.hint ? `: ${deny.hint}` : ""}`);
  return host;
}

/**
 * Reading the person's own Chrome is the person's to start: from a terminal
 * of theirs, or from Save sign-in on the Vault page, which runs this through
 * the daemon with no session in its env (handleCaptureSigninCommand). An
 * agent session that tries is refused before the Keychain is touched.
 */
export function chromeReadRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  return sessionIdFromEnv(env)
    ? "Reading your own Chrome's cookies is for a person: press Save sign-in on the Vault page and pick this laptop, or run it in your own terminal. An agent saves the agent browser's sign-in without --from-chrome"
    : null;
}

function chromeHost(site: string): string {
  const refused = chromeReadRefusal();
  if (refused) throw new SigninRefused(refused);
  return signinHost(site);
}

/** Count the site's cookies in this laptop's Chrome, so the web shows what a share would hand over before anyone confirms it. */
export function checkChromeSignin(site: string): CheckedSignin {
  const host = chromeHost(site);
  const captured = captureFromChrome(host);
  if ("error" in captured) {
    if (captured.signed_out) return { ok: true, check: true, host, cookies: 0 };
    throw new SigninRefused(captured.error);
  }
  return { ok: true, check: true, host, cookies: captured.cookies.length, ...(captured.account_hint ? { account_hint: captured.account_hint } : {}) };
}

export async function saveSignin(
  deps: PublishDeps,
  site: string,
  o: { name?: string; where: { team_id: string } | { personal: true }; fromChrome?: boolean },
): Promise<SavedSignin> {
  const host = o.fromChrome ? chromeHost(site) : signinHost(site);
  const name = o.name ?? defaultSigninName(host);

  const captured: Captured = o.fromChrome ? captureFromChrome(host) : await captureFromAgentBrowser(host);
  if ("error" in captured) throw new SigninRefused(captured.error);
  const checked = validatePayload("signin", { ...captured, captured_from: o.fromChrome ? "chrome" : "agent-browser" } satisfies SigninPayload);
  if ("error" in checked) throw new SigninRefused(checked.error);
  const payload = checked.payload;

  const call = (route: string, body: Record<string, unknown>) =>
    apiPost(deps, route, body, { exitOnError: false }).catch((err: Error) => {
      throw new SigninRefused(err.message);
    });
  const target = saveTarget(await call("/cli/vault/list", {}), name, o.where, host, o.name !== undefined);
  // A request asked with no --site names none yet: give it this one before the
  // value lands, so the session the fill wakes finds a sign-in `open` can use.
  if (target.row && !target.row.sites?.length) await call("/cli/vault/update", { ref: target.row.short_id, sites: [host] });
  const res =
    target.action === "created"
      ? await call("/cli/vault/create", { name, kind: "signin", payload, sites: [host], ...o.where })
      : await call(target.action === "filled" ? "/cli/vault/fulfill" : "/cli/vault/rotate", { ref: target.row!.short_id, payload });

  // The agent browser that captured it is signed in with exactly this jar:
  // remember it, so its next `open` writes back newer cookies instead of re-injecting.
  // value_updated_at (create, rotate and fill return it) is what that write-back names, so one racing a newer save is refused.
  const saved = res.name ?? target.row?.name ?? name;
  if (!o.fromChrome) writeSigninMemory(String(res.id ?? target.row?._id), rememberJar(saved, payload.cookies, payload, Date.now(), res.value_updated_at));
  return {
    ok: true,
    action: target.action,
    short_id: res.short_id,
    name: saved,
    host,
    cookies: payload.cookies.length,
    ...(payload.account_hint ? { account_hint: payload.account_hint } : {}),
  };
}

// ── The daemon's vault_capture_signin ───────────────────────────────────────

export interface CaptureSigninHandlerDeps {
  isRemoteDevice: () => boolean;
  runCastCommand: (args: string[], opts: { timeoutMs?: number; env?: Record<string, string> }) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  log: (message: string, level?: "info" | "warn" | "error") => void;
  childErrorDetail: (stderr: string, stdout?: string) => string;
}

/** Blanks every variable that names a session (sessionIdFromEnv treats "" as unset). */
export const NO_SESSION_ENV: Record<string, string> = Object.fromEntries(SESSION_ENV_KEYS.map((k) => [k, ""]));

/** Keychain prompt (45s cap in credentials.ts) + sqlite read + two backend calls. */
export const CAPTURE_SIGNIN_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * The web asked this laptop to save a site's sign-in out of the person's
 * Chrome. The work runs in a `cast vault save-signin --from-chrome` child:
 * the Keychain read and the sqlite copy block, and a daemon must not. The
 * child's last line is the outcome JSON (counts, the account name, or the
 * refusal sentence), never a cookie, and that is what the web reads back.
 */
export async function handleCaptureSigninCommand(commandArgs: string | undefined, deps: CaptureSigninHandlerDeps, check = false): Promise<{ result?: string; error?: string }> {
  if (deps.isRemoteDevice()) return { error: "This is a cloud host, which has no Chrome of the person's: pick a laptop" };
  let a;
  try {
    a = parseCaptureSigninArgs(commandArgs);
  } catch (err) {
    return { error: `vault_capture_signin: ${(err as Error).message}` };
  }
  deps.log(`[VAULT-SIGNIN] ${check ? "checking" : "saving"} the sign-in for ${a.site} from Chrome (child)`);
  // A person asked for this on the web; a session id the daemon inherited from the shell that started it would read as an agent's.
  const res = await deps.runCastCommand(captureSigninArgv(a, check), { timeoutMs: CAPTURE_SIGNIN_TIMEOUT_MS, env: NO_SESSION_ENV });
  const line = res.stdout.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
  let parsed: any = null;
  try {
    parsed = line ? JSON.parse(line) : null;
  } catch { /* not the child's line */ }
  if (res.code === 0 && parsed?.ok) {
    deps.log(`[VAULT-SIGNIN] ${check ? "checked" : `${parsed.action} ${parsed.short_id}`} for ${a.site}: ${parsed.cookies} cookies`);
    return { result: JSON.stringify(parsed) };
  }
  const error = typeof parsed?.reason === "string" ? parsed.reason : `Saving the sign-in failed (exit ${res.code})${deps.childErrorDetail(res.stderr, res.stdout) ? `: ${deps.childErrorDetail(res.stderr, res.stdout)}` : ""}`;
  deps.log(`[VAULT-SIGNIN] FAILED for ${a.site}: ${error}`, "warn");
  return { error };
}
