/**
 * Audit trail: where the managed browser has been, per agent session.
 *
 * Always on — the allowlist is optional, the record is not. Every distinct
 * origin a driven tab lands on is appended to a bounded JSONL file, including
 * navigations the policy refused (marked blocked). ORIGINS only, never full
 * URLs: paths and query strings routinely carry tokens and personal data, and
 * "where did the agent go" is answered by the origin.
 *
 * The file lives with the rest of the managed browser's state under
 * ~/.codecast/browser (mode 0700). It is shared by every agent on the machine
 * — each row carries the owner key so `cast browser audit` can show one
 * session's trail and `--all` the machine's.
 *
 * Bounded by rewrite: when the file grows past MAX_RECORDS the oldest half is
 * dropped. Appends are single small writes, so concurrent agents interleave
 * whole lines rather than corrupting each other.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { browserHome } from "./profile.js";
import { checkUrl, isInternalUrl, loadSitePolicy, originOf, type SitePolicy } from "./policy.js";

export type AuditVia = "open" | "action" | "history" | "reload" | "batch";

export interface AuditRecord {
  /** Epoch ms. */
  t: number;
  origin: string;
  /** Owner key of the driving session; null for a human in a bare shell. */
  session: string | null;
  /** Chrome target id of the tab ("-" for a navigation refused before any tab). */
  tab: string;
  via: AuditVia;
  /** Present only when the policy refused or flagged this origin. */
  blocked?: true;
}

const MAX_RECORDS = 4000;
const KEEP_RECORDS = 2000;

export function auditPath(): string {
  return path.join(browserHome(), "audit.jsonl");
}

export function readAudit(): AuditRecord[] {
  return parseAudit(readRaw());
}

function readRaw(): string {
  try {
    return fs.readFileSync(auditPath(), "utf-8");
  } catch {
    return "";
  }
}

function parseAudit(text: string): AuditRecord[] {
  const out: AuditRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as AuditRecord;
      if (typeof rec.t === "number" && typeof rec.origin === "string") out.push(rec);
    } catch {
      /* a torn or foreign line is dropped, not fatal */
    }
  }
  return out;
}

/**
 * Append one visit. Deduplicates against the tab's latest entry — a reload or
 * a settle-check re-reporting the same origin is not a new visit. Returns
 * whether a row was written.
 */
export function recordVisit(rec: AuditRecord): boolean {
  const raw = readRaw();
  const existing = parseAudit(raw);
  for (let i = existing.length - 1; i >= 0; i--) {
    if (existing[i].tab !== rec.tab) continue;
    const last = existing[i];
    if (last.origin === rec.origin && last.session === rec.session && !!last.blocked === !!rec.blocked) {
      return false;
    }
    break; // the tab's latest entry is a different origin — this is a real move
  }
  fs.mkdirSync(browserHome(), { recursive: true, mode: 0o700 });
  // A file whose last write was torn ends without a newline; appending onto it
  // would glue this record to the torn tail and lose BOTH lines. Start clean.
  const lead = raw && !raw.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(auditPath(), `${lead}${JSON.stringify(rec)}\n`);
  if (existing.length + 1 > MAX_RECORDS) {
    const keep = [...existing.slice(-(KEEP_RECORDS - 1)), rec];
    fs.writeFileSync(auditPath(), keep.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  return true;
}

/**
 * Record where a tab actually landed, and say so loudly when the policy would
 * not have allowed it. This is the after-the-fact path: a click, a redirect,
 * or a history move can carry a page somewhere the policy refuses, and by then
 * the page is already there. We never yank it back — the browser is shared and
 * mid-page interference breaks flows — we warn and put it on the record.
 *
 * Returns the warning to print, or null when the landing was in policy.
 */
export function auditLanding(opts: {
  url: string;
  tab: string;
  session: string | null;
  via: AuditVia;
  /** Pass the policy when the caller already loaded it (a batch loads once). */
  policy?: SitePolicy | null;
}): string | null {
  if (isInternalUrl(opts.url)) return null;
  const policy = opts.policy === undefined ? loadSitePolicy() : opts.policy;
  const verdict = checkUrl(policy, opts.url);
  recordVisit({
    t: Date.now(),
    origin: originOf(opts.url),
    session: opts.session,
    tab: opts.tab,
    via: opts.via,
    ...(verdict.allowed ? {} : { blocked: true as const }),
  });
  if (verdict.allowed) return null;
  return (
    `the page landed on ${originOf(opts.url)}, which is OUTSIDE the site allowlist ` +
    `(reached via ${opts.via === "open" ? "a redirect" : opts.via === "action" ? "an in-page action" : opts.via}).\n` +
    `  Recorded in the audit trail (\`cast browser audit\`). Navigate away, or add the origin to the allowlist.`
  );
}

/** Record a navigation the policy refused before it happened. */
export function recordBlocked(url: string, session: string | null, via: AuditVia): void {
  recordVisit({ t: Date.now(), origin: originOf(url), session, tab: "-", via, blocked: true });
}
