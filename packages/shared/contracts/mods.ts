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

/** Bumped when the host and the SDK baked into a mod stop understanding each other. */
export const MOD_PROTOCOL = 1;

export const MOD_NAME_RE = /^[a-z][a-z0-9-]{1,39}$/;
const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
/** A fence a mod renders: ```<lang>. Kept out of the names codecast draws itself. */
const FENCE_RE = /^[a-z][a-z0-9-]{1,39}$/;
const RESERVED_FENCES = new Set(["cast-canvas", "cast-diff", "mermaid", "diff", "json", "ts", "tsx", "js", "jsx", "bash", "sh", "md", "markdown", "text", "html", "css", "python", "py", "sql", "yaml", "toml"]);

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
} as const;
export type ModCollection = keyof typeof MOD_COLLECTIONS;
export const MOD_COLLECTION_NAMES = Object.keys(MOD_COLLECTIONS) as ModCollection[];

/** The writes a mod may make, each one an existing store action. */
export const MOD_WRITES = ["tasks", "sessions", "docs", "clipboard"] as const;
export type ModWrite = (typeof MOD_WRITES)[number];

export type ModPane = { id: string; title: string; icon?: string; description?: string };
export type ModCommand = { id: string; title: string; keywords?: string; icon?: string };
export type ModFence = { lang: string; description?: string };
export type ModSidebar = { id: string; title: string };

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
  };
  panes?: ModPane[];
  commands?: ModCommand[];
  fences?: ModFence[];
  sidebar?: ModSidebar[];
};

export type ManifestCheck = { ok: true; manifest: ModManifest } | { ok: false; errors: string[] };

function isList(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

/** Reads a manifest the way the loader will. Unknown keys are refused, so a typo fails here rather than silently doing nothing. */
export function validateManifest(raw: unknown): ManifestCheck {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ["the manifest must be a JSON object"] };
  const m = raw as Record<string, unknown>;
  const known = new Set(["name", "title", "description", "version", "icon", "main", "permissions", "panes", "commands", "fences", "sidebar", "$schema"]);
  for (const key of Object.keys(m)) if (!known.has(key)) errors.push(`unknown key "${key}"`);
  if (typeof m.name !== "string" || !MOD_NAME_RE.test(m.name)) errors.push(`name must be 2 to 40 characters of a-z, 0-9 and -, starting with a letter`);
  for (const key of ["title", "description", "version", "icon", "main"]) {
    if (m[key] !== undefined && typeof m[key] !== "string") errors.push(`${key} must be a string`);
  }
  const perms = m.permissions as Record<string, unknown> | undefined;
  if (perms !== undefined) {
    if (!perms || typeof perms !== "object" || Array.isArray(perms)) errors.push("permissions must be an object");
    else {
      for (const key of Object.keys(perms)) if (!["read", "write", "fetch"].includes(key)) errors.push(`unknown permission "${key}"`);
      const check = (key: string, allowed: readonly string[] | null) => {
        const v = perms[key];
        if (v === undefined || v === "*") return;
        if (!isList(v)) return errors.push(`permissions.${key} must be a list or "*"`);
        for (const item of v) {
          if (typeof item !== "string") errors.push(`permissions.${key} holds a non-string`);
          else if (allowed && !allowed.includes(item)) errors.push(`permissions.${key}: "${item}" is not one of ${allowed.join(", ")}`);
          else if (!allowed && !/^https?:\/\/[^/\s]+$/.test(item)) errors.push(`permissions.fetch: "${item}" must be an origin like https://api.example.com`);
        }
      };
      check("read", MOD_COLLECTION_NAMES);
      check("write", MOD_WRITES);
      check("fetch", null);
    }
  }
  const seen = new Set<string>();
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
  return errors.length ? { ok: false, errors } : { ok: true, manifest: m as unknown as ModManifest };
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
  | { kind: "sidebar"; id: string; props?: Record<string, unknown> };

/** The events a hooks module can hook, with what each matcher may name. */
export const MOD_EVENTS = ["mod.start", "ui.render", "command.run", "session.state", "data.change"] as const;
export type ModEventName = (typeof MOD_EVENTS)[number];

// -- Protocol ---------------------------------------------------------------

export type HostToFrame =
  | { type: "load"; proto: number; mod: { id: string; name: string; manifest: ModManifest; context: ModContext }; code: string }
  | { type: "render"; rid: string; key: string; surface: ModSurface }
  | { type: "invoke"; rid: string; fn: string; args: unknown[] }
  | { type: "command"; rid: string; id: string }
  | { type: "emit"; event: ModEventName; payload: unknown }
  | { type: "reply"; cid: string; ok: boolean; value?: unknown; error?: string };

export type FrameToHost =
  | { type: "booted" }
  | { type: "ready"; hooks: { event: string; matcher?: Record<string, unknown> }[] }
  | { type: "load-failed"; error: string }
  | { type: "rendered"; rid: string; tree?: ModNode; error?: string; pass?: boolean }
  | { type: "done"; rid: string; error?: string }
  | { type: "call"; cid: string; key?: string; method: string; args: unknown[] }
  | { type: "log"; level: "log" | "warn" | "error"; text: string }
  | { type: "invalidate"; key?: string };

/** Who and where the mod runs for, handed over at load. */
export type ModContext = {
  user: { id: string; name?: string; email?: string } | null;
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
  "http.fetch",
  "me",
] as const;
export type ModMethod = (typeof MOD_METHODS)[number];
