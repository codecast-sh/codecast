// The web host for codecast mods (plan pl-839; contract in
// shared/contracts/mods.ts). Each enabled mod runs in its own hidden iframe on
// /mod-host.html with sandbox="allow-scripts" and no same origin, so its code
// has an opaque origin and reaches nothing of the app. Everything it does goes
// through the messages below: it asks for data, the host answers from the
// local store (so reads are instant and offline), filtered by what the
// manifest grants; it asks for an action, the host runs the store's own action
// (so writes are optimistic like any other); it returns an element tree, the
// host draws it with codecast's components (ModTree).

import { toast } from "sonner";
import {
  MOD_COLLECTIONS, MOD_PROTOCOL, canRead, canWrite, permissionsSig,
  type FrameToHost, type HostToFrame, type ModContext, type ModEventName, type ModManifest, type ModNode, type ModSurface,
} from "@codecast/shared/contracts/mods";
import { withoutUndo } from "@platform/engine";
import { useInboxStore, sessionWorkState, placeInboxRows, isSub, type InboxSession } from "../../store/inboxStore";
import { WORKSPACE_SCOPED_KEYS } from "../../store/clientSyncRegistry";
import { filterByWorkspace } from "../workspaceScope";
import { activeWorkspaceKeyOf } from "../workspaceScope";
import { objectByShortId } from "./objects";

export type ModRow = {
  _id: string;
  name: string;
  title?: string;
  description?: string;
  manifest: ModManifest;
  code: string;
  rev: number;
  version: number;
  enabled: boolean;
  is_mine?: boolean;
  shared?: boolean;
  owner_name?: string;
  updated_at: number;
};

export type ModStatus = "loading" | "ready" | "failed";
export type ModLogLine = { level: "log" | "warn" | "error"; text: string; at: number };
export type RenderResult = { tree?: ModNode; error?: string; pass?: boolean };

/** The app-side capabilities the host needs from React land, registered by ModRuntimes. */
export type HostBridge = {
  navigate: (path: string) => void;
  log: (modId: string, entries: { level: string; text: string }[]) => void;
  /** Queue a call to the mod's local half and resolve with its answer. */
  callLocal: (modId: string, method: string, args: unknown) => Promise<unknown>;
};

let bridge: HostBridge | null = null;
export function setModBridge(b: HostBridge | null): void {
  bridge = b;
}
/** In-app navigation for mod surfaces and the host: the router ModRuntimes registered, else a full load. */
export function modNavigate(path: string): void {
  if (bridge) bridge.navigate(path);
  else window.location.assign(path);
}

const RENDER_TIMEOUT = 20000;
/** A mod whose register() has not returned by now is marked failed rather than left loading forever. */
const LOAD_TIMEOUT = 20000;
/** The most one mod may keep in $.state on a device. */
const STATE_CAP = 200_000;
const CALL_LIMIT = 500;

// -- Data ---------------------------------------------------------------------

type Query = {
  where?: Record<string, unknown>;
  sort?: string;
  order?: "asc" | "desc";
  limit?: number;
  fields?: string[];
  search?: string;
};

function baseName(p?: string): string | undefined {
  if (!p) return undefined;
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || undefined;
}

/**
 * The person's inbox as the inbox itself places it: which section each of
 * their sessions sits in. The same placement the sidebar draws (memoized
 * there), so a mod never re-derives "is this waiting on me" from raw fields.
 */
type InboxView = { visible: Record<string, unknown>; placements: Map<string, { bucket: string }> };
function inboxPlacements(): InboxView {
  try {
    const placed = placeInboxRows(useInboxStore.getState() as any, { scope: "mine" });
    return { visible: placed.visibleSessions, placements: placed.placements as any };
  } catch {
    return { visible: {}, placements: new Map() };
  }
}

/** A row as a mod sees it: the store's row plus the derived facts every mod would otherwise recompute. */
function present(collection: string, row: any, inbox?: InboxView): any {
  if (collection === "sessions") {
    const s = row as any;
    let state: string | undefined;
    try { state = sessionWorkState(s as InboxSession); } catch { state = undefined; }
    const me = String((useInboxStore.getState() as any).currentUser?._id ?? "");
    // Membership is the inbox's own row set; the section is its server-stamped
    // bucket when one has arrived, else the work state it sorts by.
    // Machine-started rows (subagents, workers, spawned fan-out) nest under their parent, never as the person's own card.
    const shown = !!inbox && (String(s._id) in inbox.visible || String(s.session_id) in inbox.visible) && !isSub(s as InboxSession);
    const bucket = inbox?.placements.get(String(s._id))?.bucket ?? inbox?.placements.get(String(s.session_id))?.bucket;
    return {
      ...row,
      state,
      // The section of the person's inbox the session sits in, or null when the inbox does not show it
      // (a subagent, a worker, a killed, stashed or filed session, someone else's).
      inbox: shown && bucket !== "hidden" ? (bucket ?? state ?? null) : null,
      mine: !!me && String(s.user_id ?? "") === me,
      // When the session last came to rest (its turn ended), for "how long has it waited".
      waiting_since: state && state !== "working" ? (s.turn_completed_at ?? s.agent_status_updated_at ?? s.updated_at ?? null) : null,
      project: baseName(s.git_root ?? s.project_path),
      title: s.title || s.short_title || undefined,
    };
  }
  return row;
}

const SCOPED = new Set<string>(WORKSPACE_SCOPED_KEYS);

/** A collection's rows as the person sees them: a workspace-scoped table holds only the active workspace's rows, the way its own pages show it. */
function rowsOf(collection: string): any[] {
  const key = (MOD_COLLECTIONS as Record<string, string>)[collection];
  const st = useInboxStore.getState() as any;
  const raw = st[key];
  if (!raw) return [];
  const list = (Array.isArray(raw) ? raw : Object.values(raw)).filter((r: any) => r && typeof r === "object" && !String(r._id ?? "").startsWith("__"));
  return SCOPED.has(key) ? filterByWorkspace(list, activeWorkspaceKeyOf(st)) : list;
}

function matchOne(value: unknown, cond: unknown): boolean {
  if (cond && typeof cond === "object" && !Array.isArray(cond)) {
    const c = cond as Record<string, unknown>;
    if ("in" in c) return Array.isArray(c.in) && c.in.includes(value as never);
    if ("ne" in c) return value !== c.ne;
    if ("gt" in c) return typeof value === "number" && value > (c.gt as number);
    if ("lt" in c) return typeof value === "number" && value < (c.lt as number);
    if ("contains" in c) return typeof value === "string" && value.toLowerCase().includes(String(c.contains).toLowerCase());
    if ("exists" in c) return (value !== undefined && value !== null) === !!c.exists;
  }
  return value === cond;
}

export function queryCollection(collection: string, q: Query = {}): any[] {
  const inbox = collection === "sessions" ? inboxPlacements() : undefined;
  let rows = rowsOf(collection).map((r) => present(collection, r, inbox));
  if (q.where) rows = rows.filter((r) => Object.entries(q.where!).every(([k, cond]) => matchOne(k.includes(".") ? k.split(".").reduce((v: any, part) => v?.[part], r) : r[k], cond)));
  if (q.search) {
    const needle = q.search.toLowerCase();
    rows = rows.filter((r) => ["title", "name", "message", "description", "content", "subtitle"].some((f) => typeof r[f] === "string" && r[f].toLowerCase().includes(needle)));
  }
  if (q.sort) {
    const dir = q.order === "asc" ? 1 : -1;
    const k = q.sort;
    rows.sort((a, b) => {
      const x = a[k], y = b[k];
      if (x === y) return 0;
      if (x === undefined || x === null) return 1;
      if (y === undefined || y === null) return -1;
      return (x > y ? 1 : -1) * dir;
    });
  }
  rows = rows.slice(0, Math.min(Math.max(q.limit ?? 200, 0), CALL_LIMIT));
  if (q.fields?.length) {
    const keep = new Set(["_id", ...q.fields]);
    rows = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => keep.has(k))));
  }
  return rows;
}

/** A cheap fingerprint of an answer (FNV-1a over its JSON), to tell whether a re-read changed anything. */
function signature(v: unknown): string {
  const text = JSON.stringify(v ?? null);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `${text.length}:${(h >>> 0).toString(36)}`;
}

/** What postMessage can carry: plain data only (drops functions, symbols, cycles). */
function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v ?? null));
}

// -- State (the mod's own values) ---------------------------------------------

function stateKey(modId: string): string {
  const uid = String((useInboxStore.getState() as any).currentUser?._id ?? "anon");
  return `codecast-mod-state:${uid}:${modId}`;
}
function readState(modId: string): Record<string, unknown> {
  try { return JSON.parse(localStorage.getItem(stateKey(modId)) || "{}"); } catch { return {}; }
}
/** Returns whether the stored value changed. Refuses a write that would take the mod past its cap. */
function writeState(modId: string, key: string, value: unknown): boolean {
  const all = readState(modId);
  if (JSON.stringify(all[key] ?? null) === JSON.stringify(value ?? null)) return false;
  if (value === undefined || value === null) delete all[key];
  else all[key] = value;
  const text = JSON.stringify(all);
  if (text.length > STATE_CAP) throw new Error(`a mod keeps at most ${STATE_CAP / 1000} KB in $.state on a device`);
  localStorage.setItem(stateKey(modId), text);
  return true;
}

/** An in-app path: one leading slash, never `//host` (which leaves the app). */
export function isAppPath(path: string): boolean {
  return /^\/(?![\/\\])/.test(path);
}

function isPrimaryWindow(): boolean {
  return (useInboxStore.getState() as any).syncRole !== "follower";
}

// -- Pane props handed from $.ui.open to the pane's render ----------------------

const paneProps = new Map<string, Record<string, unknown>>();
export function takePaneProps(mod: string, pane: string): Record<string, unknown> | undefined {
  return paneProps.get(`${mod}:${pane}`);
}

// -- Runtime ------------------------------------------------------------------

type Pending = { resolve: (r: RenderResult) => void; timer: ReturnType<typeof setTimeout> };
type Done = { resolve: (error?: string) => void };

export class ModRuntime {
  readonly id: string;
  row: ModRow;
  status: ModStatus = "loading";
  error: string | null = null;
  hooks: { event: string; matcher?: Record<string, unknown> }[] = [];
  logs: ModLogLine[] = [];
  private frame: HTMLIFrameElement | null = null;
  private seq = 0;
  private renders = new Map<string, Pending>();
  private dones = new Map<string, Done>();
  /** Per surface: the data calls its last render made and a signature of each answer. */
  private answers = new Map<string, { method: string; args: unknown[]; collection: string; sig: string }[]>();
  private invalidators = new Map<string, Set<() => void>>();
  private statusListeners = new Set<() => void>();
  private pendingLogs: { level: string; text: string }[] = [];
  private logTimer: ReturnType<typeof setTimeout> | null = null;
  private readyWaiters: (() => void)[] = [];
  private loads = 0;
  /** Clicks and commands of the person's still being answered: a "ui" write during one is theirs. */
  private userActs = 0;
  private loadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(row: ModRow, private container: HTMLElement) {
    this.id = row._id;
    this.row = row;
    this.onMessage = this.onMessage.bind(this);
    window.addEventListener("message", this.onMessage);
    this.mount();
  }

  private mount(): void {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("tabindex", "-1");
    frame.title = `mod ${this.row.name}`;
    frame.dataset.mod = this.row.name;
    frame.src = "/mod-host.html";
    this.loads = 0;
    // The sandbox page loads once. A second load means the mod navigated its
    // own frame (a way to carry data out in a URL), so the mod is stopped.
    frame.addEventListener("load", () => {
      if (++this.loads > 1 && frame === this.frame) this.fail("the mod navigated its own frame away; mods draw through codecast and never navigate");
    });
    this.container.appendChild(frame);
    this.frame = frame;
    if (this.loadTimer) clearTimeout(this.loadTimer);
    this.loadTimer = setTimeout(() => { if (this.status === "loading" && frame === this.frame) this.fail(`did not finish loading within ${LOAD_TIMEOUT / 1000}s (register never returned, or the machine is under heavy load)`); }, LOAD_TIMEOUT);
  }

  private fail(error: string): void {
    this.status = "failed";
    this.error = error;
    this.addLog("error", error);
    this.teardownFrame(error);
    this.readyWaiters.splice(0).forEach((r) => r());
    this.notifyStatus();
  }

  /** A new bundle for the same mod: start over in a fresh frame, keep the subscribers. */
  reload(row: ModRow): void {
    this.row = row;
    this.teardownFrame("reloaded");
    this.status = "loading";
    this.error = null;
    this.hooks = [];
    this.mount();
    this.notifyStatus();
  }

  dispose(): void {
    if (this.loadTimer) clearTimeout(this.loadTimer);
    window.removeEventListener("message", this.onMessage);
    this.teardownFrame("the mod was turned off");
    this.flushLogs();
    this.statusListeners.clear();
    this.invalidators.clear();
  }

  private teardownFrame(reason: string): void {
    this.frame?.remove();
    this.frame = null;
    for (const [rid, p] of this.renders) { clearTimeout(p.timer); p.resolve({ error: reason }); this.renders.delete(rid); }
    for (const [rid, d] of this.dones) { d.resolve(reason); this.dones.delete(rid); }
  }

  private post(msg: HostToFrame): void {
    this.frame?.contentWindow?.postMessage(msg, "*");
  }

  private context(): ModContext {
    const st = useInboxStore.getState() as any;
    const user = st.currentUser;
    const isDark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
    return {
      user: user ? { id: String(user._id), name: user.name ?? undefined } : null,
      team: st.clientState?.ui?.active_team_id ? { id: String(st.clientState.ui.active_team_id) } : null,
      surface: typeof window !== "undefined" && (window as any).electronAPI ? "desktop" : "web",
      theme: isDark ? "dark" : "light",
    };
  }

  onStatus(fn: () => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }
  private notifyStatus(): void {
    for (const fn of [...this.statusListeners]) fn();
    modHost.bump();
  }

  /** Subscribe a mounted surface to redraws: invalidate, a write to the mod's state, or a change in what it read. */
  /** A surface unmounted: the frame can drop its handlers. */
  release(key: string): void {
    this.answers.delete(key);
    if (this.status === "ready") this.post({ type: "release", key });
  }

  onInvalidate(key: string, fn: () => void): () => void {
    let set = this.invalidators.get(key);
    if (!set) this.invalidators.set(key, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size) { this.invalidators.delete(key); this.answers.delete(key); }
    };
  }

  invalidate(key?: string): void {
    const keys = !key || key === "*" ? [...this.invalidators.keys()] : [key];
    for (const k of keys) for (const fn of [...(this.invalidators.get(k) ?? [])]) fn();
  }

  /**
   * Called with the store collections that just changed. A surface redraws
   * only when one of its own reads now answers differently: heartbeats touch
   * the sessions collection every second, and a pane that shows counts must
   * not redraw for them.
   */
  dataChanged(changed: Set<string>): void {
    for (const [key, calls] of this.answers) {
      const stale = calls.some((c) => changed.has(c.collection) && signature(this.runData(c.method, c.args)) !== c.sig);
      if (stale) this.invalidate(key);
    }
    // Event hooks run in the one window that syncs, so a hook that writes fires once, not per tab.
    if (isPrimaryWindow() && this.hooks.some((h) => h.event === "data.change")) {
      for (const c of changed) this.emit("data.change", { collection: c });
    }
  }

  hasHook(event: string): boolean {
    return this.hooks.some((h) => h.event === event);
  }

  whenReady(): Promise<void> {
    if (this.status !== "loading") return Promise.resolve();
    return new Promise((r) => this.readyWaiters.push(r));
  }

  async render(key: string, surface: ModSurface): Promise<RenderResult> {
    await this.whenReady();
    if (this.status === "failed") return { error: this.error ?? "the mod failed to load" };
    const rid = `r${++this.seq}`;
    this.answers.set(key, []);
    return await new Promise<RenderResult>((resolve) => {
      const timer = setTimeout(() => {
        this.renders.delete(rid);
        const error = `the render of ${key} took longer than ${RENDER_TIMEOUT / 1000}s (a hook that never returns, or a machine under heavy load)`;
        this.addLog("error", `render: ${error}`);
        resolve({ error });
      }, RENDER_TIMEOUT);
      this.renders.set(rid, { resolve, timer });
      this.post({ type: "render", rid, key, surface: plain(surface) });
    });
  }

  private awaitDone(send: (rid: string) => void): Promise<string | undefined> {
    const rid = `d${++this.seq}`;
    return new Promise((resolve) => {
      this.dones.set(rid, { resolve });
      send(rid);
    });
  }

  async invoke(fn: string, args: unknown[]): Promise<string | undefined> {
    await this.whenReady();
    this.userActs++;
    const err = await this.awaitDone((rid) => this.post({ type: "invoke", rid, fn, args: plain(args) })).finally(() => { this.userActs--; });
    if (err) this.addLog("error", err);
    return err;
  }

  async command(id: string): Promise<string | undefined> {
    await this.whenReady();
    if (this.status === "failed") return this.error ?? "the mod failed to load";
    this.userActs++;
    const err = await this.awaitDone((rid) => this.post({ type: "command", rid, id })).finally(() => { this.userActs--; });
    if (err) this.addLog("error", `command ${id}: ${err}`);
    return err;
  }

  emit(event: ModEventName, payload: unknown): void {
    if (this.status !== "ready") return;
    this.post({ type: "emit", event, payload: plain(payload) });
  }

  private addLog(level: ModLogLine["level"], text: string): void {
    this.logs.push({ level, text, at: Date.now() });
    if (this.logs.length > 200) this.logs.splice(0, this.logs.length - 200);
    this.pendingLogs.push({ level, text });
    if (!this.logTimer) this.logTimer = setTimeout(() => this.flushLogs(), 1500);
    if (level === "error") modHost.bump();
  }

  private flushLogs(): void {
    if (this.logTimer) clearTimeout(this.logTimer);
    this.logTimer = null;
    if (!this.pendingLogs.length) return;
    const entries = this.pendingLogs.splice(0);
    bridge?.log(this.id, entries);
  }

  private onMessage(ev: MessageEvent): void {
    if (!this.frame || ev.source !== this.frame.contentWindow) return;
    const msg = ev.data as FrameToHost;
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "booted":
        this.post({ type: "load", proto: MOD_PROTOCOL, mod: { id: this.id, name: this.row.name, manifest: plain(this.row.manifest), context: this.context() }, code: this.row.code, primary: isPrimaryWindow() });
        return;
      case "ready":
        if (this.loadTimer) clearTimeout(this.loadTimer);
        this.status = "ready";
        this.hooks = Array.isArray(msg.hooks) ? msg.hooks.filter((h) => h && typeof h.event === "string").slice(0, 200) : [];
        this.readyWaiters.splice(0).forEach((r) => r());
        this.notifyStatus();
        return;
      case "load-failed":
        this.status = "failed";
        this.error = msg.error;
        this.addLog("error", `load failed: ${msg.error}`);
        this.readyWaiters.splice(0).forEach((r) => r());
        this.notifyStatus();
        return;
      case "rendered": {
        const p = this.renders.get(msg.rid);
        if (!p) return;
        clearTimeout(p.timer);
        this.renders.delete(msg.rid);
        if (msg.error) this.addLog("error", `render: ${msg.error}`);
        p.resolve({ tree: msg.tree, error: msg.error, pass: msg.pass });
        return;
      }
      case "done": {
        const d = this.dones.get(msg.rid);
        if (!d) return;
        this.dones.delete(msg.rid);
        d.resolve(msg.error);
        return;
      }
      case "log":
        this.addLog(msg.level, msg.text);
        return;
      case "invalidate":
        this.invalidate(msg.key);
        return;
      case "call":
        void this.answer(msg);
        return;
    }
  }

  /**
   * Whether a call is automation: an event hook's, or a surface's call that no
   * click of the person's is waiting on (a write made while drawing). Its
   * writes run outside the undo stack, the way every automation caller's do.
   */
  isAutomated(origin: string | undefined): boolean {
    if (origin === "user") return false;
    if (origin === "ui") return this.userActs === 0;
    return true;
  }

  private async answer(msg: Extract<FrameToHost, { type: "call" }>): Promise<void> {
    try {
      // The store action runs synchronously inside call() before its first
      // await, so wrapping the call covers the write itself.
      const run = () => this.call(msg.method, msg.args ?? [], msg.key);
      const value = await (this.isAutomated(msg.origin) ? withoutUndo(run) : run());
      this.post({ type: "reply", cid: msg.cid, ok: true, value: plain(value) });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.addLog("warn", `$.${msg.method} refused: ${error}`);
      this.post({ type: "reply", cid: msg.cid, ok: false, error });
    }
  }

  private needRead(collection: unknown): string {
    const c = String(collection);
    if (!(c in MOD_COLLECTIONS)) throw new Error(`"${c}" is not a collection a mod can read (${Object.keys(MOD_COLLECTIONS).join(", ")})`);
    if (!canRead(this.row.manifest, c)) throw new Error(`permissions.read does not include "${c}"`);
    return c;
  }

  /** The data reads, answered from the store. Pure, so a change check can run them again. */
  private runData(method: string, args: unknown[]): unknown {
    const a0 = args[0] as any;
    const a1 = args[1] as any;
    if (method === "local.get") {
      const rows = Object.values(((useInboxStore.getState() as any).modState ?? {}) as Record<string, any>);
      const row = rows.find((r) => String(r?.mod_id) === this.id && r.key === String(a0));
      return row ? { value: row.value ?? null, device: row.device_name ?? null, at: row.updated_at } : null;
    }
    const c = this.needRead(a0);
    if (method === "data.list") return queryCollection(c, a1 ?? {});
    if (method === "data.count") return queryCollection(c, { ...(a1 ?? {}), limit: CALL_LIMIT, fields: ["_id"] }).length;
    if (a1 === undefined || a1 === null || a1 === "") return null;
    const row = rowsOf(c).find((r) => String(r._id) === String(a1) || r.short_id === a1 || r.session_id === a1);
    return row ? present(c, row, c === "sessions" ? inboxPlacements() : undefined) : null;
  }

  /** A mod writes only the object kinds it declares itself; it may read any. */
  private needOwnKind(prefix: string): void {
    if (!this.row.manifest.objects?.some((k) => k.prefix === prefix)) throw new Error(`"${prefix}" is not an object kind this mod declares`);
  }

  private needWrite(write: string): void {
    if (!canWrite(this.row.manifest, write)) throw new Error(`permissions.write does not include "${write}"`);
  }

  private async call(method: string, args: unknown[], key?: string): Promise<unknown> {
    const store = useInboxStore.getState() as any;
    const a0 = args[0] as any;
    const a1 = args[1] as any;
    switch (method) {
      case "data.list":
      case "data.count":
      case "data.get":
      case "local.get": {
        const value = this.runData(method, args);
        const collection = method === "local.get" ? "modState" : (MOD_COLLECTIONS as Record<string, string>)[String(a0)];
        if (key) this.answers.get(key)?.push({ method, args, collection, sig: signature(value) });
        // local.get answers the value itself; its device and time ride on $.local.meta.
        return method === "local.get" ? ((value as any)?.value ?? null) : value;
      }
      case "local.meta": return this.runData("local.get", args);
      case "local.call": {
        if (!this.row.is_mine) throw new Error("a local call reaches only your own mods");
        if (!bridge) throw new Error("not connected");
        return await bridge.callLocal(this.id, String(a0), a1 ?? null);
      }
      case "me": {
        const u = store.currentUser;
        return u ? { id: String(u._id), name: u.name } : null;
      }
      case "ui.toast": {
        const text = String(a0 ?? "").slice(0, 300);
        const kind = a1?.kind;
        if (kind === "success") toast.success(text);
        else if (kind === "error") toast.error(text);
        else toast(text);
        return null;
      }
      case "ui.navigate": {
        const path = String(a0 ?? "");
        if (!isAppPath(path)) throw new Error("navigate takes an in-app path starting with a single /");
        modNavigate(path);
        return null;
      }
      case "ui.open": {
        const pane = String(a0 ?? "");
        if (!this.row.manifest.panes?.some((p) => p.id === pane)) throw new Error(`no pane "${pane}" in the manifest`);
        if (a1 && typeof a1 === "object") paneProps.set(`${this.row.name}:${pane}`, a1);
        else paneProps.delete(`${this.row.name}:${pane}`);
        modNavigate(`/m/${this.row.name}/${pane}`);
        this.invalidate(`pane:${pane}`);
        return null;
      }
      case "ui.invalidate": this.invalidate(a0); return null;
      case "ui.copy": {
        this.needWrite("clipboard");
        await navigator.clipboard.writeText(String(a0 ?? ""));
        return null;
      }
      case "state.get": return readState(this.id)[String(a0)];
      case "state.set": {
        // Only a real change redraws, so a render that sets what it already holds does not loop.
        if (writeState(this.id, String(a0), a1)) this.invalidate("*");
        return null;
      }
      case "tasks.create": {
        this.needWrite("tasks");
        if (!a0?.title) throw new Error("a task needs a title");
        const res = await store.createTask({ title: String(a0.title), description: a0.description, priority: a0.priority, status: a0.status, labels: a0.labels });
        return { id: String(res?.short_id ?? res?.id ?? res?._id ?? res ?? "") };
      }
      case "tasks.update": {
        this.needWrite("tasks");
        await store.updateTask(String(a0), a1 ?? {});
        return null;
      }
      case "sessions.send": {
        this.needWrite("sessions");
        const text = String(a1 ?? "").trim();
        if (!text) throw new Error("an empty message");
        store.sendMessage(String(a0), text);
        return null;
      }
      case "sessions.open": {
        modNavigate(`/conversation/${String(a0)}`);
        return null;
      }
      case "objects.create": {
        this.needWrite("objects");
        if (!a0?.prefix || !a0?.title) throw new Error("an object needs a prefix (its kind) and a title");
        this.needOwnKind(String(a0.prefix));
        const opts = { prefix: String(a0.prefix), title: String(a0.title), status: a0.status, fields: a0.fields, body: a0.body };
        const res = store.createModObject(opts);
        return { client_key: res?.client_key };
      }
      case "objects.update":
      case "objects.archive": {
        this.needWrite("objects");
        const ref = String(a0 ?? "");
        const row = (store.modObjects ?? {})[ref] ?? objectByShortId(store.modObjects, ref);
        if (!row) throw new Error(`no object ${ref}`);
        this.needOwnKind(row.prefix);
        const patch = a1 && typeof a1 === "object" ? a1 : {};
        store.updateModObject(row._id, method === "objects.archive" ? { archived: true } : {
          ...(typeof patch.title === "string" ? { title: patch.title } : {}),
          ...(typeof patch.status === "string" ? { status: patch.status } : {}),
          ...(typeof patch.body === "string" ? { body: patch.body } : {}),
          ...(patch.fields && typeof patch.fields === "object" ? { fields: patch.fields } : {}),
        });
        return null;
      }
      case "docs.create": {
        this.needWrite("docs");
        const res = await store.createDoc({ title: String(a0?.title ?? "Untitled"), content: a0?.content ?? "" });
        return { id: String(res?._id ?? res?.id ?? res ?? "") };
      }
      default:
        throw new Error(`$.${method} is not part of the mod API`);
    }
  }
}

// -- Registry -----------------------------------------------------------------

type Listener = () => void;

class ModHost {
  private runtimes = new Map<string, ModRuntime>();
  private listeners = new Set<Listener>();
  private version = 0;
  private container: HTMLElement | null = null;
  private unsubStore: (() => void) | null = null;
  private lastStates = new Map<string, string>();

  attach(container: HTMLElement): void {
    this.container = container;
    if (!this.unsubStore) this.unsubStore = this.watchStore();
  }

  detach(): void {
    for (const r of this.runtimes.values()) r.dispose();
    this.runtimes.clear();
    this.unsubStore?.();
    this.unsubStore = null;
    this.container = null;
    this.bump();
  }

  /**
   * Reconciles the running set: the viewer's own mods by their switch, and
   * teammates' shared mods the viewer installed (and their author left on).
   */
  sync(rows: ModRow[], installed: readonly string[] = []): void {
    if (!this.container) return;
    const mine = (r: ModRow) => r.is_mine !== false;
    // A teammate's mod runs at the grants it was installed with (`<id>:<permissionsSig>`):
    // widened grants stop it until the viewer reviews them.
    const consented = (r: ModRow) => installed.includes(`${r._id}:${permissionsSig(r.manifest)}`);
    const want = new Map(rows.filter((r) => r.code && r.enabled && (mine(r) || consented(r))).map((r) => [r._id, r]));
    let changed = false;
    for (const [id, rt] of this.runtimes) {
      const next = want.get(id);
      if (!next) { rt.dispose(); this.runtimes.delete(id); changed = true; }
      else if (next.rev !== rt.row.rev || next.code !== rt.row.code) { rt.reload(next); changed = true; }
      else rt.row = next;
    }
    for (const [id, row] of want) {
      if (!this.runtimes.has(id)) { this.runtimes.set(id, new ModRuntime(row, this.container)); changed = true; }
    }
    if (changed) this.bump();
  }

  /**
   * What a mod's `$.data.list(collection, query)` answers, from this window's
   * store: for an author checking the rows a mod sees
   * (`cast browser eval "__modHost.query('sessions', { where: { inbox: 'needs_input' } })"`).
   */
  query(collection: string, q: Query = {}): any[] {
    if (!(collection in MOD_COLLECTIONS)) throw new Error(`"${collection}" is not a collection a mod can read (${Object.keys(MOD_COLLECTIONS).join(", ")})`);
    return queryCollection(collection, q);
  }

  get(id: string): ModRuntime | undefined {
    return this.runtimes.get(id);
  }

  /** Running mods with the viewer's own first: on a name or fence clash, yours wins over a teammate's. */
  private ordered(): ModRuntime[] {
    return [...this.runtimes.values()].sort((a, b) => Number(b.row.is_mine !== false) - Number(a.row.is_mine !== false));
  }

  byName(name: string): ModRuntime | undefined {
    return this.ordered().find((r) => r.row.name === name);
  }

  /** The runtime that draws a fence language, if any enabled mod declares it. */
  forFence(lang: string): ModRuntime | undefined {
    return this.ordered().find((r) => r.row.manifest.fences?.some((f) => f.lang === lang));
  }

  all(): ModRuntime[] {
    return [...this.runtimes.values()];
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getVersion(): number {
    return this.version;
  }

  bump(): void {
    this.version++;
    for (const fn of [...this.listeners]) fn();
  }

  /** One store subscription for every mod: which watched collections changed, and which sessions moved state. */
  private watchStore(): () => void {
    const keys = [...Object.values(MOD_COLLECTIONS), "modState"];
    let pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = useInboxStore.subscribe((s: any, prev: any) => {
      if (!this.runtimes.size) return;
      for (const k of keys) if (s[k] !== prev[k]) pending.add(k);
      if (!pending.size || timer) return;
      timer = setTimeout(() => {
        timer = null;
        const changed = pending;
        pending = new Set();
        // One mod failing to answer must not stop the rest from hearing about changes.
        for (const rt of this.runtimes.values()) {
          try { rt.dataChanged(changed); } catch (err) { console.warn(`[mods] ${rt.row.name}: ${err instanceof Error ? err.message : String(err)}`); }
        }
        if (changed.has("sessions")) this.emitSessionStates();
      }, 400);
    });
    this.seedSessionStates();
    return () => { unsub(); if (timer) clearTimeout(timer); };
  }

  private seedSessionStates(): void {
    for (const s of rowsOf("sessions")) {
      try { this.lastStates.set(String(s._id), sessionWorkState(s)); } catch {}
    }
  }

  private emitSessionStates(): void {
    const listeners = [...this.runtimes.values()].filter((r) => r.hasHook("session.state"));
    const moves: { id: string; title?: string; from: string | null; to: string; project?: string }[] = [];
    for (const s of rowsOf("sessions")) {
      let to: string;
      try { to = sessionWorkState(s); } catch { continue; }
      const id = String(s._id);
      const from = this.lastStates.get(id) ?? null;
      if (from !== to) {
        this.lastStates.set(id, to);
        if (from !== null) moves.push({ id, title: s.title, from, to, project: baseName(s.git_root ?? s.project_path) });
      }
    }
    if (!listeners.length || !isPrimaryWindow()) return;
    for (const m of moves) for (const rt of listeners) rt.emit("session.state", m);
  }
}

export const modHost = new ModHost();
if (typeof window !== "undefined") (window as any).__modHost = modHost;
