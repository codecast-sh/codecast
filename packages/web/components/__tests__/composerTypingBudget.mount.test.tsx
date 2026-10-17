// The composer's typing budget, held with a realistic cache (7,000 sessions).
// Typing into the conversation composer felt slow because each keystroke paid
// for more than the box: page-wide work on every key, store writes that woke
// every subscriber, DOM changes that made the browser re-layer the page. This
// test pins what a keystroke may do once the box holds text: one React
// commit, no store write, and no DOM change outside the textarea itself.
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

type Tally = { commits: number; storeWrites: number; outsideMutations: string[] };
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
  textarea = container.querySelector("textarea[data-composer-field]") as HTMLTextAreaElement;
  measure = async (fn) => {
    commits = 0;
    let storeWrites = 0;
    const unsub = useInboxStore.subscribe(() => { storeWrites++; });
    const outsideMutations: string[] = [];
    const record = (records: MutationRecord[]) => {
      for (const r of records) {
        const target = r.target as Node;
        if (target === textarea || textarea.contains(target)) continue;
        const el = (target.nodeType === 1 ? target : target.parentNode) as Element;
        outsideMutations.push(`${r.type}${r.attributeName ? `:${r.attributeName}` : ""} on <${el?.tagName?.toLowerCase()} class="${String(el?.getAttribute?.("class") ?? "").slice(0, 60)}">`);
      }
    };
    const mo = new w.MutationObserver(record);
    mo.observe(container, { subtree: true, childList: true, attributes: true, characterData: true });
    await act(async () => { fn(); });
    record(mo.takeRecords());
    mo.disconnect();
    unsub();
    return { commits, storeWrites, outsideMutations };
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

test("a keystroke into a box with text commits once, writes nothing to the store, and changes nothing outside the textarea", async () => {
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
  for (const ch of text) {
    const t = await measure(() => typeChar(ch));
    worstCommits = Math.max(worstCommits, t.commits);
    storeWrites += t.storeWrites;
    for (const m of t.outsideMutations) outside.add(m);
  }
  expect(textarea.value.startsWith("hello there")).toBe(true);
  expect({ worstCommitsPerKey: worstCommits }).toEqual({ worstCommitsPerKey: 1 });
  expect({ storeWritesWhileTyping: storeWrites }).toEqual({ storeWritesWhileTyping: 0 });
  expect([...outside]).toEqual([]);
  expect(draftWritesScheduled).toBeGreaterThan(0);
});
