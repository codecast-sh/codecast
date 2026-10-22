// The Vault page's pure rules: reading a pasted .env, telling what a paste is,
// suggesting a name, checking one, and filtering the list. No React, no store,
// so each is tested on its own (vaultModel.test.ts).

import { ENV_NAME_RE, SECRET_NAME_RE, parseOtpauth, type SecretKind, type SecretMeta } from "@codecast/shared/contracts/secrets";

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

/** A name for a new secret from what the person typed so far: the env var, else the site. */
export function suggestName(fields: { env?: string; site?: string; kind: SecretKind }): string {
  if (fields.env?.trim()) return slugify(fields.env);
  if (fields.site?.trim()) {
    const base = siteName(fields.site);
    return base && fields.kind === "signin" ? `${base}-signin` : base;
  }
  return "";
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

export type Scope = "all" | "team" | "personal";

/** Rows for the list: the scope, then every query word against name, env vars, sites and note. Requests first, then by name. */
export function filterSecrets(rows: readonly SecretMeta[], opts: { query: string; scope: Scope; team: string | null; personal: string | null }): SecretMeta[] {
  const words = opts.query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows
    .filter((r) => opts.scope === "all" || r.workspace === (opts.scope === "team" ? opts.team : opts.personal))
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
