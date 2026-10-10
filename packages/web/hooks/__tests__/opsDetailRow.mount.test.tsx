// A replay or issue page opened by a link shows the row its detail feeder
// synced, whichever workspace it is in. The lists stay on the active
// workspace. Before useOpsReplay, ReplayPage read its row through the list
// reader, so a Union replay opened while Codecast was active sat on
// "Opening rp-N…" forever with the row already in the store.
// Run: bun test --timeout 60000 hooks/__tests__/opsDetailRow.mount.test.tsx
import { beforeAll, expect, test } from "bun:test";

let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let ops: typeof import("../useSyncOps");
let useInboxStore: typeof import("../../store/inboxStore").useInboxStore;

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "localStorage"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ops = await import("../useSyncOps");
  ({ useInboxStore } = await import("../../store/inboxStore"));
}, 60_000);

const REPLAY = { _id: "rx72qtvpbmmrmwcjqmhzawejsx8bq9gm", short_id: "rp-496", workspace: "team:elsewhere", started_at: 1, updated_at: 1, chunks: 1, has_timeline: true } as any;
const GROUP = { _id: "gx72qtvpbmmrmwcjqmhzawejsx8bq9gm", short_id: "eg-12", workspace: "team:elsewhere", last_seen: 1, updated_at: 1, status: "open", count: 1 } as any;

test("a detail page finds its row in another workspace; the list does not show it", async () => {
  useInboxStore.setState({ opsReplays: { [REPLAY._id]: REPLAY }, opsGroups: { [GROUP._id]: GROUP } } as any);
  const seen: any = {};
  function Probe() {
    seen.list = ops.useOpsReplays().length;
    seen.groups = ops.useOpsGroups().length;
    seen.replay = ops.useOpsReplay("rp-496")?._id;
    seen.byId = ops.useOpsReplay(REPLAY._id)?.short_id;
    seen.group = ops.useOpsGroup("eg-12")?._id;
    seen.none = ops.useOpsReplay(null);
    return null;
  }
  const root = createRoot(document.getElementById("root")!);
  await React.act(async () => root.render(React.createElement(Probe)));
  expect(seen).toEqual({ list: 0, groups: 0, replay: REPLAY._id, byId: "rp-496", group: GROUP._id, none: undefined });
  await React.act(async () => root.unmount());
});
