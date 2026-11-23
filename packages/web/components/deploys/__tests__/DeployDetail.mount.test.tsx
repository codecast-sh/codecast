// An opened deploy paints the names its push added and dropped from the store (deployDetails), and feeds that
// collection from deploys.get only while it is open and its row counts names. Only the Convex transport is faked.
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { getFunctionName } from "convex/server";
import { replaceGlobals } from "../../../test-helpers/globals";
import { closeDomWindow } from "../../../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useQuery: () => undefined,
  useQueries: () => ({}),
  useMutation: () => async () => undefined,
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
}));

let answer: any = undefined;
const asked: any[] = [];
const noThrow = await import("../../../hooks/useQueryNoThrow");
mock.module("../../../hooks/useQueryNoThrow", () => ({
  ...noThrow,
  useQueryNoThrow: (fn: any, args: any) => {
    if (getFunctionName(fn) !== "deploys:get") return { data: undefined };
    asked.push(args);
    return { data: args === "skip" ? undefined : answer };
  },
}));
mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));

const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { useInboxStore } = await import("../../../store/inboxStore");
const { DeployDetail } = await import("../DeploysPage");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

beforeEach(() => {
  answer = undefined;
  asked.length = 0;
  useInboxStore.setState({ deployDetails: {}, pending: {}, syncRole: "host" } as any);
});

const row = (extra: Record<string, unknown> = {}) => ({
  _id: "dep1", workspace: "team:t", target: "convex", repository: "acme/app", short_id: "dp-1", status: "live",
  action: "deploy", rollback_of: null, sha: "abcdef1234", previous_sha: "1234abcdef", version: null, url: null,
  started_by: "Ana", note: null, commits: 0, sessions: [], created_at: 1, live_at: 1, finished_at: 1,
  machine: "ana-mac", pushed_via: "deploy.sh", dirty: 0, adds_count: 2, drops_count: 1, ...extra,
}) as any;

function mount(d: any) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<MemoryRouter><DeployDetail d={d} now={2} /></MemoryRouter>));
  return { host, unmount: () => act(() => root.unmount()) };
}

const names = (host: HTMLElement, kind: string) =>
  [...host.querySelectorAll(`[data-deploy-names="${kind}"] code`)].map((x) => x.textContent);

test("feeds deploys.get into deployDetails and paints the names from the store", () => {
  answer = { _id: "dep1", short_id: "dp-1", adds: ["fn:a", "http:/b"], drops: ["table:c"] };
  const { host, unmount } = mount(row());
  expect(asked).toContainEqual({ ref: "dp-1" });
  expect(useInboxStore.getState().deployDetails.dep1).toMatchObject({ adds: ["fn:a", "http:/b"], drops: ["table:c"] });
  expect(names(host, "added")).toEqual(["fn:a", "http:/b"]);
  expect(names(host, "dropped")).toEqual(["table:c"]);
  unmount();
});

test("a warm store paints its names before the query answers", () => {
  useInboxStore.getState().syncTable("deployDetails", [{ _id: "dep1", adds: ["fn:held"], drops: [], _cachedAt: 1 }]);
  const { host, unmount } = mount(row({ adds_count: 1, drops_count: 0 }));
  expect(names(host, "added")).toEqual(["fn:held"]);
  unmount();
});

test("a cold store shows the row's counts without names", () => {
  const { host, unmount } = mount(row());
  expect(host.querySelector('[data-kind="added"]')!.textContent).toBe("Added 2");
  expect(host.querySelector('[data-kind="dropped"]')!.textContent).toBe("Dropped 1");
  expect(names(host, "added")).toEqual([]);
  unmount();
});

test("a push that changed nothing never asks for names", () => {
  const { unmount } = mount(row({ adds_count: 0, drops_count: 0 }));
  expect(asked.every((a) => a === "skip")).toBe(true);
  unmount();
});
