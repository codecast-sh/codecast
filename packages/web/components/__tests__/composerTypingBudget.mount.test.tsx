// The composer's typing budget, held with a realistic cache (7,000 sessions).
// Typing into the conversation composer felt slow because each keystroke paid
// for more than the box: page-wide work on every key, store writes that woke
// every subscriber, DOM changes that made the browser re-layer the page. This
// test pins what a keystroke may do once the first character is in: one React
// commit, no store write, and no DOM change outside the textarea itself.
// A failure names the budget that broke; look at what the keystroke reaches.
import { dom, w, restoreGlobals } from "./fixtures/composeDom";
import { afterAll, beforeAll, expect, mock, test } from "bun:test";

mock.module("sonner", () => {
  const noop = () => 1;
  return { toast: Object.assign(noop, { error: noop, info: noop, success: noop, warning: noop, dismiss: () => {}, loading: noop, custom: noop, promise: (p: any) => p }), Toaster: () => null };
});
import { act, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { useInboxStore } from "../../store/inboxStore";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";

afterAll(() => {
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
        <Profiler id="composer" onRender={(_id, _phase, _d, _b, start) => { commits++; if (process.env.KDEBUG) { (globalThis as any).__kcommits?.push(start); (globalThis as any).__ksnap?.(); (globalThis as any).__kper?.(start); } }}>
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
    const mo = new w.MutationObserver((records: MutationRecord[]) => {
      for (const r of records) {
        const target = r.target as Node;
        if (target === textarea || textarea.contains(target)) continue;
        const el = (target.nodeType === 1 ? target : target.parentNode) as Element;
        outsideMutations.push(`${r.type}${r.attributeName ? `:${r.attributeName}` : ""} on <${el?.tagName?.toLowerCase()} class="${String(el?.getAttribute?.("class") ?? "").slice(0, 60)}">`);
      }
    });
    mo.observe(container, { subtree: true, childList: true, attributes: true, characterData: true });
    await act(async () => { fn(); });
    mo.takeRecords().length;
    mo.disconnect();
    unsub();
    return { commits, storeWrites, outsideMutations };
  };
});

// The composer's own handlers, called as React would for a typed key (native
// event dispatch does not reach React in this jsdom setup; the other composer
// mount tests drive onChange the same way).
function typeChar(ch: string) {
  const propsKey = Object.keys(textarea).find((k) => k.startsWith("__reactProps"))!;
  const props = (textarea as any)[propsKey];
  const keyEvent = { key: ch, code: `Key${ch.toUpperCase()}`, target: textarea, currentTarget: textarea, nativeEvent: new w.KeyboardEvent("keydown", { key: ch }), preventDefault() {}, stopPropagation() {}, isComposing: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false };
  if (!process.env.KNOKEY) props.onKeyDown?.(keyEvent);
  Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, textarea.value + ch);
  props.onChange?.({ target: textarea, currentTarget: textarea, nativeEvent: new w.Event("input") });
}

if (process.env.KDEBUG) test("debug: what each commit renders", async () => {
  const key = Object.keys(textarea).find((k) => k.startsWith("__reactFiber"))!;
  let f = (textarea as any)[key]; while (f.return) f = f.return;
  const fiberRoot = f.stateNode;
  const nameOf = (x: any) => { const t = x.type; if (!t || typeof t === "string") return null; return t.displayName || t.name || t.render?.name || t.type?.name || null; };
  (globalThis as any).__kcommits = [];
  const t0 = performance.now();
  await measure(() => typeChar("a"));
  await measure(() => typeChar("b"));
  const rendered = new Map<string, number>();
  const stack = [fiberRoot.current];
  while (stack.length) { const x = stack.pop(); for (const g of [x, x.alternate]) if (g && g.actualStartTime > t0 && (g.flags & 1)) { const n = nameOf(g); if (n) rendered.set(n, (rendered.get(n) ?? 0) + 1); } for (let c = x.child; c; c = c.sibling) stack.push(c); }
  console.log("commits", (globalThis as any).__kcommits.length, JSON.stringify([...rendered]));
  // Which MessageInput hook states change between the two commits of one key.
  let mi: any = null; const st2 = [fiberRoot.current];
  while (st2.length && !mi) { const x = st2.pop(); if (nameOf(x) === "MessageInput") mi = x; for (let c = x.child; c; c = c.sibling) st2.push(c); }
  const snap = () => { const out: unknown[] = []; let h = (mi.alternate && mi.alternate.actualStartTime > mi.actualStartTime ? mi.alternate : mi).memoizedState; while (h) { out.push(h.queue ? h.memoizedState : "·"); h = h.next; } return out; };
  // Wrap every hook dispatcher in the tree, re-render once so components pick
  // up the wrapped functions, then log who dispatches during one keystroke.
  const calls: string[] = [];
  const wrapAll = () => { const st3 = [fiberRoot.current]; while (st3.length) { const x = st3.pop(); let h = x.memoizedState, j = 0; if (typeof x.type === "function" || typeof x.type === "object") while (h && typeof h === "object" && "next" in h) { const q = h.queue; if (q && typeof q.dispatch === "function" && !q.dispatch.__k) { const orig = q.dispatch; const name = nameOf(x) + "#" + j; const wrapped: any = (a: any) => { calls.push(name + " <- " + (new Error().stack ?? "").split("\n").slice(2, 4).map((l) => l.trim().replace(/\(.*\/(packages\/web\/[^)]+)\)/, "$1")).join(" < ")); return orig(a); }; wrapped.__k = true; q.dispatch = wrapped; } h = h.next; j++; } for (let c = x.child; c; c = c.sibling) st3.push(c); } };
  wrapAll(); await measure(() => typeChar("x")); wrapAll(); await measure(() => typeChar("y")); calls.length = 0;
  await measure(() => typeChar("z"));
  console.log("dispatches", JSON.stringify(calls, null, 1));
  const perCommit: string[] = [];
  (globalThis as any).__kper = (start: number) => { const names = new Set<string>(); const st4 = [fiberRoot.current]; while (st4.length) { const x = st4.pop(); for (const g of [x, x.alternate]) if (g && g.actualStartTime >= start && (g.flags & 1)) { const n = nameOf(g); if (n) names.add(n); } for (let c = x.child; c; c = c.sibling) st4.push(c); } perCommit.push([...names].slice(0, 12).join(",")); };
  const tally = await measure(() => typeChar("q"));
  (globalThis as any).__kper = null;
  console.log("percommit", JSON.stringify(perCommit, null, 1), "storeWrites", tally.storeWrites);
  const snaps: unknown[][] = [];
  (globalThis as any).__ksnap = () => snaps.push(snap());
  await measure(() => typeChar("c"));
  console.log("snaps", snaps.length);
  for (let i = 1; i < snaps.length; i++) snaps[i].forEach((v, j) => { if (!Object.is(v, snaps[i - 1][j])) console.log("commit", i, "hook", j, JSON.stringify(snaps[i - 1][j])?.slice(0, 60), "->", JSON.stringify(v)?.slice(0, 60)); });
});

test("a keystroke after the first commits once, writes nothing to the store, and changes nothing outside the textarea", async () => {
  expect(textarea).toBeTruthy();
  await measure(() => typeChar("h")); // the first character may flip send to enabled
  const text = "ello there, this is a long prompt being typed".slice(0, KEYS);
  let worstCommits = 0;
  let storeWrites = 0;
  const outside = new Set<string>();
  for (const ch of text) {
    const t = await measure(() => typeChar(ch));
    worstCommits = Math.max(worstCommits, t.commits);
    if (process.env.KDEBUG && t.commits > 1) console.log("key", JSON.stringify(ch), "commits", t.commits, "value", JSON.stringify(textarea.value.slice(-12)));
    storeWrites += t.storeWrites;
    for (const m of t.outsideMutations) outside.add(m);
  }
  expect(textarea.value.startsWith("hello there")).toBe(true);
  expect({ worstCommitsPerKey: worstCommits }).toEqual({ worstCommitsPerKey: 1 });
  expect({ storeWritesWhileTyping: storeWrites }).toEqual({ storeWritesWhileTyping: 0 });
  expect([...outside]).toEqual([]);
});
