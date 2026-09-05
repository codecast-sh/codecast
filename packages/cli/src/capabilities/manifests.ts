// Capability manifests, parsed into the shared contract's observation shapes.
//
// One module owns the four file formats a capability arrives in — SKILL.md,
// plugin.json, .mcp.json, marketplace.json — and turns each into the raw
// OBSERVATION the ingest layer consumes. Observation means: what is actually
// in the file and on the disk, nothing derived. No hash is computed here and
// no execution-surface list is emitted — `manifestHash` and
// `deriveExecutionSurfaces` (`packages/shared/contracts/capabilities.ts`) run
// server side over exactly the `CapabilityManifest` objects built here, so a
// publisher can never hand us a pre-derived answer.
//
// Reuse, not re-parsing:
//   marketplace.json   `parseMarketplaceJson` (nativeCatalog.ts:421) parses the
//                      catalog; this module only layers on the two fields it
//                      drops — per-entry `strict` and component overrides.
//   plugin ids         `splitPluginId` (nativeCatalog.ts:242).
//   install pins       `readInstalledPluginPins` (inventory.ts:402) — the
//                      gitCommitSha per install is read from Claude Code's own
//                      registry, never reinvented.
//   SKILL.md casing    the case-insensitive `SKILL.md` lookup mirrors
//                      `readSkillsIn` (inventory.ts:247).
//
// Every parser is total: a missing, unreadable or malformed input yields an
// observation with `issues` naming what was wrong — or null when there is
// nothing at all to observe — never a throw. This runs over files other tools
// and other people own.
//
// The skill identity rule (agentskills.io spec): THE DIRECTORY NAME IS THE
// IDENTITY. A frontmatter `name` that disagrees is reported as a mismatch, and
// the directory name wins — silently preferring the frontmatter name would let
// a file impersonate another skill.

import * as fs from "fs";
import * as path from "path";
import type { CapabilityManifest } from "@codecast/shared/contracts";
import {
  parseMarketplaceJson,
  splitPluginId,
  type NativeMarketplaceCatalog,
} from "./nativeCatalog.js";
import { readInstalledPluginPins, type CapabilityScope } from "./inventory.js";

/* --------------------------------------------------------------------------
 * Issues
 * -------------------------------------------------------------------------- */

/** One thing wrong with a manifest, named for a person. Reported alongside the
 *  observation rather than instead of it: a mismatched name still describes a
 *  real skill, and dropping it would hide exactly the files worth flagging. */
export interface ManifestIssue {
  code:
    | "missing_frontmatter"
    | "name_mismatch"
    | "name_invalid"
    | "description_missing"
    | "description_overlength"
    | "missing_name"
    | "component_path_invalid"
    | "mcp_url_missing_type"
    | "mcp_server_invalid"
    | "unparseable";
  detail: string;
}

/* --------------------------------------------------------------------------
 * Small total helpers (same conventions as inventory.ts / nativeCatalog.ts;
 * their copies are module-private, and three lines is cheaper than exporting)
 * -------------------------------------------------------------------------- */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseJsonTotal(input: string | unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

function readFileTotal(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
}

/** String or array-of-strings, normalized to an array. Anything else is nothing. */
function stringList(v: unknown): string[] | undefined {
  if (typeof v === "string") return text(v) ? [v.trim()] : undefined;
  if (!Array.isArray(v)) return undefined;
  const out = v.map((item) => text(item)).filter((s): s is string => s !== undefined);
  return out.length > 0 ? out : undefined;
}

/** Every file under `dir`, as sorted relative paths. Bounded depth so a
 *  symlink cycle inside someone else's skill cannot hang a scan. */
function walkFiles(dir: string, depth = 6): string[] {
  if (depth <= 0) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      for (const child of walkFiles(path.join(dir, entry.name), depth - 1)) {
        out.push(`${entry.name}/${child}`);
      }
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      out.push(entry.name);
    }
  }
  return out.sort();
}

/** `${VAR}` and `${VAR:-default}` references in a config string. The variables
 *  Claude Code itself supplies are not something the capability WANTS from the
 *  environment, so they are excluded. */
const PROVIDED_VARS = new Set([
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_SKILL_DIR",
  "CLAUDE_PROJECT_DIR",
]);

function envRefs(value: string, into: Set<string>): void {
  for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)) {
    if (!PROVIDED_VARS.has(match[1])) into.add(match[1]);
  }
}

/* --------------------------------------------------------------------------
 * Frontmatter — the YAML subset real SKILL.md files use
 * -------------------------------------------------------------------------- */

// A full YAML parser is not a dependency this package has, and pulling one in
// for frontmatter would parse far more than the spec allows anyway. This
// covers what exists in the wild (scalars, quoted strings, inline arrays,
// block lists, one-level maps, `|`/`>` blocks) and skips anything else rather
// than guessing — skipping keeps the parser total.

/** Split on a separator at top level only. A comma (or space) inside parens or
 *  quotes is part of the entry: `Bash(git add, git commit)` is ONE tool grant,
 *  and a blind split would feed the consent screen mangled halves. Unbalanced
 *  input never throws — the open paren or quote simply swallows the rest into
 *  its entry, which keeps the parser total. */
function splitTopLevel(input: string, sep: "," | "space"): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: '"' | "'" | undefined;
  let current = "";
  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) out.push(trimmed);
    current = "";
  };
  for (const ch of input) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === "(") {
      depth++;
      current += ch;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (depth === 0 && (sep === "," ? ch === "," : /\s/.test(ch))) {
      flush();
    } else {
      current += ch;
    }
  }
  flush();
  return out;
}

function parseInlineScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner, ",").map((part) => stripQuotes(part));
  }
  return stripQuotes(trimmed);
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

interface Frontmatter {
  present: boolean;
  fields: Record<string, unknown>;
}

export function extractFrontmatter(content: string): Frontmatter {
  const lines = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return { present: false, fields: {} };
  const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line));
  if (end < 0) return { present: false, fields: {} };

  const fields: Record<string, unknown> = {};
  let i = 1;
  while (i < end) {
    const line = lines[i];
    const top = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!top) {
      i++;
      continue;
    }
    const key = top[1];
    const rest = top[2].trim();

    if (/^[|>][+-]?$/.test(rest)) {
      // Block scalar: every following line indented deeper belongs to it.
      const block: string[] = [];
      i++;
      while (i < end && (lines[i].trim() === "" || /^\s+/.test(lines[i]))) {
        block.push(lines[i].replace(/^\s{1,}/, ""));
        i++;
      }
      fields[key] = block.join(rest.startsWith("|") ? "\n" : " ").trim();
      continue;
    }

    if (rest !== "") {
      fields[key] = parseInlineScalar(rest);
      i++;
      continue;
    }

    // Empty value: a block list, a one-level map, or genuinely empty.
    const items: string[] = [];
    const map: Record<string, string> = {};
    let sawList = false;
    let sawMap = false;
    i++;
    while (i < end && /^\s+\S/.test(lines[i])) {
      const child = lines[i].trim();
      const listItem = child.match(/^-\s*(.*)$/);
      const mapItem = child.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (listItem) {
        sawList = true;
        items.push(stripQuotes(listItem[1].trim()));
      } else if (mapItem && !sawList) {
        sawMap = true;
        map[mapItem[1]] = stripQuotes(mapItem[2].trim());
      }
      i++;
    }
    fields[key] = sawList ? items : sawMap ? map : "";
  }
  return { present: true, fields };
}

/* --------------------------------------------------------------------------
 * SKILL.md
 * -------------------------------------------------------------------------- */

/** The six fields the agentskills.io spec allows — the ONLY ones that survive
 *  claude.ai uploads and the Skills API, which reject anything else with a
 *  hard error. Everything a writer emits for a non-claude target must fit
 *  in here. */
export const PORTABLE_SKILL_FIELDS = [
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
] as const;

/** Claude Code's documented extensions. Real files use them, Claude Code
 *  honors them, and every other surface rejects them — so they are preserved
 *  and MARKED, never dropped: the writer keeps them for a claude target and
 *  strips them elsewhere. */
export const CLAUDE_ONLY_SKILL_FIELDS = [
  "when_to_use",
  "argument-hint",
  "arguments",
  "disable-model-invocation",
  "user-invocable",
  "disallowed-tools",
  "model",
  "effort",
  "context",
  "agent",
  "background",
  "hooks",
  "paths",
  "shell",
] as const;

/** Spec constraint on `name`: ≤64 chars, lowercase letters, digits and single
 *  hyphens, no hyphen at either end. */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

export interface SkillPortableFields {
  name?: string;
  description?: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
}

export interface SkillObservation {
  kind: "skill";
  /** The identity: the directory name (or the file stem for a bare `.md`).
   *  Never the frontmatter name — see the module header. */
  name: string;
  portable: SkillPortableFields;
  /** Claude Code-only fields, raw. Kept for a claude target, stripped for
   *  every other one. */
  claudeOnly: Record<string, unknown>;
  /** Fields in neither list (`version` is the common one). Claude Code
   *  ignores them silently; the Skills API rejects them. */
  unknown: Record<string, unknown>;
  /** Observation for `deriveExecutionSurfaces` / `manifestHash` — populated
   *  from the frontmatter here, from the directory walk in
   *  `readSkillObservation`. */
  manifest: CapabilityManifest;
  issues: ManifestIssue[];
}

/** `allowed-tools` in any of its three documented spellings: a YAML list, a
 *  comma separated string, or a space separated string. */
function parseAllowedTools(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return stringList(value);
  const raw = text(value);
  if (!raw) return undefined;
  // Top-level split only: `Bash(git add, git commit)` is one grant in either
  // spelling, so the comma/space inside its parens must not separate. The
  // separator is comma when one exists at top level, else whitespace — a comma
  // that only appears inside parens must not force comma mode, or
  // `Read Bash(git add, git commit)` would collapse into a single entry.
  const byComma = splitTopLevel(raw, ",");
  const out = byComma.length > 1 ? byComma : splitTopLevel(raw, "space");
  return out.length > 0 ? out : undefined;
}

/** Skill-scoped hooks, reduced to the event names the manifest carries. The
 *  full hook config is claude-only detail; the OBSERVATION only needs to say
 *  "this capability registers hooks on these events". */
function hookNames(value: unknown): string[] | undefined {
  if (isRecord(value)) {
    const inner = isRecord(value.hooks) ? value.hooks : value;
    const keys = Object.keys(inner);
    return keys.length > 0 ? keys : undefined;
  }
  return stringList(value);
}

/** Keys are matched with `-` and `_` interchangeable, the same tolerance
 *  `frontmatter()` (inventory.ts:200) has always applied — both spellings
 *  exist in the wild. */
function canon(key: string): string {
  return key.replace(/_/g, "-").toLowerCase();
}

export function parseSkillMd(content: string, identity: string): SkillObservation {
  const issues: ManifestIssue[] = [];
  const { present, fields } = extractFrontmatter(content);
  if (!present) {
    issues.push({ code: "missing_frontmatter", detail: "no YAML frontmatter block at the top of the file" });
  }

  const portableKeys = new Map(PORTABLE_SKILL_FIELDS.map((f) => [canon(f), f]));
  const claudeKeys = new Set(CLAUDE_ONLY_SKILL_FIELDS.map(canon));

  const portable: SkillPortableFields = {};
  const claudeOnly: Record<string, unknown> = {};
  const unknown: Record<string, unknown> = {};

  for (const [rawKey, value] of Object.entries(fields)) {
    const key = canon(rawKey);
    if (portableKeys.has(key)) {
      switch (key) {
        case "name":
          portable.name = text(value);
          break;
        case "description":
          // Preserved raw even when overlength — truncating here would make
          // the observation lie about the file.
          portable.description = typeof value === "string" ? value : text(value);
          break;
        case "license":
          portable.license = text(value);
          break;
        case "compatibility":
          portable.compatibility = text(value);
          break;
        case "metadata":
          if (isRecord(value)) {
            const map: Record<string, string> = {};
            for (const [k, v] of Object.entries(value)) {
              if (typeof v === "string") map[k] = v;
            }
            portable.metadata = map;
          }
          break;
        case "allowed-tools":
          portable.allowedTools = parseAllowedTools(value);
          break;
      }
    } else if (claudeKeys.has(key)) {
      claudeOnly[rawKey] = value;
    } else {
      unknown[rawKey] = value;
    }
  }

  if (portable.name !== undefined && portable.name !== identity) {
    issues.push({
      code: "name_mismatch",
      detail: `frontmatter name "${portable.name}" does not match the directory name "${identity}"; the directory name is the identity`,
    });
  }
  const effectiveName = portable.name ?? identity;
  if (!SKILL_NAME_PATTERN.test(effectiveName) || effectiveName.length > MAX_SKILL_NAME_LENGTH) {
    issues.push({
      code: "name_invalid",
      detail: `"${effectiveName}" breaks the spec's name rule (max 64 chars; lowercase letters, digits and single hyphens)`,
    });
  }
  if (present && !portable.description) {
    issues.push({ code: "description_missing", detail: "description is required and must be non-empty" });
  } else if ((portable.description?.length ?? 0) > MAX_SKILL_DESCRIPTION_LENGTH) {
    issues.push({
      code: "description_overlength",
      detail: `description is ${portable.description!.length} chars; the spec caps it at ${MAX_SKILL_DESCRIPTION_LENGTH}. Preserved unmodified.`,
    });
  }

  const manifest: CapabilityManifest = {};
  if (portable.allowedTools?.length) manifest.allowedTools = portable.allowedTools;
  const hooks = hookNames(claudeOnly["hooks"]);
  if (hooks?.length) manifest.hooks = hooks;

  return { kind: "skill", name: identity, portable, claudeOnly, unknown, manifest, issues };
}

/**
 * One skill from disk: a `<dir>/SKILL.md` directory or a bare `<name>.md` file
 * (the legacy command shape, still read — never emitted). Returns null when
 * there is no skill file to observe at all.
 *
 * The walk fills the manifest's `scripts` and `bin` so the server-side
 * `deriveExecutionSurfaces` sees the real structure: a skill shipping
 * `scripts/` is code whatever its prose says.
 */
export function readSkillObservation(entryPath: string): SkillObservation | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(entryPath);
  } catch {
    return null;
  }

  if (stat.isDirectory()) {
    // Accept either spelling of SKILL.md — same rule as readSkillsIn
    // (inventory.ts:247): a case-insensitive macOS volume lets a lowercase one
    // work locally and then vanish on a case-sensitive disk.
    let manifestFile: string | undefined;
    try {
      manifestFile = fs.readdirSync(entryPath).find((f) => /^skill\.md$/i.test(f));
    } catch {
      return null;
    }
    if (!manifestFile) return null;
    const content = readFileTotal(path.join(entryPath, manifestFile));
    if (content === undefined) return null;

    const observation = parseSkillMd(content, path.basename(entryPath));
    const scripts = walkFiles(path.join(entryPath, "scripts")).map((f) => `scripts/${f}`);
    const bin = walkFiles(path.join(entryPath, "bin")).map((f) => `bin/${f}`);
    if (scripts.length) observation.manifest.scripts = scripts;
    if (bin.length) observation.manifest.bin = bin;
    return observation;
  }

  if (!entryPath.endsWith(".md")) return null;
  const content = readFileTotal(entryPath);
  if (content === undefined) return null;
  return parseSkillMd(content, path.basename(entryPath, ".md"));
}

/* --------------------------------------------------------------------------
 * plugin.json
 * -------------------------------------------------------------------------- */

/**
 * What a declared component path MEANS, per field — the semantics are not
 * uniform and getting them wrong double-counts or hides components:
 * `skills` ADDS to the default `skills/` scan, while `commands`, `agents`,
 * `workflows` and `outputStyles` REPLACE their default directories. `hooks`,
 * `mcpServers` and `lspServers` point at config files rather than scan roots.
 */
export const COMPONENT_PATH_SEMANTICS = {
  skills: "adds",
  commands: "replaces",
  agents: "replaces",
  workflows: "replaces",
  outputStyles: "replaces",
  hooks: "config",
  mcpServers: "config",
  lspServers: "config",
} as const;

export type ComponentPathField = keyof typeof COMPONENT_PATH_SEMANTICS;

export interface UserConfigOption {
  type?: string;
  title?: string;
  description?: string;
  /** Routes the value to the keychain and keeps it out of settings files.
   *  The one flag a consent screen must show. */
  sensitive: boolean;
  required?: boolean;
  multiple?: boolean;
}

export interface PluginJsonObservation {
  /** The only required field. Absence is an issue, not a throw. */
  name?: string;
  displayName?: string;
  version?: string;
  description?: string;
  author?: { name?: string; email?: string; url?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  /** Free-form; Claude Code never acts on it. Carried verbatim. */
  metadata?: Record<string, unknown>;
  defaultEnabled?: boolean;
  /** Declared component paths, per field, exactly as written. Consult
   *  `COMPONENT_PATH_SEMANTICS` for what each list does to the defaults. */
  componentPaths: Partial<Record<ComponentPathField, string[]>>;
  /** `mcpServers`/`lspServers` given inline as objects rather than paths:
   *  the declared server names. */
  inlineServers?: Partial<Record<"mcpServers" | "lspServers", string[]>>;
  userConfig?: Record<string, UserConfigOption>;
  issues: ManifestIssue[];
}

export function parsePluginJson(input: string | unknown): PluginJsonObservation {
  const issues: ManifestIssue[] = [];
  const doc = parseJsonTotal(input);
  if (!isRecord(doc)) {
    return { componentPaths: {}, issues: [{ code: "unparseable", detail: "plugin.json is not a JSON object" }] };
  }

  const name = text(doc.name);
  if (!name) issues.push({ code: "missing_name", detail: "plugin.json declares no name, the one required field" });

  const componentPaths: Partial<Record<ComponentPathField, string[]>> = {};
  const inlineServers: Partial<Record<"mcpServers" | "lspServers", string[]>> = {};
  for (const field of Object.keys(COMPONENT_PATH_SEMANTICS) as ComponentPathField[]) {
    const value = doc[field];
    if (value === undefined) continue;
    if ((field === "mcpServers" || field === "lspServers") && isRecord(value)) {
      const names = Object.keys(value);
      if (names.length > 0) inlineServers[field] = names;
      continue;
    }
    const paths = stringList(value);
    if (!paths) continue;
    componentPaths[field] = paths;
    for (const p of paths) {
      if (!p.startsWith("./")) {
        issues.push({ code: "component_path_invalid", detail: `${field} path "${p}" must start with "./"` });
      }
    }
  }

  let userConfig: Record<string, UserConfigOption> | undefined;
  if (isRecord(doc.userConfig)) {
    userConfig = {};
    for (const [key, raw] of Object.entries(doc.userConfig)) {
      if (!isRecord(raw)) continue;
      userConfig[key] = {
        ...(text(raw.type) ? { type: text(raw.type) } : {}),
        ...(text(raw.title) ? { title: text(raw.title) } : {}),
        ...(text(raw.description) ? { description: text(raw.description) } : {}),
        sensitive: raw.sensitive === true,
        ...(typeof raw.required === "boolean" ? { required: raw.required } : {}),
        ...(typeof raw.multiple === "boolean" ? { multiple: raw.multiple } : {}),
      };
    }
  }

  const author = isRecord(doc.author)
    ? {
        ...(text(doc.author.name) ? { name: text(doc.author.name) } : {}),
        ...(text(doc.author.email) ? { email: text(doc.author.email) } : {}),
        ...(text(doc.author.url) ? { url: text(doc.author.url) } : {}),
      }
    : undefined;

  return {
    ...(name ? { name } : {}),
    ...(text(doc.displayName) ? { displayName: text(doc.displayName) } : {}),
    ...(text(doc.version) ? { version: text(doc.version) } : {}),
    ...(text(doc.description) ? { description: text(doc.description) } : {}),
    ...(author && Object.keys(author).length > 0 ? { author } : {}),
    ...(text(doc.homepage) ? { homepage: text(doc.homepage) } : {}),
    ...(text(doc.repository) ? { repository: text(doc.repository) } : {}),
    ...(text(doc.license) ? { license: text(doc.license) } : {}),
    ...(stringList(doc.keywords) ? { keywords: stringList(doc.keywords) } : {}),
    ...(isRecord(doc.metadata) ? { metadata: doc.metadata } : {}),
    ...(typeof doc.defaultEnabled === "boolean" ? { defaultEnabled: doc.defaultEnabled } : {}),
    componentPaths,
    ...(Object.keys(inlineServers).length > 0 ? { inlineServers } : {}),
    ...(userConfig && Object.keys(userConfig).length > 0 ? { userConfig } : {}),
    issues,
  };
}

/* --------------------------------------------------------------------------
 * .mcp.json
 * -------------------------------------------------------------------------- */

export interface McpServerObservation {
  name: string;
  /** The declared `type`, or "stdio" inferred from a bare `command`. Absent
   *  for the typeless-url misconfiguration, which is reported, not repaired —
   *  Claude Code skips such a server, and inventing "http" here would report
   *  a server as live that is not. */
  transport?: string;
  command?: string;
  args?: string[];
  url?: string;
  /** Header NAMES only. Header values routinely carry bearer tokens, and an
   *  observation is hashed, stored and rendered. */
  headerNames?: string[];
  /** Env var NAMES only, from the `env` map and from `${VAR}` references in
   *  the command, args, url and headers. Never values. */
  envKeys?: string[];
}

export interface McpDocumentObservation {
  servers: McpServerObservation[];
  issues: ManifestIssue[];
}

/**
 * `.mcp.json` in both real shapes: the documented `{mcpServers: {...}}`
 * wrapper (project files) and the bare server map a plugin's `.mcp.json` uses
 * (verified: example-plugin ships `{"example-server": {...}}` with no
 * wrapper).
 */
export function parseMcpJson(input: string | unknown): McpDocumentObservation {
  const issues: ManifestIssue[] = [];
  const doc = parseJsonTotal(input);
  if (!isRecord(doc)) {
    return { servers: [], issues: [{ code: "unparseable", detail: ".mcp.json is not a JSON object" }] };
  }
  const map = isRecord(doc.mcpServers) ? doc.mcpServers : doc;

  const servers: McpServerObservation[] = [];
  for (const [name, raw] of Object.entries(map)) {
    if (!isRecord(raw)) continue;
    const command = text(raw.command);
    const url = text(raw.url);
    const type = text(raw.type);
    if (!command && !url) {
      // Skipping without a word would hide a misconfiguration — the module's
      // contract is that nothing observed vanishes silently.
      issues.push({
        code: "mcp_server_invalid",
        detail: `server "${name}" declares neither a command nor a url; give it one or remove the entry — Claude Code cannot load it as written`,
      });
      continue;
    }

    const args = Array.isArray(raw.args)
      ? raw.args.filter((a): a is string => typeof a === "string")
      : undefined;
    const env = new Set<string>();
    if (isRecord(raw.env)) for (const key of Object.keys(raw.env)) env.add(key);
    for (const value of [command, url, ...(args ?? [])]) {
      if (value) envRefs(value, env);
    }
    const headerNames: string[] = [];
    if (isRecord(raw.headers)) {
      for (const [header, value] of Object.entries(raw.headers)) {
        headerNames.push(header);
        if (typeof value === "string") envRefs(value, env);
      }
    }

    const transport = type ?? (command ? "stdio" : undefined);
    if (url && !type) {
      issues.push({
        code: "mcp_url_missing_type",
        detail: `server "${name}" has a url but no type; Claude Code refuses to load it`,
      });
    }

    servers.push({
      name,
      ...(transport ? { transport } : {}),
      ...(command ? { command } : {}),
      ...(args && args.length > 0 ? { args } : {}),
      ...(url ? { url } : {}),
      ...(headerNames.length > 0 ? { headerNames } : {}),
      ...(env.size > 0 ? { envKeys: [...env].sort() } : {}),
    });
  }
  return { servers, issues };
}

/** Observed servers in the shape `CapabilityManifest.mcp` carries. The command
 *  line is joined with its args — same convention `readMcpFrom`
 *  (inventory.ts:425) uses, because the exact command line is the thing a
 *  consent screen shows. */
export function toManifestMcp(servers: readonly McpServerObservation[]): CapabilityManifest["mcp"] {
  return servers.map((s) => ({
    name: s.name,
    ...(s.command ? { command: [s.command, ...(s.args ?? [])].join(" ") } : {}),
    ...(s.url ? { url: s.url } : {}),
  }));
}

/* --------------------------------------------------------------------------
 * A plugin directory
 * -------------------------------------------------------------------------- */

export interface PluginObservation {
  /** plugin.json's `name`, falling back to the directory name — the manifest
   *  itself is optional. */
  name: string;
  /** Present when `.claude-plugin/plugin.json` existed and parsed. */
  pluginJson?: PluginJsonObservation;
  /** The structural observation: components, bin, scripts, hooks, mcp,
   *  envKeys. This is the object `deriveExecutionSurfaces` and `manifestHash`
   *  are fed server side. */
  manifest: CapabilityManifest;
  /** Skill observations for every skill the plugin ships, so per-skill
   *  identity problems (a mismatched name) surface at the plugin level too. */
  skills: SkillObservation[];
  issues: ManifestIssue[];
}

/** A declared path resolved inside the plugin, or undefined when it escapes —
 *  a `../` in a component path reaches outside the trust unit the plugin is,
 *  and reading there would attribute someone else's files to it. */
function resolveInside(pluginDir: string, declared: string): string | undefined {
  const resolved = path.resolve(pluginDir, declared);
  const root = path.resolve(pluginDir);
  const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);
  if (!inside(resolved, root)) return undefined;
  // The lexical check alone is defeated by a symlink: `./link` resolves inside
  // the plugin as a string while the link points anywhere on disk — and plugin
  // caches are git clones, which carry symlinks. Compare the REAL paths too.
  // A target that does not exist has nothing to attribute either way, so
  // ENOENT falls back to the lexical answer (the caller reports absence).
  try {
    return inside(fs.realpathSync(resolved), fs.realpathSync(root)) ? resolved : undefined;
  } catch {
    return resolved;
  }
}

/** Skill directories under a scan root: each subdirectory holding a SKILL.md.
 *  A root that is itself a skill directory counts as one skill. */
function scanSkillDirs(root: string): string[] {
  try {
    if (fs.readdirSync(root).some((f) => /^skill\.md$/i.test(f))) return [root];
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of readDirTotal(root)) {
    const dir = path.join(root, entry);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (readDirTotal(dir).some((f) => /^skill\.md$/i.test(f))) out.push(dir);
  }
  return out;
}

function readDirTotal(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** `*.md` files under a directory, recursively, as component names — the
 *  relative path minus the extension, so `commands/git/sync.md` observes as
 *  "git/sync". Claude Code namespaces commands by subdirectory, and a flat
 *  scan would undercount both the components and the hash. */
function scanMarkdownNames(dir: string): string[] {
  return walkFiles(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}

/** Hook event names from a `hooks.json`, in both real shapes: the
 *  `{hooks: {Event: [...]}}` wrapper (verified: ralph-loop) and a bare
 *  `{Event: [...]}` map. */
function hookEventsFromFile(file: string): string[] {
  const doc = parseJsonTotal(readFileTotal(file));
  if (!isRecord(doc)) return [];
  const map = isRecord(doc.hooks) ? doc.hooks : doc;
  return Object.keys(map).filter((k) => Array.isArray(map[k]));
}

/**
 * One plugin directory, observed: manifest parsed, components discovered with
 * the per-field semantics applied (skills paths ADD, commands/agents paths
 * REPLACE — `COMPONENT_PATH_SEMANTICS`), hooks and MCP configs read, `bin/`
 * and `scripts/` walked. Returns null only when the directory itself is
 * unreadable — a plugin with no plugin.json is a real, loadable plugin.
 */
export function readPluginObservation(pluginDir: string): PluginObservation | null {
  try {
    if (!fs.statSync(pluginDir).isDirectory()) return null;
  } catch {
    return null;
  }

  const issues: ManifestIssue[] = [];
  const manifestPath = path.join(pluginDir, ".claude-plugin", "plugin.json");
  const manifestRaw = readFileTotal(manifestPath);
  const pluginJson = manifestRaw !== undefined ? parsePluginJson(manifestRaw) : undefined;
  if (pluginJson) issues.push(...pluginJson.issues);
  const name = pluginJson?.name ?? path.basename(pluginDir);

  const declaredPaths = (field: ComponentPathField): string[] => {
    const out: string[] = [];
    for (const declared of pluginJson?.componentPaths[field] ?? []) {
      const resolved = resolveInside(pluginDir, declared);
      if (!resolved) {
        issues.push({
          code: "component_path_invalid",
          detail: `${field} path "${declared}" escapes the plugin directory (through ".." or a symlink); keep component paths inside the plugin`,
        });
        continue;
      }
      // The observation reports what is THERE. A declared path with nothing on
      // disk must not become a component (it would enter the hash and the
      // consent screen as a phantom) — it becomes an issue instead.
      if (!fs.existsSync(resolved)) {
        issues.push({
          code: "component_path_invalid",
          detail: `${field} path "${declared}" is declared in plugin.json but does not exist on disk; fix the path or add the file`,
        });
        continue;
      }
      out.push(resolved);
    }
    return out;
  };
  /** Whether plugin.json said anything for the field. Distinct from
   *  `declaredPaths(...).length`: a field declared with only invalid paths
   *  still REPLACES its default directory — falling back would observe the
   *  exact components the plugin's config switched off. */
  const declaredAny = (field: ComponentPathField): boolean =>
    pluginJson?.componentPaths[field] !== undefined;

  // Skills: the default scan PLUS declared paths. A root SKILL.md is a real
  // shape too (a plugin that is one skill).
  const skillDirs = new Set<string>();
  for (const dir of scanSkillDirs(path.join(pluginDir, "skills"))) skillDirs.add(dir);
  for (const declared of declaredPaths("skills")) {
    for (const dir of scanSkillDirs(declared)) skillDirs.add(dir);
  }
  const rootSkill = readDirTotal(pluginDir).some((f) => /^skill\.md$/i.test(f));
  const skills: SkillObservation[] = [];
  if (rootSkill) {
    const obs = readSkillObservation(pluginDir);
    if (obs) skills.push(obs);
  }
  for (const dir of [...skillDirs].sort()) {
    const obs = readSkillObservation(dir);
    if (obs) skills.push(obs);
  }

  // Commands and agents: declared paths REPLACE the default directory.
  const markdownComponents = (field: "commands" | "agents"): string[] => {
    const roots = declaredAny(field) ? declaredPaths(field) : [path.join(pluginDir, field)];
    const names = new Set<string>();
    for (const root of roots) {
      // declaredPaths already proved a declared root exists, so a `.md` root
      // is a real file here, never a phantom from the manifest.
      if (root.endsWith(".md")) {
        names.add(path.basename(root, ".md"));
        continue;
      }
      for (const stem of scanMarkdownNames(root)) names.add(stem);
    }
    return [...names].sort();
  };
  const commands = markdownComponents("commands");
  const agents = markdownComponents("agents");

  // Hooks: a declared config path, else the default hooks/hooks.json.
  const hookFiles = declaredAny("hooks") ? declaredPaths("hooks") : [path.join(pluginDir, "hooks", "hooks.json")];
  const hookEvents = new Set<string>();
  for (const file of hookFiles) {
    for (const event of hookEventsFromFile(file)) hookEvents.add(event);
  }

  // MCP: a declared config path or inline map, else the default .mcp.json.
  const mcpServers: McpServerObservation[] = [];
  const mcpFiles = declaredAny("mcpServers") ? declaredPaths("mcpServers") : [path.join(pluginDir, ".mcp.json")];
  for (const file of mcpFiles) {
    const raw = readFileTotal(file);
    if (raw === undefined) continue;
    const parsed = parseMcpJson(raw);
    mcpServers.push(...parsed.servers);
    issues.push(...parsed.issues);
  }

  const bin = walkFiles(path.join(pluginDir, "bin")).map((f) => `bin/${f}`);
  const scripts = walkFiles(path.join(pluginDir, "scripts")).map((f) => `scripts/${f}`);

  const envKeys = new Set<string>();
  for (const server of mcpServers) for (const key of server.envKeys ?? []) envKeys.add(key);

  const manifest: CapabilityManifest = {};
  const components: NonNullable<CapabilityManifest["components"]> = {};
  if (skills.length) components.skill = skills.map((s) => s.name);
  if (commands.length) components.command = commands;
  if (agents.length) components.subagent = agents;
  if (mcpServers.length) components.mcp = mcpServers.map((s) => s.name);
  if (hookEvents.size) components.hook = [...hookEvents].sort();
  if (Object.keys(components).length) manifest.components = components;
  if (bin.length) manifest.bin = bin;
  if (scripts.length) manifest.scripts = scripts;
  if (hookEvents.size) manifest.hooks = [...hookEvents].sort();
  if (mcpServers.length) manifest.mcp = toManifestMcp(mcpServers);
  if (envKeys.size) manifest.envKeys = [...envKeys].sort();

  for (const skill of skills) issues.push(...skill.issues);

  return {
    name,
    ...(pluginJson ? { pluginJson } : {}),
    manifest,
    skills,
    issues,
  };
}

/* --------------------------------------------------------------------------
 * marketplace.json — the two fields parseMarketplaceJson drops
 * -------------------------------------------------------------------------- */

export interface MarketplaceEntryExtras {
  name: string;
  /**
   * Who owns the component definitions. `true` (the default): plugin.json is
   * authoritative and the entry may only supplement it. `false`: the
   * marketplace entry IS the definition — how a curator restructures someone
   * else's repo — and a plugin.json that declares components is a conflict.
   */
  strict: boolean;
  /** Component declarations on the entry itself: paths for the markdown
   *  kinds, declared server names for inline `mcpServers`/`lspServers`. */
  components?: Partial<Record<ComponentPathField, string[]>>;
}

export interface MarketplaceManifest {
  /** The catalog exactly as `parseMarketplaceJson` (nativeCatalog.ts:421)
   *  reads it — this module adds to that parse, never repeats it. */
  catalog: NativeMarketplaceCatalog;
  /** Per plugin name, the ownership fields the catalog shape omits. Only
   *  entries that say something beyond the default appear. */
  extras: Record<string, MarketplaceEntryExtras>;
}

export function parseMarketplaceManifest(
  input: string | unknown,
  fallbackName?: string,
): MarketplaceManifest | null {
  const doc = parseJsonTotal(input);
  const catalog = parseMarketplaceJson(doc, fallbackName);
  if (!catalog) return null;

  const extras: Record<string, MarketplaceEntryExtras> = {};
  if (isRecord(doc) && Array.isArray(doc.plugins)) {
    for (const raw of doc.plugins) {
      if (!isRecord(raw)) continue;
      const name = text(raw.name);
      if (!name) continue;
      const strict = raw.strict !== false;

      const components: Partial<Record<ComponentPathField, string[]>> = {};
      for (const field of Object.keys(COMPONENT_PATH_SEMANTICS) as ComponentPathField[]) {
        const value = raw[field];
        if (value === undefined) continue;
        if ((field === "mcpServers" || field === "lspServers") && isRecord(value)) {
          const names = Object.keys(value);
          if (names.length > 0) components[field] = names;
          continue;
        }
        const paths = stringList(value);
        if (paths) components[field] = paths;
      }

      const hasComponents = Object.keys(components).length > 0;
      if (!strict || hasComponents) {
        extras[name] = { name, strict, ...(hasComponents ? { components } : {}) };
      }
    }
  }
  return { catalog, extras };
}

/* --------------------------------------------------------------------------
 * Installed plugins — pins carried through
 * -------------------------------------------------------------------------- */

export interface InstalledPluginObservation {
  /** `name@marketplace`, as Claude Code's registry keys it. */
  pluginId: string;
  scope: CapabilityScope;
  version?: string;
  /** The gitCommitSha Claude Code recorded for this install — the pin, read
   *  from its registry via `readInstalledPluginPins` (inventory.ts:402). */
  sha?: string;
  projectPath?: string;
  /** The install directory, observed — null when the cached bytes are not on
   *  disk (a registry row can outlive its cache directory). */
  observation: PluginObservation | null;
}

/**
 * Every installed plugin's manifest observation, with its pin.
 *
 * The install directory is derived from Claude Code's cache layout
 * (`cache/<marketplace>/<plugin>/<version>`), which matched the registry's
 * own `installPath` for every install on a real machine. If
 * `readInstalledPluginPins` ever surfaces `installPath` directly, prefer it
 * here and delete the derivation.
 */
export function readInstalledPluginObservations(home: string): InstalledPluginObservation[] {
  const out: InstalledPluginObservation[] = [];
  for (const [pluginId, pin] of Object.entries(readInstalledPluginPins(home))) {
    const { name, marketplace } = splitPluginId(pluginId);
    const dir =
      marketplace && pin.version
        ? path.join(home, ".claude", "plugins", "cache", marketplace, name, pin.version)
        : undefined;
    out.push({
      pluginId,
      scope: pin.scope,
      ...(pin.version ? { version: pin.version } : {}),
      ...(pin.sha ? { sha: pin.sha } : {}),
      ...(pin.projectPath ? { projectPath: pin.projectPath } : {}),
      observation: dir ? readPluginObservation(dir) : null,
    });
  }
  return out;
}

export async function readInstalledPluginObservationsAsync(home: string): Promise<InstalledPluginObservation[]> {
  const { scanWorkerHost } = await import('../workers/bridge.js');
  if (scanWorkerHost()) {
    const { collectScan, scanCanFallback } = await import('../workers/scanClient.js');
    try {
      const rows = await collectScan({ name: 'manifests', home });
      return rows.map(row => { if (row.type !== 'manifest') throw new Error('invalid manifest observation'); return row.value as InstalledPluginObservation; });
    } catch (error) { if (!scanCanFallback(error)) throw error; }
  }
  return readInstalledPluginObservations(home);
}
