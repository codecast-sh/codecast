// A surface that reads many tasks' threads at once (the line's problem list)
// loads them on demand: the store's task rows carry no comments
// (lib/detailRows), so the feeder reads the threads the store lacks or holds
// from before a task's newest comment, and nothing else.
// Run: bun test --timeout 60000 hooks/__tests__/useSyncTaskThreads.mount.test.tsx
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";

// Whether the server has confirmed the caller (convex/react useConvexAuth).
let authenticated = true;
const convexReact = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({ ...convexReact, useConvexAuth: () => ({ isAuthenticated: authenticated, isLoading: false }) }));

let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let ConvexProvider: typeof import("convex/react").ConvexProvider;
let getFunctionName: typeof import("convex/server").getFunctionName;
let tasksHooks: typeof import("../useSyncTasks");
let useInboxStore: typeof import("../../store/inboxStore").useInboxStore;
let dom: import("jsdom").JSDOM;

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "localStorage"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ ConvexProvider } = await import("convex/react"));
  ({ getFunctionName } = await import("convex/server"));
  tasksHooks = await import("../useSyncTasks");
  ({ useInboxStore } = await import("../../store/inboxStore"));
}, 60_000);
afterAll(() => {
  mock.module("convex/react", () => convexReact);
  closeDomWindow(dom);
});

// Convex ids: the feeder skips an optimistic stub's key.
const id = (n: number) => `k57${String(n).padStart(29, "0")}`;
const comment = (n: number) => ({ _id: `c${n}`, author: "line", text: `Refine refused: ${n}`, created_at: n });
const served = (n: number, comments: any[], last?: number) => ({
  _id: id(n), short_id: `ct-${n}`, title: `problem ${n}`, status: "open", updated_at: 1, cause: {},
  ...(last !== undefined ? { last_comment_at: last } : {}), comments,
});

let asked: string[][];
let answers: Map<string, any>;
// Set to hold every answer until the test releases it.
let gate: Promise<void> | null;
const client: any = {
  async query(ref: any, args: { ids: string[] }) {
    expect(getFunctionName(ref)).toBe("tasks:webGetByIds");
    asked.push(args.ids);
    if (gate) await gate;
    // tasks.webGetByIds answers a caller it does not know with no rows.
    if (!authenticated) return { items: [] };
    return { items: args.ids.map((i) => answers.get(i)).filter(Boolean) };
  },
};
const state = () => useInboxStore.getState() as any;
const settle = async () => { await React.act(async () => { await new Promise((r) => setTimeout(r, 5)); }); };

function Probe({ rows }: { rows: Array<{ _id: string; last_comment_at?: number }> }) {
  tasksHooks.useSyncTaskThreads(rows);
  return null;
}
const draw = async (root: import("react-dom/client").Root, rows: Array<{ _id: string; last_comment_at?: number }>) => {
  await React.act(async () => root.render(React.createElement(ConvexProvider, { client }, React.createElement(Probe, { rows }))));
  await settle();
};
const mount = async (rows: Array<{ _id: string; last_comment_at?: number }>) => {
  const root = createRoot(document.getElementById("root")!);
  await draw(root, rows);
  return root;
};

beforeEach(() => {
  asked = [];
  answers = new Map();
  gate = null;
  authenticated = true;
  tasksHooks.resetTaskThreadReads();
  useInboxStore.setState({ tasks: {}, taskComments: {}, pending: {}, currentUser: { _id: "userA" } } as any);
});

test("reads the threads the store lacks, once, and files them thin", async () => {
  answers.set(id(1), served(1, [comment(1)], 1));
  answers.set(id(2), served(2, [], undefined));
  const rows = [{ _id: id(1), last_comment_at: 1 }, { _id: id(2) }, { _id: "temp_task_stub" }];
  const root = await mount(rows);
  expect(asked).toEqual([[id(1), id(2)]]);
  expect(state().taskComments[id(1)].comments).toEqual([comment(1)]);
  // A task with no comments is held too: an empty thread is an answer.
  expect(state().taskComments[id(2)].comments).toEqual([]);
  expect(state().tasks[id(1)].comments).toBeUndefined();
  expect(state().tasks[id(1)].comment_count).toBe(1);

  // The store changing under it (the threads landing) asks for nothing more.
  await settle();
  expect(asked).toHaveLength(1);
  await React.act(async () => root.unmount());
});

test("reads a held thread again only when the task row says its comments moved", async () => {
  tasksHooks.holdTaskThreads([served(1, [comment(1)], 1), served(2, [comment(2)], 2)]);
  answers.set(id(2), served(2, [comment(2), comment(3)], 3));
  // Task 2's row was patched by the sync log (a new comment); this window
  // holds the thread from before it.
  const root = await mount([{ _id: id(1), last_comment_at: 1 }, { _id: id(2), last_comment_at: 3 }]);
  expect(asked).toEqual([[id(2)]]);
  expect(state().taskComments[id(2)].comments).toEqual([comment(2), comment(3)]);
  expect(state().taskComments[id(2)].as_of).toBe(3);
  await React.act(async () => root.unmount());
});

test("a task the server leaves out of its answer is not asked for again", async () => {
  const rows = [{ _id: id(9), last_comment_at: 4 }];
  let root = await mount(rows);
  expect(asked).toEqual([[id(9)]]);
  await React.act(async () => root.unmount());
  root = await mount(rows);
  expect(asked).toHaveLength(1);
  await React.act(async () => root.unmount());
});

test("many problems are read in bounded calls and land together", async () => {
  const rows = Array.from({ length: 120 }, (_, n) => ({ _id: id(n + 100), last_comment_at: 1 }));
  for (const r of rows) answers.set(r._id, { _id: r._id, short_id: `ct-${r._id.slice(-4)}`, title: "p", status: "open", updated_at: 1, cause: {}, last_comment_at: 1, comments: [comment(1)] });
  const root = await mount(rows);
  expect(asked.map((ids) => ids.length)).toEqual([50, 50, 20]);
  expect(Object.keys(state().taskComments)).toHaveLength(120);
  await React.act(async () => root.unmount());
});

// The line boots from cached task rows before the websocket has an identity.
// A read made then is answered as a stranger's, with no rows, and that answer
// once stood for good as "these tasks have no thread": the notes never loaded,
// through sign-in and through a remount.
test("asks nothing before the server has confirmed the caller, and reads once it has", async () => {
  answers.set(id(1), served(1, [comment(1)], 1));
  const rows = [{ _id: id(1), last_comment_at: 1 }];
  authenticated = false;
  const root = await mount(rows);
  expect(asked).toEqual([]);
  expect(state().taskComments[id(1)]).toBeUndefined();

  authenticated = true;
  await draw(root, rows);
  expect(asked).toEqual([[id(1)]]);
  expect(state().taskComments[id(1)].comments).toEqual([comment(1)]);
  await React.act(async () => root.unmount());
});

test("an answer that lands after the socket lost its identity is not taken as the task having no thread", async () => {
  answers.set(id(1), served(1, [comment(1)], 1));
  const rows = [{ _id: id(1), last_comment_at: 1 }];
  let release!: () => void;
  gate = new Promise<void>((r) => { release = r; });
  let root = await mount(rows);
  expect(asked).toHaveLength(1);
  // The token refresh fails while the read is out: the server answers a stranger.
  authenticated = false;
  await draw(root, rows);
  release();
  gate = null;
  await settle();
  expect(state().taskComments[id(1)]).toBeUndefined();

  // The identity is back: the thread is read, in this mount and in a new one.
  authenticated = true;
  await draw(root, rows);
  expect(asked).toHaveLength(2);
  expect(state().taskComments[id(1)].comments).toEqual([comment(1)]);
  await React.act(async () => root.unmount());

  useInboxStore.setState({ taskComments: {} } as any);
  root = await mount(rows);
  expect(asked).toHaveLength(3);
  expect(state().taskComments[id(1)].comments).toEqual([comment(1)]);
  await React.act(async () => root.unmount());
});

test("what one account was not sent says nothing about the next one signed in", async () => {
  const rows = [{ _id: id(9), last_comment_at: 4 }];
  let root = await mount(rows);
  expect(asked).toHaveLength(1);
  await React.act(async () => root.unmount());

  // Another person signs in on this machine; the task is theirs.
  useInboxStore.setState({ currentUser: { _id: "userB" } } as any);
  answers.set(id(9), served(9, [comment(4)], 4));
  root = await mount(rows);
  expect(asked).toHaveLength(2);
  expect(state().taskComments[id(9)].comments).toEqual([comment(4)]);
  await React.act(async () => root.unmount());
});

test("a thread on screen is held against the cap, and released when the surface closes", async () => {
  const { isDetailPinned } = await import("../../lib/detailRows");
  answers.set(id(1), served(1, [comment(1)], 1));
  const root = await mount([{ _id: id(1), last_comment_at: 1 }]);
  expect(isDetailPinned("taskComments", id(1))).toBe(true);
  await React.act(async () => root.unmount());
  expect(isDetailPinned("taskComments", id(1))).toBe(false);
});
