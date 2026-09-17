/**
 * `cast browser sync [url]` — one body for both drivers.
 *
 * On a laptop it carries this machine's current Chrome logins into the
 * managed browser (the local carry; the Keychain is here). On the cloud host
 * it is a REQUEST: the host has no Keychain, so it asks the owner's laptop
 * daemon (cloud.requestBrowserSync -> the `cloud_browser_sync` command) to
 * carry the login through an SSH port forward into this host's Chrome, then
 * polls for the outcome. The host runs the built-in CDP driver and the
 * laptop the engine driver, which is why the body lives here and each
 * driver registers the verb with its own ensure-browser.
 *
 * Nothing here prints a cookie: the request carries the site ORIGIN and the
 * answer carries counts.
 */

import { OWN_LOGIN_REASON, provisionLocalLogins } from "./credentials.js";
import { readState, type InstanceState } from "./instance.js";
import { loadSitePolicy } from "./policy.js";
import { keepsOwnLogin } from "./profile.js";
import { refuseNavigation, withScheme } from "./siteGuard.js";
import { DATACENTER_IP_NOTE, explainSyncFailure } from "../cloud/browserSync.js";
import { deviceId, isRemoteDevice } from "../remote/device.js";
import { convexClient } from "../remote/cli.js";
import { fmt, icons } from "../colors.js";

/** The host CLI waits this long for the laptop by default. */
export const DEFAULT_SYNC_WAIT_S = 150;
const POLL_MS = 2_000;

export interface SyncOptions {
  all?: boolean;
  wait: string;
  via?: string;
}

export interface SyncDeps {
  /** Bring the managed browser up (the driver's own recovery), so the port sent is a live one. */
  ensureBrowser: () => Promise<void>;
  /** The calling session's owner key, for the audit trail. */
  me: () => string | null;
  isRemote?: () => boolean;
  readState?: () => InstanceState | null;
  provisionLocalLogins?: typeof provisionLocalLogins;
  loadSitePolicy?: () => ReturnType<typeof loadSitePolicy>;
  refuseNavigation?: typeof refuseNavigation;
  convex?: () => Promise<{ client: { mutation(fn: any, args: any): Promise<any>; query(fn: any, args: any): Promise<any> }; token: string; api: any }>;
  deviceId?: () => string;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/**
 * The server's own sentence out of a Convex client error, which wraps it in
 * request ids and a stack ("… Server Error\nUncaught Error: <sentence>\n at …").
 */
export function serverErrorLine(msg: string): string {
  const m = /Uncaught (?:Error|ConvexError): ([^\n]*)/.exec(msg);
  return (m ? m[1] : msg.split("\n")[0]).trim();
}

const OK = `${fmt.success(icons.check)}`;
const BAD = `${fmt.error(icons.cross)}`;
const DOT = fmt.muted(icons.dot);

type CarryCounts = { injected?: number; sites?: number; rejected?: number; host?: string; reason?: string };

/** The one sentence for a carry's outcome, local or via a laptop, so the wording cannot drift between the two. */
export function carryResultLine(r: CarryCounts, label: string, via?: string): string {
  const host = r.host ?? label;
  if (!r.injected) return `${DOT} nothing to carry for ${host}${r.reason ? ` — ${r.reason}` : ""}`;
  const where = r.sites ? `across ${r.sites} site${r.sites === 1 ? "" : "s"}` : `for ${host}`;
  const rej = r.rejected ? fmt.muted(` (${r.rejected} Chrome would not store)`) : "";
  return `${OK} carried ${r.injected} cookie${r.injected === 1 ? "" : "s"} ${where} from your Chrome${via ? ` via ${via}` : ""}${rej}`;
}

/** `--wait` as whole seconds; null when it is not a non negative integer. */
export function parseWaitSeconds(raw: string): number | null {
  return /^\d+$/.test(raw.trim()) ? parseInt(raw, 10) : null;
}

/** Run the verb; returns the exit code (the drivers `process.exit` it). */
export async function runBrowserSync(url: string | undefined, o: SyncOptions, deps: SyncDeps): Promise<number> {
  const out = deps.out ?? ((l) => console.log(l));
  const err = deps.err ?? ((l) => console.error(l));
  const fail = (msg: string, hint?: string): number => {
    err(`${BAD} ${msg}`);
    if (hint) err(`  ${fmt.muted(hint)}`);
    return 1;
  };
  const isRemote = deps.isRemote ?? isRemoteDevice;
  const state = deps.readState ?? readState;

  if (!isRemote()) {
    // The local carry, as it always was.
    if (o.all || o.via) out(fmt.muted("  --all and --via only mean something on the cloud host; ignored here"));
    await deps.ensureBrowser();
    const s = state();
    if (!s || s.remote || !s.sourceProfile) return fail("no local browser started from your Chrome profile", "`cast browser start` (without --fresh) first");
    const target = url ? withScheme(url) : null;
    const r = await (deps.provisionLocalLogins ?? provisionLocalLogins)(s.port, target, { profileDir: s.sourceProfile, channel: s.channel });
    out(carryResultLine(r, r.host));
    out(fmt.muted("  `open` does this for the site it opens; a login on a sibling host needs this whole-jar sync or a URL on that host"));
    return 0;
  }

  // The cloud host: ask the laptop.
  const note = () => out(fmt.muted(`  ${DATACENTER_IP_NOTE}`));
  if (!url && !o.all) return fail("on the cloud host name the site: cast browser sync <site> (or --all for every site)");
  // The whole jar is a deliberate act (the mutation takes exactly one of the
  // two); silently sending the site would make `--all` a no-op.
  if (url && o.all) return fail("name a site or --all, not both: cast browser sync <site> carries that site, cast browser sync --all every site");
  const wait = parseWaitSeconds(o.wait);
  if (wait === null) return fail(`--wait ${o.wait} is not a number of seconds (0 returns right after asking; default ${DEFAULT_SYNC_WAIT_S})`);
  let origin: string | undefined;
  let hostname = "";
  if (url) {
    const target = withScheme(url);
    let u: URL;
    try {
      u = new URL(target);
    } catch {
      return fail(`'${url}' is not a valid URL`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return fail(`${u.protocol}// is not a site a login can be carried to`);
    origin = u.origin;
    hostname = u.hostname;
    if (keepsOwnLogin(hostname)) {
      out(`${DOT} nothing to carry for ${hostname} — ${OWN_LOGIN_REASON}; this host has no Google account`);
      note();
      return 0;
    }
    const deny = (deps.refuseNavigation ?? refuseNavigation)(target, deps.me(), "sync");
    if (deny) return fail(deny.message.replace(/^refusing to open/, "refusing to carry a login for"), deny.hint);
  } else if ((deps.loadSitePolicy ?? loadSitePolicy)()) {
    return fail("with a site allowlist active, name the site: cast browser sync <site>");
  }
  const label = hostname || "every site";

  await deps.ensureBrowser();
  const s = state();
  if (!s?.port) return fail("no managed browser is running on this host", "`cast browser start` first");
  const env = deps.env ?? process.env;
  const conversationId = env.CODECAST_CONVERSATION_ID || undefined;

  const { client, token, api } = await (deps.convex ?? convexClient)();
  let asked: { command_id: string; device_id: string; label: string | null };
  try {
    asked = await client.mutation(api.cloud.requestBrowserSync, {
      api_token: token,
      device_id: (deps.deviceId ?? deviceId)(),
      cdp_port: s.port,
      ...(origin ? { origin } : { all: true }),
      ...(conversationId ? { conversation_id: conversationId } : {}),
      ...(o.via ? { via_device_id: o.via } : {}),
    });
  } catch (e) {
    const raw = (e as Error).message ?? String(e);
    const msg = serverErrorLine(raw);
    if (/No online laptop|not one of your online laptops/.test(msg)) {
      err(`${BAD} ${msg}`);
      err(`  ${fmt.muted("the host's browser stays signed out; continue without the login or retry once your laptop is awake")}`);
      note();
      return 1;
    }
    if (/Could not find public function/i.test(raw)) {
      return fail("this host's cast and its server disagree about browser sync — update the host's cast (cast hosts provision from the laptop)");
    }
    return fail(msg);
  }
  const via = asked.label ?? asked.device_id.slice(0, 8);
  out(`${DOT} asked ${via} to carry your login for ${label} (request ${asked.command_id}) — waiting up to ${wait}s`);
  if (wait === 0) {
    note();
    return 0;
  }

  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + wait * 1000;
  for (;;) {
    const row = await client.query(api.cloud.commandOutcome, { api_token: token, command_id: asked.command_id });
    if (row?.executed_at) {
      if (row.error) {
        const why = explainSyncFailure(row.error);
        err(`${BAD} ${why.message}`);
        if (why.hint) err(`  ${fmt.muted(why.hint)}`);
        note();
        return 1;
      }
      let r: { ok?: boolean } & CarryCounts = {};
      try {
        r = JSON.parse(row.result ?? "{}");
      } catch { /* an older laptop's bare result */ }
      out(carryResultLine(r, label, via));
      note();
      return 0;
    }
    if (now() >= deadline) break;
    await sleep(POLL_MS);
  }
  err(`${BAD} no answer from ${via} yet; the request stays valid for 5 minutes and a late carry is harmless (the same cookies are a no-op) — rerun to check`);
  note();
  return 1;
}
