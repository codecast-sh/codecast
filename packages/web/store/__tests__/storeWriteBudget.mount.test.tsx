// The store's per-write budget with a realistic cache (7,000 sessions). Every
// store write runs every mounted subscriber's selectors, and a liveness push
// writes the sessions map a few times a second. Two things made that the main
// cost of typing on a busy account: signatures that were the cache spelled out
// (a 1.4 MB string, rebuilt per push and compared character by character by
// each subscriber), and surfaces that re-rendered on writes that changed
// nothing they show. This test mounts the always-mounted hooks over the cache
// and pins: no subscription holds a long string, and a write that changes
// nothing a surface reads (a no-op write, a heartbeat on one row) re-renders
// nothing.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const restoreGlobals = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage, indexedDB, IDBKeyRange, IS_REACT_ACT_ENVIRONMENT: true });

const { act, Profiler } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useInboxStore } = await import("../inboxStore");
const { useMinePlacement, useWaitingOnPerson, useNewResults } = await import("../../hooks/useNeedsInputCount");
const { useDecisionQueue } = await import("../../hooks/useDecisionQueue");
const { useAssistantConversationIds } = await import("../../lib/surfaces");
const { useFleetSummaries } = await import("../../components/presence/useMemberActivity");
const { useCollectionRows } = await import("../../hooks/useCollectionRows");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

const ME = "user_write_budget";
const SESSIONS = 7000;
const MAX_SIGNATURE_CHARS = 1024;

function syntheticSessions(n: number): Record<string, any> {
  const out: Record<string, any> = {};
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const id = `jx7${String(i).padStart(29, "0")}`;
    out[id] = { _id: id, session_id: `s-${i}`, title: `Session ${i}`, user_id: i % 7 ? ME : "user_teammate", agent_type: i % 13 ? "claude_code" : "codex", status: i % 9 ? "completed" : "active", is_idle: i % 9 !== 0, agent_status: i % 9 ? "idle" : "working", message_count: 20 + (i % 50), updated_at: now - i * 60_000, started_at: now - i * 120_000, last_heartbeat: now, project_path: `/src/p${i % 40}` };
  }
  return out;
}

const SESSION_WHERE = (row: any) => row.status === "active";
const SESSION_SIG = (row: any) => `${row.title}|${row.agent_status}`;

function AlwaysMounted() {
  useMinePlacement();
  useWaitingOnPerson();
  useNewResults();
  useDecisionQueue();
  useAssistantConversationIds();
  useFleetSummaries();
  useCollectionRows("sessions", { where: SESSION_WHERE, sig: SESSION_SIG });
  return null;
}

let commits = 0;
let fiberRoot: any;

beforeAll(async () => {
  useInboxStore.setState({ sessions: syntheticSessions(SESSIONS), currentUser: { _id: ME, name: "Budget" } } as any);
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Profiler id="always" onRender={() => { commits++; }}><AlwaysMounted /></Profiler>);
  });
  const key = Object.keys(host).find((k) => k.startsWith("__reactContainer"))!;
  fiberRoot = (host as any)[key].stateNode;
});

// Every value a mounted subscription compares on each store write: the
// selected value of each useSyncExternalStore, and each useTrackedStore dep.
function subscriptionValues(): Array<{ where: string; value: unknown }> {
  const out: Array<{ where: string; value: unknown }> = [];
  const nameOf = (f: any) => { const t = f.type; return t && typeof t !== "string" ? t.displayName || t.name || "?" : "?"; };
  const stack = [fiberRoot.current];
  while (stack.length) {
    const f = stack.pop();
    let h = f.memoizedState;
    let i = 0;
    while (f.tag === 0 && h && typeof h === "object" && "next" in h) {
      if (h.queue && typeof h.queue.getSnapshot === "function") out.push({ where: `${nameOf(f)} hook ${i}`, value: h.memoizedState });
      const v = h.memoizedState;
      if (v && typeof v === "object" && "current" in v && v.current && Array.isArray(v.current.deps)) {
        v.current.deps.forEach((d: unknown, j: number) => out.push({ where: `${nameOf(f)} hook ${i} dep ${j}`, value: d }));
      }
      h = h.next;
      i++;
    }
    for (let c = f.child; c; c = c.sibling) stack.push(c);
  }
  return out;
}

test("no mounted subscription compares a long string", () => {
  const values = subscriptionValues();
  expect(values.length).toBeGreaterThan(10);
  const long = values.filter((v) => typeof v.value === "string" && (v.value as string).length > MAX_SIGNATURE_CHARS).map((v) => `${v.where}: ${(v.value as string).length} chars`);
  expect(long).toEqual([]);
});

test("a write nothing reads re-renders nothing", async () => {
  commits = 0;
  await act(async () => { useInboxStore.setState({ __budgetProbe: 1 } as any); });
  expect(commits).toBe(0);
});

test("a heartbeat on one row re-renders nothing", async () => {
  const sessions = useInboxStore.getState().sessions as Record<string, any>;
  const id = Object.keys(sessions)[42];
  commits = 0;
  await act(async () => { useInboxStore.setState({ sessions: { ...sessions, [id]: { ...sessions[id], last_heartbeat: Date.now() + 1000 } } } as any); });
  expect(commits).toBe(0);
});

test("a real change on one row re-renders", async () => {
  const sessions = useInboxStore.getState().sessions as Record<string, any>;
  const id = Object.keys(sessions)[0];
  commits = 0;
  await act(async () => { useInboxStore.setState({ sessions: { ...sessions, [id]: { ...sessions[id], title: "Renamed", agent_status: "idle", status: "active" } } } as any); });
  expect(commits).toBeGreaterThan(0);
});
