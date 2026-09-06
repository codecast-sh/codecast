// What agent capabilities exist on this machine, and which scope switched each
// one on.
//
// Claude Code already keeps all of this on disk in a machine-readable form, so
// this module READS rather than reconstructs:
//
//   plugins      <project>/.claude/settings.json        (scope: project)
//                <project>/.claude/settings.local.json  (scope: local)
//                ~/.claude/settings.json                (scope: user)
//                  → `enabledPlugins` + `extraKnownMarketplaces`
//   marketplaces ~/.claude/plugins/known_marketplaces.json
//   installs     ~/.claude/plugins/installed_plugins.json  (carries gitCommitSha)
//   mcp          ~/.claude.json → `mcpServers`            (scope: user)
//                <project>/.mcp.json → `mcpServers`       (scope: project)
//   skills       ~/.claude/skills, <project>/.claude/skills
//   commands     ~/.claude/commands, <project>/.claude/commands
//   subagents    ~/.claude/agents, <project>/.claude/agents
//
// Other clients keep their own state on the same disk, and one machine row has
// to span all of them, so each item carries a `client` tag. WHERE each client
// reads from is not knowledge this module keeps: every path comes from the
// client's `agentFileTargets` descriptor (agentClients.ts) — the same verified
// slots the materializing driver writes and `capabilitySupport` derives from.
// One encoding, so the scanner can never report a file a client does not read
// (the descriptor's whole point: a slot is present only when someone verified
// the client loads it), and a slot added to the registry is scanned for free.
//
//   shared       ~/.agents/skills — the cross-client skills directory Codex
//                documents and Cursor reads. Read ONCE: a client-dir symlink
//                into it is reported as a link on the one shared item, never as
//                a second install, so a symlink materializer cannot look like
//                drift.
//
// A client reader is a no-op when the client's dot-dir is absent — the same
// rule the hook installers follow (stableContext.ts, "every installer is a
// no-op when the client's dot-dir is absent").
//
// Scopes STACK rather than override: the same plugin enabled at user and project
// scope reports twice, once per scope. That is what lets the UI answer "why is
// this active here?" by naming the scope that switched it on, so the union is
// preserved rather than flattened.
//
// Every reader is total: nothing here ever throws. But absent and unreadable
// are DIFFERENT answers and the scan reports both. A missing file contributes
// nothing; a file that exists and cannot be read or parsed lands in
// `Inventory.unreadable` with its path and errno. Without that split, a
// half-written ~/.claude.json or a chmod-000 settings file reads as "this
// machine has nothing", and a reconciler then invents drift out of a read
// error. The rule: ENOENT on a path we probed speculatively is absence;
// any failure on a path the filesystem told us exists (a listed directory
// entry, a file that opened but did not parse) is unknown, and unknown must
// never be folded into empty.

import * as fs from "fs";
import * as path from "path";
import { timeSyncFs } from "../slowSync.js";
import { scanWorkerHost } from "../workers/bridge.js";
import { visitScan, scanCanFallback } from "../workers/scanClient.js";
import { AGENT_CLIENTS, observedScopeRank, SNIPPET_CATALOG} from "@codecast/shared/contracts";
import type { AgentClientId } from "@codecast/shared/contracts";

// Both of these are the shared contract's, re-exported so this module's existing
// importers keep their path. They were declared here as narrower copies, and the
// kind list in particular was missing `snippet` and `hook`: `fleetDiff` compiles
// its row order against this union, so the first daemon to report a hook would
// have had the CLI drop it while the Convex fold kept it — the two surfaces
// answering differently on identical data.
import type { InstalledEntry, ObservedScope, CapabilityKind } from "@codecast/shared/contracts";
export type { CapabilityKind };
export type CapabilityScope = ObservedScope;

export interface InventoryItem {
  kind: CapabilityKind;
  /** Unique within its kind: a skill's name, a plugin's `name@marketplace`. */
  name: string;
  /** The library slug, when the scanner can name it with certainty — a builtin
   *  section is `builtin/<slug>` by construction. Absent for anything the
   *  scanner cannot match; the server's catalog matching fills the rest. */
  slug?: string;
  description?: string;
  scope: CapabilityScope;
  /**
   * Whether this capability is actually active.
   *
   * Plugins have three states, and a library UI has to tell them apart: switched
   * on (`enabledPlugins: true`), switched off on purpose (`false` — a decision
   * worth showing rather than an absence), and downloaded but never declared
   * (present only in `installed_plugins.json`, reported with scope `user` and
   * `installed: true`). Everything else is simply present, so it is always
   * `true`.
   */
  enabled: boolean;
  /** Downloaded to disk, whether or not it is switched on. Plugins only. */
  installed?: boolean;
  /** Absolute path to the file that declares or defines it. */
  source: string;
  /**
   * Which agent client this capability belongs to. `"shared"` is the
   * cross-client ~/.agents/skills directory, which every client can read.
   * Optional because `InventoryItem` has a second producer
   * (`nativeCatalog.ts` `toInventoryItems`) and rows from older binaries
   * arrive over the wire without it — absent means `claude`, the only client
   * the scanner knew before the field existed.
   */
  client?: AgentClientId | "shared";
  /** Kind-specific extras — a plugin's marketplace, an MCP server's transport. */
  meta?: Record<string, string>;
}

/**
 * The wire seam, checked at build time.
 *
 * This module is the daemon's producer; the browser and Convex read the very
 * same rows back as the contract's `InstalledEntry`. Nothing at runtime compares
 * the two shapes — a report is serialized here and parsed there — so a field
 * renamed, retyped or made required on either side compiles clean on both and
 * fails only on somebody's machine, as a capability that quietly stops
 * rendering. That is the per-machine, invisible failure the contract's header
 * calls the worst bug this system can have. This line fails the build instead.
 *
 * It is an `extends`, not an equality: the row may carry MORE than the readers
 * model (`client` is ours alone), it may never carry less.
 */
type Conforms<T extends true> = T;
type _RowIsAnInstalledEntry = Conforms<InventoryItem extends InstalledEntry ? true : false>;

export interface MarketplaceRef {
  name: string;
  /** "owner/repo" for a github source, otherwise the raw source string. */
  repo?: string;
  scope: CapabilityScope;
}

/** A path that exists (or was listed) but could not be read or parsed. The
 *  scan's third value: not present, not absent — unknown. Downstream, unknown
 *  never writes and never removes; it produces a conflict record and a
 *  "could not read <path>" on the device card. */
export interface UnreadablePath {
  path: string;
  /** The errno when there is one (EACCES, ELOOP…), otherwise the parse or
   *  stat error's message. */
  error: string;
}

export interface Inventory {
  items: InventoryItem[];
  marketplaces: MarketplaceRef[];
  /** Every path the scan probed that exists but could not be read. Empty means
   *  every absence in `items` is a real absence. */
  unreadable: UnreadablePath[];
}

// ---------------------------------------------------------------- file helpers

function errorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code) return code;
  return err instanceof Error ? err.message : String(err);
}

/** A failed read of a path we probed speculatively: ENOENT/ENOTDIR is honest
 *  absence and stays silent; anything else is unknown and is recorded. */
function noteIfUnreadable(sink: UnreadablePath[] | undefined, p: string, err: unknown): void {
  const code = errorCode(err);
  if (code === "ENOENT" || code === "ENOTDIR") return;
  sink?.push({ path: p, error: code });
}

/** A failed read of a path the filesystem told us exists — a listed directory
 *  entry, a symlink being resolved. Even ENOENT is unknown here (a dangling
 *  symlink lists but does not resolve), so every failure is recorded. */
function noteUnreadable(sink: UnreadablePath[] | undefined, p: string, err: unknown): void {
  sink?.push({ path: p, error: errorCode(err) });
}

function readJson(file: string, sink?: UnreadablePath[]): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    noteIfUnreadable(sink, file, err);
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    // The file exists and opened — a parse failure is a half-written or
    // hand-mangled file, never an empty machine.
    noteUnreadable(sink, file, err);
    return undefined;
  }
}

function readDir(dir: string, sink?: UnreadablePath[]): string[] {
  try {
    return fs.readdirSync(dir);
  } catch (err) {
    noteIfUnreadable(sink, dir, err);
    return [];
  }
}

function fileExists(file: string, sink?: UnreadablePath[]): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch (err) {
    noteIfUnreadable(sink, file, err);
    return false;
  }
}

function dirExists(dir: string, sink?: UnreadablePath[]): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch (err) {
    // An EACCES here (exec-denial on a parent dir) must not read as "client
    // absent" — that is the unknown-as-empty conflation this module bans.
    noteIfUnreadable(sink, dir, err);
    return false;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Frontmatter `key: value` from the head of a markdown file. Mirrors the
 *  tolerant matching `readAvailableSkills` (daemon.ts) has always used —
 *  CC's own field is hyphenated, but the underscore spelling appears in the
 *  wild, so both are accepted. */
function frontmatter(content: string, key: string): string | undefined {
  const pattern = new RegExp(`^---[\\s\\S]*?${key.replace(/-/g, "[-_]")}:\\s*(.+?)[\\r\\n]`, "im");
  return content.match(pattern)?.[1]?.trim();
}

function isHiddenFromMenu(content: string): boolean {
  return /^---[\s\S]*?user[-_]invocable:\s*false\b/im.test(content);
}

// ------------------------------------------------------------------ the roots

/** What one claude scope contributes, in the order it is read. */
interface ClaudeScopePlan {
  scope: CapabilityScope;
  skills?: string;
  commands?: string;
  agents?: string;
  settings?: string;
}

/** Claude's read plan, resolved from its own `agentFileTargets` descriptor so
 *  the paths live in exactly one place (a second hand-kept table here is how
 *  the scanner and the driver drift apart). Claude keeps its bespoke reader —
 *  plugins, the `local` settings overlay, and the read ORDER (which
 *  `toInvocableList` pins against the daemon) are claude-specific — but the
 *  locations all come from the registry. Commands are the one exception: a
 *  read-only legacy kind with no descriptor slot (`capabilitySupport` answers
 *  "unsupported"), so their dir is named here and nowhere else. */
function claudeScopePlans(home: string, projectPath?: string): ClaudeScopePlan[] {
  const targets = AGENT_CLIENTS.claude.agentFileTargets;
  const user = (template: string | undefined) => (template ? fromHomeTemplate(home, template) : undefined);
  const project = (template: string | undefined) =>
    template && projectPath ? path.join(projectPath, template) : undefined;
  const plans: ClaudeScopePlan[] = [
    {
      scope: "user",
      skills: user(targets?.skillsDir?.user),
      commands: path.join(home, ".claude", "commands"),
      agents: user(targets?.agentsDir?.user),
      settings: user(targets?.pluginSettings?.user),
    },
  ];
  if (projectPath) {
    plans.push({
      scope: "project",
      skills: project(targets?.skillsDir?.project),
      commands: path.join(projectPath, ".claude", "commands"),
      agents: project(targets?.agentsDir?.project),
      settings: project(targets?.pluginSettings?.project),
    });
    // `local` shares the project's .claude dir: only its settings overlay is
    // its own — listing the same skills twice would lie about their origin.
    plans.push({ scope: "local", settings: project(targets?.pluginSettings?.local) });
  }
  return plans;
}

// -------------------------------------------------------- markdown capabilities

/** The one reading of ~/.agents/skills, indexed so client-dir symlinks into it
 *  can be attributed to the item they point at instead of re-counted. Keys are
 *  real paths (both the skill's entry and its manifest — a link may point at
 *  either), because the comparison target is `fs.realpathSync` of the link. */
interface SharedSkills {
  index: Map<string, InventoryItem>;
  /** Shared items no client link has claimed yet. A linked item is emitted at
   *  its first link's position — the exact slot the old scanner gave the
   *  symlink entry, which keeps the daemon-parity order `toInvocableList`
   *  pins byte for byte. Whatever is still here after the scan is appended
   *  at the end. */
  unplaced: Set<InventoryItem>;
}

/** Record one more client-dir path that links to a shared skill. */
function appendLink(
  item: InventoryItem,
  linkPath: string,
  client: InventoryItem["client"],
  scope: CapabilityScope,
): void {
  const prev = item.meta?.links;
  item.meta = { ...item.meta, links: prev ? `${prev}\n${linkPath}` : linkPath };
  // The `/` menu is Claude Code's surface: only a link Claude itself follows —
  // one sitting inside a Claude skills dir — puts the shared skill in it.
  // A codex/cursor link must not (`toInvocableList` reads this flag).
  if (client === "claude") item.meta.claude_linked = "true";
  // The item reports the narrowest scope any link installed it at. The old
  // scanner attributed each symlink entry to the dir it sat in; now that the
  // links collapse onto one item, a skill linked only into a project dir must
  // not claim user scope — that would misanswer "why is this active here?".
  if (observedScopeRank(scope) < observedScopeRank(item.scope)) item.scope = scope;
}

/** Skills: a `<dir>/<name>/SKILL.md`, or a bare `<dir>/<name>.md`.
 *  Both layouts are real — `~/.claude/skills` on a live machine holds a mix. */
function readSkillsIn(
  dir: string,
  scope: CapabilityScope,
  client: InventoryItem["client"],
  sink?: UnreadablePath[],
  shared?: SharedSkills,
  onItem?: (item: InventoryItem, entryPath: string) => void,
): InventoryItem[] {
  const out: InventoryItem[] = [];
  for (const entry of readDir(dir, sink)) {
    const entryPath = path.join(dir, entry);
    let content = "";
    let source = entryPath;
    try {
      // A symlink into ~/.agents/skills is that shared skill installed here,
      // not a second skill: report the link on the shared item and move on.
      if (shared && fs.lstatSync(entryPath).isSymbolicLink()) {
        const hit = shared.index.get(fs.realpathSync(entryPath));
        if (hit) {
          appendLink(hit, entryPath, client, scope);
          if (shared.unplaced.delete(hit)) out.push(hit);
          continue;
        }
      }
      if (fs.statSync(entryPath).isDirectory()) {
        // CC writes an uppercase SKILL.md, but a case-insensitive macOS volume
        // lets a lowercase one work locally and then vanish on a case-sensitive
        // one. Accept either spelling so a skill surfaces the same everywhere.
        const manifest = readDir(entryPath, sink).find((f) => /^skill\.md$/i.test(f));
        if (!manifest) continue;
        source = path.join(entryPath, manifest);
        content = fs.readFileSync(source, "utf-8");
      } else if (entry.endsWith(".md")) {
        content = fs.readFileSync(entryPath, "utf-8");
      } else continue;
    } catch (err) {
      // readdir listed this name, so a failure here — a dangling symlink's
      // ENOENT included — is unknown, not absence.
      noteUnreadable(sink, source, err);
      continue;
    }
    if (isHiddenFromMenu(content)) continue;
    const item: InventoryItem = {
      kind: "skill",
      name: frontmatter(content, "name") || entry.replace(/\.md$/, ""),
      description: frontmatter(content, "description"),
      scope,
      enabled: true,
      source,
      client,
    };
    out.push(item);
    onItem?.(item, entryPath);
  }
  return out;
}

function readMarkdownDir(
  dir: string,
  kind: "command" | "subagent",
  scope: CapabilityScope,
  client: InventoryItem["client"],
  sink?: UnreadablePath[],
): InventoryItem[] {
  const out: InventoryItem[] = [];
  for (const file of readDir(dir, sink)) {
    if (!file.endsWith(".md")) continue;
    const source = path.join(dir, file);
    let content = "";
    try {
      content = fs.readFileSync(source, "utf-8");
    } catch (err) {
      noteUnreadable(sink, source, err);
      continue;
    }
    out.push({
      kind,
      name: file.replace(/\.md$/, ""),
      description: frontmatter(content, "description"),
      scope,
      enabled: true,
      source,
      client,
    });
  }
  return out;
}

// ------------------------------------------------------------------- plugins

/** Plugins declared by a settings file, plus the marketplaces it knows.
 *  Verified shape: `{ enabledPlugins: {"name@marketplace": bool},
 *  extraKnownMarketplaces: {name: {source: {source, repo}}} }`. */
function readPluginsFromSettings(settingsFile: string, scope: CapabilityScope, sink?: UnreadablePath[]): {
  items: InventoryItem[];
  marketplaces: MarketplaceRef[];
} {
  const doc = readJson(settingsFile, sink);
  if (!isRecord(doc)) return { items: [], marketplaces: [] };

  const items: InventoryItem[] = [];
  const enabled = doc.enabledPlugins;
  if (isRecord(enabled)) {
    for (const [id, on] of Object.entries(enabled)) {
      if (typeof on !== "boolean") continue;
      const [name, marketplace] = id.split("@");
      items.push({
        kind: "plugin",
        name: id,
        scope,
        enabled: on,
        source: settingsFile,
        client: "claude",
        meta: { plugin: name ?? id, ...(marketplace ? { marketplace } : {}) },
      });
    }
  }

  const marketplaces: MarketplaceRef[] = [];
  const known = doc.extraKnownMarketplaces;
  if (isRecord(known)) {
    for (const [name, entry] of Object.entries(known)) {
      const src = isRecord(entry) && isRecord(entry.source) ? entry.source : undefined;
      const repo = typeof src?.repo === "string" ? src.repo : undefined;
      marketplaces.push({ name, repo, scope });
    }
  }

  return { items, marketplaces };
}

/** Marketplaces Claude Code has actually cloned, from its own registry file. */
export function readKnownMarketplaces(home: string, sink?: UnreadablePath[]): MarketplaceRef[] {
  const doc = readJson(path.join(home, ".claude", "plugins", "known_marketplaces.json"), sink);
  if (!isRecord(doc)) return [];
  const out: MarketplaceRef[] = [];
  for (const [name, entry] of Object.entries(doc)) {
    const src = isRecord(entry) && isRecord(entry.source) ? entry.source : undefined;
    out.push({ name, repo: typeof src?.repo === "string" ? src.repo : undefined, scope: "user" });
  }
  return out;
}

export interface PluginInstall {
  version?: string;
  sha?: string;
  /** The scope the install was made at, as Claude Code recorded it. */
  scope: CapabilityScope;
  /** For a project-scoped install, the project it was made for. A plugin
   *  installed for another checkout is on this disk but not active here. */
  projectPath?: string;
}

/** What Claude Code has actually downloaded, keyed by `name@marketplace`.
 *  It records `gitCommitSha` per install, so sha pinning never has to be
 *  reinvented — it is read from here. */
export function readInstalledPluginPins(home: string, sink?: UnreadablePath[]): Record<string, PluginInstall> {
  const doc = readJson(path.join(home, ".claude", "plugins", "installed_plugins.json"), sink);
  if (!isRecord(doc) || !isRecord(doc.plugins)) return {};
  const out: Record<string, PluginInstall> = {};
  for (const [id, installs] of Object.entries(doc.plugins)) {
    const first = Array.isArray(installs) ? installs[0] : undefined;
    if (!isRecord(first)) continue;
    const scope = first.scope;
    out[id] = {
      version: typeof first.version === "string" ? first.version : undefined,
      sha: typeof first.gitCommitSha === "string" ? first.gitCommitSha : undefined,
      scope: scope === "project" || scope === "local" ? scope : "user",
      projectPath: typeof first.projectPath === "string" ? first.projectPath : undefined,
    };
  }
  return out;
}

// ----------------------------------------------------------------------- mcp

/** MCP servers from one `{mcpServers: {...}}` document — Claude Code's and
 *  Cursor's shared shape. A server is either stdio (`command` + `args`) or
 *  remote (`url` + `type`). */
function readMcpFrom(
  file: string,
  scope: CapabilityScope,
  client: InventoryItem["client"],
  sink?: UnreadablePath[],
): InventoryItem[] {
  const doc = readJson(file, sink);
  if (!isRecord(doc) || !isRecord(doc.mcpServers)) return [];
  const out: InventoryItem[] = [];
  for (const [name, raw] of Object.entries(doc.mcpServers)) {
    if (!isRecord(raw)) continue;
    const url = typeof raw.url === "string" ? raw.url : undefined;
    const command = typeof raw.command === "string" ? raw.command : undefined;
    const transport = typeof raw.type === "string" ? raw.type : url ? "http" : "stdio";
    const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === "string") : [];
    out.push({
      kind: "mcp",
      name,
      scope,
      enabled: true,
      source: file,
      client,
      meta: {
        transport,
        ...(url ? { url } : {}),
        // The exact command line an MCP server will run is the single most
        // important thing to show before enabling one, so it is carried here
        // rather than re-read at render time.
        ...(command ? { command: [command, ...args].join(" ") } : {}),
      },
    });
  }
  return out;
}

// -------------------------------------------------------------- other clients

/** MCP servers from a TOML config's `[mcp_servers]` tables — the
 *  `toml_mcp_servers` shape `agentFileTargets` declares for codex. Read line
 *  by line, deliberately not a TOML dependency: the daemon needs three keys
 *  from one well-known section shape, our own codex writer already does
 *  line-level surgery on this exact file (`ensureCodexHooksFeature`,
 *  stableContext.ts), and a lenient line reader keeps working on the
 *  hand-edited configs a strict parser would reject wholesale — which would
 *  turn one stray line into "this machine has no codex servers".
 *
 *  Handles the layouts real configs use: `[mcp_servers.<name>]` sections,
 *  arrays that span lines (`args = [` … `]`), and inline tables under a bare
 *  `[mcp_servers]` (`name = { command = "npx", … }`). Remaining limits, on
 *  purpose: double-quoted strings only, no dotted keys inside a section. */
function parseTomlMcpServers(toml: string): Array<{ name: string; command?: string; args: string[]; url?: string }> {
  const out: Array<{ name: string; command?: string; args: string[]; url?: string }> = [];
  let current: (typeof out)[number] | undefined;
  /** Set while an `args = [` array is still open — the exact command line is
   *  the single most important thing to show before enabling a server, so a
   *  multi-line array must accumulate, never silently truncate to `[`'s line. */
  let openArgs: (typeof out)[number] | undefined;
  /** Inside a bare `[mcp_servers]` table, whose entries are inline tables. */
  let inRootTable = false;
  for (const line of toml.split(/\r?\n/)) {
    if (openArgs) {
      openArgs.args.push(...[...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]));
      if (line.includes("]")) openArgs = undefined;
      continue;
    }
    // A bare name is one dotless key; a quoted name may contain dots. Written
    // as two alternatives so a nested table like `[mcp_servers.x.env]` falls
    // through to the section guard below instead of minting a phantom server
    // named `x.env` — the real ~/.codex/config.toml on this machine has one.
    const section = line.match(/^\s*\[\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/);
    if (section) {
      current = { name: section[1] ?? section[2], args: [] };
      out.push(current);
      inRootTable = false;
      continue;
    }
    if (/^\s*\[\s*mcp_servers\s*\]\s*(?:#.*)?$/.test(line)) {
      inRootTable = true;
      current = undefined;
      continue;
    }
    // Any other section header (a nested `[mcp_servers.x.env]` included) ends
    // the server's own key block.
    if (/^\s*\[/.test(line)) {
      current = undefined;
      inRootTable = false;
      continue;
    }
    if (inRootTable) {
      // `name = { command = "npx", args = ["-y"] }` — TOML inline tables are
      // single-line by spec, so the three keys can be pulled straight out.
      const inline = line.match(/^\s*(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*=\s*\{(.*)\}\s*(?:#.*)?$/);
      if (inline) {
        const body = inline[3];
        const server: (typeof out)[number] = { name: inline[1] ?? inline[2], args: [] };
        server.command = body.match(/\bcommand\s*=\s*"([^"]*)"/)?.[1];
        server.url = body.match(/\burl\s*=\s*"([^"]*)"/)?.[1];
        const args = body.match(/\bargs\s*=\s*\[([^\]]*)\]/);
        if (args) server.args = [...args[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
        out.push(server);
        continue;
      }
    }
    if (!current) continue;
    const kv = line.match(/^\s*([A-Za-z_][\w-]*)\s*=\s*(.+?)\s*$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    if (key === "command" || key === "url") {
      const str = rawValue.match(/^"([^"]*)"/);
      if (str) current[key] = str[1];
    } else if (key === "args") {
      current.args = [...rawValue.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
      if (rawValue.includes("[") && !rawValue.includes("]")) openArgs = current;
    }
  }
  return out;
}

/** MCP items from a `toml_mcp_servers`-shaped config file. */
function readTomlMcp(
  file: string,
  scope: CapabilityScope,
  client: InventoryItem["client"],
  sink: UnreadablePath[],
): InventoryItem[] {
  let toml: string;
  try {
    toml = fs.readFileSync(file, "utf-8");
  } catch (err) {
    noteIfUnreadable(sink, file, err);
    return [];
  }
  return parseTomlMcpServers(toml).map((server) => ({
    kind: "mcp" as const,
    name: server.name,
    scope,
    enabled: true,
    source: file,
    client,
    meta: {
      transport: server.url ? "http" : "stdio",
      ...(server.url ? { url: server.url } : {}),
      ...(server.command ? { command: [server.command, ...server.args].join(" ") } : {}),
    },
  }));
}

/** Hook items from a `json_hooks`-shaped file — Claude's settings.json matcher
 *  groups with nested `hooks` entries, the schema our own installer writes
 *  (`installStableHookCodex`, stableContext.ts). */
function readJsonHooks(file: string, client: InventoryItem["client"], sink: UnreadablePath[]): InventoryItem[] {
  const out: InventoryItem[] = [];
  const doc = readJson(file, sink);
  if (!isRecord(doc) || !isRecord(doc.hooks)) return out;
  for (const [event, matchers] of Object.entries(doc.hooks)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      if (!isRecord(matcher) || !Array.isArray(matcher.hooks)) continue;
      for (const hook of matcher.hooks) {
        if (!isRecord(hook) || typeof hook.command !== "string") continue;
        out.push({
          kind: "hook",
          // The command's basename alone collides across events, so the
          // event is part of the name.
          name: `${event} ${path.basename(hook.command)}`,
          scope: "user",
          enabled: true,
          source: file,
          client,
          meta: { event, command: hook.command },
        });
      }
    }
  }
  return out;
}

/** An `mdc` instruction directory: `<dir>/*.mdc` (frontmatter carries
 *  `description`) plus plain `.md`. Instruction content, so kind `snippet` —
 *  the same kind vocabulary every other surface ranks. */
function readMdcRules(
  dir: string,
  scope: CapabilityScope,
  client: InventoryItem["client"],
  sink: UnreadablePath[],
): InventoryItem[] {
  const out: InventoryItem[] = [];
  for (const file of readDir(dir, sink)) {
    if (!/\.(md|mdc)$/.test(file)) continue;
    const source = path.join(dir, file);
    let content = "";
    try {
      content = fs.readFileSync(source, "utf-8");
    } catch (err) {
      noteUnreadable(sink, source, err);
      continue;
    }
    out.push({
      kind: "snippet",
      name: file.replace(/\.(md|mdc)$/, ""),
      description: frontmatter(content, "description"),
      scope,
      enabled: true,
      source,
      client,
      meta: { role: "rule" },
    });
  }
  return out;
}

/** Expand one `agentFileTargets` home template (`~/…`). The contract keeps
 *  user paths as templates because the shared module is isomorphic and cannot
 *  resolve `~`; this module runs on the machine, so it is the resolver. */
function fromHomeTemplate(home: string, template: string): string {
  return path.join(home, template.replace(/^~\//, ""));
}

/**
 * One non-claude client's capabilities, read from the slots its
 * `agentFileTargets` descriptor declares — nothing here knows a path of its
 * own. Gated on the client's `~/.<id>` dot-dir: a machine without the client
 * reports zero items and zero unreadable paths, because absence of the client
 * is not a read failure.
 */
function readClientItems(
  clientId: Extract<AgentClientId, "codex" | "cursor">,
  home: string,
  projectPath: string | undefined,
  sink: UnreadablePath[],
  shared: SharedSkills,
): InventoryItem[] {
  const targets = AGENT_CLIENTS[clientId].agentFileTargets;
  if (!targets) return [];
  if (!dirExists(path.join(home, `.${clientId}`), sink)) return [];
  const user = (template: string | undefined) => (template ? fromHomeTemplate(home, template) : undefined);
  const project = (template: string | undefined) =>
    template && projectPath ? path.join(projectPath, template) : undefined;
  const out: InventoryItem[] = [];

  // Skills. The user slot may BE a cross-client dir (codex documents
  // ~/.agents/skills as its user path); those are read once up front, so a slot
  // naming one is skipped here rather than double-counted. Checked against every
  // shared dir rather than only this client's own: what matters is whether the
  // directory was already read, not which descriptor happened to declare it.
  const sharedDirs = new Set(sharedSkillDirs(home));
  const skillsUser = user(targets.skillsDir?.user);
  if (skillsUser && !sharedDirs.has(skillsUser)) {
    out.push(...readSkillsIn(skillsUser, "user", clientId, sink, shared));
  }
  const skillsProject = project(targets.skillsDir?.project);
  if (skillsProject) out.push(...readSkillsIn(skillsProject, "project", clientId, sink, shared));

  // Subagents.
  const agentsUser = user(targets.agentsDir?.user);
  if (agentsUser) out.push(...readMarkdownDir(agentsUser, "subagent", "user", clientId, sink));
  const agentsProject = project(targets.agentsDir?.project);
  if (agentsProject) out.push(...readMarkdownDir(agentsProject, "subagent", "project", clientId, sink));

  // MCP, dispatched on the declared file shape.
  const readMcp = targets.mcpConfig?.shape === "toml_mcp_servers" ? readTomlMcp : readMcpFrom;
  const mcpUser = user(targets.mcpConfig?.user);
  if (mcpUser) out.push(...readMcp(mcpUser, "user", clientId, sink));
  const mcpProject = project(targets.mcpConfig?.project);
  if (mcpProject) out.push(...readMcp(mcpProject, "project", clientId, sink));

  // Hooks. Only the shape our own writer produces is parseable; `unverified`
  // names an observed file whose schema nobody confirmed, so reading it would
  // be a guess — the slot grants no support and grants no scan either.
  if (targets.hooksConfig?.shape === "json_hooks") {
    out.push(...readJsonHooks(fromHomeTemplate(home, targets.hooksConfig.path), clientId, sink));
  }

  // Instructions. `markdown` is one always-loaded file — presence is the
  // capability, the content is free-form prose, not components. `mdc` is a
  // rules directory of one snippet per file.
  const instruction = targets.instructionFile;
  if (instruction) {
    for (const [scope, target] of [
      ["user", user(instruction.user)],
      ["project", project(instruction.project)],
    ] as Array<[CapabilityScope, string | undefined]>) {
      if (!target) continue;
      if (instruction.format === "mdc") {
        out.push(...readMdcRules(target, scope, clientId, sink));
      } else if (fileExists(target, sink)) {
        out.push({
          kind: "snippet",
          name: path.basename(target),
          scope,
          enabled: true,
          source: target,
          client: clientId,
          meta: { role: "instructions" },
        });
        // Plus one entry per BUILTIN section installed inside it. The file's
        // presence says "instructions exist"; the sections say WHICH codecast
        // capabilities are on — the granularity a builtin/<slug> binding needs
        // to cross-reference against, and what the Installed tab shows as
        // "on N machines". Detected by each spec's own end marker, the same
        // signal cast install/uninstall key on.
        let content = "";
        try {
          content = fs.readFileSync(target, "utf-8");
        } catch (err) {
          noteUnreadable(sink, target, err);
        }
        if (content) {
          for (const entry of SNIPPET_CATALOG) {
            const spec = entry.section?.spec;
            if (!spec || !content.includes(spec.endMarker)) continue;
            out.push({
              kind: "snippet",
              name: entry.slug,
              description: entry.desc,
              scope,
              enabled: true,
              source: target,
              client: clientId,
              slug: `builtin/${entry.slug}`,
              meta: { role: "builtin_section" },
            });
          }
        }
      }
    }
  }

  return out;
}

/** The cross-client user skills dirs, taken from every descriptor that declares
 *  one rather than spelled out here — the same rule the rest of this module
 *  follows, and the reason a slot verified into the registry is scanned for
 *  free. A SET because several clients name the same directory (`~/.agents/skills`
 *  for both codex and cursor today): reading it twice would report one skill as
 *  two, which the fleet diff renders as drift that is not there. */
function sharedSkillDirs(home: string): string[] {
  const dirs = new Set<string>();
  for (const client of Object.values(AGENT_CLIENTS)) {
    const shared = client.agentFileTargets?.skillsDir?.shared;
    if (shared) dirs.add(fromHomeTemplate(home, shared));
  }
  return [...dirs];
}

/** The one read of the cross-client skills dirs. Layouts match `readSkillsIn`;
 *  the index maps every real path a client symlink could resolve to (the skill's
 *  entry and its manifest) back to the emitted item. */
function readSharedAgentSkills(home: string, sink: UnreadablePath[]): { items: InventoryItem[]; shared: SharedSkills } {
  const shared: SharedSkills = { index: new Map(), unplaced: new Set() };
  const items: InventoryItem[] = [];
  for (const dir of sharedSkillDirs(home)) {
    items.push(...readSkillsIn(dir, "user", "shared", sink, undefined, (item, entryPath) => {
      shared.unplaced.add(item);
      try {
        shared.index.set(fs.realpathSync(entryPath), item);
        shared.index.set(fs.realpathSync(item.source), item);
      } catch {
        // The entry was just read, so a realpath failure is a race; the item
        // still reports, it just cannot receive links.
      }
    }));
  }
  return { items, shared };
}

// ------------------------------------------------------------------ the scan

/**
 * Everything installed for Claude Code on this machine, for one project.
 *
 * `projectPath` is optional and should be omitted unless it is trustworthy —
 * the daemon treats a path that does not exist, or that equals $HOME, as a
 * failed resolution, and passing one here would attribute the user's whole home
 * directory to a project.
 */
export function readInventory(home: string, projectPath?: string): Inventory {
  // Timed here rather than at a caller: the daemon's skills lookup and the
  // heartbeat's capability inventory both walk through this one function.
  return timeSyncFs("readInventory", projectPath ?? "global", () => {
    const scan = inventorySteps(home, projectPath);
    for (const step of scan.steps) step.run();
    return scan.finish();
  });
}

/**
 * The same scan for the daemon's heartbeat: one directory read per turn of
 * the loop, so a machine with hundreds of skills never holds the loop for the
 * whole tree. Same steps, same order, same output as readInventory.
 */
export async function readInventoryAsync(home: string, projectPath?: string): Promise<Inventory> {
  if (scanWorkerHost()) {
    try {
      const inventory: Inventory = { items: [], marketplaces: [], unreadable: [] };
      await visitScan({ name: "inventory", home, ...(projectPath ? { projectPath } : {}) }, rows => {
       for (const row of rows) {
        if (row.type === "item") inventory.items.push(row.value as InventoryItem);
        else if (row.type === "marketplace") inventory.marketplaces.push(row.value as MarketplaceRef);
        else if (row.type === "unreadable") inventory.unreadable.push(row.value as UnreadablePath);
        else throw new Error("invalid inventory observation");
       }
      });
      return inventory;
    } catch (error) { if (!scanCanFallback(error)) throw error; }
  }
  return readInventoryAsyncLocal(home, projectPath);
}

export async function readInventoryAsyncLocal(home: string, projectPath?: string): Promise<Inventory> {
  const scan = inventorySteps(home, projectPath);
  for (const step of scan.steps) {
    timeSyncFs("readInventory step", step.label, step.run);
    await new Promise((resolve) => setImmediate(resolve));
  }
  return scan.finish();
}

interface InventoryStep {
  label: string;
  run: () => void;
}

/**
 * The scan as a list of steps over shared accumulators. Each step is one
 * directory or file read; the drivers above decide whether to yield between
 * them. The order is the output order, so both drivers produce byte identical
 * inventories.
 */
function inventorySteps(home: string, projectPath?: string): { steps: InventoryStep[]; finish(): Inventory } {
  const unreadable: UnreadablePath[] = [];
  const items: InventoryItem[] = [];
  const marketplaces: MarketplaceRef[] = [];
  // The shared skills directory is read before any client dir so a client's
  // symlink into it can attach to the item it points at. Items are NOT pushed
  // there: a linked one enters at its first link's position, and the rest are
  // appended after the scan — see `SharedSkills.unplaced`.
  let sharedSkills: ReturnType<typeof readSharedAgentSkills> | undefined;
  const shared = () => sharedSkills!.shared;
  const steps: InventoryStep[] = [
    { label: "known marketplaces", run: () => { marketplaces.push(...readKnownMarketplaces(home, unreadable)); } },
    { label: "shared agent skills", run: () => { sharedSkills = readSharedAgentSkills(home, unreadable); } },
  ];

  for (const { scope, skills, commands, agents, settings } of claudeScopePlans(home, projectPath)) {
    if (skills) steps.push({ label: skills, run: () => { items.push(...readSkillsIn(skills, scope, "claude", unreadable, shared())); } });
    if (commands) steps.push({ label: commands, run: () => { items.push(...readMarkdownDir(commands, "command", scope, "claude", unreadable)); } });
    if (agents) steps.push({ label: agents, run: () => { items.push(...readMarkdownDir(agents, "subagent", scope, "claude", unreadable)); } });
    if (settings) {
      steps.push({
        label: settings,
        run: () => {
          const plugins = readPluginsFromSettings(settings, scope, unreadable);
          items.push(...plugins.items);
          marketplaces.push(...plugins.marketplaces);
        },
      });
    }
  }

  // MCP lives outside settings.json: user scope in ~/.claude.json, project
  // scope in the repo's own .mcp.json (paths from the descriptor's mcpConfig).
  const claudeMcp = AGENT_CLIENTS.claude.agentFileTargets?.mcpConfig;
  if (claudeMcp) {
    const userMcp = fromHomeTemplate(home, claudeMcp.user);
    steps.push({ label: userMcp, run: () => { items.push(...readMcpFrom(userMcp, "user", "claude", unreadable)); } });
    if (projectPath && claudeMcp.project) {
      const projectMcp = path.join(projectPath, claudeMcp.project);
      steps.push({ label: projectMcp, run: () => { items.push(...readMcpFrom(projectMcp, "project", "claude", unreadable)); } });
    }
  }

  // Shared skills nothing linked to: still this machine's capabilities, they
  // just were not installed into any client dir.
  steps.push({ label: "unplaced shared skills", run: () => { items.push(...sharedSkills!.items.filter((i) => shared().unplaced.has(i))); } });

  // The other clients on this machine, one tag each, so a single machine row
  // spans all of them — each read from its own descriptor's slots.
  steps.push({ label: "codex", run: () => { items.push(...readClientItems("codex", home, projectPath, unreadable, shared())); } });
  steps.push({ label: "cursor", run: () => { items.push(...readClientItems("cursor", home, projectPath, unreadable, shared())); } });

  // Pins are per install, not per declaration — fold them onto plugin rows.
  steps.push({
    label: "installed plugin pins",
    run: () => {
      const pins = readInstalledPluginPins(home, unreadable);
      const declared = new Set<string>();
      for (const item of items) {
        if (item.kind !== "plugin") continue;
        declared.add(item.name);
        const pin = pins[item.name];
        item.installed = pin !== undefined;
        if (!pin) continue;
        item.meta = {
          ...item.meta,
          ...(pin.version ? { version: pin.version } : {}),
          ...(pin.sha ? { sha: pin.sha } : {}),
        };
      }

      // Downloaded but declared nowhere. Claude Code lists these too, and the
      // library needs them: "installed, not switched on" is a different offer to
      // the user than "not installed", and it costs nothing to turn on.
      //
      // A project-scoped install belongs to the project it was made for. Claude
      // Code lists such a plugin whatever directory you run it from; codecast must
      // not, because showing another checkout's plugin as available here would be a
      // lie about this project's capabilities.
      const pluginRegistry = path.join(home, ".claude", "plugins", "installed_plugins.json");
      for (const [id, pin] of Object.entries(pins)) {
        if (declared.has(id)) continue;
        if (pin.projectPath && pin.projectPath !== projectPath) continue;
        const [name, marketplace] = id.split("@");
        items.push({
          kind: "plugin",
          name: id,
          scope: pin.scope,
          enabled: false,
          installed: true,
          source: pluginRegistry,
          client: "claude",
          meta: {
            plugin: name ?? id,
            ...(marketplace ? { marketplace } : {}),
            ...(pin.version ? { version: pin.version } : {}),
            ...(pin.sha ? { sha: pin.sha } : {}),
            ...(pin.projectPath ? { projectPath: pin.projectPath } : {}),
          },
        });
      }
    },
  });

  return {
    steps,
    finish() {
      const seen = new Set<string>();
      return {
        items,
        unreadable,
        marketplaces: marketplaces.filter((m) => {
          // Scope belongs in the key: the same marketplace registered at two scopes
          // is two registrations, and only an exact repeat is a duplicate. NOT
          // `fleetRowKey`, which drops scope and lowercases on purpose — that one
          // answers "the same thing across machines", the opposite question.
          //
          // NUL separates because no name or scope can contain it. Written as an
          // escape and not the byte itself: a literal NUL makes this file binary to
          // rg and grep, which then drop it from every search without saying so.
          const key = `${m.name}\u0000${m.scope}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }),
      };
    },
  };
}

/** The `/`-menu shape the compose box already consumes, from an inventory.
 *
 *  The contract is `readAvailableSkills`'s (daemon.ts), reproduced byte for
 *  byte so ct-42820 can repoint the daemon here without changing any
 *  conversation's serialized `available_skills` payload: all commands list
 *  before all skills, user scope before project within each kind, and the
 *  FIRST listing wins a name collision — a user entry beats a project entry,
 *  and a command beats a same-named skill. (Not "narrowest scope wins": the
 *  daemon has always been first-wins, and the live menu is whatever the
 *  daemon sends. A deliberate contract change belongs in ct-42820, next to
 *  the swap, where the payload diff can be owned.) */
export function toInvocableList(inv: Inventory): Array<{ name: string; description: string }> {
  const menu = inv.items.filter((item) => {
    if (item.kind !== "skill" && item.kind !== "command") return false;
    if (!item.enabled) return false;
    // The `/` menu is Claude Code's own surface: only what Claude Code itself
    // would list may appear. That excludes codex and cursor items — but a
    // shared ~/.agents/skills skill reached through a symlink inside one of
    // Claude's OWN skill dirs is in the menu (Claude follows the link, and
    // the daemon has always listed it). A shared skill linked only from
    // another client's dir stays out — `appendLink` records which.
    return !item.client || item.client === "claude" || (item.client === "shared" && item.meta?.claude_linked === "true");
  });
  // The scan interleaves kinds per scope; the daemon reads all command dirs,
  // then all skill dirs. Partitioning restores its order exactly, because
  // within each kind the scan is already user-then-project, and a linked
  // shared skill sits at its claude symlink's directory position.
  const ordered = [...menu.filter((i) => i.kind === "command"), ...menu.filter((i) => i.kind === "skill")];
  const seen = new Set<string>();
  const out: Array<{ name: string; description: string }> = [];
  for (const item of ordered) {
    if (seen.has(item.name)) continue;
    seen.add(item.name);
    out.push({ name: item.name, description: item.description ?? "" });
  }
  return out;
}

/**
 * The name the daemon repoints `readAvailableSkills` at (ct-42820). An alias,
 * not a copy: two bodies for the `/` menu contract is how it would fork.
 */
export const invocableSkills = toInvocableList;
