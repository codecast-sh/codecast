// TEMP probe (not committed): cold-open a long conversation and attribute
// forced layouts (a layout read after a DOM write) to animation-frame callbacks.
await import("./harness");
const w = window as any;
const N = Number(process.env.PROBE_N ?? 2000);

let dirty = true;
let inRaf: string | null = null;
type Cb = { site: string; forced: number; reads: number; sites: Map<string, number> };
const cbs: Cb[] = [];
let cur: Cb | null = null;
let forcedOutside = 0;
const appSite = (skip = 0) => {
  const lines = new Error().stack!.split("\n").filter((l) => l.includes("/packages/web/") && !l.includes("/perf/"));
  return lines[skip]?.trim().replace(/^at /, "").replace(/\(?\/\S*\/packages\/web\//, "") ?? "?";
};
const markDirty = () => { dirty = true; };
const onRead = () => {
  if (cur) cur.reads++;
  if (!dirty) return;
  dirty = false;
  if (cur) { cur.forced++; const s = appSite(); cur.sites.set(s, (cur.sites.get(s) ?? 0) + 1); } else forcedOutside++;
};
for (const name of ["offsetHeight", "offsetWidth", "clientHeight", "clientWidth", "scrollHeight", "scrollWidth", "offsetTop", "scrollTop"]) {
  const d = Object.getOwnPropertyDescriptor(w.HTMLElement.prototype, name)!;
  Object.defineProperty(w.HTMLElement.prototype, name, { ...d, get(this: any) { onRead(); return d.get!.call(this); } });
}
const gbcr = w.HTMLElement.prototype.getBoundingClientRect;
w.HTMLElement.prototype.getBoundingClientRect = function () { onRead(); return gbcr.call(this); };
for (const m of ["appendChild", "insertBefore", "removeChild", "replaceChild"]) {
  const f = w.Node.prototype[m];
  w.Node.prototype[m] = function (...a: any[]) { markDirty(); return f.apply(this, a); };
}
for (const m of ["setAttribute", "removeAttribute", "toggleAttribute"]) {
  const f = w.Element.prototype[m];
  w.Element.prototype[m] = function (...a: any[]) { markDirty(); return f.apply(this, a); };
}
for (const proto of [w.CSSStyleDeclaration.prototype]) {
  for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
    if (d.set) Object.defineProperty(proto, k, { ...d, set(this: any, v: any) { markDirty(); d.set!.call(this, v); } });
  }
  const sp = proto.setProperty;
  proto.setProperty = function (...a: any[]) { markDirty(); return sp.apply(this, a); };
}
for (const k of ["textContent", "nodeValue", "data"]) {
  for (const proto of [w.Node.prototype, w.CharacterData.prototype]) {
    const d = Object.getOwnPropertyDescriptor(proto, k);
    if (d?.set) Object.defineProperty(proto, k, { ...d, set(this: any, v: any) { markDirty(); d.set!.call(this, v); } });
  }
}
const rawRaf = globalThis.requestAnimationFrame;
globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
  const site = appSite(0);
  return rawRaf(() => {
    // A frame lays the page out before the next rAF batch only if one ran;
    // model: each callback starts with whatever is dirty.
    const c: Cb = { site, forced: 0, reads: 0, sites: new Map() };
    cbs.push(c); cur = c;
    try { cb(performance.now()); } finally { cur = null; }
  }) as any;
};
w.requestAnimationFrame = globalThis.requestAnimationFrame;

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { ConvexProviderWithAuth } = await import("convex/react");
const { MemoryRouter } = await import("react-router");
const { useInboxStore } = await import("../store/inboxStore");
const { InboxConversation } = await import("../app/inbox/QueuePageClient");
const conv = `jx7${"1".padStart(29, "0")}`;
const now = Date.UTC(2026, 10, 7, 12);
useInboxStore.setState({ sessions: {}, conversations: {}, pendingMessages: {}, drafts: {}, currentUser: { _id: "user_perf", name: "Perf" }, clientStateInitialized: true } as any);
useInboxStore.getState().syncTable("sessions", [{ _id: conv, session_id: "s-1", title: "Long", user_id: "user_perf", agent_type: "claude_code", status: "completed", is_idle: true, message_count: N, updated_at: now, started_at: now, last_heartbeat: now }] as any);
const msgs = Array.from({ length: N }, (_, i) => ({ _id: `${conv.slice(0, 20)}m${String(i).padStart(11, "0")}`, conversation_id: conv, role: i % 2 ? "assistant" : "user", timestamp: now - (N - i) * 30_000, content: i % 2 ? `## Answer ${i}\n\nbody ${i}` : `Prompt ${i}` }));
useInboxStore.getState().setMessages(conv, msgs as any, { hasMoreAbove: false, initialized: true });
const convex = { clearAuth() {}, setAuth() {}, watchQuery: () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined, localQueryLogs: () => undefined, journal: () => undefined }), query: () => new Promise(() => {}), mutation: async () => null, action: async () => null, connectionState: () => ({ isWebSocketConnected: true }), subscribeToConnectionState: () => () => {}, prewarmQuery() {} } as any;
const host = w.document.createElement("div");
w.document.body.appendChild(host);
const root = createRoot(host);
await act(async () => {
  root.render(<ConvexProviderWithAuth client={convex} useAuth={() => ({ isLoading: false, isAuthenticated: true, fetchAccessToken: async () => "p" })}><MemoryRouter><InboxConversation sessionId={conv} isIdle autoFocusInput={false} /></MemoryRouter></ConvexProviderWithAuth>);
});
for (let i = 0; i < 150; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
console.log("rows drawn", host.querySelectorAll("[data-vkey], [data-index]").length, "dom nodes", host.querySelectorAll("*").length);
console.log("rAF callbacks", cbs.length, "forced outside rAF", forcedOutside);
const top = [...cbs].sort((a, b) => b.forced - a.forced).slice(0, 12);
for (const c of top) console.log(c.forced, "forced /", c.reads, "reads  scheduled at", c.site, [...c.sites].slice(0, 4));
process.exit(0);
