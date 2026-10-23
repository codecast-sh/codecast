// The Vault page's pure rules: reading a pasted .env, telling what a paste is,
// suggesting a name, checking one, a secret's health, and filtering the list. No React, no store,
// so each is tested on its own (vaultModel.test.ts).

import { ENV_NAME_RE, SECRET_NAME_RE, envFor, parseOtpauth, secretHealth, validatePayload, type SecretHealth, type SecretKind, type SecretMeta } from "@codecast/shared/contracts/secrets";
import { findSecrets, replaceSecrets, vaultReference, type FoundSecret } from "@codecast/shared/contracts/secretShapes";

export type EnvEntry = { key: string; value: string };

/**
 * The assignments in .env text: `KEY=value`, `export KEY=value`, quoted values
 * (double quotes take \n escapes, single quotes are literal), an unquoted
 * value's ` # comment` dropped. Comments, blank lines and anything that is not
 * an assignment are skipped; a key given twice keeps its last value, as a
 * shell would.
 */
export function parseEnvText(text: string): EnvEntry[] {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || !ENV_NAME_RE.test(m[1]!)) continue;
    let value = m[2]!;
    const q = value[0];
    if ((q === '"' || q === "'") && value.lastIndexOf(q) > 0) {
      value = value.slice(1, value.lastIndexOf(q));
      if (q === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    if (value) out.set(m[1]!, value);
  }
  return [...out].map(([key, value]) => ({ key, value }));
}

export type PasteKind =
  | { kind: "otp"; seed: string; issuer?: string; account?: string }
  | { kind: "env-line"; env: string; value: string }
  | { kind: "env-file"; entries: EnvEntry[] };

/** What a paste into a value field is, when it is more than a value: a 2FA link, one `KEY=value`, or a whole .env. */
export function classifyPaste(text: string): PasteKind | null {
  const t = text.trim();
  if (/^otpauth:\/\//i.test(t)) {
    const p = parseOtpauth(t);
    return p ? { kind: "otp", seed: t, issuer: p.issuer, account: p.account } : null;
  }
  const entries = parseEnvText(t);
  if (entries.length >= 2) return { kind: "env-file", entries };
  if (entries.length === 1 && !t.includes("\n")) return { kind: "env-line", env: entries[0]!.key, value: entries[0]!.value };
  return null;
}

/** A name as agents would type it: lowercase, dashes, at most 63 characters. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
}

/** The site's own name from a host or URL: `https://dashboard.stripe.com/x` -> `stripe`. */
export function siteName(site: string): string {
  const host = site.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/:].*$/, "").replace(/^www\./, "");
  const parts = host.split(".").filter(Boolean);
  return slugify(parts.length >= 2 ? parts[parts.length - 2]! : (parts[0] ?? ""));
}

/** A name for a new secret from what the person typed so far: the env var, else the site, else what a pasted key is (`sk_test_…` -> stripe-test). */
export function suggestName(fields: { env?: string; site?: string; value?: string; kind: SecretKind }): string {
  if (fields.env?.trim()) return slugify(fields.env);
  if (fields.site?.trim()) {
    const base = siteName(fields.site);
    return base && fields.kind === "signin" ? `${base}-signin` : base;
  }
  const value = fields.value?.trim();
  const shape = value ? findSecrets(value).find((f) => f.start === 0 && f.end === value.length) : undefined;
  return shape?.name ?? "";
}

/** Why a name can't be used here, in a few words, or null. `taken` is every name already in the target workspace. */
export function nameIssue(name: string, taken: ReadonlySet<string>): string | null {
  if (!name) return "Name it";
  if (!SECRET_NAME_RE.test(name)) return "Lowercase letters, digits and dashes";
  if (taken.has(name)) return "Already in this vault";
  return null;
}

/** Names in use in one workspace, the set nameIssue checks against. */
export function namesIn(rows: readonly SecretMeta[], workspace: string | null, except?: string): Set<string> {
  return new Set(rows.filter((r) => r.workspace === workspace && r._id !== except).map((r) => r.name));
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export { secretHealth, type SecretHealth };

/** Each state's word and sol accent, the same on the list and the detail. */
export const HEALTH: Record<SecretHealth, { label: string; tone: "red" | "orange" | "yellow" | "text-dim" }> = {
  expired: { label: "Expired", tone: "red" },
  expiring: { label: "Expiring", tone: "orange" },
  stale: { label: "Not used in 90 days", tone: "yellow" },
  unused: { label: "Never used", tone: "text-dim" },
};

/** A time ahead, as the list reads it: "in 5m", "in 3h", "in 6d". */
export function formatIn(ts: number, now: number): string {
  const ms = Math.max(0, ts - now);
  if (ms < HOUR) return `in ${Math.max(1, Math.floor(ms / 60_000))}m`;
  if (ms < DAY) return `in ${Math.floor(ms / HOUR)}h`;
  return `in ${Math.floor(ms / DAY)}d`;
}

/** A stub from a create on another surface has no short id until the server answers. */
export const isStub = (row: Pick<SecretMeta, "short_id">) => !row.short_id;

/** The env vars a secret fills: the ones it names, else the defaults its name implies. */
export const envVars = (row: Pick<SecretMeta, "name" | "kind" | "env">) => envFor(row).map((b) => b.var);

/**
 * Where a list row says a secret is used: a sign-in's sites (or a secret's
 * sites when it names no env var), else the env vars it names, else the
 * default names it still injects (`implied`, drawn dashed on web).
 */
export function whereUsed(row: Pick<SecretMeta, "name" | "kind" | "env" | "sites">): { sites: boolean; named: string[]; implied: string[] } {
  const sites = row.kind === "signin" || (!row.env?.length && !!row.sites?.length);
  const named = (sites ? row.sites : row.env) ?? [];
  return { sites, named, implied: !sites && !named.length ? envVars(row) : [] };
}

export type Scope = "all" | "team" | "personal";

/**
 * Rows for the list: the scope, then with `attention` only requests and
 * secrets whose health needs a look, then every query word against name, env
 * vars, sites and note. Requests first, then by name.
 */
export function filterSecrets(rows: readonly SecretMeta[], opts: { query: string; scope: Scope; team: string | null; personal: string | null; attention?: boolean; now?: number }): SecretMeta[] {
  const words = opts.query.toLowerCase().split(/\s+/).filter(Boolean);
  const now = opts.now ?? Date.now();
  return rows
    .filter((r) => opts.scope === "all" || r.workspace === (opts.scope === "team" ? opts.team : opts.personal))
    .filter((r) => !opts.attention || r.status === "requested" || secretHealth(r, now) !== null)
    .filter((r) => {
      if (!words.length) return true;
      const hay = [r.name, r.short_id, r.kind, ...(r.env ?? []), ...(r.sites ?? []), r.note ?? ""].join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === "requested" ? -1 : 1));
}

/** Env vars from a chip editor's text: split on spaces and commas. */
export function splitList(text: string): string[] {
  return text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

/** Every field a value form can hold, whatever the kind; the kind picks which become the payload. */
export type ValueDraft = { value: string; username: string; password: string; totp_seed: string; content: string; filename: string };
export const EMPTY_DRAFT: ValueDraft = { value: "", username: "", password: "", totp_seed: "", content: "", filename: "" };

/** The payload a draft makes for a kind, before validatePayload checks it. A sign-in is never typed in. */
export function payloadOf(kind: SecretKind, d: ValueDraft): Record<string, string> | null {
  if (kind === "key") return { value: d.value };
  if (kind === "login") {
    const out: Record<string, string> = {};
    if (d.username.trim()) out.username = d.username;
    if (d.password) out.password = d.password;
    if (d.totp_seed.trim()) out.totp_seed = d.totp_seed;
    return out;
  }
  if (kind === "file") return d.filename.trim() ? { content: d.content, filename: d.filename } : { content: d.content };
  return null;
}

/** A draft's payload, checked by the same rule the server applies; the error never quotes the value. */
export function checkedPayload(kind: SecretKind, draft: ValueDraft): { payload: unknown } | { error: string } {
  const raw = payloadOf(kind, draft);
  if (!raw) return { error: "Save a sign-in from the agent browser with the command above" };
  return validatePayload(kind, raw);
}

/** What each audit event says after the actor's name, on the web panel and the phone. */
export const EVENT_VERB: Record<string, string> = {
  created: "added it",
  updated: "edited it",
  rotated: "replaced the value",
  revealed: "revealed it",
  read: "read it",
  injected: "injected it",
  signed_in: "signed in with it",
  refreshed: "refreshed the sign-in",
  requested: "asked for it",
  fulfilled: "filled it",
  deleted: "deleted it",
  ask_first_on: "turned on Ask first",
  ask_first_off: "turned off Ask first",
  approval_requested: "asked to read it",
  approved: "approved a read",
  denied: "denied a read",
  restored: "restored an earlier value",
  redaction_sync: "synced redaction",
};

/** The sol accent of each event's dot; unlisted kinds stay dim. */
export const EVENT_TONE: Record<string, "blue" | "cyan" | "orange" | "yellow" | "magenta" | "green"> = {
  read: "blue",
  injected: "blue",
  signed_in: "cyan",
  revealed: "orange",
  rotated: "yellow",
  requested: "magenta",
  fulfilled: "green",
  created: "green",
  approval_requested: "magenta",
  approved: "green",
  denied: "orange",
  restored: "yellow",
  ask_first_on: "cyan",
  ask_first_off: "orange",
};

/** Activity with the value swap it has not shown yet: a rotate pressed here stamps rotated_at on the row before its event arrives. */
export function withPendingSwap<E extends { kind: string; at: number }, P>(events: E[], row: Pick<SecretMeta, "rotated_at">, pending: P): (E | P)[] {
  const lastSwap = Math.max(0, ...events.filter((e) => e.kind === "rotated" || e.kind === "restored").map((e) => e.at));
  return row.rotated_at && row.rotated_at > lastSwap ? [pending, ...events] : events;
}

/** A message's text with each caught value (ComposerCatch) swapped for a
 *  reference to the key it was saved as, naming the env vars it sets. */
export function withVaultReferences(text: string, found: readonly FoundSecret[], names: readonly string[]): string {
  return replaceSecrets(
    text,
    found.map((f, i) => ({ start: f.start, end: f.end, with: vaultReference(names[i]!, envFor({ name: names[i]!, kind: "key", env: f.env ? [f.env] : [] }).map((b) => b.var)) })),
  );
}

/**
 * Creates each item not in `saved`, in order, stopping at the first refusal.
 * Answers every index saved so far, so a retry skips the ones already in the
 * Vault instead of finding their names taken.
 */
export async function saveRemaining<T>(items: readonly T[], saved: ReadonlySet<number>, create: (item: T, i: number) => Promise<string | null>): Promise<{ saved: Set<number>; failed?: { index: number; error: string } }> {
  const done = new Set(saved);
  for (const [i, item] of items.entries()) {
    if (done.has(i)) continue;
    const error = await create(item, i);
    if (error) return { saved: done, failed: { index: i, error } };
    done.add(i);
  }
  return { saved: done };
}
