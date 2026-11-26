// Ship again keeps one press in flight: a second press while the session has neither started its run nor answered sends
// nothing more, and each press records the judged files its confirm listed as the person's approval. The web's button
// and the phone's run screen both press through this hook. usePullRequestMerge reads its row with one stable signature,
// so the reader's memo survives a re-render.
// Run: bun test --timeout 60000 hooks/__tests__/useShipAgain.mount.test.tsx
import { afterAll, beforeAll, expect, mock, test } from "bun:test";

// No server here: every subscription stays unanswered.
const convex = { ...(await import("convex/react")) };
mock.module("convex/react", () => ({ ...convex, useQueries: () => ({}), useQuery: () => undefined, useMutation: () => async () => null }));

const recorded: string[][] = [];
const real = { ...(await import("../usePressApproval")) };
mock.module("../usePressApproval", () => ({
  ...real,
  usePressApproval: (_id: string, active: boolean) => {
    const files = active ? [{ path: "convex/schema.ts", writers: [] }] : null;
    return { files, record: async () => (recorded.push(files ? files.map((f) => f.path) : []), !!files) };
  },
}));
const sigs: unknown[] = [];
const rowsReal = { ...(await import("../useCollectionRows")) };
mock.module("../useCollectionRows", () => ({
  ...rowsReal,
  useCollectionRows: (key: string, opts: any = {}) => {
    if (key === "pullRequests") sigs.push(opts.sig);
    return rowsReal.useCollectionRows(key, opts);
  },
}));

let React: typeof import("react");
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let useShipAgain: typeof import("../useShipAgain").useShipAgain;
let usePullRequestMerge: typeof import("../useSyncTimeline").usePullRequestMerge;
let useInboxStore: typeof import("../../store/inboxStore").useInboxStore;
let restoreSend: (() => void) | null = null;

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "localStorage"]) {
    Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  act = React.act;
  ({ createRoot } = await import("react-dom/client"));
  ({ useShipAgain } = await import("../useShipAgain"));
  ({ usePullRequestMerge } = await import("../useSyncTimeline"));
  ({ useInboxStore } = await import("../../store/inboxStore"));
}, 60_000);
afterAll(() => restoreSend?.());

const FLOW = { slug: "change", label: "Ship" };

test("one press in flight: a second press sends nothing, and the confirm's files are recorded as the approval", async () => {
  const sent: string[] = [];
  const original = useInboxStore.getState().sendMessage;
  useInboxStore.setState({ sendMessage: ((id: string, text: string) => { sent.push(`${id}:${text.slice(0, 30)}`); }) as any });
  restoreSend = () => useInboxStore.setState({ sendMessage: original });
  const seen: { current: ReturnType<typeof useShipAgain> | null } = { current: null };
  let reviewing = false;
  function Probe() {
    seen.current = useShipAgain(FLOW, "conv_subject", reviewing);
    return null;
  }
  const root = createRoot(document.getElementById("root")!);
  await act(async () => root.render(<Probe />));
  expect(seen.current!.sent).toBe(false);

  // A one-click press: sent once, approving nothing; the second press while it is in flight sends nothing.
  await act(async () => { seen.current!.send(); });
  expect(seen.current!.sent).toBe(true);
  await act(async () => { seen.current!.send(); });
  expect(sent).toEqual(["conv_subject:Run your change through the Sh"]);
  expect(recorded).toEqual([[]]);

  // A confirmed press records the files its confirm listed.
  await act(async () => root.unmount());
  reviewing = true;
  const root2 = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root2.render(<Probe />));
  expect(seen.current!.files?.map((f) => f.path)).toEqual(["convex/schema.ts"]);
  await act(async () => { seen.current!.send(); });
  expect(recorded[1]).toEqual(["convex/schema.ts"]);
  expect(sent.length).toBe(2);
  await act(async () => root2.unmount());
});

test("usePullRequestMerge reads its row with one stable signature across renders", async () => {
  sigs.length = 0;
  let n = 0;
  function Probe() {
    usePullRequestMerge({ repository: "acme/app", number: 7 });
    n++;
    return null;
  }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(<Probe />));
  await act(async () => root.render(<Probe />));
  expect(n).toBeGreaterThanOrEqual(2);
  expect(sigs.length).toBeGreaterThanOrEqual(2);
  expect(new Set(sigs).size).toBe(1);
  await act(async () => root.unmount());
});
