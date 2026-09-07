/**
 * Laptop-side transforms for the home mirror: what a file looks like when it
 * leaves the laptop. Pure functions over text/JSON — no filesystem here.
 *
 * Three rules recur in every transform:
 *   - codecast-owned content is stripped (instruction sections, hook
 *     entries) so the host can re-inject its own copies without duplicates;
 *   - secrets and provider-routing keys never ship (see SECRET_KEY_RE,
 *     SECRET_VALUE_RE, CLAUDE_ENV_DENY and the MCP rule);
 *   - laptop-home paths are remapped to the host home in config and
 *     instruction-file kinds; scripts and skill bodies are verbatim.
 */

import * as path from "node:path";
import { REFERENCES_SECTION, SNIPPET_CATALOG, type SectionSpec } from "@codecast/shared/contracts";
import { findOwnedSections } from "@platform/snippets";
import { AGENT_SCRUBBED_ENV_VARS } from "../../agentEnv.js";
import { isCodecastHookCommand } from "../../codecastOwned.js";

export type MirrorKind =
  | "verbatim"
  | "claude-md"
  | "agents-md"
  | "claude-settings"
  | "codex-toml"
  | "codex-hooks"
  | "toml-remap"
  | "json-remap"
  | "gemini-settings"
  | "opencode-json"
  | "gitconfig"
  | "gitignore";

export const MIRROR_KINDS: readonly MirrorKind[] = [
  "verbatim", "claude-md", "agents-md", "claude-settings", "codex-toml", "codex-hooks",
  "toml-remap", "json-remap", "gemini-settings", "opencode-json", "gitconfig", "gitignore",
];

export interface TransformContext {
  /** The laptop's $HOME. */
  fromHome: string;
  /** The host's home. */
  toHome: string;
}

/**
 * A key whose VALUE is a secret, wherever it sits. `token` does not match a
 * key ending in `tokens` (MAX_THINKING_TOKENS, model_max_output_tokens are
 * limits, not secrets) and `auth` only as a whole word or prefix of
 * authorization/authentication/auth_* (never `author`).
 */
export const SECRET_KEY_RE = /(token(?!s$)|secret|passw|api[_-]?key|credential|private[_-]?key|^auth(?:$|[_-]|orization|entication|token))/i;

/** A string VALUE that looks like a secret whatever its key is called. */
export const SECRET_VALUE_RE =
  /(^|\b)(Bearer|Basic)\s+\S|sk-ant-|\bsk-[A-Za-z0-9]{8}|\b(ghp|gho|ghu|ghs|github_pat)_|\bxox[abp]-|\bAKIA[0-9A-Z]{12}|-----BEGIN |:\/\/[^/\s:@]+:[^/\s@]+@/;

/**
 * settings.json env keys that route or authenticate claude on the laptop and
 * would route the host's claude away from the credential the credential push
 * installs. Strings match exactly; RegExps match the whole key.
 */
export const CLAUDE_ENV_DENY: ReadonlyArray<string | RegExp> = [
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  /^CLAUDE_CODE_SKIP_/, "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL", /^ANTHROPIC_DEFAULT_.*_MODEL$/, "ANTHROPIC_CUSTOM_HEADERS",
  /^ANTHROPIC_VERTEX_/, /^ANTHROPIC_BEDROCK_/, /^AWS_/, "CLOUD_ML_REGION",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "OTEL_EXPORTER_OTLP_HEADERS",
  ...AGENT_SCRUBBED_ENV_VARS,
];

export function isDeniedClaudeEnvKey(key: string): boolean {
  return CLAUDE_ENV_DENY.some((d) => (typeof d === "string" ? d === key : d.test(key)));
}

/** Top-level settings.json keys that are laptop-specific or auth-bearing. */
export const CLAUDE_SETTINGS_DROP = [
  "apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "otelHeadersHelper",
  "forceLoginMethod", "forceLoginOrgUUID", "sandbox",
  "enableAllProjectMcpServers", "enabledMcpjsonServers", "disabledMcpjsonServers",
] as const;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace the laptop home prefix with the host home wherever it names a path:
 * followed by `/`, a quote, whitespace or the end of the text — so
 * `/Users/ashot2` is left alone.
 */
export function remapHome(text: string, fromHome: string, toHome: string): string {
  if (!fromHome || fromHome === toHome || fromHome === "/") return text;
  const from = fromHome.replace(/\/+$/, "");
  const re = new RegExp(`${escapeRe(from)}(?=[/"'\\s]|$)`, "g");
  return text.replace(re, toHome.replace(/\/+$/, ""));
}

/** The home-relative path of an absolute path under `home`, or null. */
export function homeRelative(abs: string, home: string): string | null {
  const base = home.replace(/\/+$/, "");
  if (abs === base) return "";
  if (!abs.startsWith(`${base}/`)) return null;
  return abs.slice(base.length + 1);
}

/** The path a command's first token names, `~`-expanded, if it is under `home`. */
function commandPathUnderHome(command: unknown, home: string): string | null {
  if (typeof command !== "string") return null;
  const first = command.trim().split(/\s+/)[0] ?? "";
  const expanded = first.startsWith("~/") ? path.posix.join(home, first.slice(2)) : first;
  if (!expanded.startsWith("/")) return null;
  const rel = homeRelative(expanded, home);
  return rel ? rel : null;
}

// ---------------------------------------------------------------------------
// Instruction files
// ---------------------------------------------------------------------------

/** Every section spec codecast installs into CLAUDE.md / AGENTS.md. */
export function ownedSectionSpecs(): SectionSpec[] {
  const specs = SNIPPET_CATALOG.filter((d) => d.section).map((d) => d.section!.spec);
  specs.push(REFERENCES_SECTION);
  return specs;
}

/** Every codecast-owned block in `text`, across all specs, outermost first, non-overlapping. */
export function findAllOwnedSections(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const spec of ownedSectionSpecs()) ranges.push(...findOwnedSections(text, spec));
  ranges.sort((a, b) => a.start - b.start);
  const out: Array<{ start: number; end: number }> = [];
  let last = -1;
  for (const r of ranges) {
    if (r.start < last) continue;
    out.push(r);
    last = r.end;
  }
  return out;
}

/**
 * The user's own text: every codecast section removed. Only the seam where a
 * block was cut is tidied (a run of blank lines there collapses to one;
 * a cut at the very end leaves a single trailing newline) — everything the
 * user wrote, fenced code included, ships byte for byte.
 */
export function stripOwnedSections(text: string): string {
  const ranges = findAllOwnedSections(text);
  if (!ranges.length) return text;
  let out = "";
  let last = 0;
  for (const r of ranges) {
    out += text.slice(last, r.start);
    out = out.replace(/\n{3,}$/, "\n\n");
    last = r.end;
  }
  const tail = text.slice(last);
  if (tail === "") return out.replace(/\n+$/, "\n");
  return out + tail;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

export interface ScrubResult<T> {
  value: T;
  /** Dotted paths of what was removed, for the dry run and the header. */
  scrubbed: string[];
}

/**
 * Drop every key whose NAME looks secret (at any depth) and every string
 * VALUE that looks like a token, recording what went.
 */
export function scrubSecrets<T>(value: T, label = ""): ScrubResult<T> {
  const scrubbed: string[] = [];
  const walk = (v: unknown, at: string): unknown => {
    if (typeof v === "string") {
      if (SECRET_VALUE_RE.test(v)) { scrubbed.push(at || "(value)"); return undefined; }
      return v;
    }
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      v.forEach((item, i) => {
        const r = walk(item, `${at}[${i}]`);
        if (r !== undefined) out.push(r);
      });
      return out;
    }
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
        const here = at ? `${at}.${k}` : k;
        if (SECRET_KEY_RE.test(k)) { scrubbed.push(here); continue; }
        const r = walk(item, here);
        if (r !== undefined) out[k] = r;
      }
      return out;
    }
    return v;
  };
  return { value: walk(value, label) as T, scrubbed };
}

// ---------------------------------------------------------------------------
// ~/.claude/settings.json
// ---------------------------------------------------------------------------

type HookGroup = { matcher?: string; hooks?: Array<{ command?: string; [k: string]: unknown }>; [k: string]: unknown };
type Hooks = Record<string, HookGroup[]>;

/** Remove codecast's own entries from a hooks table; drop groups/events left empty. */
export function dropCodecastHooks(hooks: unknown, home: string): Hooks | undefined {
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return undefined;
  const out: Hooks = {};
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    const kept: HookGroup[] = [];
    for (const g of groups as HookGroup[]) {
      if (!g || typeof g !== "object") continue;
      const entries = Array.isArray(g.hooks) ? g.hooks.filter((h) => !isCodecastHookCommand(h?.command, home)) : [];
      if (entries.length) kept.push({ ...g, hooks: entries });
    }
    if (kept.length) out[event] = kept;
  }
  return Object.keys(out).length ? out : undefined;
}

function remapHooks(hooks: Hooks | undefined, ctx: TransformContext): Hooks | undefined {
  if (!hooks) return undefined;
  const out: Hooks = {};
  for (const [event, groups] of Object.entries(hooks)) {
    out[event] = groups.map((g) => ({
      ...g,
      hooks: (g.hooks ?? []).map((h) => (typeof h.command === "string" ? { ...h, command: remapHome(h.command, ctx.fromHome, ctx.toHome) } : h)),
    }));
  }
  return out;
}

export interface ClaudeSettingsTransform {
  settings: Record<string, unknown>;
  /** Home-relative files the settings point at (statusLine script) to ship too. */
  referencedFiles: string[];
  scrubbed: string[];
}

/**
 * The laptop's settings.json as the host may receive it: auth/routing keys
 * and the bypass-mode disabler gone, denied and secret-looking env gone,
 * codecast hook entries gone, laptop paths remapped.
 */
export function transformClaudeSettings(input: unknown, ctx: TransformContext): ClaudeSettingsTransform {
  const src = (input && typeof input === "object" && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {}) as Record<string, unknown>;
  const scrubbedAll: string[] = [];
  for (const k of CLAUDE_SETTINGS_DROP) if (k in src) { delete src[k]; scrubbedAll.push(k); }

  if (src.permissions && typeof src.permissions === "object" && !Array.isArray(src.permissions)) {
    const p = { ...(src.permissions as Record<string, unknown>) };
    if ("disableBypassPermissionsMode" in p) { delete p.disableBypassPermissionsMode; scrubbedAll.push("permissions.disableBypassPermissionsMode"); }
    // Path-bearing rules (additionalDirectories, and allow/deny/ask entries
    // like `Read(/Users/x/notes/**)`) point at the host's home.
    for (const key of ["additionalDirectories", "allow", "deny", "ask"]) {
      if (Array.isArray(p[key])) {
        p[key] = (p[key] as unknown[]).map((d) => (typeof d === "string" ? remapHome(d, ctx.fromHome, ctx.toHome) : d));
      }
    }
    src.permissions = p;
  }

  if (src.env && typeof src.env === "object" && !Array.isArray(src.env)) {
    const env: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src.env as Record<string, unknown>)) {
      if (isDeniedClaudeEnvKey(k)) { scrubbedAll.push(`env.${k}`); continue; }
      env[k] = typeof v === "string" ? remapHome(v, ctx.fromHome, ctx.toHome) : v;
    }
    src.env = env;
  }

  const referencedFiles: string[] = [];
  const hooks = dropCodecastHooks(src.hooks, ctx.fromHome);
  if (hooks) src.hooks = remapHooks(hooks, ctx); else delete src.hooks;

  if (src.statusLine && typeof src.statusLine === "object" && !Array.isArray(src.statusLine)) {
    const sl = { ...(src.statusLine as Record<string, unknown>) };
    const ref = commandPathUnderHome(sl.command, ctx.fromHome);
    if (ref) referencedFiles.push(ref);
    if (typeof sl.command === "string") sl.command = remapHome(sl.command, ctx.fromHome, ctx.toHome);
    src.statusLine = sl;
  }

  const { value, scrubbed } = scrubSecrets(src);
  return { settings: value, referencedFiles, scrubbed: [...scrubbedAll, ...scrubbed] };
}

// ---------------------------------------------------------------------------
// TOML (codex, grok) — line-level table splitting; bodies stay opaque
// ---------------------------------------------------------------------------

export interface TomlTable {
  /** null for the preamble before the first header. */
  name: string | null;
  /** The header line itself, verbatim (null for the preamble). */
  header: string | null;
  lines: string[];
}

const TOML_HEADER_RE = /^\s*\[\[?\s*([^\]]*?)\s*\]\]?\s*(#.*)?$/;

/** Split TOML into its top-level tables. Reassembling with joinTomlTables is byte-identical. */
export function splitTomlTables(text: string): TomlTable[] {
  const tables: TomlTable[] = [{ name: null, header: null, lines: [] }];
  for (const line of text.split("\n")) {
    const m = TOML_HEADER_RE.exec(line);
    if (m) tables.push({ name: unquoteTomlKey(m[1]!), header: line, lines: [] });
    else tables[tables.length - 1]!.lines.push(line);
  }
  return tables;
}

export function joinTomlTables(tables: TomlTable[]): string {
  const out: string[] = [];
  for (const t of tables) {
    if (t.header !== null) out.push(t.header);
    out.push(...t.lines);
  }
  return out.join("\n");
}

/** `projects."/Users/x/y"` → `projects./Users/x/y`; quotes only matter for matching the first segment. */
function unquoteTomlKey(raw: string): string {
  return raw.trim();
}

export function tableFirstSegment(name: string): string {
  const m = /^([A-Za-z0-9_-]+|"[^"]*"|'[^']*')/.exec(name);
  return (m?.[1] ?? name).replace(/^["']|["']$/g, "");
}

const TOML_KV_RE = /^(\s*)([A-Za-z0-9_\-."']+)\s*=\s*(.*)$/;

/** Every quoted string inside a TOML value (a plain string, an array, an inline table). */
function tomlStrings(raw: string): string[] {
  const out: string[] = [];
  for (const m of raw.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)) out.push(m[1] !== undefined ? m[1] : m[2]!);
  return out;
}

/** The keys of an inline table value `{ a = 1, b = "x" }`. */
function inlineTableKeys(raw: string): string[] {
  const v = raw.trim();
  if (!v.startsWith("{")) return [];
  return [...v.matchAll(/(?:^\{|,)\s*([A-Za-z0-9_\-."']+)\s*=/g)].map((m) => m[1]!.replace(/^["']|["']$/g, ""));
}

/** Scrub secret keys/values inside one table's lines; remap paths. */
function scrubTomlLines(lines: string[], tableName: string, ctx: TransformContext, scrubbed: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const m = TOML_KV_RE.exec(line);
    if (m) {
      const key = m[2]!.replace(/^["']|["']$/g, "");
      const lastSeg = key.split(".").pop() ?? key;
      const label = tableName ? `${tableName}.${key}` : key;
      if (SECRET_KEY_RE.test(lastSeg) || SECRET_KEY_RE.test(key)) { scrubbed.push(label); continue; }
      if (inlineTableKeys(m[3]!).some((k) => SECRET_KEY_RE.test(k))) { scrubbed.push(label); continue; }
      if (tomlStrings(m[3]!).some((v) => SECRET_VALUE_RE.test(v))) { scrubbed.push(label); continue; }
    }
    out.push(remapHome(line, ctx.fromHome, ctx.toHome));
  }
  return out;
}

export interface TomlTransform {
  text: string;
  scrubbed: string[];
}

/**
 * Codex config.toml for the host: `[projects.*]` (laptop paths; host trust
 * is host-owned) and `[mcp_servers.*]` (the MCP rule) dropped, secret
 * keys/values scrubbed, paths remapped. Unknown tables are byte-identical.
 */
export function transformCodexToml(text: string, ctx: TransformContext): TomlTransform {
  const scrubbed: string[] = [];
  const kept: TomlTable[] = [];
  for (const t of splitTomlTables(text)) {
    if (t.name !== null) {
      const first = tableFirstSegment(t.name);
      if (first === "projects" || first === "mcp_servers") { scrubbed.push(`[${t.name}]`); continue; }
      // A whole table named like a secret (e.g. [model_providers.x.auth]) goes.
      const segs = t.name.split(".").map((s) => s.replace(/^["']|["']$/g, ""));
      if (segs.some((s) => SECRET_KEY_RE.test(s))) { scrubbed.push(`[${t.name}]`); continue; }
    }
    kept.push({ ...t, lines: scrubTomlLines(t.lines, t.name ?? "", ctx, scrubbed) });
  }
  return { text: joinTomlTables(kept), scrubbed };
}

/** Grok's config.toml follows the same rules. */
export const transformGrokToml = transformCodexToml;

/** Any other TOML: scrub + remap, tables kept. */
export function transformTomlRemap(text: string, ctx: TransformContext): TomlTransform {
  const scrubbed: string[] = [];
  const kept = splitTomlTables(text).map((t) => {
    if (t.name !== null && tableFirstSegment(t.name) === "mcp_servers") { scrubbed.push(`[${t.name}]`); return null; }
    return { ...t, lines: scrubTomlLines(t.lines, t.name ?? "", ctx, scrubbed) };
  }).filter((t): t is TomlTable => t !== null);
  return { text: joinTomlTables(kept), scrubbed };
}

// ---------------------------------------------------------------------------
// JSON kinds
// ---------------------------------------------------------------------------

export interface JsonTransform {
  value: unknown;
  scrubbed: string[];
}

/** Parse JSON, tolerating JSONC (line and block comments, trailing commas). */
export function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const stripped = text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(stripped);
  }
}

function remapJsonStrings(value: unknown, ctx: TransformContext): unknown {
  if (typeof value === "string") return remapHome(value, ctx.fromHome, ctx.toHome);
  if (Array.isArray(value)) return value.map((v) => remapJsonStrings(v, ctx));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = remapJsonStrings(v, ctx);
    return out;
  }
  return value;
}

export function transformJsonRemap(value: unknown, ctx: TransformContext): JsonTransform {
  const { value: clean, scrubbed } = scrubSecrets(value);
  return { value: remapJsonStrings(clean, ctx), scrubbed };
}

/** Gemini settings.json: mcpServers gone, then scrub + remap. */
export function transformGeminiSettings(value: unknown, ctx: TransformContext): JsonTransform {
  const src = value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
  const scrubbed: string[] = [];
  if ("mcpServers" in src) { delete src.mcpServers; scrubbed.push("mcpServers"); }
  const r = transformJsonRemap(src, ctx);
  return { value: r.value, scrubbed: [...scrubbed, ...r.scrubbed] };
}

/** opencode.json(c): `mcp` gone, then scrub + remap. */
export function transformOpencodeJson(value: unknown, ctx: TransformContext): JsonTransform {
  const src = value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
  const scrubbed: string[] = [];
  if ("mcp" in src) { delete src.mcp; scrubbed.push("mcp"); }
  const r = transformJsonRemap(src, ctx);
  return { value: r.value, scrubbed: [...scrubbed, ...r.scrubbed] };
}

/** Codex hooks.json: codecast entries gone, commands remapped. */
export function transformHooksJson(value: unknown, ctx: TransformContext): JsonTransform {
  const src = value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
  const hooks = dropCodecastHooks(src.hooks, ctx.fromHome);
  if (hooks) src.hooks = remapHooks(hooks, ctx); else delete src.hooks;
  return { value: src, scrubbed: [] };
}

// ---------------------------------------------------------------------------
// ~/.gitconfig
// ---------------------------------------------------------------------------

export interface GitConfigPair {
  key: string;
  value: string;
}

/**
 * Keys the mirror block may carry. `user.*` and `push.autoSetupRemote` are
 * NOT here: the host's git identity is owned by the host git setup
 * (hostGitScript), which also owns the placeholder rule for repo-local
 * identities.
 */
export const GITCONFIG_ALLOW: ReadonlyArray<string | RegExp> = [
  /^alias\./,
  "core.excludesfile", "core.editor", "core.autocrlf", "core.pager", "core.ignorecase", "core.attributesfile",
  /^init\./, /^pull\./, /^push\./, /^fetch\./, "merge.conflictstyle", "diff.algorithm", "diff.colormoved",
  /^rebase\./, /^rerere\./, /^color\./, /^branch\./, "commit.verbose", "commit.template",
  /^log\./, /^status\./, /^column\./, "help.autocorrect", /^advice\./,
];

export const GITCONFIG_DENY: ReadonlyArray<string | RegExp> = [
  "user.name", "user.email", "push.autosetupremote",
  /^credential\./, /^gpg\./, "commit.gpgsign", "tag.gpgsign", "user.signingkey", /^url\./, /^include/,
  "core.sshcommand", "core.hookspath", /^http\./, /^https\./, /^filter\./, /^lfs\./, /^safe\./, /^maintenance\./,
];

function matchesKey(list: ReadonlyArray<string | RegExp>, key: string): boolean {
  const lower = key.toLowerCase();
  return list.some((d) => (typeof d === "string" ? d === lower : d.test(lower)));
}

export function gitconfigKeyAllowed(key: string): boolean {
  return !matchesKey(GITCONFIG_DENY, key) && matchesKey(GITCONFIG_ALLOW, key);
}

/** Parse `git config --list -z --show-origin` output. */
export function parseGitConfigList(out: string): Array<GitConfigPair & { origin: string }> {
  const pairs: Array<GitConfigPair & { origin: string }> = [];
  const parts = out.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const origin = parts[i]!;
    const kv = parts[i + 1]!;
    const nl = kv.indexOf("\n");
    const key = nl === -1 ? kv : kv.slice(0, nl);
    const value = nl === -1 ? "" : kv.slice(nl + 1);
    if (!key) continue;
    pairs.push({ origin, key, value });
  }
  return pairs;
}

export interface GitconfigRender {
  /** The INI text between the markers (no markers). */
  text: string;
  /** Home-relative files the config points at, to ship verbatim. */
  referencedFiles: string[];
  dropped: string[];
}

function gitQuote(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t");
  return /^\s|\s$|[#;]|^$/.test(value) ? `"${escaped}"` : escaped;
}

/** Deterministic INI from allowed pairs; laptop paths remapped. */
export function renderGitconfig(pairs: GitConfigPair[], ctx: TransformContext): GitconfigRender {
  const referenced = new Set<string>();
  const dropped: string[] = [];
  const sections = new Map<string, string[]>();
  const sorted = [...pairs].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  for (const { key, value } of sorted) {
    if (!gitconfigKeyAllowed(key)) { dropped.push(key); continue; }
    const segs = key.split(".");
    if (segs.length < 2) { dropped.push(key); continue; }
    const section = segs[0]!.toLowerCase();
    const leaf = segs[segs.length - 1]!;
    const sub = segs.slice(1, -1).join(".");
    const header = sub ? `[${section} "${sub.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]` : `[${section}]`;
    let v = value;
    if (["core.excludesfile", "core.attributesfile", "commit.template"].includes(key.toLowerCase())) {
      const abs = v.startsWith("~/") ? path.posix.join(ctx.fromHome, v.slice(2)) : v;
      const rel = homeRelative(abs, ctx.fromHome);
      if (rel) referenced.add(rel);
      v = abs;
    }
    v = remapHome(v, ctx.fromHome, ctx.toHome);
    if (!sections.has(header)) sections.set(header, []);
    sections.get(header)!.push(`\t${leaf} = ${gitQuote(v)}`);
  }
  const out: string[] = [];
  for (const header of [...sections.keys()].sort()) {
    out.push(header, ...sections.get(header)!);
  }
  return { text: out.length ? out.join("\n") + "\n" : "", referencedFiles: [...referenced], dropped };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface TransformOutcome {
  bytes: Buffer;
  scrubbed: string[];
  referencedFiles: string[];
}

/** One entry's bytes for the wire, by kind. Throws on unparseable content. */
export function transformByKind(kind: MirrorKind, bytes: Buffer, ctx: TransformContext): TransformOutcome {
  const text = () => bytes.toString("utf-8");
  const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
  switch (kind) {
    case "verbatim":
    case "gitignore":
    case "gitconfig":
      return { bytes, scrubbed: [], referencedFiles: [] };
    case "claude-md":
    case "agents-md":
      // Paths in an instruction file are informational; a laptop-home path
      // there would send the host's agent to a directory that does not exist.
      return { bytes: Buffer.from(remapHome(stripOwnedSections(text()), ctx.fromHome, ctx.toHome)), scrubbed: [], referencedFiles: [] };
    case "claude-settings": {
      const r = transformClaudeSettings(JSON.parse(text()), ctx);
      return { bytes: json(r.settings), scrubbed: r.scrubbed, referencedFiles: r.referencedFiles };
    }
    case "codex-toml": {
      const r = transformCodexToml(text(), ctx);
      return { bytes: Buffer.from(r.text), scrubbed: r.scrubbed, referencedFiles: [] };
    }
    case "toml-remap": {
      const r = transformTomlRemap(text(), ctx);
      return { bytes: Buffer.from(r.text), scrubbed: r.scrubbed, referencedFiles: [] };
    }
    case "codex-hooks": {
      const r = transformHooksJson(JSON.parse(text()), ctx);
      return { bytes: json(r.value), scrubbed: r.scrubbed, referencedFiles: [] };
    }
    case "json-remap": {
      const r = transformJsonRemap(parseJsonLoose(text()), ctx);
      return { bytes: json(r.value), scrubbed: r.scrubbed, referencedFiles: [] };
    }
    case "gemini-settings": {
      const r = transformGeminiSettings(parseJsonLoose(text()), ctx);
      return { bytes: json(r.value), scrubbed: r.scrubbed, referencedFiles: [] };
    }
    case "opencode-json": {
      const r = transformOpencodeJson(parseJsonLoose(text()), ctx);
      return { bytes: json(r.value), scrubbed: r.scrubbed, referencedFiles: [] };
    }
  }
}

/**
 * Workspace staging: what a project-level agent config file looks like when
 * copied to the host. Settings get the same scrub/remap/hook-drop as the home
 * mirror, codex config.toml the same table rules; everything else is
 * verbatim. Null when the file cannot be parsed — the caller skips it rather
 * than shipping unscrubbed bytes.
 */
export function transformForHost(rel: string, bytes: Buffer, ctx: TransformContext): Buffer | null {
  try {
    if (rel === ".claude/settings.json" || rel === ".claude/settings.local.json") {
      return transformByKind("claude-settings", bytes, ctx).bytes;
    }
    if (rel === ".codex/config.toml") return transformByKind("codex-toml", bytes, ctx).bytes;
    return bytes;
  } catch {
    return null;
  }
}
