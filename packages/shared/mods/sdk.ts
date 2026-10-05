// The mod SDK: what `import ... from "codecast-mod"` resolves to. The CLI bundles
// it into every mod, so it runs inside the mod's sandboxed iframe, never in the
// app. It turns JSX into plain element trees, keeps the hooks a mod registers,
// answers the host's requests (render a surface, run a command, call a
// handler) and turns every `$` call into a message the host answers.

import type { FrameToHost, HostToFrame, ModContext, ModManifest, ModNode, ModSurface } from "../contracts/mods";

// -- Elements and JSX --------------------------------------------------------

type Props = Record<string, unknown> | null;
type Component = (props: Record<string, unknown>) => unknown;

export const Fragment = "Fragment";

/** JSX factory. Function components run at once: a tree is data, not a live component. */
export function h(type: string | Component, props: Props, ...children: unknown[]): unknown {
  const p = { ...(props ?? {}) } as Record<string, unknown>;
  const kids = flatten(children);
  if (typeof type === "function") return type({ ...p, children: kids });
  if (type === Fragment) return kids;
  const out: { t: string; p?: Record<string, unknown>; c?: unknown[] } = { t: type };
  if (Object.keys(p).length) out.p = p;
  if (kids.length) out.c = kids;
  return out;
}

function flatten(list: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const item of list) {
    if (Array.isArray(item)) out.push(...flatten(item));
    else if (item !== undefined && item !== null && item !== false && item !== true) out.push(item);
  }
  return out;
}

// Element names as values, so `<Box>` compiles to h("Box", …) and a typo is a
// compile error in the author's editor rather than a refused tree.
export const Box = "Box", Row = "Row", Column = "Column", Grid = "Grid", Card = "Card", Text = "Text", Heading = "Heading",
  Button = "Button", Input = "Input", TextArea = "TextArea", Select = "Select", Toggle = "Toggle", Table = "Table",
  Tabs = "Tabs", Tab = "Tab", Badge = "Badge", Ref = "Ref", Chart = "Chart", Markdown = "Markdown", Canvas = "Canvas",
  Code = "Code", Progress = "Progress", Divider = "Divider", Spacer = "Spacer", Icon = "Icon", Link = "Link",
  Image = "Image", Kbd = "Kbd", Stat = "Stat", Empty = "Empty", List = "List", Item = "Item", Time = "Time",
  Avatar = "Avatar", Sparkline = "Sparkline";

// -- Hooks --------------------------------------------------------------------

type Next = (e?: any) => Promise<any>;
type Hook = ($: any, e: any, next: Next) => unknown;
type Registration = { event: string; matcher?: Record<string, unknown>; hook: Hook };
export type On = (event: string, matcherOrHook: Record<string, unknown> | Hook, hook?: Hook) => void;
export type Register = (on: On) => void;

const hooks: Registration[] = [];
const handlers = new Map<string, Map<string, (...args: unknown[]) => unknown>>();
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let callSeq = 0;
let manifest: ModManifest | null = null;
let context: ModContext | null = null;

function post(msg: FrameToHost): void {
  parent.postMessage(msg, "*");
}

function matches(reg: Registration, event: string, e: Record<string, unknown>): boolean {
  if (reg.event !== event) return false;
  if (!reg.matcher) return true;
  return Object.entries(reg.matcher).every(([k, v]) => e[k] === v);
}

/** Runs the hooks for one event as a chain: each gets `next`, the last `next` is the host's default. */
async function dispatch(event: string, e: Record<string, unknown>, $: unknown, fallback: (e: any) => unknown): Promise<unknown> {
  const chain = hooks.filter((reg) => matches(reg, event, e));
  const run = async (i: number, input: any): Promise<unknown> => {
    if (i >= chain.length) return fallback(input);
    return await chain[i].hook($, Object.freeze({ ...input }), (next?: any) => run(i + 1, next ?? input));
  };
  return run(0, e);
}

// -- $ ------------------------------------------------------------------------

function call(key: string | undefined, method: string, args: unknown[]): Promise<unknown> {
  const cid = `c${++callSeq}`;
  return new Promise((resolve, reject) => {
    pending.set(cid, { resolve, reject });
    post({ type: "call", cid, key, method, args: JSON.parse(JSON.stringify(args ?? [])) });
  });
}

async function modFetch(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json: unknown = undefined;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, headers: Object.fromEntries(res.headers.entries()), text, json };
}

/** A `$` bound to one dispatch, so the host knows which surface a read belongs to and re-renders it when that data changes. */
function makeApi(key?: string): any {
  const local: Record<string, Record<string, unknown>> = {
    http: { fetch: modFetch },
    ui: { invalidate: (k?: string) => post({ type: "invalidate", key: k ?? key }) },
  };
  const nouns = new Map<string, unknown>();
  return new Proxy({}, {
    get(_t, noun: string) {
      if (noun === "manifest") return manifest;
      if (noun === "context") return context;
      if (noun === "key") return key;
      if (noun === "me") return () => call(key, "me", []);
      if (nouns.has(noun)) return nouns.get(noun);
      const ns = new Proxy({}, {
        get(_n, method: string) {
          const own = local[noun]?.[method];
          if (own) return own;
          return (...args: unknown[]) => call(key, `${noun}.${method}`, args);
        },
      });
      nouns.set(noun, ns);
      return ns;
    },
  });
}

// -- Trees --------------------------------------------------------------------

/** Swaps every function prop for a handler id and keeps the function, per surface key. */
function serialize(node: unknown, key: string, fns: Map<string, (...args: unknown[]) => unknown>): ModNode {
  if (node === null || node === undefined || node === false || node === true) return null;
  if (typeof node === "string" || typeof node === "number") return node;
  if (Array.isArray(node)) return { t: "Fragment", c: node.map((n) => serialize(n, key, fns)) };
  if (typeof node !== "object") return String(node);
  const el = node as { t?: string; p?: Record<string, unknown>; c?: unknown[] };
  if (typeof el.t !== "string") return String(JSON.stringify(node));
  const out: { t: string; p?: Record<string, unknown>; c?: ModNode[] } = { t: el.t };
  if (el.p) {
    out.p = {};
    for (const [k, v] of Object.entries(el.p)) {
      if (k === "children") continue;
      if (typeof v === "function") {
        const id = `${key}#${fns.size + 1}`;
        fns.set(id, v as (...args: unknown[]) => unknown);
        out.p[k] = { $fn: id };
      } else out.p[k] = v === undefined ? null : JSON.parse(JSON.stringify(v));
    }
  }
  if (el.c) out.c = el.c.map((c) => serialize(c, key, fns));
  return out;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.stack ? `${err.message}\n${err.stack.split("\n").slice(1, 6).join("\n")}` : err.message;
  return String(err);
}

// -- Messages from the host ---------------------------------------------------

async function onMessage(msg: HostToFrame): Promise<void> {
  switch (msg.type) {
    case "reply": {
      const p = pending.get(msg.cid);
      if (!p) return;
      pending.delete(msg.cid);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error ?? "refused"));
      return;
    }
    case "render": {
      const surface: ModSurface = msg.surface;
      const e = { surface: surface.kind, [surface.kind]: surface.id, props: surface.props ?? {}, context };
      try {
        let passed = false;
        const tree = await dispatch("ui.render", e, makeApi(msg.key), () => { passed = true; return null; });
        const fns = new Map<string, (...args: unknown[]) => unknown>();
        const out = serialize(tree, msg.key, fns);
        handlers.set(msg.key, fns);
        post({ type: "rendered", rid: msg.rid, tree: out, pass: passed && out === null });
      } catch (err) {
        post({ type: "rendered", rid: msg.rid, error: errorText(err) });
      }
      return;
    }
    case "invoke": {
      const key = msg.fn.slice(0, msg.fn.lastIndexOf("#"));
      const fn = handlers.get(key)?.get(msg.fn);
      try {
        if (!fn) throw new Error(`that control is gone (${msg.fn}); the surface re-rendered`);
        await fn(...msg.args);
        post({ type: "done", rid: msg.rid });
      } catch (err) {
        post({ type: "done", rid: msg.rid, error: errorText(err) });
      }
      return;
    }
    case "command": {
      try {
        await dispatch("command.run", { command: msg.id }, makeApi(), () => undefined);
        post({ type: "done", rid: msg.rid });
      } catch (err) {
        post({ type: "done", rid: msg.rid, error: errorText(err) });
      }
      return;
    }
    case "emit": {
      try {
        await dispatch(msg.event, { ...(msg.payload as object) }, makeApi(), () => undefined);
      } catch (err) {
        post({ type: "log", level: "error", text: `${msg.event}: ${errorText(err)}` });
      }
      return;
    }
  }
}

function captureConsole(): void {
  for (const level of ["log", "warn", "error"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      const text = args.map((a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(" ");
      post({ type: "log", level, text: text.slice(0, 4000) });
    };
  }
  addEventListener("error", (ev) => post({ type: "log", level: "error", text: errorText((ev as ErrorEvent).error ?? (ev as ErrorEvent).message) }));
  addEventListener("unhandledrejection", (ev) => post({ type: "log", level: "error", text: `unhandled: ${errorText((ev as PromiseRejectionEvent).reason)}` }));
}

/** Called by the bundle's entry with the mod's `register`. */
export async function start(register: Register | undefined): Promise<void> {
  const load = (globalThis as any).__modLoad as Extract<HostToFrame, { type: "load" }> | undefined;
  manifest = load?.mod.manifest ?? null;
  context = load?.mod.context ?? null;
  captureConsole();
  addEventListener("message", (ev: MessageEvent) => {
    if (ev.source !== parent || !ev.data || typeof ev.data.type !== "string") return;
    void onMessage(ev.data as HostToFrame);
  });
  if (typeof register !== "function") {
    post({ type: "load-failed", error: "the hooks module must export a `register(on)` function" });
    return;
  }
  const on: On = (event, matcherOrHook, hook) => {
    if (typeof matcherOrHook === "function") hooks.push({ event, hook: matcherOrHook as Hook });
    else if (typeof hook === "function") hooks.push({ event, matcher: matcherOrHook, hook });
    else throw new Error(`on("${event}") needs a hook function`);
  };
  try {
    await register(on);
  } catch (err) {
    post({ type: "load-failed", error: `register threw: ${errorText(err)}` });
    return;
  }
  post({ type: "ready", hooks: hooks.map(({ event, matcher }) => ({ event, matcher })) });
  try {
    await dispatch("mod.start", { context }, makeApi(), () => undefined);
  } catch (err) {
    post({ type: "log", level: "error", text: `mod.start: ${errorText(err)}` });
  }
}
