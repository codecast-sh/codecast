// Codecast mods: the contract shared by the CLI (which builds and publishes a
// mod), Convex (which stores it) and the web (which runs it in a sandbox and
// draws what it returns). Design: doc "Codecast mods" (plan pl-839).
//
// A mod is a folder with a `codecast-mod.json` manifest and a hooks module
// exporting `register(on)`. The CLI bundles the module together with the SDK
// (shared/mods/sdk.ts) into one script; the web loads that script into an
// opaque-origin iframe and talks to it over postMessage with the protocol
// below. The mod never touches the app's DOM: it returns element trees, and
// codecast draws them with its own components.

import { themeErrors, type ModTheme } from "./theme";

/** Bumped when the host and the SDK baked into a mod stop understanding each other. */
export const MOD_PROTOCOL = 1;

export const MOD_NAME_RE = /^[a-z][a-z0-9-]{1,39}$/;
const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
/** A fence a mod renders: ```<lang>. Kept out of the names codecast draws itself. */
const FENCE_RE = /^[a-z][a-z0-9-]{1,39}$/;
/**
 * Blocks a mod may never claim. A fence's code reaches the mod that draws it,
 * so claiming a programming language would hand a mod every snippet of that
 * language in every conversation, past its read grants. A mod's fences are
 * its own vocabulary (`bug`, `incident`), never a language.
 */
const RESERVED_FENCES = new Set([
  "cast-canvas", "cast-diff", "mermaid", "diff", "patch", "json", "jsonc", "json5", "ts", "tsx", "typescript", "js", "jsx", "javascript", "mjs", "cjs",
  "bash", "sh", "zsh", "fish", "shell", "console", "powershell", "ps1", "bat", "cmd", "md", "markdown", "mdx", "text", "txt", "plaintext", "html", "xml", "svg",
  "css", "scss", "sass", "less", "python", "py", "sql", "yaml", "yml", "toml", "ini", "env", "dotenv", "dockerfile", "docker", "makefile", "make", "go", "golang",
  "rust", "rs", "java", "kotlin", "kt", "swift", "c", "h", "cpp", "cc", "hpp", "cs", "csharp", "fsharp", "ruby", "rb", "php", "perl", "lua", "r", "scala", "dart",
  "elixir", "ex", "erlang", "haskell", "hs", "clojure", "ocaml", "zig", "nim", "julia", "groovy", "gradle", "graphql", "gql", "proto", "protobuf", "terraform",
  "tf", "hcl", "nginx", "vim", "log", "csv", "tsv", "latex", "tex", "vue", "svelte", "astro", "prisma", "solidity", "sol", "wasm", "asm", "nix", "diagram", "output",
]);

/**
 * What a mod may read from the store, by the name a mod uses. Each maps to the
 * store collection that holds it, so a mod reads exactly what the person sees,
 * already local, already scoped to what they can access.
 */
export const MOD_COLLECTIONS = {
  sessions: "sessions",
  tasks: "tasks",
  plans: "plans",
  docs: "docs",
  projects: "projects",
  initiatives: "initiatives",
  commits: "commits",
  prs: "pullRequests",
  triggers: "agentTasks",
  decisions: "sessionDecisions",
  pages: "artifacts",
  workflows: "workflowRuns",
  comments: "comments",
  chat: "chatMessages",
  labels: "buckets",
  /** Mod-defined objects (manifest `objects`), every kind in one collection. */
  objects: "modObjects",
} as const;
export type ModCollection = keyof typeof MOD_COLLECTIONS;
export const MOD_COLLECTION_NAMES = Object.keys(MOD_COLLECTIONS) as ModCollection[];

/** The writes a mod may make, each one an existing store action. */
export const MOD_WRITES = ["tasks", "sessions", "docs", "clipboard", "objects"] as const;
export type ModWrite = (typeof MOD_WRITES)[number];

export type ModPane = { id: string; title: string; icon?: string; description?: string };
export type ModCommand = { id: string; title: string; keywords?: string; icon?: string };
export type ModFence = { lang: string; description?: string };
export type ModSidebar = { id: string; title: string };

// -- Objects ------------------------------------------------------------------
//
// A mod can define a new kind of first-class object: `bug-14`, `inc-3`. Rows
// live in one shared table (mod_objects) with a workspace access key like
// tasks, so a kind is a declaration, not a migration. Its short id is a live
// pill wherever codecast renders prose, every kind gets a list page, a detail
// page and `cast obj <prefix>` verbs for agents, and the declaring mod can
// draw its own card and page for it.

export const MOD_OBJECT_FIELD_TYPES = ["text", "markdown", "number", "enum", "person", "ref", "date", "bool", "url"] as const;
export type ModObjectFieldType = (typeof MOD_OBJECT_FIELD_TYPES)[number];
export type ModObjectField = { type: ModObjectFieldType; label?: string; options?: string[] };
export type ModObjectKind = {
  /** The short-id prefix, 2 to 8 lowercase letters: objects are `<prefix>-<n>`. */
  prefix: string;
  /** Singular display name, e.g. "Bug". */
  title: string;
  plural?: string;
  icon?: string;
  /** The status lifecycle, in order. The first is where a new object starts; the last means done. */
  statuses?: string[];
  fields?: Record<string, ModObjectField>;
  /**
   * The rows live in another system and are named by that system's own ids:
   * `<prefix>-<first 8 hex of its uuid>` (or the whole uuid). Nothing is stored;
   * the declaring mod answers `object.resolve` with the row, live.
   */
  external?: boolean;
};

export const OBJECT_PREFIX_RE = /^[a-z]{2,8}$/;
/** Prefixes codecast already reads as something else; a kind may not claim them. */
export const RESERVED_OBJECT_PREFIXES: ReadonlySet<string> = new Set([
  "ct", "pl", "tr", "in", "op", "sd", "cl", "ds", "or", "sg", "pr", "dp", "jx", "doc", "msg", "obj", "date", "label", "mod", "http", "https",
]);
/** Text payload an object reference rides in through markdown, like `doc:` and `msg:`. */
export const OBJECT_REF_PREFIX = "obj:";
/** An object short id: `<prefix>-<number>` for a stored object. */
export const OBJECT_SHORT_ID_RE = /^([a-z]{2,8})-(\d{1,7})$/;
/** An external object's id: `<prefix>-<8 hex>` or `<prefix>-<uuid>`, the other system's own id. */
export const EXTERNAL_OBJECT_ID_RE = /^([a-z]{2,8})-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{8})$/;
/** Scans prose for object ids of both shapes; a match only becomes a reference when its prefix is a kind that takes that shape. */
export const OBJECT_REF_SCAN_SOURCE = "\\b[a-z]{2,8}-(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{8}|\\d{1,7})\\b";

export function objectStatusIsDone(kind: Pick<ModObjectKind, "statuses"> | undefined, status: string | undefined): boolean {
  const list = kind?.statuses;
  return !!status && !!list?.length && status === list[list.length - 1];
}

export type ModManifest = {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  icon?: string;
  /** The hooks module, relative to the folder. Default `ui.tsx`. */
  main?: string;
  permissions?: {
    read?: ModCollection[] | "*";
    write?: ModWrite[] | "*";
    /** Origins the mod may fetch from, e.g. "https://api.github.com". "*" for any. */
    fetch?: string[] | "*";
    /** App connectors (by source name, e.g. "union") whose readers the mod may call with $.connector.read, as the person viewing it. */
    connectors?: string[];
  };
  /** Keys the mod's requests need, set by its author and never sent to a browser: codecast attaches one to a $.http.fetch that names it, and only toward its origins. */
  secrets?: ModSecret[];
  panes?: ModPane[];
  commands?: ModCommand[];
  fences?: ModFence[];
  sidebar?: ModSidebar[];
  objects?: ModObjectKind[];
  /** Color themes the person can pick in Settings (contracts/theme.ts): data, applied app-wide. */
  themes?: ModTheme[];
  /**
   * The local half: a module the codecast daemon runs on a machine you own,
   * with that machine's full access (files, processes, network, env). It runs
   * on each of the author's machines unless revoked there (`cast mod revoke`),
   * and reaches the app through what it publishes and the calls the UI makes.
   */
  local?: { main: string; description?: string };
  /** What agents should know to use this mod well (its objects, its fences, when to reach for them), usually from AGENTS.md beside the manifest. Every session the mod applies to starts with it, and `cast mod guide` prints it. */
  agents?: string;
};

/**
 * A key a mod's requests carry. The author sets the value (the Mods page, or
 * `cast mod secret set`); codecast stores it encrypted and attaches it on the
 * server to a `$.http.fetch(url, { secret })` bound for one of `origins`, so no
 * browser, teammate or mod code ever holds it. Sent as `Authorization: Bearer
 * <value>`, or as the raw value of `header` when one is named.
 */
export type ModSecret = { name: string; description?: string; origins: string[]; header?: string };
export const MOD_SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,39}$/;
const ORIGIN_RE = /^https?:\/\/[^/\s]+$/;

/** A local half's published value, as the sandboxed half reads it ($.local.get). */
export type ModLocalState = { mod_id: string; key: string; value: unknown; device_name?: string; updated_at: number };

export type ManifestCheck = { ok: true; manifest: ModManifest } | { ok: false; errors: string[] };

function isList(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

/** Reads a manifest the way the loader will. Unknown keys are refused, so a typo fails here rather than silently doing nothing. */
export function validateManifest(raw: unknown): ManifestCheck {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ["the manifest must be a JSON object"] };
  const m = raw as Record<string, unknown>;
  const known = new Set(["name", "title", "description", "version", "icon", "main", "permissions", "panes", "commands", "fences", "sidebar", "objects", "themes", "local", "agents", "secrets", "$schema"]);
  for (const key of Object.keys(m)) if (!known.has(key)) errors.push(`unknown key "${key}"`);
  if (typeof m.name !== "string" || !MOD_NAME_RE.test(m.name)) errors.push(`name must be 2 to 40 characters of a-z, 0-9 and -, starting with a letter`);
  if (typeof m.agents === "string" && m.agents.length > 2000) errors.push("agents holds at most 2000 characters");
  for (const key of ["title", "description", "version", "icon", "main", "agents"]) {
    if (m[key] !== undefined && typeof m[key] !== "string") errors.push(`${key} must be a string`);
  }
  const seen = new Set<string>();
  const perms = m.permissions as Record<string, unknown> | undefined;
  if (perms !== undefined) {
    if (!perms || typeof perms !== "object" || Array.isArray(perms)) errors.push("permissions must be an object");
    else {
      for (const key of Object.keys(perms)) if (!["read", "write", "fetch", "connectors"].includes(key)) errors.push(`unknown permission "${key}"`);
      const check = (key: string, allowed: readonly string[] | null) => {
        const v = perms[key];
        if (v === undefined || v === "*") return;
        if (!isList(v)) return errors.push(`permissions.${key} must be a list or "*"`);
        for (const item of v) {
          if (typeof item !== "string") errors.push(`permissions.${key} holds a non-string`);
          else if (allowed && !allowed.includes(item)) errors.push(`permissions.${key}: "${item}" is not one of ${allowed.join(", ")}`);
          else if (!allowed && !ORIGIN_RE.test(item)) errors.push(`permissions.fetch: "${item}" must be an origin like https://api.example.com`);
        }
      };
      check("read", MOD_COLLECTION_NAMES);
      check("write", MOD_WRITES);
      check("fetch", null);
      const c = perms.connectors;
      if (c !== undefined && (!isList(c) || !c.every((x) => typeof x === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(x)))) errors.push(`permissions.connectors must be a list of connector source names, e.g. ["union"]`);
    }
  }
  if (m.secrets !== undefined) {
    if (!isList(m.secrets)) errors.push("secrets must be a list");
    else for (const raw of m.secrets) {
      const o = (raw ?? {}) as Record<string, unknown>;
      const name = String(o.name ?? "");
      if (!MOD_SECRET_NAME_RE.test(name)) { errors.push(`secrets: name "${name}" must be 2 to 40 characters of A-Z, 0-9 and _, like UNION_KEY`); continue; }
      if (seen.has(`secrets:${name}`)) errors.push(`secrets: "${name}" is declared twice`);
      seen.add(`secrets:${name}`);
      for (const key of Object.keys(o)) if (!["name", "description", "origins", "header"].includes(key)) errors.push(`secrets: "${name}" has an unknown key "${key}"`);
      if (!isList(o.origins) || !o.origins.length || !o.origins.every((x) => typeof x === "string" && ORIGIN_RE.test(x))) errors.push(`secrets: "${name}".origins must list the origins it may be sent to, like ["https://api.example.com"]`);
      else if (!o.origins.every((x) => fetchAllows(perms?.fetch, x as string))) errors.push(`secrets: "${name}" goes to an origin permissions.fetch does not list`);
      if (o.header !== undefined && (typeof o.header !== "string" || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(o.header))) errors.push(`secrets: "${name}".header must be a header name, like X-Api-Key`);
    }
  }
  const list = (key: string, idKey: string, re: RegExp, needsTitle: boolean) => {
    const v = m[key];
    if (v === undefined) return;
    if (!isList(v)) return errors.push(`${key} must be a list`);
    for (const item of v) {
      const o = item as Record<string, unknown>;
      const id = o?.[idKey];
      if (typeof id !== "string" || !re.test(id)) { errors.push(`${key}: ${idKey} "${String(id)}" must be lowercase a-z, 0-9 and -`); continue; }
      if (seen.has(`${key}:${id}`)) errors.push(`${key}: "${id}" is declared twice`);
      seen.add(`${key}:${id}`);
      if (needsTitle && typeof o.title !== "string") errors.push(`${key}: "${id}" needs a title`);
      if (key === "fences" && RESERVED_FENCES.has(id)) errors.push(`fences: "${id}" is a block codecast draws itself`);
    }
  };
  list("panes", "id", ID_RE, true);
  list("commands", "id", ID_RE, true);
  list("fences", "lang", FENCE_RE, false);
  list("sidebar", "id", ID_RE, true);
  if (m.local !== undefined) {
    const l = m.local as Record<string, unknown>;
    if (!l || typeof l !== "object" || typeof l.main !== "string" || !/\.(t|j)sx?$/.test(l.main)) errors.push(`local.main must name the local module, e.g. "local.ts"`);
    else for (const key of Object.keys(l)) if (!["main", "description"].includes(key)) errors.push(`local has an unknown key "${key}"`);
  }
  if (m.objects !== undefined) {
    if (!isList(m.objects)) errors.push("objects must be a list");
    else for (const raw of m.objects) {
      const o = raw as Record<string, unknown>;
      const prefix = String(o?.prefix ?? "");
      if (!OBJECT_PREFIX_RE.test(prefix)) { errors.push(`objects: prefix "${prefix}" must be 2 to 8 lowercase letters`); continue; }
      if (RESERVED_OBJECT_PREFIXES.has(prefix)) errors.push(`objects: "${prefix}" is a prefix codecast already uses`);
      if (seen.has(`objects:${prefix}`)) errors.push(`objects: "${prefix}" is declared twice`);
      seen.add(`objects:${prefix}`);
      if (typeof o.title !== "string" || !o.title) errors.push(`objects: "${prefix}" needs a title`);
      for (const key of Object.keys(o)) if (!["prefix", "title", "plural", "icon", "statuses", "fields", "external"].includes(key)) errors.push(`objects: "${prefix}" has an unknown key "${key}"`);
      if (o.external !== undefined && typeof o.external !== "boolean") errors.push(`objects: "${prefix}".external must be true or false`);
      if (o.statuses !== undefined && (!isList(o.statuses) || !o.statuses.every((x) => typeof x === "string" && x))) errors.push(`objects: "${prefix}".statuses must be a list of names`);
      if (o.fields !== undefined) {
        if (!o.fields || typeof o.fields !== "object" || Array.isArray(o.fields)) errors.push(`objects: "${prefix}".fields must be an object of name -> { type }`);
        else for (const [name, f] of Object.entries(o.fields as Record<string, any>)) {
          if (!/^[a-z][a-z0-9_]{0,39}$/.test(name)) errors.push(`objects: "${prefix}" field "${name}" must be lowercase a-z, 0-9 and _`);
          if (["title", "status", "body", "short_id", "_id"].includes(name)) errors.push(`objects: "${prefix}" field "${name}" is built in; every object already has it`);
          if (!MOD_OBJECT_FIELD_TYPES.includes(f?.type)) errors.push(`objects: "${prefix}" field "${name}" type must be one of ${MOD_OBJECT_FIELD_TYPES.join(", ")}`);
          if (f?.type === "enum" && (!isList(f.options) || !f.options.length)) errors.push(`objects: "${prefix}" field "${name}" is an enum and needs options`);
        }
      }
    }
  }
  if (m.themes !== undefined) errors.push(...themeErrors(m.themes));
  return errors.length ? { ok: false, errors } : { ok: true, manifest: m as unknown as ModManifest };
}

/**
 * What a mod is allowed to touch, as one comparable string. Installing a
 * teammate's mod records it; when the author widens the grants, the mod stops
 * running for that person until they review the new ones.
 */
export function permissionsSig(manifest: Pick<ModManifest, "permissions"> | undefined): string {
  const p = manifest?.permissions ?? {};
  const norm = (v: unknown) => (v === "*" ? "*" : Array.isArray(v) ? [...v].map(String).sort().join(",") : "");
  // Connectors join the signature only when granted, so a mod without them keeps the signature its installs recorded.
  return `r=${norm(p.read)};w=${norm(p.write)};f=${norm(p.fetch)}${p.connectors?.length ? `;c=${norm(p.connectors)}` : ""}`;
}

function fetchAllows(fetch: unknown, origin: string): boolean {
  return fetch === "*" || (isList(fetch) && fetch.includes(origin));
}

/** The declared secret a fetch to `url` may carry, or why it may not. */
export function secretFor(manifest: ModManifest, name: string, url: string): { ok: true; secret: ModSecret } | { ok: false; error: string } {
  const secret = manifest.secrets?.find((s) => s.name === name);
  if (!secret) return { ok: false, error: `the manifest declares no secret "${name}" (secrets: ${(manifest.secrets ?? []).map((s) => s.name).join(", ") || "none"})` };
  let origin: string;
  try { origin = new URL(url).origin; } catch { return { ok: false, error: `"${url}" is not a URL` }; }
  if (!secret.origins.includes(origin)) return { ok: false, error: `${name} is sent only to ${secret.origins.join(", ")}, not ${origin}` };
  return { ok: true, secret };
}

export function canReadConnector(manifest: ModManifest, source: string): boolean {
  return !!manifest.permissions?.connectors?.includes(source);
}

export function canRead(manifest: ModManifest, collection: string): boolean {
  const read = manifest.permissions?.read;
  return read === "*" || (Array.isArray(read) && read.includes(collection as ModCollection));
}

export function canWrite(manifest: ModManifest, write: string): boolean {
  const w = manifest.permissions?.write;
  return w === "*" || (Array.isArray(w) && w.includes(write as ModWrite));
}

// -- Element trees ----------------------------------------------------------

/** A handler in a tree: the SDK swaps each function prop for one of these. */
export type ModHandlerRef = { $fn: string };
export type ModNode = ModElement | string | number | null;
export type ModElement = { t: string; p?: Record<string, unknown>; c?: ModNode[] };

/** Every element the host draws. A tree naming anything else is refused with the element's name. */
export const MOD_ELEMENTS = [
  "Box", "Row", "Column", "Grid", "Card", "Text", "Heading", "Button", "Input", "TextArea", "Select", "Toggle",
  "Table", "Tabs", "Tab", "Badge", "Ref", "Chart", "Markdown", "Canvas", "Code", "Progress", "Divider", "Spacer",
  "Icon", "Link", "Image", "Kbd", "Stat", "Empty", "List", "Item", "Time", "Avatar", "Sparkline",
] as const;
export type ModElementName = (typeof MOD_ELEMENTS)[number];

// -- Surfaces and events ----------------------------------------------------

export type ModSurface =
  | { kind: "pane"; id: string; props?: Record<string, unknown> }
  | { kind: "fence"; id: string; props: { code: string; meta?: string } }
  | { kind: "sidebar"; id: string; props?: Record<string, unknown> }
  /** An object's page: the declaring mod draws it, `id` is the kind's prefix and props.object the row. */
  | { kind: "object"; id: string; props: { object: Record<string, unknown> } }
  /** An external object's live row: the declaring mod's `object.resolve` hook answers with data, not a tree. `id` is the kind's prefix. */
  | { kind: "resolve"; id: string; props: { id: string } };

/** The row a mod's `object.resolve` hook answers with: what the pill, hover card and page show for an external object. */
export type ResolvedObject = { title: string; status?: string; fields?: Record<string, unknown>; body?: string };

/** The events a hooks module can hook, with what each matcher may name. */
export const MOD_EVENTS = ["mod.start", "ui.render", "object.resolve", "command.run", "session.state", "data.change"] as const;
export type ModEventName = (typeof MOD_EVENTS)[number];

// -- Protocol ---------------------------------------------------------------

export type HostToFrame =
  | { type: "load"; proto: number; mod: { id: string; name: string; manifest: ModManifest; context: ModContext }; code: string; primary?: boolean }
  | { type: "render"; rid: string; key: string; surface: ModSurface }
  | { type: "invoke"; rid: string; fn: string; args: unknown[] }
  | { type: "command"; rid: string; id: string }
  | { type: "emit"; event: ModEventName; payload: unknown }
  /** A surface unmounted: its handlers can go. */
  | { type: "release"; key: string }
  | { type: "reply"; cid: string; ok: boolean; value?: unknown; error?: string };

export type FrameToHost =
  | { type: "booted" }
  | { type: "ready"; hooks: { event: string; matcher?: Record<string, unknown> }[] }
  | { type: "load-failed"; error: string }
  /** `value` answers a "resolve" surface (with `pass` while the answer is still on its way), `tree` every other. */
  | { type: "rendered"; rid: string; tree?: ModNode; value?: unknown; error?: string; pass?: boolean }
  | { type: "done"; rid: string; error?: string }
  /**
   * `origin` says what the call serves: "ui" a drawn surface (its handlers run
   * on the person's clicks), "user" a command the person ran, "hook" an event
   * hook or start-up code. Writes from a hook are automation and never land
   * on the person's undo stack.
   */
  | { type: "call"; cid: string; key?: string; method: string; args: unknown[]; origin?: "ui" | "user" | "hook" }
  | { type: "log"; level: "log" | "warn" | "error"; text: string }
  | { type: "invalidate"; key?: string };

/** Who and where the mod runs for, handed over at load. */
export type ModContext = {
  user: { id: string; name?: string } | null;
  team: { id: string; name?: string } | null;
  surface: "web" | "desktop" | "mobile";
  theme: "dark" | "light";
};

/** Every `$` method the host answers, by its dotted name. `cast mod inspect` reports these. */
export const MOD_METHODS = [
  "data.list", "data.get", "data.count",
  "ui.toast", "ui.navigate", "ui.open", "ui.invalidate", "ui.copy",
  "state.get", "state.set",
  "tasks.create", "tasks.update",
  "sessions.send", "sessions.open",
  "docs.create",
  "objects.create", "objects.update", "objects.archive",
  "local.get", "local.meta", "local.call",
  "http.fetch",
  "connector.read",
  "me",
] as const;
export type ModMethod = (typeof MOD_METHODS)[number];
