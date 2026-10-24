/**
 * The two site-policy hooks every browser driver path calls.
 *
 * `cast browser` can drive Chrome through more than one engine (the built-in
 * CDP driver, the agent-browser engine, the extension bridge). The allowlist
 * and the audit trail must behave identically on all of them, so the decision
 * lives here and each driver adds exactly two calls:
 *
 *   1. `refuseNavigation(url, ...)` BEFORE an explicit navigation. Non-null
 *      means "do not navigate": the caller prints/throws the message and stops.
 *      The refused attempt is already on the audit trail by the time it
 *      returns.
 *   2. `auditLanding(...)` AFTER any step that can move the page — same call
 *      the built-in driver makes after `settle`. It records the origin and
 *      returns a warning when the page is somewhere the policy would not have
 *      allowed (an in-page click, a redirect). It never yanks the page back.
 *
 * Both take the current URL as a string, so an engine only has to be able to
 * say where its tab is — nothing about CDP leaks through this seam.
 */

import { denyNavigation, loadSitePolicy, type SitePolicy } from "./policy.js";
import { auditLanding, recordBlocked, type AuditVia } from "./audit.js";
import { DEFAULT_WEB_URL, webBaseUrl } from "../config/readLocalConfig.js";
import { readSigninState, unapprovedSignins, type SigninMemory } from "../secrets/signin.js";
import { isWebAuthnMethod, WEBAUTHN_REFUSAL } from "./bridge/protocol.js";

export { auditLanding };
export type { AuditVia, SitePolicy };

/** Normalise the way `open` does, so a bare host is checked as https. */
export function withScheme(url: string): string {
  return /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
}

/**
 * The pre-navigation gate. Returns the refusal to show, or null to proceed.
 * Loads the policy itself unless one is passed (a batch loads once).
 */
export function refuseNavigation(
  url: string,
  session: string | null,
  via: AuditVia,
  policy: SitePolicy | null = loadSitePolicy(),
): { message: string; hint: string } | null {
  const target = withScheme(url);
  const deny = vaultPageRefusal(target) ?? denyNavigation(policy, target);
  if (!deny) return null;
  recordBlocked(target, session, via);
  return deny;
}

/** Where codecast's own web app answers: the public app, the local proxy, the dev server, and the web_url this machine is configured with. */
function codecastHosts(): Set<string> {
  const hosts = new Set(["codecast.sh", "www.codecast.sh", "local.codecast.sh", "localhost:3200", "127.0.0.1:3200"]);
  for (const base of [DEFAULT_WEB_URL, webBaseUrl()]) {
    try {
      hosts.add(new URL(base).host.toLowerCase());
    } catch { /* a malformed web_url names no host */ }
  }
  return hosts;
}

/**
 * codecast's Vault page is a person's: from it an agent driving their signed-in
 * browser could reveal an Ask first value, approve its own read or switch Ask
 * first off, and the backend cannot tell those clicks from theirs. The rest of
 * the app stays open for agents to verify.
 */
export function vaultPageRefusal(url: string): { message: string; hint: string } | null {
  let u: URL;
  try {
    u = new URL(withScheme(url));
  } catch {
    return null;
  }
  if (!/^\/vault(\/|$)/i.test(u.pathname) || !codecastHosts().has(u.host.toLowerCase())) return null;
  return {
    message: `refusing to open ${u.origin}/vault: only a person uses the Vault page`,
    hint: "Read a secret with cast vault get or run, and ask for a missing one with cast vault request; an old /vault?f= Files link opens as /files.",
  };
}

/**
 * The refusal for an engine command that names a CDP WebAuthn method
 * (`WebAuthn.enable`, `WebAuthn.addVirtualAuthenticator`, …) anywhere in its
 * arguments, or null to proceed. The bridge refuses the same methods on the
 * wire; this names the reason before the engine runs.
 */
export function webAuthnRefusal(verb: string, args: readonly string[]): { message: string; hint: string } | null {
  if (![verb, ...args].some(isWebAuthnMethod)) return null;
  return { message: WEBAUTHN_REFUSAL, hint: "Touch ID confirms a Vault action only from the person; hand them the step." };
}

/**
 * The URLs an engine command loads by itself, each to pass the gate `open`
 * passes: `open`, `goto` and `navigate <url>`, `read <url>`, `tab new <url>`,
 * `diff url <a> <b>`, and `pushstate <url>`, read against the page the tab is
 * on (`pageUrl`, else the web app), since a client-side push reaches a route
 * without loading it.
 */
export function urlsLoadedBy(verb: string, args: readonly string[], pageUrl: () => string | null = () => null): string[] {
  const pos = args.filter((a) => !a.startsWith("-"));
  if (verb === "open" || verb === "goto" || verb === "navigate" || verb === "read") return pos.slice(0, 1);
  if (verb === "tab") return pos[0] === "new" ? pos.slice(1, 2) : [];
  if (verb === "diff") return pos[0] === "url" ? pos.slice(1, 3) : [];
  if (verb === "pushstate" && pos[0]) {
    try {
      return [new URL(pos[0], pageUrl() ?? webBaseUrl()).href];
    } catch {
      return [pos[0]];
    }
  }
  return [];
}

/**
 * Verbs that can change which page a tab is on. Drivers with a passthrough
 * shape (one engine call per verb) audit after any of these; drivers with
 * per-verb code call `auditLanding` where they already settle.
 */
export const NAVIGATING_VERBS: ReadonlySet<string> = new Set([
  "open", "goto", "click", "type", "fill", "press", "select", "back", "forward", "reload", "do", "batch",
]);

/** Which audit `via` label a passthrough verb maps to. */
export function viaFor(verb: string): AuditVia {
  if (verb === "open" || verb === "goto") return "open";
  if (verb === "back" || verb === "forward") return "history";
  if (verb === "reload") return "reload";
  if (verb === "do" || verb === "batch") return "batch";
  return "action";
}

// ---------------------------------------------------------------------------
// Sign-in landings
// ---------------------------------------------------------------------------

/**
 * Identity hosts a page redirects to when the browser is signed out. Named
 * because they never host the work itself: landing on one means "sign in",
 * whatever the agent asked for.
 */
const SIGN_IN_HOSTS = [
  "accounts.google.com",
  "login.microsoftonline.com",
  "login.live.com",
  "appleid.apple.com",
  "auth.atlassian.com",
  "id.atlassian.com",
  "login.salesforce.com",
  "signin.aws.amazon.com",
];

/** Hosts whose first label says "this is the sign-in front door". */
const SIGN_IN_LABELS = /^(accounts|account|login|signin|sign-in|sso|auth|id|idp|identity)$/;
/** Paths that are a sign-in form wherever they live. */
const SIGN_IN_PATHS = /\/(login|signin|sign-in|sign_in|log-in|auth\/login|users\/sign_in|session\/new|oauth2\/v2\/auth|o\/oauth2)(\/|$|\?)/i;

/**
 * Is this URL a sign-in page? Returns the identity host to name, or null.
 * A hostname or path pattern is enough — the cost of a false positive is one
 * advisory line, the cost of a miss is an agent that reads a login form as
 * the page it asked for and reports "the site is empty".
 */
export function signInHost(url: string): string | null {
  let u: URL;
  try {
    u = new URL(withScheme(url));
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (SIGN_IN_HOSTS.includes(host)) return host;
  if (SIGN_IN_LABELS.test(host.split(".")[0]) && host.split(".").length > 2) return host;
  if (SIGN_IN_PATHS.test(u.pathname)) return host;
  return null;
}

/**
 * The advisory an agent reads after landing on a sign-in page: what happened
 * and the one command that fixes it. `keepsOwn` says whether this host's
 * login is one the agent browser holds for itself (profile.ts) — then it was
 * never carried from the human's Chrome, and a person signing in once is the
 * whole answer.
 */
export function signInLandingNote(url: string, keepsOwn: (host: string) => boolean, realHint: string | null = null): string | null {
  const host = signInHost(url);
  if (!host) return null;
  const why = keepsOwn(host)
    ? "the agent browser keeps its own login for this site (never copied from your Chrome — a shared one signs both out; Chrome normally signs it in from your account on launch)"
    : "your Chrome's cookies for it were carried, so this site keeps its session elsewhere or you are signed out there too";
  const fix = realHint ? `Or ${realHint}` : "";
  return `landed on a sign-in page (${host}) — ${why}. A person signs in once: \`cast browser login\` raises the agent browser on this tab and waits.${fix ? ` ${fix}` : ""}`;
}

// ---------------------------------------------------------------------------
// Ask first sign-ins in the shared agent browser
// ---------------------------------------------------------------------------

/**
 * What an engine command reads out of the browser: "jar" for every cookie
 * (`cookies`, `state save`), "page" for the current page's storage
 * (`storage`), null for anything else. Anything that is not plainly a write
 * (`set`, `clear`) counts as a read, so a stray flag value cannot slip a read
 * past.
 */
export function browserJarRead(verb: string, args: readonly string[]): "jar" | "page" | null {
  const ops = args.filter((a) => !a.startsWith("-"));
  const writes = (op: string | undefined) => op === "set" || op === "clear";
  if (verb === "cookies") return writes(ops[0]) ? null : "jar";
  if (verb === "storage") return writes(ops[1]) ? null : "page";
  if (verb === "state") return ops.includes("save") ? "jar" : null;
  return null;
}

/**
 * The refusal for a cookie or storage read that would hand this session an
 * Ask first sign-in it holds no approval for, or null to proceed. `pageUrl`
 * is the page a "page" read reads; the memory is this machine's
 * (secrets/signin.ts).
 */
export function vaultJarRefusal(
  read: "jar" | "page",
  pageUrl: string | null,
  conversation: string | null,
  state: Record<string, SigninMemory> = readSigninState(),
  now = Date.now(),
): { message: string; hint: string } | null {
  // A page read whose page is unknown is checked against every sign-in.
  let host: string | null = null;
  if (read === "page") {
    try {
      host = new URL(pageUrl ?? "").hostname;
    } catch { /* unknown page */ }
  }
  const held = unapprovedSignins(state, host, conversation, now);
  if (!held.length) return null;
  const site = held[0].ask_first!.sites[0];
  return {
    message: `refusing to read ${read === "jar" ? "the browser's cookies" : `storage on ${host}`}: Ask first sign-in ${held.map((m) => m.name).join(", ")} is in the agent browser and this session has no approval for it`,
    hint: site ? `cast browser open https://${site} asks a person to approve this session.` : "A person approves this session's read when it opens the site.",
  };
}
