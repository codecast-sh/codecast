/**
 * Site policy for the managed browser: an optional allowlist of origins the
 * calling agent may navigate to.
 *
 * Where the list lives — in the config surfaces that already exist, never a
 * new file:
 *
 *   - per project:  `allow = [...]` under `[browser]` in .codecast/workspace.toml
 *     (found by walking up from the CLI's working directory)
 *   - per machine:  `browser_allow: [...]` in ~/.codecast/config.json
 *
 * The effective policy is the UNION of both lists: an origin either file
 * allows is allowed. No list configured anywhere means no policy — everything
 * is allowed, which keeps the feature strictly opt-in. A configured but EMPTY
 * list means "allow nothing", so a project can be locked down explicitly.
 *
 * Matching rules (one pattern per entry):
 *
 *   example.com          exact host — http or https, any port
 *   *.example.com        example.com AND every subdomain
 *   example.com:8443     exact host, exactly this port (default ports count:
 *                        `example.com:443` matches https://example.com)
 *   http://localhost     scheme-restricted — only that scheme matches
 *   *                    allow every public site (an explicit escape hatch)
 *
 * Wildcards (`*` and `*.x`) never match a private address: loopback,
 * link-local, RFC 1918 and CGNAT IPs, unique-local IPv6, `localhost` and the
 * `.local`/`.internal`/`.localhost` names. A dev server, a router or a cloud
 * metadata endpoint is reachable only through an entry naming it exactly
 * (`localhost:3200`, `169.254.169.254`), so a broad list cannot open the
 * machine's own network by accident.
 *
 * A pattern without a scheme matches http and https only. URLs on other
 * schemes (file:, data:, ...) are refused while a policy is active unless a
 * pattern names that scheme. Browser furniture (about:blank, chrome://...)
 * is always allowed — blocking it would only break tab plumbing, and it
 * reaches no site.
 *
 * Enforcement is per calling process, so it binds only the session that ran
 * the command — the browser is shared, and one agent's policy must never
 * interfere with another agent's tabs.
 *
 * Fail closed on a broken source: if a workspace.toml exists but cannot be
 * parsed, we cannot know whether it held an allowlist, so navigation is
 * refused with a message naming the file — silently falling open would make a
 * typo disable the policy.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseManifest } from "../workspace/manifest.js";
import { MANIFEST_REL_PATH } from "../workspace/resolver.js";
import type { Config } from "../config/types.js";
import { codecastDir } from "../codecastDir.js";
import { defaultConfigDir } from "../config/configDir.js";

export interface PolicySource {
  /** File the patterns came from, for messages. */
  file: string;
  /** Where in the file, e.g. "[browser] allow". */
  key: string;
  patterns: string[];
}

export interface SitePolicy {
  sources: PolicySource[];
  /** Sources that exist but could not be read — navigation fails closed. */
  errors: { file: string; message: string }[];
}

export interface Verdict {
  allowed: boolean;
  /** The pattern that allowed it, when one did. */
  matched?: string;
  /** Why it was refused, when it was. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

interface ParsedPattern {
  raw: string;
  scheme: string | null; // null = http or https
  host: string;
  wildcard: boolean; // "*." prefix — host and all subdomains
  port: string | null; // null = any port
  matchAll: boolean;
}

export function parsePattern(raw: string): ParsedPattern | null {
  let rest = raw.trim().toLowerCase();
  if (!rest) return null;
  if (rest === "*") return { raw, scheme: null, host: "", wildcard: false, port: null, matchAll: true };

  let scheme: string | null = null;
  const m = /^([a-z][a-z0-9+.-]*):\/\//.exec(rest);
  if (m) {
    scheme = m[1];
    rest = rest.slice(m[0].length);
  }
  // Origin-level policy: anything after the host:port is ignored.
  rest = rest.split("/")[0];

  let wildcard = false;
  if (rest.startsWith("*.")) {
    wildcard = true;
    rest = rest.slice(2);
  }

  let port: string | null = null;
  const colon = rest.lastIndexOf(":");
  if (colon >= 0) {
    const p = rest.slice(colon + 1);
    if (/^\d+$/.test(p)) {
      port = p;
      rest = rest.slice(0, colon);
    }
  }
  if (!rest) return null;
  return { raw, scheme, host: rest, wildcard, port, matchAll: false };
}

/** The port a URL is effectively on, with scheme defaults filled in. */
function effectivePort(u: URL): string {
  if (u.port) return u.port;
  if (u.protocol === "https:") return "443";
  if (u.protocol === "http:") return "80";
  return "";
}

/** IPv4 dotted quad to its four octets, or null. */
function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

function privateIpv4([a, b]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * Is this hostname (as `URL.hostname` spells it) loopback, link-local or
 * otherwise private, so that only an exact entry opens it? Judged from the
 * name alone, no DNS lookup: IP literals in those ranges, localhost and
 * *.localhost. Other names (corp.internal, printer.local) match wildcards
 * like any public name; an allowlist that names them meant them.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const v4 = ipv4(host);
  if (v4) return privateIpv4(v4);
  if (!host.startsWith("[")) return false;
  const v6 = host.slice(1, -1);
  if (v6 === "::1" || v6 === "::") return true;
  if (/^f[cd][0-9a-f]{0,2}:/.test(v6) || /^fe[89ab][0-9a-f]?:/.test(v6)) return true;
  const mapped = /^::ffff:(.+)$/.exec(v6);
  if (mapped) {
    const tail = mapped[1];
    const dotted = ipv4(tail);
    if (dotted) return privateIpv4(dotted);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      return privateIpv4([hi >> 8, hi & 255]);
    }
  }
  return false;
}

function matchesPattern(p: ParsedPattern, u: URL): boolean {
  const host = u.hostname.toLowerCase();
  if ((p.matchAll || p.wildcard) && isPrivateHost(host)) return false;
  if (p.matchAll) return true;
  const proto = u.protocol.replace(/:$/, "");
  if (p.scheme ? proto !== p.scheme : proto !== "http" && proto !== "https") return false;
  const hostOk = p.wildcard ? host === p.host || host.endsWith(`.${p.host}`) : host === p.host;
  if (!hostOk) return false;
  if (p.port !== null && effectivePort(u) !== p.port) return false;
  return true;
}

/**
 * Pages the browser itself owns. They reach no site, and refusing them only
 * breaks tab plumbing (every new tab is about:blank first).
 */
export function isInternalUrl(url: string): boolean {
  return /^(about|chrome|chrome-extension|chrome-error|devtools):/i.test(url.trim());
}

/** Origin label for audit rows: real origin when the URL has one, scheme otherwise. */
export function originOf(url: string): string {
  try {
    const u = new URL(url);
    if (u.origin && u.origin !== "null") return u.origin;
    return `${u.protocol}//`;
  } catch {
    return url.slice(0, 80);
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function codecastRoot(): string {
  return codecastDir();
}

/** Walk up from `cwd` to the nearest .codecast/workspace.toml, if any. */
export function findManifestFile(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, MANIFEST_REL_PATH);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Load the effective policy for a command run in `cwd`. Returns null when no
 * allowlist is configured anywhere — the everything-allowed default.
 */
export function loadSitePolicy(cwd: string = process.cwd()): SitePolicy | null {
  const sources: PolicySource[] = [];
  const errors: { file: string; message: string }[] = [];

  const manifestFile = findManifestFile(cwd);
  if (manifestFile) {
    try {
      const manifest = parseManifest(manifestFile);
      if (manifest?.browser.allow !== undefined) {
        sources.push({ file: manifestFile, key: "[browser] allow", patterns: manifest.browser.allow });
      }
    } catch (err) {
      errors.push({ file: manifestFile, message: (err as Error).message });
    }
  }

  const machine = loadMachinePolicy();
  if (machine) {
    sources.push(...machine.sources);
    errors.push(...machine.errors);
  }

  if (!sources.length && !errors.length) return null;
  return { sources, errors };
}

/**
 * The machine half of the policy alone: `browser_allow` in
 * ~/.codecast/config.json, or its parse/shape error (fail closed). For a
 * process whose working directory is not a project — the laptop daemon's
 * cookie-carry child — where walking up for a manifest would apply whatever
 * project the daemon happens to run from.
 */
export function loadMachinePolicy(): SitePolicy | null {
  const sources: PolicySource[] = [];
  const errors: { file: string; message: string }[] = [];
  const configFile = path.join(defaultConfigDir(), "config.json");
  if (fs.existsSync(configFile)) {
    let config: Config | undefined;
    try {
      config = JSON.parse(fs.readFileSync(configFile, "utf-8")) as Config;
    } catch (err) {
      // An unparseable file says nothing about the list: the one this process
      // last read whole still holds (the bridge host reads this on every
      // agent-tab landing). Never read whole, a list cannot be ruled out.
      if (lastMachineAllow === undefined) errors.push({ file: configFile, message: (err as Error).message });
      else if (lastMachineAllow) sources.push({ file: configFile, key: "browser_allow", patterns: lastMachineAllow });
    }
    if (config) {
      const allow = config.browser_allow;
      lastMachineAllow = null;
      if (allow !== undefined) {
        if (Array.isArray(allow) && allow.every((x) => typeof x === "string")) {
          sources.push({ file: configFile, key: "browser_allow", patterns: allow });
          lastMachineAllow = allow;
        } else {
          errors.push({ file: configFile, message: "browser_allow must be an array of strings" });
          lastMachineAllow = undefined;
        }
      }
    }
  }
  if (!sources.length && !errors.length) return null;
  return { sources, errors };
}

/** The machine list as this process last read config.json whole: undefined before any whole read (or after a malformed list), null for no list. */
let lastMachineAllow: string[] | null | undefined;

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** Is this URL allowed under the policy? (null policy = no policy = allowed) */
export function checkUrl(policy: SitePolicy | null, url: string): Verdict {
  if (isInternalUrl(url)) return { allowed: true };
  if (!policy) return { allowed: true };
  if (policy.errors.length) {
    const e = policy.errors[0];
    return { allowed: false, reason: `the policy source ${e.file} could not be read (${e.message})` };
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { allowed: false, reason: `'${url}' is not a valid URL` };
  }
  for (const source of policy.sources) {
    for (const raw of source.patterns) {
      const p = parsePattern(raw);
      if (p && matchesPattern(p, u)) return { allowed: true, matched: raw };
    }
  }
  return { allowed: false, reason: `${originOf(url)} is not in the site allowlist` };
}

/** One line naming every policy source, for refusal messages. */
export function describeSources(policy: SitePolicy): string {
  const parts = policy.sources.map((s) => `${s.file} ${s.key} (${s.patterns.length} entr${s.patterns.length === 1 ? "y" : "ies"})`);
  for (const e of policy.errors) parts.push(`${e.file} (unreadable: ${e.message})`);
  return parts.join(" + ");
}

/**
 * The pre-navigation gate for explicit navigations (`open`, batch `open`).
 * Returns null when the navigation may proceed, or a refusal the CLI prints.
 */
export function denyNavigation(
  policy: SitePolicy | null,
  url: string,
): { message: string; hint: string } | null {
  const verdict = checkUrl(policy, url);
  if (verdict.allowed) return null;
  const hint = policy!.errors.length
    ? `fix that file (or remove the broken entry) — while it is unreadable, navigation fails closed`
    : `policy: ${describeSources(policy!)}\n` +
      `  allow it by adding "${hostOnly(url)}"${isPrivateHost(hostOnly(url)) ? "" : " (or a *.wildcard)"} to one of those lists`;
  return { message: `refusing to open ${url} — ${verdict.reason}`, hint };
}

function hostOnly(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}
