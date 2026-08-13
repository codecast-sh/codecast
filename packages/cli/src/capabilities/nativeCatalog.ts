// The plugin catalog Claude Code already keeps, read rather than rebuilt.
//
// Claude Code ships a full plugin manager: it clones marketplaces, downloads
// plugins, records a commit sha per install, and can list everything on offer.
// Codecast is a client of that work, never a competitor to it, so this module
// only reads. Nothing here installs, enables, or writes a file.
//
// There are two ways to get the same catalog, and both are used:
//
//   subprocess  `claude plugin list --available --json` — the freshest answer,
//               because Claude Code applies its own scope rules while producing
//               it. Costs ~2.4s and a process.
//   disk        `~/.claude/plugins/marketplaces/<name>/.claude-plugin/marketplace.json`
//               — the catalog file Claude Code cloned. No subprocess, richer per
//               plugin (author, category, homepage, and the source's commit sha),
//               and it carries the `renames` map the CLI listing omits.
//
// The disk read is the fallback, not the second choice: a machine with no
// `claude` on PATH, an old binary without `--available`, or a hung process must
// still produce a catalog. Every function here is total — a missing, slow or
// malformed source yields empty, never a throw. This runs on other people's
// machines against a tool we do not own.
//
// Verified on a real machine, 2026-08-13 (fixtures in `__fixtures__/`):
//
//   * `claude plugin list --available --json` → `{installed: [...], available: [...]}`,
//     297 available entries. `claude plugin list --json`, with no `--available`,
//     returns a BARE ARRAY of the installed rows instead. Both shapes are parsed.
//   * `claude plugin details <id>` has no `--json`; its output is a fixed text
//     layout, and it is the only place the projected token cost appears.
//   * `claude plugin details` fails for some INSTALLED plugins ("not found",
//     exit 1, message on stdout — `ralph-loop@claude-plugins-official` on this
//     machine, while `typescript-lsp@claude-plugins-official`, equally installed
//     and equally disabled, succeeds). Absence of details is therefore normal and
//     never an error the caller has to handle.
//
// Identity is deliberately NOT minted here. A capability slug is built by the
// ingest layer from a source it determined itself (`formatCapabilitySlug`,
// `packages/shared/contracts/capabilities.ts`) — a catalog reader that minted
// slugs would be accepting an identity from whatever a marketplace file claims,
// which is exactly the hijack that contract's prefix rule prevents. This module
// reports facts: which marketplace, which plugin name, which sha.

import * as fs from "fs";
import * as path from "path";
import { AGENT_CLIENTS } from "@codecast/shared/contracts";
import { execFile } from "../proc.js";
import { hasBin } from "../doctorClients.js";
import {
  readKnownMarketplaces,
  type CapabilityScope,
  type InventoryItem,
} from "./inventory.js";

/** Claude Code's own binary name, from the client registry rather than a
 *  literal — the same descriptor the daemon launches and resumes with
 *  (`packages/shared/contracts/agentClients.ts:289`). */
const CLAUDE_BINARY = AGENT_CLIENTS.claude.binary;

/** A listing spends a process and blocks nothing; 20s matches the model
 *  inventory collector's budget for the same class of call
 *  (`packages/cli/src/modelInventory.ts:15`). */
export const NATIVE_CATALOG_TIMEOUT_MS = 20_000;

/**
 * `execFile`'s default `maxBuffer` is 1MB, and the community marketplace alone
 * carries 2,281 plugins with full descriptions. A listing that overflows the
 * buffer fails with ENOBUFS and looks exactly like a broken binary, so the
 * ceiling is raised well past any plausible catalog.
 */
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;

/* --------------------------------------------------------------------------
 * Shapes
 * -------------------------------------------------------------------------- */

/** Where a plugin's bytes come from, as a marketplace describes them.
 *  `path` is a directory inside the marketplace repo (`"./plugins/foo"`), the
 *  form 4 of 5 official entries use; the rest name another repository. */
export interface NativePluginSource {
  kind: "path" | "git" | "git-subdir" | "url" | "other";
  /** The literal `source` string, when the entry gave a string rather than an
   *  object. Preserved so a caller can show what the file actually said. */
  raw?: string;
  url?: string;
  /** Subdirectory inside the repository, for `git-subdir`. */
  path?: string;
  /** A tag or branch. Moving, so it is never a pin on its own. */
  ref?: string;
  /** The commit. This IS the pin, and it comes from the catalog rather than
   *  being invented here. */
  sha?: string;
}

/** One plugin a marketplace offers. Not a `Capability` — no slug, no identity;
 *  see the note about ingest at the top of the file. */
export interface NativePluginOffer {
  /** `name@marketplace`, the id every `claude plugin` command accepts. */
  pluginId: string;
  name: string;
  marketplace: string;
  description?: string;
  version?: string;
  /** `author.name` from the catalog. Anyone may write "Anthropic" there, so it
   *  renders as a claim, never as provenance. */
  publisher?: string;
  category?: string;
  homepage?: string;
  /** Only the CLI listing reports this; the marketplace file does not. */
  installCount?: number;
  tags?: string[];
  source?: NativePluginSource;
}

/** One plugin Claude Code reports as downloaded on this machine. */
export interface NativeInstalledPlugin {
  pluginId: string;
  name: string;
  marketplace?: string;
  version?: string;
  scope: CapabilityScope;
  /** Switched on. Independent of being downloaded: both false-with-installed
   *  and true-without-installed are real states. */
  enabled: boolean;
  installPath?: string;
  installedAt?: string;
  lastUpdated?: string;
  /** Set on a project-scoped install: the checkout it was made for. */
  projectPath?: string;
}

export interface NativePluginList {
  installed: NativeInstalledPlugin[];
  available: NativePluginOffer[];
}

/**
 * A marketplace catalog file, parsed.
 *
 * `renames` is append-only history: a former plugin name maps to its current
 * name, or to `null` when the plugin was removed. Claude Code follows chains,
 * so it is resolved rather than looked up once (`resolvePluginRename`).
 */
export interface NativeMarketplaceCatalog {
  name: string;
  description?: string;
  owner?: string;
  renames: Record<string, string | null>;
  plugins: NativePluginOffer[];
}

export interface NativeCatalog {
  /** Empty when the catalog came from disk — see `degraded`. */
  installed: NativeInstalledPlugin[];
  /**
   * What can be installed here, NOT the whole catalog: Claude Code drops a
   * plugin from `available` once it is installed and loadable at this scope.
   * Verified — the tool offered 297 of the 300 entries in the cloned files, and
   * the three missing ones were exactly the three it had installed and loaded.
   * A library listing is therefore `available` joined with `installed`, never
   * `available` alone.
   */
  available: NativePluginOffer[];
  marketplaces: NativeMarketplaceCatalog[];
  /** How the answer was obtained. `none` means both paths came up empty. */
  origin: "cli" | "disk" | "none";
  /** One short phrase naming what went wrong, written for a person to read.
   *  Present whenever the CLI path did not answer. */
  degraded?: string;
}

/* --------------------------------------------------------------------------
 * Small total helpers
 * -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function scopeOf(value: unknown): CapabilityScope {
  return value === "local" || value === "project" ? value : "user";
}

/** Split `name@marketplace`. The separator cannot occur inside either half —
 *  Claude Code composes the id from a directory name and a marketplace name — so
 *  the first `@` is the boundary. */
export function splitPluginId(pluginId: string): { name: string; marketplace?: string } {
  const at = pluginId.indexOf("@");
  if (at <= 0) return { name: pluginId };
  return { name: pluginId.slice(0, at), marketplace: pluginId.slice(at + 1) || undefined };
}

/** Parse JSON that may be preceded or followed by chatter. A CLI can print an
 *  update notice or a warning around its payload, and losing the whole catalog
 *  to one stray line would be the worst possible trade. */
function parseLooseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Fall through to the bracket scan.
  }
  const start = raw.search(/[[{]/);
  if (start < 0) return undefined;
  const openChar = raw[start];
  const closeChar = openChar === "[" ? "]" : "}";
  const end = raw.lastIndexOf(closeChar);
  if (end <= start) return undefined;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/* --------------------------------------------------------------------------
 * Parsing the CLI listing
 * -------------------------------------------------------------------------- */

function parseInstalledRow(raw: unknown): NativeInstalledPlugin | undefined {
  if (!isRecord(raw)) return undefined;
  const pluginId = text(raw.id);
  if (!pluginId) return undefined;
  const { name, marketplace } = splitPluginId(pluginId);
  const version = text(raw.version);
  const installPath = text(raw.installPath);
  const installedAt = text(raw.installedAt);
  const lastUpdated = text(raw.lastUpdated);
  const projectPath = text(raw.projectPath);
  return {
    pluginId,
    name,
    ...(marketplace ? { marketplace } : {}),
    ...(version ? { version } : {}),
    scope: scopeOf(raw.scope),
    // A row with no `enabled` field is treated as off. Downloaded-but-not-on is
    // the safe reading, and it is also the one the library wants to show as an
    // offer rather than as a live capability.
    enabled: raw.enabled === true,
    ...(installPath ? { installPath } : {}),
    ...(installedAt ? { installedAt } : {}),
    ...(lastUpdated ? { lastUpdated } : {}),
    ...(projectPath ? { projectPath } : {}),
  };
}

function parseAvailableRow(raw: unknown): NativePluginOffer | undefined {
  if (!isRecord(raw)) return undefined;
  const pluginId = text(raw.pluginId);
  const fromId = pluginId ? splitPluginId(pluginId) : undefined;
  const name = text(raw.name) ?? fromId?.name;
  const marketplace = text(raw.marketplaceName) ?? fromId?.marketplace;
  if (!name || !marketplace) return undefined;
  const description = text(raw.description);
  const version = text(raw.version);
  const installCount = count(raw.installCount);
  const source = parsePluginSource(raw.source);
  return {
    pluginId: pluginId ?? `${name}@${marketplace}`,
    name,
    marketplace,
    ...(description ? { description } : {}),
    ...(version ? { version } : {}),
    ...(installCount !== undefined ? { installCount } : {}),
    ...(source ? { source } : {}),
  };
}

/**
 * `claude plugin list --json` output, in either shape it comes in.
 *
 * With `--available` it is `{installed, available}`; without, it is a bare array
 * of the installed rows. Accepting both means a caller that drops `--available`
 * on an older binary still gets its installed set instead of nothing.
 */
export function parsePluginListJson(input: string | unknown): NativePluginList {
  const doc = typeof input === "string" ? parseLooseJson(input) : input;
  const rows = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

  const installedRaw = Array.isArray(doc) ? doc : isRecord(doc) ? rows(doc.installed) : [];
  const availableRaw = isRecord(doc) && !Array.isArray(doc) ? rows(doc.available) : [];

  const installed: NativeInstalledPlugin[] = [];
  for (const row of installedRaw) {
    const parsed = parseInstalledRow(row);
    if (parsed) installed.push(parsed);
  }
  const available: NativePluginOffer[] = [];
  for (const row of availableRaw) {
    const parsed = parseAvailableRow(row);
    if (parsed) available.push(parsed);
  }
  return { installed, available };
}

/* --------------------------------------------------------------------------
 * Parsing a marketplace catalog file
 * -------------------------------------------------------------------------- */

function parsePluginSource(raw: unknown): NativePluginSource | undefined {
  const asString = text(raw);
  if (asString) {
    // A bare string is a directory inside the marketplace repository. It carries
    // no sha of its own — the marketplace's own checkout is the pin.
    const isPath = asString.startsWith(".") || asString.startsWith("/");
    return isPath
      ? { kind: "path", raw: asString, path: asString }
      : { kind: "url", raw: asString, url: asString };
  }
  if (!isRecord(raw)) return undefined;
  const declared = text(raw.source);
  const kind: NativePluginSource["kind"] =
    declared === "git-subdir" || declared === "git" || declared === "url" || declared === "path"
      ? declared
      : "other";
  return {
    kind,
    ...(declared ? { raw: declared } : {}),
    ...(text(raw.url) ? { url: text(raw.url) } : {}),
    ...(text(raw.path) ? { path: text(raw.path) } : {}),
    ...(text(raw.ref) ? { ref: text(raw.ref) } : {}),
    ...(text(raw.sha) ? { sha: text(raw.sha) } : {}),
  };
}

function parseCatalogPlugin(raw: unknown, marketplace: string): NativePluginOffer | undefined {
  if (!isRecord(raw)) return undefined;
  const name = text(raw.name);
  if (!name) return undefined;
  const author = isRecord(raw.author) ? text(raw.author.name) : text(raw.author);
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((t) => text(t)).filter((t): t is string => t !== undefined)
    : undefined;
  const description = text(raw.description);
  const version = text(raw.version);
  const category = text(raw.category);
  const homepage = text(raw.homepage);
  const source = parsePluginSource(raw.source);
  return {
    pluginId: `${name}@${marketplace}`,
    name,
    marketplace,
    ...(description ? { description } : {}),
    ...(version ? { version } : {}),
    ...(author ? { publisher: author } : {}),
    ...(category ? { category } : {}),
    ...(homepage ? { homepage } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(source ? { source } : {}),
  };
}

/**
 * One `.claude-plugin/marketplace.json`, parsed.
 *
 * `fallbackName` names the marketplace when the file omits its own `name` — the
 * directory it was cloned into is what every plugin id on this machine already
 * uses, so it is the right answer rather than a guess.
 */
export function parseMarketplaceJson(
  input: string | unknown,
  fallbackName?: string,
): NativeMarketplaceCatalog | null {
  const doc = typeof input === "string" ? parseLooseJson(input) : input;
  if (!isRecord(doc)) return null;
  const name = text(doc.name) ?? fallbackName;
  if (!name) return null;

  const renames: Record<string, string | null> = {};
  if (isRecord(doc.renames)) {
    for (const [from, to] of Object.entries(doc.renames)) {
      if (to === null) renames[from] = null;
      else if (typeof to === "string" && to.trim()) renames[from] = to.trim();
      // Anything else is not a rename we can act on, so it is dropped rather
      // than stored as a value that would later resolve to nonsense.
    }
  }

  const plugins: NativePluginOffer[] = [];
  if (Array.isArray(doc.plugins)) {
    for (const entry of doc.plugins) {
      const parsed = parseCatalogPlugin(entry, name);
      if (parsed) plugins.push(parsed);
    }
  }

  const description = text(doc.description);
  const owner = isRecord(doc.owner) ? text(doc.owner.name) : text(doc.owner);
  return {
    name,
    ...(description ? { description } : {}),
    ...(owner ? { owner } : {}),
    renames,
    plugins,
  };
}

export interface RenameResolution {
  /** The plugin's current name, or null when the catalog says it was removed. */
  name: string | null;
  /** True when the input name is no longer the current one. */
  renamed: boolean;
  /** The chain that was followed, ending at the resolved name. */
  chain: string[];
  /** True when the chain looped, which `claude plugin validate` rejects but a
   *  hand-edited file can still contain. The last name before the loop wins. */
  cycle: boolean;
}

/**
 * Follow a marketplace's rename history to the plugin's current name.
 *
 * Chains are real: `formatter → code-formatter → formatter-pro` resolves through
 * two entries, so a single lookup answers the wrong question. A `null` entry
 * terminates the chain and means the plugin was removed — which a library UI
 * must show as "gone", not as "missing from the catalog".
 */
export function resolvePluginRename(
  renames: Record<string, string | null> | undefined,
  name: string,
): RenameResolution {
  const chain: string[] = [name];
  if (!renames) return { name, renamed: false, chain, cycle: false };

  const seen = new Set<string>([name]);
  let current = name;
  while (Object.prototype.hasOwnProperty.call(renames, current)) {
    const next = renames[current];
    if (next === null) return { name: null, renamed: true, chain, cycle: false };
    if (seen.has(next)) return { name: current, renamed: current !== name, chain, cycle: true };
    seen.add(next);
    chain.push(next);
    current = next;
  }
  return { name: current, renamed: current !== name, chain, cycle: false };
}

/**
 * The offer a plugin id resolves to today, following renames.
 *
 * Returns `{offer: null, removed: true}` for a plugin the catalog retired: that
 * is a different answer from "we have never heard of it", and the settings file
 * that still names it needs the difference explained.
 */
export function resolveOffer(
  catalog: NativeCatalog,
  pluginId: string,
): { offer: NativePluginOffer | null; removed: boolean; renamedFrom?: string } {
  const { name, marketplace } = splitPluginId(pluginId);
  const market = marketplace
    ? catalog.marketplaces.find((m) => m.name === marketplace)
    : undefined;
  const resolution = resolvePluginRename(market?.renames, name);
  if (resolution.name === null) return { offer: null, removed: true, renamedFrom: name };

  const wanted = marketplace ? `${resolution.name}@${marketplace}` : resolution.name;
  const offer =
    catalog.available.find((o) => o.pluginId === wanted) ??
    (marketplace ? undefined : catalog.available.find((o) => o.name === resolution.name)) ??
    null;
  return {
    offer,
    removed: false,
    ...(resolution.renamed ? { renamedFrom: name } : {}),
  };
}

/* --------------------------------------------------------------------------
 * Projected token cost — `claude plugin details`
 * -------------------------------------------------------------------------- */

/**
 * A token count as Claude Code prints it.
 *
 * The printed forms are `~86 tok`, `~1.4k`, `~0` and `< 20`. The last is a
 * ceiling rather than an estimate, and flattening it to 20 would quietly turn
 * "under twenty" into "twenty" in a total. `underBound` keeps the difference so
 * a sum can say "under" when any of its parts did.
 */
export interface TokenEstimate {
  tokens: number;
  underBound: boolean;
}

export interface PluginComponentCost {
  name: string;
  alwaysOn?: TokenEstimate;
  onInvoke?: TokenEstimate;
}

export interface PluginComponents {
  skills: string[];
  agents: string[];
  hooks: string[];
  mcpServers: string[];
  lspServers: string[];
}

export interface PluginDetails {
  name: string;
  version?: string;
  description?: string;
  /** The `name@marketplace` the tool resolved, or `<name>@inline` for a plugin
   *  loaded from a directory. */
  sourceId?: string;
  components: PluginComponents;
  /** Added to EVERY session, whether or not the plugin is used. This is the
   *  number the library exists to surface. */
  alwaysOn?: TokenEstimate;
  /** Per component, when the tool printed the breakdown. A plugin whose cost
   *  rounds to nothing gets no table at all. */
  perComponent: PluginComponentCost[];
}

/**
 * One printed token count. Returns undefined for anything unrecognised, so a
 * changed layout costs one number rather than the whole reading.
 */
export function parseTokenEstimate(raw: string): TokenEstimate | undefined {
  const match = raw.trim().match(/^([~<≈]?)\s*([\d,]+(?:\.\d+)?)\s*([kKmM])?/);
  if (!match) return undefined;
  const value = Number(match[2].replace(/,/g, ""));
  if (!Number.isFinite(value)) return undefined;
  const scale = match[3]?.toLowerCase() === "k" ? 1_000 : match[3]?.toLowerCase() === "m" ? 1_000_000 : 1;
  return { tokens: Math.round(value * scale), underBound: match[1] === "<" };
}

const COMPONENT_LABELS: Array<{ label: string; key: keyof PluginComponents }> = [
  { label: "Skills", key: "skills" },
  { label: "Agents", key: "agents" },
  { label: "Hooks", key: "hooks" },
  { label: "MCP servers", key: "mcpServers" },
  { label: "LSP servers", key: "lspServers" },
];

/** Component names as the inventory prints them: comma separated, with an
 *  optional trailing note in parentheses ("(harness-only — no model context
 *  cost)") that is commentary rather than a component. */
function parseComponentNames(rest: string): string[] {
  const withoutNote = rest.replace(/\s*\([^)]*\)\s*$/, "");
  return withoutNote
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * `claude plugin details <id>` output.
 *
 * Returns null when the tool did not describe a plugin — most often because it
 * reports "not found" on stdout with exit 1, which happens for plugins that ARE
 * installed (verified: `ralph-loop@claude-plugins-official`). A caller shows the
 * plugin without a cost badge; it does not treat this as a failure.
 */
export function parsePluginDetails(stdout: string): PluginDetails | null {
  const body = stdout.replace(/\r\n/g, "\n");
  if (!body.trim()) return null;
  if (/^\s*Plugin\s+".*?"\s+not found/m.test(body)) return null;

  const lines = body.split("\n");
  const components: PluginComponents = { skills: [], agents: [], hooks: [], mcpServers: [], lspServers: [] };
  const perComponent: PluginComponentCost[] = [];
  let name: string | undefined;
  let version: string | undefined;
  let description: string | undefined;
  let sourceId: string | undefined;
  let alwaysOn: TokenEstimate | undefined;
  let sawSection = false;
  let inCostTable = false;

  for (const line of lines) {
    if (!line.trim()) {
      // A blank line closes the per-component table; the prose that follows it
      // ("On-invoke cost is paid each time…") is not a row.
      inCostTable = false;
      continue;
    }

    // The section headers are flush left too, so they are ruled out before the
    // first flush line is taken as the plugin's name.
    if (/^(Component inventory|Projected token cost|Per-component)/.test(line.trim())) {
      sawSection = true;
      continue;
    }

    if (name === undefined && !/^\s/.test(line)) {
      // The first flush line is `<name>` or `<name> <version>`.
      const parts = line.trim().split(/\s+/);
      const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
      if (last && /^v?\d[\w.+-]*$/.test(last)) {
        version = last;
        name = parts.slice(0, -1).join(" ");
      } else {
        name = parts.join(" ");
      }
      continue;
    }

    const source = line.match(/^\s*Source:\s*(.+)$/);
    if (source) {
      sourceId = source[1].trim();
      continue;
    }

    const component = line.match(/^\s+(.+?)\s*\((\d+)\)\s*(.*)$/);
    if (component) {
      const entry = COMPONENT_LABELS.find((c) => c.label === component[1].trim());
      if (entry) {
        sawSection = true;
        components[entry.key] = parseComponentNames(component[3]);
        continue;
      }
    }

    const always = line.match(/^\s*Always-on:\s*(.+)$/);
    if (always) {
      sawSection = true;
      alwaysOn = parseTokenEstimate(always[1]);
      continue;
    }

    if (/^\s+component\s+always-on/i.test(line)) {
      inCostTable = true;
      continue;
    }

    if (inCostTable) {
      // Columns are separated by runs of two or more spaces, which is what keeps
      // `< 20` (one internal space) intact as a single cell.
      const cells = line.trim().split(/\s{2,}/);
      if (cells.length >= 2) {
        const componentName = cells[0].trim();
        const cost: PluginComponentCost = { name: componentName };
        const first = parseTokenEstimate(cells[1]);
        if (first) cost.alwaysOn = first;
        const second = cells[2] ? parseTokenEstimate(cells[2]) : undefined;
        if (second) cost.onInvoke = second;
        if (componentName) perComponent.push(cost);
      }
      continue;
    }

    // The first indented line before any section is the description.
    if (description === undefined && name !== undefined && !sawSection && /^\s+\S/.test(line)) {
      description = line.trim();
    }
  }

  if (!name || !sawSection) return null;
  return {
    name,
    ...(version ? { version } : {}),
    ...(description ? { description } : {}),
    ...(sourceId ? { sourceId } : {}),
    components,
    ...(alwaysOn ? { alwaysOn } : {}),
    perComponent,
  };
}

/** What a set of plugins adds to every session. `underBound` survives the sum:
 *  a total built from ceilings is itself a ceiling, and rendering it as an exact
 *  figure would overstate what the tool actually measured. */
export function sumAlwaysOn(details: Array<PluginDetails | null | undefined>): TokenEstimate {
  let tokens = 0;
  let underBound = false;
  for (const d of details) {
    if (!d?.alwaysOn) continue;
    tokens += d.alwaysOn.tokens;
    underBound = underBound || d.alwaysOn.underBound;
  }
  return { tokens, underBound };
}

/* --------------------------------------------------------------------------
 * Reading the disk
 * -------------------------------------------------------------------------- */

function marketplacesRoot(home: string): string {
  return path.join(home, ".claude", "plugins", "marketplaces");
}

/** The catalog file for one cloned marketplace, or null if it is not there. */
export function readMarketplaceCatalog(home: string, marketplace: string): NativeMarketplaceCatalog | null {
  const file = path.join(marketplacesRoot(home), marketplace, ".claude-plugin", "marketplace.json");
  try {
    return parseMarketplaceJson(fs.readFileSync(file, "utf-8"), marketplace);
  } catch {
    return null;
  }
}

/**
 * Every marketplace catalog Claude Code has cloned.
 *
 * The registry file is the list of what SHOULD be there
 * (`readKnownMarketplaces`, `inventory.ts:227`); the directory is what actually
 * is. Both are read and merged, because a marketplace can be cloned without the
 * registry mentioning it and registered without having been cloned yet.
 */
export function readMarketplaceCatalogs(home: string): NativeMarketplaceCatalog[] {
  const names = new Set<string>();
  for (const m of readKnownMarketplaces(home)) names.add(m.name);
  try {
    for (const entry of fs.readdirSync(marketplacesRoot(home), { withFileTypes: true })) {
      if (entry.isDirectory()) names.add(entry.name);
    }
  } catch {
    // No marketplaces directory: the registry file's names are all we have.
  }

  const out: NativeMarketplaceCatalog[] = [];
  for (const name of names) {
    const catalog = readMarketplaceCatalog(home, name);
    if (catalog) out.push(catalog);
  }
  return out;
}

/* --------------------------------------------------------------------------
 * Running the tool
 * -------------------------------------------------------------------------- */

export interface NativeCatalogOptions {
  /** Home directory holding `.claude`. Defaults to the process's own. */
  home?: string;
  /** Directory to run `claude` in. Project-scoped plugins depend on it. */
  cwd?: string;
  timeoutMs?: number;
  /** Skip the subprocess entirely and read the cloned catalog files. */
  preferDisk?: boolean;
  /** Injected in tests. Resolves with the tool's stdout, or an error phrase. */
  run?: (args: string[]) => Promise<{ stdout: string; error?: string }>;
}

function defaultHome(): string {
  return process.env.HOME || process.env.USERPROFILE || "";
}

/**
 * Run the `claude` binary, bounded and total.
 *
 * `execFile`'s callback still hands back whatever was printed before a failure,
 * and Claude Code prints its "not found" message on STDOUT with a non-zero exit,
 * so stdout is returned alongside the error rather than discarded.
 */
function runClaude(args: string[], opts: NativeCatalogOptions): Promise<{ stdout: string; error?: string }> {
  if (opts.run) return opts.run(args);
  if (!hasBin(CLAUDE_BINARY)) {
    return Promise.resolve({ stdout: "", error: `${CLAUDE_BINARY} is not on PATH` });
  }
  return new Promise((resolve) => {
    execFile(
      CLAUDE_BINARY,
      args,
      {
        timeout: opts.timeoutMs ?? NATIVE_CATALOG_TIMEOUT_MS,
        maxBuffer: MAX_STDOUT_BYTES,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      },
      (err, stdout) => {
        const out = typeof stdout === "string" ? stdout : "";
        if (!err) return resolve({ stdout: out });
        const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
        resolve({
          stdout: out,
          error: killed ? `${CLAUDE_BINARY} timed out` : err.message.split("\n")[0],
        });
      },
    );
  });
}

/**
 * The catalog this machine can see, from the tool if it answers and from the
 * cloned files if it does not.
 *
 * Never throws and never rejects. A caller that gets `origin: "none"` has a
 * machine with no catalog at all, which is a thing to render, not an error.
 */
export async function loadNativeCatalog(opts: NativeCatalogOptions = {}): Promise<NativeCatalog> {
  const home = opts.home ?? defaultHome();

  const fromDisk = (degraded?: string): NativeCatalog => {
    const marketplaces = readMarketplaceCatalogs(home);
    const available = marketplaces.flatMap((m) => m.plugins);
    return {
      // Deliberately empty: what is INSTALLED and switched on comes from
      // `readInventory` (inventory.ts), which reads the same settings files
      // Claude Code writes and understands how their scopes stack. Recomputing
      // that here from the plugin registry would be a second, worse answer.
      installed: [],
      available,
      marketplaces,
      origin: available.length > 0 || marketplaces.length > 0 ? "disk" : "none",
      ...(degraded ? { degraded } : {}),
    };
  };

  if (opts.preferDisk) return fromDisk();

  const { stdout, error } = await runClaude(["plugin", "list", "--available", "--json"], opts);
  if (error && !stdout.trim()) return fromDisk(error);

  const list = parsePluginListJson(stdout);
  if (list.available.length === 0 && list.installed.length === 0) {
    return fromDisk(error ?? "claude returned no plugins");
  }

  // The catalog files are read even on the happy path: they carry the `renames`
  // map and the per plugin author, category and commit sha that the listing
  // omits, and reading them costs no process.
  const marketplaces = readMarketplaceCatalogs(home);
  const enriched = list.available.map((offer) => {
    const richer = marketplaces
      .find((m) => m.name === offer.marketplace)
      ?.plugins.find((p) => p.name === offer.name);
    return richer ? { ...richer, ...offer, source: offer.source ?? richer.source } : offer;
  });

  return {
    installed: list.installed,
    available: enriched,
    marketplaces,
    origin: "cli",
    ...(error ? { degraded: error } : {}),
  };
}

/**
 * The projected token cost of one plugin, or null when the tool cannot report
 * it. Absence is normal (see `parsePluginDetails`), so this never throws and a
 * caller renders the plugin without a cost badge.
 */
export async function readPluginDetails(
  pluginId: string,
  opts: NativeCatalogOptions = {},
): Promise<PluginDetails | null> {
  const { stdout } = await runClaude(["plugin", "details", pluginId], opts);
  return parsePluginDetails(stdout);
}

/* --------------------------------------------------------------------------
 * Bridging to the machine inventory
 * -------------------------------------------------------------------------- */

/**
 * Installed plugins as inventory rows.
 *
 * `readInventory` reads the settings files directly; this is the same fact from
 * Claude Code's own mouth, in the same shape, so the fleet diff can consume
 * either without a second code path. The meta keys match the ones the diff
 * already reads — `marketplace`, `version`, `projectPath`
 * (`fleetDiff.ts:217-247`).
 */
export function toInventoryItems(installed: NativeInstalledPlugin[], source: string): InventoryItem[] {
  return installed.map((p) => ({
    kind: "plugin" as const,
    name: p.pluginId,
    scope: p.scope,
    enabled: p.enabled,
    installed: true,
    source: p.installPath ?? source,
    meta: {
      plugin: p.name,
      ...(p.marketplace ? { marketplace: p.marketplace } : {}),
      ...(p.version ? { version: p.version } : {}),
      ...(p.projectPath ? { projectPath: p.projectPath } : {}),
    },
  }));
}
