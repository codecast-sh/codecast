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
// Scopes STACK rather than override: the same plugin enabled at user and project
// scope reports twice, once per scope. That is what lets the UI answer "why is
// this active here?" by naming the scope that switched it on, so the union is
// preserved rather than flattened.
//
// Every reader is total: a missing, unreadable or malformed file yields nothing
// rather than throwing. An inventory scan runs on a user's machine against files
// other tools own, so it must never be the reason a heartbeat fails.

import * as fs from "fs";
import * as path from "path";

/** Where a capability was switched on. Narrowest first. */
export type CapabilityScope = "local" | "project" | "user";

export type CapabilityKind = "skill" | "command" | "subagent" | "plugin" | "mcp";

export interface InventoryItem {
  kind: CapabilityKind;
  /** Unique within its kind: a skill's name, a plugin's `name@marketplace`. */
  name: string;
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
  /** Kind-specific extras — a plugin's marketplace, an MCP server's transport. */
  meta?: Record<string, string>;
}

export interface MarketplaceRef {
  name: string;
  /** "owner/repo" for a github source, otherwise the raw source string. */
  repo?: string;
  scope: CapabilityScope;
}

export interface Inventory {
  items: InventoryItem[];
  marketplaces: MarketplaceRef[];
}

// ---------------------------------------------------------------- file helpers

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }
}

function readDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
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

/** The files and directories a scope contributes, in the order they are read. */
function scopeRoots(home: string, projectPath?: string): Array<{ scope: CapabilityScope; root: string; settings: string }> {
  const roots: Array<{ scope: CapabilityScope; root: string; settings: string }> = [
    { scope: "user", root: path.join(home, ".claude"), settings: path.join(home, ".claude", "settings.json") },
  ];
  if (projectPath) {
    const dir = path.join(projectPath, ".claude");
    roots.push({ scope: "project", root: dir, settings: path.join(dir, "settings.json") });
    roots.push({ scope: "local", root: dir, settings: path.join(dir, "settings.local.json") });
  }
  return roots;
}

// -------------------------------------------------------- markdown capabilities

/** Skills: a `<dir>/<name>/SKILL.md`, or a bare `<dir>/<name>.md`.
 *  Both layouts are real — `~/.claude/skills` on a live machine holds a mix. */
function readSkillsIn(dir: string, scope: CapabilityScope): InventoryItem[] {
  const out: InventoryItem[] = [];
  for (const entry of readDir(dir)) {
    const entryPath = path.join(dir, entry);
    let content = "";
    let source = entryPath;
    try {
      if (fs.statSync(entryPath).isDirectory()) {
        // CC writes an uppercase SKILL.md, but a case-insensitive macOS volume
        // lets a lowercase one work locally and then vanish on a case-sensitive
        // one. Accept either spelling so a skill surfaces the same everywhere.
        const manifest = readDir(entryPath).find((f) => /^skill\.md$/i.test(f));
        if (!manifest) continue;
        source = path.join(entryPath, manifest);
        content = fs.readFileSync(source, "utf-8");
      } else if (entry.endsWith(".md")) {
        content = fs.readFileSync(entryPath, "utf-8");
      } else continue;
    } catch {
      continue;
    }
    if (isHiddenFromMenu(content)) continue;
    out.push({
      kind: "skill",
      name: frontmatter(content, "name") || entry.replace(/\.md$/, ""),
      description: frontmatter(content, "description"),
      scope,
      enabled: true,
      source,
    });
  }
  return out;
}

function readMarkdownDir(dir: string, kind: "command" | "subagent", scope: CapabilityScope): InventoryItem[] {
  const out: InventoryItem[] = [];
  for (const file of readDir(dir)) {
    if (!file.endsWith(".md")) continue;
    const source = path.join(dir, file);
    let content = "";
    try {
      content = fs.readFileSync(source, "utf-8");
    } catch {
      continue;
    }
    out.push({
      kind,
      name: file.replace(/\.md$/, ""),
      description: frontmatter(content, "description"),
      scope,
      enabled: true,
      source,
    });
  }
  return out;
}

// ------------------------------------------------------------------- plugins

/** Plugins declared by a settings file, plus the marketplaces it knows.
 *  Verified shape: `{ enabledPlugins: {"name@marketplace": bool},
 *  extraKnownMarketplaces: {name: {source: {source, repo}}} }`. */
function readPluginsFromSettings(settingsFile: string, scope: CapabilityScope): {
  items: InventoryItem[];
  marketplaces: MarketplaceRef[];
} {
  const doc = readJson(settingsFile);
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
export function readKnownMarketplaces(home: string): MarketplaceRef[] {
  const doc = readJson(path.join(home, ".claude", "plugins", "known_marketplaces.json"));
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
export function readInstalledPluginPins(home: string): Record<string, PluginInstall> {
  const doc = readJson(path.join(home, ".claude", "plugins", "installed_plugins.json"));
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

/** MCP servers from one `{mcpServers: {...}}` document.
 *  A server is either stdio (`command` + `args`) or remote (`url` + `type`). */
function readMcpFrom(file: string, scope: CapabilityScope): InventoryItem[] {
  const doc = readJson(file);
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
  const items: InventoryItem[] = [];
  const marketplaces: MarketplaceRef[] = [...readKnownMarketplaces(home)];

  for (const { scope, root, settings } of scopeRoots(home, projectPath)) {
    // Markdown capabilities live under the scope's .claude dir. `local` shares
    // that directory with `project`, so only its settings file is read — listing
    // the same skills twice would be a lie about where they came from.
    if (scope !== "local") {
      items.push(...readSkillsIn(path.join(root, "skills"), scope));
      items.push(...readMarkdownDir(path.join(root, "commands"), "command", scope));
      items.push(...readMarkdownDir(path.join(root, "agents"), "subagent", scope));
    }
    const plugins = readPluginsFromSettings(settings, scope);
    items.push(...plugins.items);
    marketplaces.push(...plugins.marketplaces);
  }

  // MCP lives outside settings.json: user scope in ~/.claude.json, project
  // scope in the repo's own .mcp.json.
  items.push(...readMcpFrom(path.join(home, ".claude.json"), "user"));
  if (projectPath) items.push(...readMcpFrom(path.join(projectPath, ".mcp.json"), "project"));

  // Pins are per install, not per declaration — fold them onto plugin rows.
  const pins = readInstalledPluginPins(home);
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
      meta: {
        plugin: name ?? id,
        ...(marketplace ? { marketplace } : {}),
        ...(pin.version ? { version: pin.version } : {}),
        ...(pin.sha ? { sha: pin.sha } : {}),
        ...(pin.projectPath ? { projectPath: pin.projectPath } : {}),
      },
    });
  }

  const seen = new Set<string>();
  return {
    items,
    marketplaces: marketplaces.filter((m) => {
      const key = `${m.name} ${m.scope}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}

/** The `/`-menu shape the compose box already consumes, from an inventory.
 *  Kept identical to `readAvailableSkills`'s contract — name plus description,
 *  narrowest scope winning on a name collision — so the inventory can back the
 *  existing surface without changing it. */
export function toInvocableList(inv: Inventory): Array<{ name: string; description: string }> {
  const order: CapabilityScope[] = ["local", "project", "user"];
  const byName = new Map<string, InventoryItem>();
  for (const item of inv.items) {
    if (item.kind !== "skill" && item.kind !== "command") continue;
    if (!item.enabled) continue;
    const prev = byName.get(item.name);
    if (prev && order.indexOf(prev.scope) <= order.indexOf(item.scope)) continue;
    byName.set(item.name, item);
  }
  return [...byName.values()].map((i) => ({ name: i.name, description: i.description ?? "" }));
}
