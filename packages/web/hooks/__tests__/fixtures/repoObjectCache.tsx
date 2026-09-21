import "fake-indexeddb/auto";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexProvider } from "convex/react";
import { getFunctionName } from "convex/server";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../../test-helpers/globals";

const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost/" });
const restore = replaceGlobals({ window: dom.window, document: dom.window.document,
  navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true });
const { useInboxStore } = await import("../../../store/inboxStore");
const { flushSyncPublishes } = await import("../../../store/syncTransaction");
const { usePullRequest } = await import("../../useSyncTimeline");
const { useEntityResolution } = await import("../../../lib/entityDisplay");
const { usePRLookup } = await import("../../usePRLookup");
const cache = await import("../../../store/idbCache");
for (let i = 0; i < 1000 && !useInboxStore.getState().clientStateInitialized; i++) await new Promise(resolve => setTimeout(resolve, 1));
expect(useInboxStore.getState().clientStateInitialized).toBe(true);
cache.setHydrating(false);
const store = () => useInboxStore.getState();
store()._setIDBWrite(cache.writePatchesToIDB);
const container = dom.window.document.getElementById("root")!;
let root: Root;
const responses = new Map<string, any>();
const listeners = new Set<() => void>();
let requests: Array<{ args: any; resolve: (value: any) => void; reject: (error: Error) => void }>;
const client: any = {
  watchQuery(ref: any) {
    return {
      onUpdate(callback: () => void) { listeners.add(callback); return () => listeners.delete(callback); },
      localQueryResult() { return responses.get(getFunctionName(ref)); },
      localQueryLogs() { return []; },
      journal() { return undefined; },
    };
  },
  action(ref: any, args: any) {
    expect(getFunctionName(ref)).toBe("githubApp:fetchPull");
    return new Promise((resolve, reject) => requests.push({ args, resolve, reject }));
  },
};
const pr = { _id: "pr1", repository: "union-ai/union-mobile", number: 3591, title: "Call scoring baseline", state: "merged", updated_at: 1,
  files: [{ filename: "score.ts", patch: "@@ -1 +1 @@\n-old\n+new" }] };
const commit = { _id: "commit1", repository: "union-ai/union-mobile", sha: "abcdef1234567890", message: "Cache visited objects", timestamp: 1 };

function Page() {
  const row = usePullRequest("Union-AI/union-mobile", 3591);
  return <p>{row?.title ?? "Missing"}</p>;
}
function Reference({ type = "pr" }: { type?: "pr" | "commit" }) {
  const ref = type === "pr" ? "Union-AI/union-mobile#3591" : "Union-AI/union-mobile@abcdef1";
  const entity = useEntityResolution(ref, type);
  return <p>{entity.label}</p>;
}
function Lookup({ number = 3591, enabled = true }: { number?: number; enabled?: boolean }) {
  const lookup = usePRLookup("Union-AI/union-mobile", number, enabled);
  return <><p>{lookup.error ?? lookup.reason ?? "Waiting for cached row"}</p><button onClick={lookup.retry}>Retry</button></>;
}
const render = async (element: React.ReactNode) => {
  await act(async () => { root.render(<ConvexProvider client={client}>{element}</ConvexProvider>); });
  await act(async () => { flushSyncPublishes(); });
};
const sync = async (key: string, rows: any[]) => {
  await act(async () => { store().syncTable(key, rows); flushSyncPublishes(); });
};

beforeEach(() => {
  responses.clear();
  requests = [];
  store().syncTable("pullRequests", [], { isDelta: false });
  store().syncTable("commits", [], { isDelta: false });
  flushSyncPublishes();
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); });
afterAll(() => { store()._setIDBWrite(() => {}); dom.window.close(); restore(); });

test("a mixed-case URL paints a cached PR before any server answer", async () => {
  await sync("pullRequests", [pr]);
  await render(<Page />);
  expect(container.textContent).toBe(pr.title);
  expect(requests).toHaveLength(0);
});

test("a PR preview feeds the page and persists its full files", async () => {
  responses.set("pull_requests:webGet", pr);
  await render(<><Reference /><Page /></>);
  expect(container.textContent).toContain(pr.title);
  expect(container.textContent).not.toContain("Missing");
  expect(store().pullRequests.pr1.files).toEqual(pr.files);
  const disk = await cache.loadCache(["pullRequests"]);
  expect(disk?.pullRequests.pr1.files).toEqual(pr.files);
  await sync("pullRequests", [{ ...pr, _id: "pr2", number: 3592 }]);
  expect(store().pullRequests.pr1.title).toBe(pr.title);
});

test("commit previews persist and keep receiving store updates offline", async () => {
  responses.set("commits:webGet", commit);
  await render(<Reference type="commit" />);
  expect(container.textContent).toContain(commit.message);
  expect((await cache.loadCache(["commits"]))?.commits.commit1.message).toBe(commit.message);
  responses.clear();
  await act(async () => { listeners.forEach((listener) => listener()); });
  await sync("commits", [{ ...commit, message: "Updated locally" }]);
  expect(container.textContent).toContain("Updated locally");
});

test("a visited PR restores from disk and renders with no network response", async () => {
  responses.set("pull_requests:webGet", pr);
  await render(<Reference />);
  const disk = await cache.loadCache(["pullRequests"]);
  expect(disk?.pullRequests.pr1).toBeDefined();
  await act(async () => root.unmount());
  responses.clear();
  store().syncTable("pullRequests", [], { isDelta: false });
  flushSyncPublishes();
  root = createRoot(container);
  await sync("pullRequests", Object.values(disk!.pullRequests));
  await render(<><Reference /><Page /></>);
  expect(container.textContent).toContain(pr.title);
  expect(container.textContent).not.toContain("Missing");
});

test("lookup errors remain errors and retry can recover", async () => {
  await render(<Lookup />);
  expect(requests[0].args).toEqual({ repository: "union-ai/union-mobile", number: 3591 });
  await act(async () => requests[0].reject(new Error("GitHub temporarily unavailable")));
  expect(container.textContent).toContain("GitHub temporarily unavailable");
  await act(async () => (container.querySelector("button") as HTMLButtonElement).click());
  expect(requests).toHaveLength(2);
  await act(async () => requests[1].resolve({ ok: true }));
  expect(container.textContent).toContain("Waiting for cached row");
  expect(container.textContent).not.toContain("unavailable");
});

test("navigation ignores a late failure for the previous PR", async () => {
  await render(<Lookup />);
  await render(<Lookup number={3592} />);
  await act(async () => requests[0].resolve({ ok: false, reason: "no_team_installation" }));
  expect(container.textContent).not.toContain("no_team_installation");
  await act(async () => requests[1].resolve({ ok: false, reason: "not_on_github" }));
  expect(container.textContent).toContain("not_on_github");
});

test("an existing cached PR needs no on-demand lookup", async () => {
  await render(<Lookup enabled={false} />);
  expect(requests).toHaveLength(0);
});
