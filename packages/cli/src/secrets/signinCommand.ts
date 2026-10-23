// `cast vault save-signin <site>`: store a site's sign-in in the Vault, from
// the agent browser a person just signed in through, or (`--from-chrome`)
// from the person's own Chrome on this laptop. The web's Save sign-in runs the
// second through the `vault_capture_signin` daemon command, so the cookies go
// from this machine straight into the encrypted row and only the outcome
// (counts, an account name, or why not) travels back.
//
// One name per site and workspace: saving again rotates it, and saving under
// an open request's name fills that request.

import { apiPost, type PublishDeps } from "../castApi.js";
import { keepsOwnLogin } from "../browser/profile.js";
import { OWN_LOGIN_REASON } from "../browser/credentials.js";
import { validatePayload, type SecretMeta, type SigninPayload } from "@codecast/shared/contracts/secrets";
import { captureFromAgentBrowser, captureFromChrome, type Captured } from "./signinBrowser.js";
import { captureSigninArgv, defaultSigninName, parseCaptureSigninArgs, rememberJar, signinSite, writeSigninMemory } from "./signin.js";

export type SavedSignin = {
  ok: true;
  action: "created" | "rotated" | "filled";
  short_id: string;
  name: string;
  host: string;
  cookies: number;
  account_hint?: string;
};

export class SigninRefused extends Error {}

/** Which row a save writes: a new one, the open request it fills, or the sign-in it replaces. Refuses a name held by another kind. */
export function saveTarget(rows: readonly SecretMeta[], name: string, where: { team_id: string } | { personal: true }): { action: SavedSignin["action"]; row?: SecretMeta } {
  const inWorkspace = (r: SecretMeta) => ("team_id" in where ? r.workspace === `team:${where.team_id}` : r.workspace.startsWith("user:"));
  const row = rows.find((r) => r.name === name && inWorkspace(r));
  if (!row) return { action: "created" };
  if (row.kind !== "signin") throw new SigninRefused(`${name} is already a ${row.kind} in this vault (${row.short_id}): save the sign-in under another name with --name`);
  return { action: row.status === "requested" ? "filled" : "rotated", row };
}

export async function saveSignin(
  deps: PublishDeps,
  site: string,
  o: { name?: string; where: { team_id: string } | { personal: true }; fromChrome?: boolean },
): Promise<SavedSignin> {
  const host = signinSite(site);
  if (!host) throw new SigninRefused(`${site} is not a site: name it like github.com`);
  if (keepsOwnLogin(host)) throw new SigninRefused(`${host} is never saved: ${OWN_LOGIN_REASON}`);
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
  const target = saveTarget(await call("/cli/vault/list", {}), name, o.where);
  const res =
    target.action === "created"
      ? await call("/cli/vault/create", { name, kind: "signin", payload, sites: [host], ...o.where })
      : await call(target.action === "filled" ? "/cli/vault/fulfill" : "/cli/vault/rotate", { ref: target.row!.short_id, payload });

  // The agent browser that captured it is signed in with exactly this jar:
  // remember it, so its next `open` writes back newer cookies instead of re-injecting.
  // updated_at (rotate and fill return it) is what that write-back names, so one racing a newer save is refused.
  if (!o.fromChrome) writeSigninMemory(String(res.id ?? target.row?._id), rememberJar(res.name ?? name, payload.cookies, payload, Date.now(), res.updated_at));
  return {
    ok: true,
    action: target.action,
    short_id: res.short_id,
    name: res.name ?? name,
    host,
    cookies: payload.cookies.length,
    ...(payload.account_hint ? { account_hint: payload.account_hint } : {}),
  };
}

// ── The daemon's vault_capture_signin ───────────────────────────────────────

export interface CaptureSigninHandlerDeps {
  isRemoteDevice: () => boolean;
  runCastCommand: (args: string[], opts: { timeoutMs?: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  log: (message: string, level?: "info" | "warn" | "error") => void;
  childErrorDetail: (stderr: string, stdout?: string) => string;
}

/** Keychain prompt (45s cap in credentials.ts) + sqlite read + two backend calls. */
export const CAPTURE_SIGNIN_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * The web asked this laptop to save a site's sign-in out of the person's
 * Chrome. The work runs in a `cast vault save-signin --from-chrome` child:
 * the Keychain read and the sqlite copy block, and a daemon must not. The
 * child's last line is the outcome JSON (counts, the account name, or the
 * refusal sentence), never a cookie, and that is what the web reads back.
 */
export async function handleCaptureSigninCommand(commandArgs: string | undefined, deps: CaptureSigninHandlerDeps): Promise<{ result?: string; error?: string }> {
  if (deps.isRemoteDevice()) return { error: "This is a cloud host, which has no Chrome of the person's: pick a laptop" };
  let a;
  try {
    a = parseCaptureSigninArgs(commandArgs);
  } catch (err) {
    return { error: `vault_capture_signin: ${(err as Error).message}` };
  }
  deps.log(`[VAULT-SIGNIN] saving the sign-in for ${a.site} from Chrome (child)`);
  const res = await deps.runCastCommand(captureSigninArgv(a), { timeoutMs: CAPTURE_SIGNIN_TIMEOUT_MS });
  const line = res.stdout.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
  let parsed: any = null;
  try {
    parsed = line ? JSON.parse(line) : null;
  } catch { /* not the child's line */ }
  if (res.code === 0 && parsed?.ok) {
    deps.log(`[VAULT-SIGNIN] ${parsed.action} ${parsed.short_id} for ${a.site}: ${parsed.cookies} cookies`);
    return { result: JSON.stringify(parsed) };
  }
  const error = typeof parsed?.reason === "string" ? parsed.reason : `Saving the sign-in failed (exit ${res.code})${deps.childErrorDetail(res.stderr, res.stdout) ? `: ${deps.childErrorDetail(res.stderr, res.stdout)}` : ""}`;
  deps.log(`[VAULT-SIGNIN] FAILED for ${a.site}: ${error}`, "warn");
  return { error };
}
