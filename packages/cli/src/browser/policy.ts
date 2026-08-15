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
 *   *                    allow everything (an explicit escape hatch)
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
import * as os from "node:os";
import * as path from "node:path";
import { parseManifest } from "../workspace/manifest.js";
import { MANIFEST_REL_PATH } from "../workspace/resolver.js";
import type { Config } from "../config/types.js";

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

function matchesPattern(p: ParsedPattern, u: URL): boolean {
  if (p.matchAll) return true;
  const proto = u.protocol.replace(/:$/, "");
  if (p.scheme ? proto !== p.scheme : proto !== "http" && proto !== "https") return false;
  const host = u.hostname.toLowerCase();
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
  return process.env.CODECAST_DIR || path.join(os.homedir(), ".codecast");
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

  const configFile = path.join(codecastRoot(), "config.json");
  if (fs.existsSync(configFile)) {
    try {
      const config = JSON.parse(fs.readFileSync(configFile, "utf-8")) as Config;
      const allow = config.browser_allow;
      if (allow !== undefined) {
        if (Array.isArray(allow) && allow.every((x) => typeof x === "string")) {
          sources.push({ file: configFile, key: "browser_allow", patterns: allow });
        } else {
          errors.push({ file: configFile, message: "browser_allow must be an array of strings" });
        }
      }
    } catch (err) {
      // config.json is read by everything; if it is unreadable the CLI has
      // bigger problems, but for policy purposes we cannot rule a list out.
      errors.push({ file: configFile, message: (err as Error).message });
    }
  }

  if (!sources.length && !errors.length) return null;
  return { sources, errors };
}

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
      `  allow it by adding "${hostOnly(url)}" (or a *.wildcard) to one of those lists`;
  return { message: `refusing to open ${url} — ${verdict.reason}`, hint };
}

function hostOnly(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}
