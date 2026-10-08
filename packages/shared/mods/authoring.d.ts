// Types for a codecast mod's hooks module: `import { ... } from "codecast-mod"`.
// `cast mod new` writes this file into the mod's folder and `cast mod build`
// resolves the import to the SDK, so the editor and the bundle agree. This file
// is also the API reference: every event, every `$` method and every element.

declare module "codecast-mod" {
  // ---------------------------------------------------------------- registering

  /**
   * The hooks module exports `register(on)`. `on(event, matcher?, hook)` adds a
   * hook; hooks for one event run as a chain in the order registered.
   *
   *   export const register: Register = (on) => {
   *     on("ui.render", { pane: "main" }, async ($, e) => <Text>hello</Text>);
   *     on("command.run", { command: "ping" }, async ($) => $.ui.toast("pong"));
   *   };
   */
  export type Register = (on: On) => void | Promise<void>;

  export interface On {
    (event: "mod.start", hook: Hook<{ context: Context }, void>): void;
    (event: "ui.render", matcher: { pane: string } | { fence: string } | { sidebar: string } | { object: string }, hook: Hook<RenderEvent, Node>): void;
    (event: "ui.render", hook: Hook<RenderEvent, Node>): void;
    (event: "command.run", matcher: { command: string }, hook: Hook<{ command: string }, void>): void;
    (event: "command.run", hook: Hook<{ command: string }, void>): void;
    (event: "session.state", hook: Hook<SessionStateEvent, void>): void;
    (event: "session.state", matcher: Partial<SessionStateEvent>, hook: Hook<SessionStateEvent, void>): void;
    (event: "data.change", hook: Hook<{ collection: Collection }, void>): void;
    (event: "data.change", matcher: { collection: Collection }, hook: Hook<{ collection: Collection }, void>): void;
  }

  /**
   * Every hook is `($, e, next)`. `$` is the codecast API, bound to this
   * dispatch. `e` is the event, frozen. `next(e?)` runs the hooks after this one
   * and then codecast's own behaviour: return it unchanged to pass, call it with
   * a changed event to rewrite what the rest see, or return without calling it
   * to answer the event yourself.
   */
  export type Hook<E, R> = ($: Api, e: Readonly<E>, next: (e?: E) => Promise<R>) => R | Promise<R>;

  export type RenderEvent = {
    surface: "pane" | "fence" | "sidebar" | "object";
    /** The pane id, when surface is "pane". */
    pane?: string;
    /** The fence's language, when surface is "fence". */
    fence?: string;
    sidebar?: string;
    /** The kind's prefix, when surface is "object": draw the top of that kind's object page. */
    object?: string;
    /**
     * For a fence: { code, meta } (the block's text only; which message or session it came from is not
     * passed, so a block that needs it carries it in its own text). For a pane: whatever
     * `$.ui.open(pane, props)` passed, plus `query`, and `embedded: true` when the pane is drawn
     * inside a message (its link alone on a line): a good moment for a compact layout.
     * For an object: { object }, the row.
     */
    props: Record<string, any>;
    context: Context;
  };

  export type SessionStateEvent = { id: string; title?: string; from: string | null; to: string; project?: string };

  export type Context = {
    user: { id: string; name?: string; email?: string } | null;
    team: { id: string; name?: string } | null;
    surface: "web" | "desktop" | "mobile";
    theme: "dark" | "light";
  };

  // ---------------------------------------------------------------- $

  /** What `$.data` reads, by name. A mod reads only the collections its manifest lists under permissions.read. */
  export type Collection =
    | "sessions" | "tasks" | "plans" | "docs" | "projects" | "initiatives" | "commits" | "prs"
    | "triggers" | "decisions" | "pages" | "workflows" | "comments" | "chat" | "labels" | "objects";

  /**
   * A row as the store holds it. The fields most views need, per collection
   * (rows carry more; log one to see everything):
   *   sessions  _id, title, state ("working" | "needs_input" | "done" | "dormant" | "idle"), project, project_path,
   *             git_branch, agent_type, model, message_count, updated_at, started_at, idle_summary,
   *             inbox: the section of the person's inbox it sits in ("needs_input", "done", "dormant", "working",
   *               "questions", "pinned", "new"), or null when their inbox does not show it (subagents, workers,
   *               killed, stashed, filed, other people's): { where: { inbox: "needs_input" } } is "waiting on me",
   *             mine: whether the person started it, waiting_since: when it came to rest (null while working)
   *   tasks     _id, short_id ("ct-12"), title, description, status, priority, assignee (when set: a user id, as
   *             $.me().id, or "agent:<name>"), plan, task_type, triage_status, updated_at, created_at, closed_at
   *   plans     _id, short_id ("pl-8"), title, status, session_ids, updated_at
   *   docs      _id, title, doc_type, author_name, project_path, updated_at
   *   prs       _id, repository, number, title, state, draft, author_github_username, checks_state, head_ref,
   *             additions, deletions, linked_session_ids, updated_at
   *   triggers  _id, short_id ("tr-4"), title, prompt, status, schedule_type, run_at, run_count, agent_type
   *   objects   _id, short_id ("bug-14"), prefix, number, title, status, fields, body, user_id, client_key,
   *             created_at, updated_at. Archived objects are not listed. A just-created object carries
   *             short_id "<prefix>-…" until the server numbers it; find it by its client_key.
   * Times are milliseconds since the epoch.
   */
  export type Row = Record<string, any> & { _id: string };

  /**
   * A query over one collection, answered from the local store (instant, offline).
   * `where` matches a field exactly, or with an operator object.
   */
  export type Query = {
    /** A key may be a dotted path into the row: { "fields.severity": "p0" }. */
    where?: Record<string, unknown | { in: unknown[] } | { ne: unknown } | { gt: number } | { lt: number } | { contains: string } | { exists: boolean }>;
    /** A field to sort by. */
    sort?: string;
    order?: "asc" | "desc";
    limit?: number;
    /** Return only these fields (plus _id): keeps big rows cheap to send. */
    fields?: string[];
    /** Free text matched against title, name, message and description. */
    search?: string;
  };

  export interface Api {
    /** Codecast's data, from the local store. A render that reads a collection re-renders when it changes. */
    data: {
      list(collection: Collection, query?: Query): Promise<Row[]>;
      get(collection: Collection, id: string): Promise<Row | null>;
      count(collection: Collection, query?: Query): Promise<number>;
    };
    ui: {
      toast(text: string, opts?: { kind?: "info" | "success" | "error" }): Promise<void>;
      /** Go to an in-app path, e.g. "/tasks" or "/conversation/<id>". */
      navigate(path: string): Promise<void>;
      /** Open one of this mod's panes; `props` reach its render as e.props. */
      open(pane: string, props?: Record<string, unknown>): Promise<void>;
      /** Draw this surface again (or every surface of the mod when given "*"). */
      invalidate(key?: string): void;
      copy(text: string): Promise<void>;
    };
    /** The mod's own values for this person on this device, kept across reloads and new versions. A write redraws the mod's surfaces. To share a value across machines, publish it from the local half. */
    state: {
      get<T = unknown>(key: string): Promise<T | undefined>;
      set(key: string, value: unknown): Promise<void>;
    };
    /** Needs permissions.write "tasks". */
    tasks: {
      create(task: { title: string; description?: string; priority?: "low" | "medium" | "high" | "urgent"; status?: "backlog" | "open" | "in_progress" | "in_review" | "done"; labels?: string[] }): Promise<{ id: string }>;
      update(id: string, patch: { title?: string; description?: string; priority?: string; status?: string }): Promise<void>;
    };
    /** Needs permissions.write "sessions". */
    sessions: {
      /** Send a message to a session, as you. */
      send(id: string, text: string): Promise<void>;
      open(id: string): Promise<void>;
    };
    /**
     * Objects of the kinds this mod declares under "objects" (needs permissions.write "objects").
     * Read them with $.data.list("objects", { where: { prefix: "bug" } }).
     */
    objects: {
      /**
       * The object appears at once (an optimistic row); the server numbers it a moment later.
       * The answer's client_key finds it: $.data.list("objects", { where: { client_key } }).
       */
      create(obj: { prefix: string; title: string; status?: string; fields?: Record<string, unknown>; body?: string }): Promise<{ client_key: string }>;
      /** By short id ("bug-14") or _id. `fields` merges into the object's fields. */
      update(id: string, patch: { title?: string; status?: string; fields?: Record<string, unknown>; body?: string }): Promise<void>;
      archive(id: string): Promise<void>;
    };
    /** Needs permissions.write "docs". */
    docs: {
      create(doc: { title: string; content: string }): Promise<{ id: string }>;
    };
    /**
     * The mod's local half (manifest "local"), running on your machines where you approved it.
     * get() reads a value it published with $.publish, and a surface that reads one redraws when it
     * changes. call() runs one of its on("local.call", { method }) hooks and resolves with the answer.
     */
    local: {
      get<T = unknown>(key: string): Promise<T | null>;
      /** Which machine published the value, and when. */
      meta(key: string): Promise<{ value: unknown; device: string | null; at: number } | null>;
      call<T = unknown>(method: string, args?: unknown): Promise<T>;
    };
    /** Fetch from an origin listed under permissions.fetch. Runs in the sandbox, so the server must allow CORS. */
    http: {
      fetch(url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ ok: boolean; status: number; headers: Record<string, string>; text: string; json: any }>;
    };
    me(): Promise<{ id: string; name?: string; email?: string } | null>;
    readonly manifest: Manifest;
    readonly context: Context;
    /** The surface this dispatch draws, e.g. "pane:main". */
    readonly key?: string;
  }

  export type ThemePalette = Partial<Record<
    | "bg" | "bg-alt" | "card" | "border" | "text" | "text-muted" | "text-dim" | "link"
    | "red" | "orange" | "amber" | "yellow" | "green" | "cyan" | "blue" | "violet" | "magenta"
    | "font-ui" | "font-mono",
    string
  >>;

  export type Manifest = {
    name: string; title?: string; description?: string; version?: string; icon?: string; main?: string;
    permissions?: { read?: Collection[] | "*"; write?: ("tasks" | "sessions" | "docs" | "clipboard" | "objects")[] | "*"; fetch?: string[] | "*" };
    panes?: { id: string; title: string; icon?: string; description?: string }[];
    commands?: { id: string; title: string; keywords?: string; icon?: string }[];
    fences?: { lang: string; description?: string }[];
    sidebar?: { id: string; title: string }[];
    /** What agents should know to use this mod well: its objects, its fences, when to reach for them. `cast mod guide` prints it to every agent that asks. */
    agents?: string;
    /**
     * Color themes the person can pick in Settings > Appearance. Data, not CSS: a hex
     * value per token for light and/or dark; a token left out keeps codecast's own.
     * Accents also recolor every Tailwind scale of their hue, and bg/text the grays.
     */
    themes?: { id: string; title: string; light?: ThemePalette; dark?: ThemePalette }[];
    /** The local half: a module the daemon runs on machines where you approved it (cast mod approve). */
    local?: { main: string; description?: string };
    /**
     * New kinds of first-class objects. Each gets `<prefix>-<n>` short ids that render as live pills
     * everywhere, a list page (/objects/<prefix>), a page per object (/o/<prefix>-<n>), and
     * `cast obj <prefix> ...` verbs for agents. Draw the top of an object's page with
     * on("ui.render", { object: "<prefix>" }, ...). Every field shows on the object's page and to agents.
     */
    objects?: {
      prefix: string;
      title: string;
      plural?: string;
      icon?: string;
      /** In order: the first is where a new object starts, the last means done. */
      statuses?: string[];
      fields?: Record<string, { type: "text" | "markdown" | "number" | "enum" | "person" | "ref" | "date" | "bool" | "url"; label?: string; options?: string[] }>;
    }[];
  };

  // ---------------------------------------------------------------- elements

  /** What a render returns. Codecast draws it with its own components, themed. */
  export type Node = Element | string | number | null | undefined | false | Node[];
  export type Element = { t: string; p?: Record<string, unknown>; c?: Node[] };

  type Children = { children?: any };
  /** Theme tokens: an accent name maps to codecast's palette. */
  export type Tone = "default" | "muted" | "dim" | "blue" | "green" | "yellow" | "red" | "magenta" | "cyan" | "orange" | "violet";
  type Space = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12;
  type Layout = Children & {
    gap?: Space; pad?: Space; padX?: Space; padY?: Space; align?: "start" | "center" | "end" | "stretch" | "baseline";
    justify?: "start" | "center" | "end" | "between" | "around"; wrap?: boolean; grow?: boolean; width?: number | string;
    height?: number | string; maxWidth?: number | string; scroll?: boolean; border?: boolean; rounded?: boolean;
    bg?: "card" | "alt" | "none" | Tone; tone?: Tone; onPress?: () => unknown; tip?: string;
  };

  export const Box: (p: Layout & { direction?: "row" | "column" }) => Element;
  export const Row: (p: Layout) => Element;
  export const Column: (p: Layout) => Element;
  export const Grid: (p: Layout & { columns?: number | string; min?: number }) => Element;
  export const Card: (p: Layout & { title?: string; subtitle?: string; actions?: Node }) => Element;
  /** `grow` takes the free space in a Row (as on layouts). */
  export const Text: (p: Children & { tone?: Tone; size?: "xs" | "sm" | "md" | "lg" | "xl" | "2xl"; weight?: "normal" | "medium" | "semibold" | "bold"; mono?: boolean; italic?: boolean; truncate?: boolean; lines?: number; align?: "left" | "center" | "right"; grow?: boolean; tip?: string }) => Element;
  export const Heading: (p: Children & { level?: 1 | 2 | 3; tone?: Tone }) => Element;
  export const Button: (p: Children & { label?: string; onPress?: () => unknown; variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md"; icon?: string; disabled?: boolean; tip?: string }) => Element;
  export const Input: (p: { value?: string; placeholder?: string; onChange?: (value: string) => unknown; onSubmit?: (value: string) => unknown; autoFocus?: boolean; mono?: boolean; width?: number | string }) => Element;
  export const TextArea: (p: { value?: string; placeholder?: string; rows?: number; onChange?: (value: string) => unknown; onSubmit?: (value: string) => unknown }) => Element;
  export const Select: (p: { value?: string; options: (string | { value: string; label: string })[]; onChange?: (value: string) => unknown; placeholder?: string }) => Element;
  export const Toggle: (p: { value?: boolean; label?: string; onChange?: (value: boolean) => unknown }) => Element;
  /** Columns name fields of each row; a column's `render` key names how to draw the cell. */
  export const Table: (p: {
    rows: Record<string, unknown>[];
    columns: { key: string; label?: string; width?: number | string; align?: "left" | "right" | "center"; as?: "text" | "ref" | "time" | "badge" | "number" | "mono" | "markdown" }[];
    onRowPress?: (row: Record<string, unknown>) => unknown; empty?: string; dense?: boolean; sortable?: boolean; maxHeight?: number;
  }) => Element;
  export const Tabs: (p: Children & { value?: string; onChange?: (value: string) => unknown }) => Element;
  export const Tab: (p: Children & { id: string; label: string; count?: number }) => Element;
  export const Badge: (p: Children & { tone?: Tone; dot?: boolean }) => Element;
  /** A live codecast reference: "ct-123", "pl-8", "tr-4", "bug-14", a session id, "owner/repo#12". Draws as the same pill messages use, titled with the object's own title; `label` shows only until the object resolves. */
  export const Ref: (p: { id: string; label?: string }) => Element;
  /** An Observable Plot spec, as cast-canvas charts take: { marks: [{ type: "barY", data, x, y }], y: { grid: true } }. */
  export const Chart: (p: { spec: Record<string, unknown>; height?: number }) => Element;
  /** Markdown drawn the way messages are: short ids become live pills. */
  export const Markdown: (p: { text: string; size?: "sm" | "md" }) => Element;
  /** Raw HTML and SVG, sanitized and themed like a cast-canvas block (no scripts). */
  export const Canvas: (p: { html: string; height?: number }) => Element;
  export const Code: (p: { code: string; lang?: string; wrap?: boolean; maxHeight?: number }) => Element;
  export const Progress: (p: { value: number; max?: number; tone?: Tone; label?: string }) => Element;
  export const Divider: (p: { label?: string }) => Element;
  export const Spacer: (p: { size?: Space }) => Element;
  /** A lucide icon by name, e.g. "bug", "git-pull-request", "sparkles". */
  export const Icon: (p: { name: string; size?: number; tone?: Tone }) => Element;
  export const Link: (p: Children & { href: string; tone?: Tone }) => Element;
  export const Image: (p: { src: string; alt?: string; width?: number | string; height?: number | string; rounded?: boolean }) => Element;
  export const Kbd: (p: { keys: string }) => Element;
  export const Stat: (p: { label: string; value: string | number; delta?: string; tone?: Tone; hint?: string }) => Element;
  export const Empty: (p: { title: string; hint?: string; icon?: string }) => Element;
  export const List: (p: Children & { dense?: boolean; divided?: boolean }) => Element;
  export const Item: (p: Children & { title?: string; subtitle?: string; icon?: string; trailing?: Node; onPress?: () => unknown; tone?: Tone }) => Element;
  /** A time, relative ("3m ago") by default. Takes ms since the epoch or an ISO string. */
  export const Time: (p: { at: number | string; format?: "relative" | "time" | "date" | "datetime" }) => Element;
  export const Avatar: (p: { name?: string; src?: string; size?: number }) => Element;
  export const Sparkline: (p: { values: number[]; tone?: Tone; height?: number; width?: number }) => Element;

  export const Fragment: string;
  export function h(type: any, props: any, ...children: any[]): any;
}

// The local half: `import { type LocalRegister } from "codecast-mod/local"`.
// It runs in the codecast daemon on your machine with that machine's access
// (node:fs, processes, network), at a version you approved there.
declare module "codecast-mod/local" {
  export type RunResult = { code: number; stdout: string; stderr: string };
  export interface LocalApi {
    /** Publish a value the mod's UI reads with $.local.get(key) and redraws on. Coalesced to one write a second per key. */
    publish(key: string, value: unknown): void;
    objects: {
      create(obj: { prefix: string; title: string; status?: string; fields?: Record<string, unknown>; body?: string }): Promise<{ short_id: string }>;
      update(shortId: string, patch: { title?: string; status?: string; fields?: Record<string, unknown>; body?: string }): Promise<void>;
    };
    /** Run a cast command, e.g. $.cast(["task", "ls", "--json"]). */
    cast(argv: string[], opts?: { cwd?: string; timeoutMs?: number }): Promise<RunResult>;
    /** Run a command line in a login shell. */
    sh(command: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<RunResult>;
    every(ms: number, fn: () => unknown): () => void;
    after(ms: number, fn: () => unknown): () => void;
    readonly device: string;
    readonly manifest: any;
  }
  export type LocalHook<E> = ($: LocalApi, e: Readonly<E>) => unknown;
  export interface LocalOn {
    /** Once, when the daemon starts this half. Start timers here. */
    (event: "local.start", hook: LocalHook<{ device: string }>): void;
    /** A call from the mod's UI ($.local.call(method, args)); the return value is the answer. */
    (event: "local.call", matcher: { method: string }, hook: LocalHook<{ method: string; args: any }>): void;
    /**
     * Any of your sessions, on any agent and machine, changing who acts next: "working", "needs_input",
     * "done", "dormant", "idle". Runs always, with no window open. Match on to/from to narrow it.
     */
    (event: "session.state", hook: LocalHook<{ id: string; from: string | null; to: string; title?: string }>): void;
    (event: "session.state", matcher: { to?: string; from?: string }, hook: LocalHook<{ id: string; from: string | null; to: string; title?: string }>): void;
  }
  export type LocalRegister = (on: LocalOn) => void | Promise<void>;
}

declare namespace JSX {
  type Element = any;
  interface IntrinsicElements { [name: string]: any }
  interface ElementChildrenAttribute { children: {} }
  /** `key` keeps a list's rows apart across redraws, as in React. */
  interface IntrinsicAttributes { key?: string | number }
}
