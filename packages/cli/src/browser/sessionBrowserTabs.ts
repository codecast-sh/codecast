/**
 * The browser tabs each session on this machine has open right now, for the
 * web inbox's Browser view (convex/browserTabs.ts).
 *
 * Two sources:
 *   - `cast browser`: the browser itself. The extension bridge tags every cast
 *     tab in the person's Chrome with the engine session keys holding it, so
 *     one `/json/list` names them all with their live titles; the agent Chrome
 *     and the desktop pane are matched against each session's pinned tabs.
 *   - Claude in Chrome: the transcript, read incrementally. Its tool calls name
 *     the tab they drove, and its results carry the tab titles and addresses.
 *
 * The daemon runs one scan per tick and sends the device's whole set when it
 * changes, or when the keepalive comes due (BrowserTabsReporter).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  BROWSER_TABS_KEEPALIVE_MS,
  type BrowserTabWhere,
  type SessionBrowserReport,
  type SessionBrowserTab,
} from "@codecast/shared/contracts";
import { listTargets, readCdpJson, type CdpEndpoint } from "./cdp.js";
import { engineStateDir, isPaneSession, isRealSession, ownerOfSessionKey } from "./engine.js";
import { readState } from "./instance.js";
import { bridgeEndpointIfConfigured } from "./bridge/real.js";
import { liveDesktopPaneRegistry } from "./desktopPaneRegistry.js";
import { isPidAlive } from "../workspace/chrome.js";

/** A Claude in Chrome tab undriven this long no longer counts (cast closes its own idle tabs at the same age). */
export const CLAUDE_TAB_FRESH_MS = 30 * 60_000;
const MAX_TABS_PER_SESSION = 8;

/** The session id behind an engine key's owner part (`env-<id>`, `session-<id>`), or null for a pane owner. */
export function sessionIdOfEngineKey(key: string): string | null {
  const m = /^(?:env|session)-(.+)$/.exec(ownerOfSessionKey(key));
  return m ? m[1] : null;
}

interface Pin {
  key: string;
  targetId: string;
  mtimeMs: number;
}

function readPins(stateDir: string): Pin[] {
  let names: string[];
  try {
    names = fs.readdirSync(stateDir);
  } catch {
    return [];
  }
  const pins: Pin[] = [];
  for (const name of names) {
    if (!name.endsWith(".target")) continue;
    const file = path.join(stateDir, name);
    try {
      const t = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (typeof t?.targetId === "string") pins.push({ key: name.slice(0, -".target".length), targetId: t.targetId, mtimeMs: fs.statSync(file).mtimeMs });
    } catch {
      /* raced with a removal */
    }
  }
  return pins;
}

/** Accumulates tabs per session, first seen wins, newest use kept. */
export class TabSet {
  readonly bySession = new Map<string, { tabs: SessionBrowserTab[]; lastUsedAt: number }>();
  add(sessionId: string, tab: SessionBrowserTab, usedAt: number): void {
    const entry = this.bySession.get(sessionId) ?? { tabs: [], lastUsedAt: 0 };
    if (!entry.tabs.some((t) => t.id === tab.id && t.where === tab.where) && entry.tabs.length < MAX_TABS_PER_SESSION) entry.tabs.push(tab);
    entry.lastUsedAt = Math.max(entry.lastUsedAt, usedAt);
    this.bySession.set(sessionId, entry);
  }
  reports(): SessionBrowserReport[] {
    return [...this.bySession.entries()]
      .map(([session_id, e]) => ({ session_id, tabs: e.tabs, last_used_at: Math.round(e.lastUsedAt) }))
      .sort((a, b) => a.session_id.localeCompare(b.session_id));
  }
}

type BridgeTab = { id?: string; type?: string; title?: string; url?: string; cast?: boolean; sessions?: string[] };

export interface CastScanDeps {
  stateDir?: string;
  /** The bridge's tab list (`/json/list` on its CDP face), null when the bridge is not up. */
  bridgeTabs?: () => Promise<BridgeTab[] | null>;
  /** Page targets of the browser at an endpoint. */
  targets?: (ep: CdpEndpoint) => Promise<Array<{ targetId: string; title: string; url: string }>>;
  agentPort?: () => number | null;
  panePort?: () => number | null;
}

async function defaultBridgeTabs(): Promise<BridgeTab[] | null> {
  const ep = await bridgeEndpointIfConfigured();
  if (!ep) return null;
  const unscoped: CdpEndpoint = typeof ep === "number" ? ep : { port: ep.port, token: ep.token };
  return readCdpJson<BridgeTab[]>(unscoped, "/json/list", 10_000);
}

function defaultAgentPort(): number | null {
  const state = readState();
  return state && !state.remote && isPidAlive(state.pid) ? state.port : null;
}

/** `cast browser` tabs, per session id. */
export async function scanCastTabs(into: TabSet, deps: CastScanDeps = {}): Promise<void> {
  const pins = readPins(deps.stateDir ?? engineStateDir());
  if (pins.length === 0) return;
  const pinAge = new Map<string, number>();
  for (const pin of pins) {
    const sid = sessionIdOfEngineKey(pin.key);
    if (sid) pinAge.set(sid, Math.max(pinAge.get(sid) ?? 0, pin.mtimeMs));
  }

  if (pins.some((p) => isRealSession(p.key))) {
    const tabs = await (deps.bridgeTabs ?? defaultBridgeTabs)().catch(() => null);
    for (const t of tabs ?? []) {
      if (!t.cast || t.type !== "page" || !t.id) continue;
      for (const holder of t.sessions ?? []) {
        const sid = sessionIdOfEngineKey(holder);
        if (sid) into.add(sid, { id: t.id, title: t.title ?? "", url: t.url ?? "", where: "chrome" }, pinAge.get(sid) ?? 0);
      }
    }
  }

  const targets = deps.targets ?? ((ep: CdpEndpoint) => listTargets(ep, 5_000));
  const matchPins = async (where: BrowserTabWhere, mine: Pin[], port: number | null) => {
    if (mine.length === 0 || port == null) return;
    const live = await targets(port).catch(() => null);
    if (!live) return;
    const byId = new Map(live.map((t) => [t.targetId, t]));
    for (const pin of mine) {
      const sid = sessionIdOfEngineKey(pin.key);
      const t = byId.get(pin.targetId);
      if (sid && t) into.add(sid, { id: t.targetId, title: t.title, url: t.url, where }, pin.mtimeMs);
    }
  };
  await matchPins("pane", pins.filter((p) => isPaneSession(p.key)), (deps.panePort ?? (() => liveDesktopPaneRegistry()?.port ?? null))());
  await matchPins("agent", pins.filter((p) => !isPaneSession(p.key) && !isRealSession(p.key)), (deps.agentPort ?? defaultAgentPort)());
}

// ── Claude in Chrome, from the transcript ───────────────────────────────────

const CIC_PREFIX = "mcp__claude-in-chrome__";
const FIRST_READ_BYTES = 2 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;

interface ClaudeTabState {
  offset: number;
  lastUsedAt: number;
  /** Tab ids the session drove, oldest first. */
  driven: string[];
  known: Map<string, { title?: string; url?: string }>;
  pending: Map<string, { tabId?: string; url?: string }>;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => (c && typeof c === "object" && (c as any).type === "text" ? String((c as any).text ?? "") : "")).join("\n");
}

/** Every tab a Claude in Chrome result names with its title and address. */
export function parseClaudeTabListing(text: string): Array<{ id: string; title?: string; url?: string }> {
  const out: Array<{ id: string; title?: string; url?: string }> = [];
  // `• tabId 123: "Title" (https://…)`
  for (const m of text.matchAll(/tabId[\s:]*(\d+)\s*:\s*"([^"\n]*)"\s*\(([^)\s]+)\)/g)) out.push({ id: m[1], title: m[2], url: m[3] });
  // JSON objects: {"tabId":123,"title":"…","url":"…"} in any key order.
  for (const m of text.matchAll(/\{[^{}]*"tabId"\s*:\s*(\d+)[^{}]*\}/g)) {
    try {
      const o = JSON.parse(m[0]);
      out.push({ id: String(o.tabId), title: typeof o.title === "string" ? o.title : undefined, url: typeof o.url === "string" ? o.url : undefined });
    } catch {
      /* not a whole object */
    }
  }
  return out;
}

function lineTime(d: any): number {
  const t = typeof d?.timestamp === "string" ? Date.parse(d.timestamp) : NaN;
  return Number.isFinite(t) ? t : 0;
}

function drive(state: ClaudeTabState, tabId: string): void {
  state.driven = [...state.driven.filter((t) => t !== tabId), tabId].slice(-MAX_TABS_PER_SESSION);
}

/** Feed transcript lines to the state (exported for tests). */
export function consumeClaudeLines(state: ClaudeTabState, content: string): void {
  for (const line of content.split("\n")) {
    if (!line.includes(CIC_PREFIX) && !(state.pending.size > 0 && line.includes("tool_result"))) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const blocks = d?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks) {
      if (b?.type === "tool_use" && typeof b.name === "string" && b.name.startsWith(CIC_PREFIX)) {
        const input = b.input ?? {};
        const tabId = input.tabId != null ? String(input.tabId) : undefined;
        const url = typeof input.url === "string" ? input.url : undefined;
        state.pending.set(b.id, { tabId, url });
        if (state.pending.size > 50) state.pending.delete(state.pending.keys().next().value!);
        state.lastUsedAt = Math.max(state.lastUsedAt, lineTime(d));
        if (tabId) drive(state, tabId);
      } else if (b?.type === "tool_result" && state.pending.has(b.tool_use_id)) {
        const call = state.pending.get(b.tool_use_id)!;
        state.pending.delete(b.tool_use_id);
        const text = resultText(b.content);
        for (const t of parseClaudeTabListing(text)) {
          const prev = state.known.get(t.id) ?? {};
          state.known.set(t.id, { title: t.title ?? prev.title, url: t.url ?? prev.url });
        }
        const executed = /Executed on tabId:\s*(\d+)/.exec(text)?.[1];
        const tabId = call.tabId ?? executed;
        if (!tabId) continue;
        drive(state, tabId);
        if (call.url && !state.known.get(tabId)?.url) state.known.set(tabId, { ...state.known.get(tabId), url: call.url });
      }
    }
  }
}

export function newClaudeTabState(): ClaudeTabState {
  return { offset: 0, lastUsedAt: 0, driven: [], known: new Map(), pending: new Map() };
}

/** Incremental Claude in Chrome reader, one state per transcript. */
export class ClaudeChromeTabs {
  private states = new Map<string, ClaudeTabState>();

  scan(into: TabSet, sessionId: string, transcript: string, now: number): void {
    let size: number;
    let mtime: number;
    try {
      const st = fs.statSync(transcript);
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      return;
    }
    let state = this.states.get(transcript);
    if (!state && now - mtime > CLAUDE_TAB_FRESH_MS) return; // nothing recent to find
    if (!state || state.offset > size) {
      state = newClaudeTabState();
      state.offset = Math.max(0, size - FIRST_READ_BYTES);
      this.states.set(transcript, state);
    }
    while (state.offset < size) {
      const len = Math.min(CHUNK_BYTES, size - state.offset);
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(transcript, "r");
      try {
        fs.readSync(fd, buf, 0, len, state.offset);
      } finally {
        fs.closeSync(fd);
      }
      // Only whole lines: a half-written tail is read again next time.
      const end = buf.lastIndexOf(0x0a);
      if (end < 0) break;
      consumeClaudeLines(state, buf.subarray(0, end + 1).toString("utf-8"));
      state.offset += end + 1;
    }
    if (now - state.lastUsedAt > CLAUDE_TAB_FRESH_MS) return;
    for (const id of [...state.driven].reverse()) {
      const k = state.known.get(id);
      into.add(sessionId, { id, title: k?.title ?? "", url: k?.url ?? "", where: "claude" }, state.lastUsedAt);
    }
  }

  /** Drop states for transcripts no longer asked about. */
  retain(transcripts: Set<string>): void {
    for (const key of this.states.keys()) if (!transcripts.has(key)) this.states.delete(key);
  }
}

// ── The reporter ────────────────────────────────────────────────────────────

export interface ScanSession {
  id: string;
  /** A Claude Code transcript to read for Claude in Chrome tabs. */
  transcript?: string | null;
}

export class BrowserTabsReporter {
  private claude = new ClaudeChromeTabs();
  private lastSig: string | null = null;
  private lastSentAt = 0;

  constructor(private send: (sessions: SessionBrowserReport[]) => Promise<unknown>, private castDeps: CastScanDeps = {}) {}

  async scan(sessions: ScanSession[], now = Date.now()): Promise<SessionBrowserReport[]> {
    const into = new TabSet();
    await scanCastTabs(into, this.castDeps);
    const transcripts = new Set<string>();
    for (const s of sessions) {
      if (!s.transcript) continue;
      transcripts.add(s.transcript);
      this.claude.scan(into, s.id, s.transcript, now);
    }
    this.claude.retain(transcripts);
    return into.reports();
  }

  /** One tick: scan, and send when the set changed or the keepalive is due. Returns whether it sent. */
  async tick(sessions: ScanSession[], now = Date.now()): Promise<boolean> {
    const reports = await this.scan(sessions, now);
    const sig = JSON.stringify(reports);
    // An empty set the server already has (nothing ever sent) needs no send.
    if (this.lastSig === null && reports.length === 0) {
      this.lastSig = sig;
      return false;
    }
    if (sig === this.lastSig && now - this.lastSentAt < BROWSER_TABS_KEEPALIVE_MS) return false;
    await this.send(reports);
    this.lastSig = sig;
    this.lastSentAt = now;
    return true;
  }
}
