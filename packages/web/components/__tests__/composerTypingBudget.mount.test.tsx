// The composer's typing budget, held with a realistic cache (7,000 sessions).
// Typing into the conversation composer felt slow because each keystroke paid
// for more than the box: page-wide work on every key, store writes that woke
// every subscriber, DOM changes that made the browser re-layer the page. This
// test pins what a keystroke may do once the box holds text: one React
// commit, no store write, no DOM change at all (the box's value changes; its
// text node, which React mirrors the value into, must not), and no read of
// layout (each one forces the browser to lay out the whole page,
// which beside a long transcript cost tens of ms per key).
// A failure names the budget that broke; look at what the keystroke reaches.
import { dom, w, restoreGlobals } from "./fixtures/composeDom";
import { afterAll, beforeAll, expect, mock, test } from "bun:test";

mock.module("sonner", () => {
  const noop = () => 1;
  return { toast: Object.assign(noop, { error: noop, info: noop, success: noop, warning: noop, dismiss: () => {}, loading: noop, custom: noop, promise: (p: any) => p }), Toaster: () => null };
});
// The draft save is debounced (300ms after the last key) by design: it runs on
// a pause, not per keystroke. Held here so a slow test keystroke cannot let it
// fire mid-burst; the test checks it was scheduled instead.
const realDraftWrites = await import("../../lib/pendingDraftWrites");
let draftWritesScheduled = 0;
mock.module("../../lib/pendingDraftWrites", () => ({ ...realDraftWrites, scheduleDraftWrite: () => { draftWritesScheduled++; } }));
import { act, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { useInboxStore } from "../../store/inboxStore";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";

afterAll(() => {
  mock.module("../../lib/pendingDraftWrites", () => realDraftWrites);
  closeDomWindow(dom);
  restoreGlobals();
});

const CONV_ID = "jx70000000000000000000000typebud"; // 32 chars => isConvexId
const SESSIONS = 7000;
const KEYS = 40;

function fakeConvex() {
  const client = offlineConvexClient("https://example.convex.cloud");
  (client as any).mutation = async () => null;
  (client as any).query = async () => null;
  (client as any).watchQuery = () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined, localQueryLogs: () => undefined, journal: () => undefined });
  return client;
}

function syntheticSessions(n: number): Record<string, any> {
  const out: Record<string, any> = {};
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const id = `jx7${String(i).padStart(29, "0")}`;
    out[id] = { _id: id, session_id: `s-${i}`, title: `Session ${i}`, user_id: "user_type_budget", agent_type: "claude_code", status: i % 9 ? "completed" : "active", is_idle: i % 9 !== 0, message_count: 20 + (i % 50), updated_at: now - i * 60_000, started_at: now - i * 120_000, project_path: `/src/p${i % 40}` };
  }
  out[CONV_ID] = { _id: CONV_ID, session_id: "s-typebud", title: "Typing budget", user_id: "user_type_budget", agent_type: "claude_code", status: "active", is_idle: true, message_count: 3, updated_at: now, started_at: now };
  return out;
}

// jsdom has no canvas; the composer measures its draft on one, so give it a
// context that answers, or the measuring path never runs here.
(w.HTMLCanvasElement.prototype as any).getContext = () => ({ font: "", measureText: (t: string) => ({ width: t.length * 7 }) });

// Chrome (web and desktop) sizes the box with CSS field-sizing; the Safari
// fallback that measures scrollHeight per key is not what this budget holds.
(globalThis as any).CSS = { supports: (prop: string) => prop === "field-sizing" };

// Every read that makes the browser lay out the page when it is dirty, named
// with the app line that made it.
const readSite = (name: string) => `${name} ${new Error().stack!.split("\n").find((l) => l.includes("/packages/web/") && !l.includes("__tests__"))?.trim() ?? "?"}`;
const LAYOUT_GETTERS: Array<[any, string]> = [
  [w.HTMLElement.prototype, "offsetWidth"], [w.HTMLElement.prototype, "offsetHeight"],
  [w.Element.prototype, "clientWidth"], [w.Element.prototype, "clientHeight"],
  [w.Element.prototype, "scrollWidth"], [w.Element.prototype, "scrollHeight"],
];
let layoutReads: string[] = [];
for (const [proto, name] of LAYOUT_GETTERS) {
  const desc = Object.getOwnPropertyDescriptor(proto, name)!;
  Object.defineProperty(proto, name, { ...desc, get() { layoutReads.push(readSite(name)); return desc.get!.call(this); } });
}
for (const [owner, name] of [[w.Element.prototype, "getBoundingClientRect"], [w, "getComputedStyle"], [globalThis, "getComputedStyle"]] as Array<[any, string]>) {
  const real = owner[name];
  owner[name] = function (this: unknown, ...args: unknown[]) { layoutReads.push(readSite(name)); return real.apply(this, args); };
}

type Tally = { commits: number; storeWrites: number; outsideMutations: string[]; layoutReads: string[] };
let measure: (fn: () => void) => Promise<Tally>;
let totalCommits = 0;
let textarea: HTMLTextAreaElement;

beforeAll(async () => {
  (useInboxStore.getState() as any)._setDispatch(async () => undefined);
  useInboxStore.setState({ sessions: syntheticSessions(SESSIONS), conversations: {}, pendingMessages: {}, drafts: {}, currentSessionId: CONV_ID, currentUser: { _id: "user_type_budget", name: "Typist" } } as any);
  const { MessageInput } = await import("../MessageInput");
  const container = w.document.createElement("div");
  w.document.body.appendChild(container);
  let commits = 0;
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ConvexProvider client={fakeConvex()}>
        <Profiler id="composer" onRender={() => { commits++; totalCommits++; }}>
          <MessageInput conversationId={CONV_ID} status="active" sessionId="s-typebud" agentType="claude_code" agentStatus={"idle" as any} isSessionReady />
        </Profiler>
      </ConvexProvider>,
    );
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  // The store's boot hydration (inboxStore bootPersistence) ends with a write of its own; on a loaded machine it can
  // land inside a keystroke's window and count as typing's. Let it settle before anything is measured.
  for (let i = 0; i < 400 && !useInboxStore.getState().clientStateInitialized; i++) await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  textarea = container.querySelector("textarea[data-composer-field]") as HTMLTextAreaElement;
  measure = async (fn) => {
    commits = 0;
    let storeWrites = 0;
    const unsub = useInboxStore.subscribe(() => { storeWrites++; });
    const outsideMutations: string[] = [];
    const record = (records: MutationRecord[]) => {
      for (const r of records) {
        const target = r.target as Node;
        const el = (target.nodeType === 1 ? target : target.parentNode) as Element;
        outsideMutations.push(`${r.type}${r.attributeName ? `:${r.attributeName}` : ""} on <${el?.tagName?.toLowerCase()} class="${String(el?.getAttribute?.("class") ?? "").slice(0, 60)}">`);
      }
    };
    const mo = new w.MutationObserver(record);
    mo.observe(container, { subtree: true, childList: true, attributes: true, characterData: true });
    layoutReads = [];
    await act(async () => { fn(); });
    const reads = layoutReads;
    record(mo.takeRecords());
    mo.disconnect();
    unsub();
    return { commits, storeWrites, outsideMutations, layoutReads: reads };
  };
});

// The composer's own handlers, called as React would for a typed key (native
// event dispatch does not reach React in this jsdom setup; the other composer
// mount tests drive onChange the same way).
// Wait until the composer has stopped committing on its own (lazy pieces
// resolving after mount), so a keystroke's tally holds only what it caused.
async function settle() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const before = totalCommits;
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    if (totalCommits === before) return;
  }
}

function typeChar(ch: string) {
  const propsKey = Object.keys(textarea).find((k) => k.startsWith("__reactProps"))!;
  const props = (textarea as any)[propsKey];
  const keyEvent = { key: ch, code: `Key${ch.toUpperCase()}`, target: textarea, currentTarget: textarea, nativeEvent: new w.KeyboardEvent("keydown", { key: ch }), preventDefault() {}, stopPropagation() {}, isComposing: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false };
  props.onKeyDown?.(keyEvent);
  Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, textarea.value + ch);
  props.onChange?.({ target: textarea, currentTarget: textarea, nativeEvent: new w.Event("input") });
}

test("a keystroke into a box with text commits once, writes nothing to the store, changes nothing in the DOM tree, and reads no layout", async () => {
  expect(textarea).toBeTruthy();
  // The first characters change what an empty box shows (the ghost suggestion
  // hides, send turns on), and that settles one commit later. Then the budget.
  await measure(() => typeChar("h"));
  await measure(() => typeChar("e"));
  await settle();
  const text = "llo there, this is a long prompt being typed".slice(0, KEYS);
  let worstCommits = 0;
  let storeWrites = 0;
  const outside = new Set<string>();
  const reads = new Set<string>();
  for (const ch of text) {
    const t = await measure(() => typeChar(ch));
    worstCommits = Math.max(worstCommits, t.commits);
    storeWrites += t.storeWrites;
    for (const m of t.outsideMutations) outside.add(m);
    for (const r of t.layoutReads) reads.add(r);
  }
  expect(textarea.value.startsWith("hello there")).toBe(true);
  expect({ worstCommitsPerKey: worstCommits }).toEqual({ worstCommitsPerKey: 1 });
  expect({ storeWritesWhileTyping: storeWrites }).toEqual({ storeWritesWhileTyping: 0 });
  expect([...outside]).toEqual([]);
  expect({ layoutReadsWhileTyping: [...reads] }).toEqual({ layoutReadsWhileTyping: [] });
  expect(draftWritesScheduled).toBeGreaterThan(0);
});
