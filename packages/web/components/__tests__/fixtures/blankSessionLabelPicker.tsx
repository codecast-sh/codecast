import assert from "node:assert/strict";
import { mock } from "bun:test";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost/inbox", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "MutationObserver", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
mock.module("next/navigation", () => ({ useRouter: () => ({ push() {}, replace() {}, back() {} }), usePathname: () => "/inbox" }));
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({
  ...convexReact,
  useQuery: () => undefined, useMutation: () => async () => undefined,
  useAction: () => async () => undefined, useConvex: () => ({}),
  useQueries: () => ({}),
  useConvexAuth: () => ({ isAuthenticated: false, isLoading: false }),
}));
const errors: string[] = [];
mock.module("sonner", () => ({ toast: { success() {}, error: (message: string) => errors.push(message) } }));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ActionSubmenu } = await import("../../CommandPalette");
const { useInboxStore, convBucketMap } = await import("../../../store/inboxStore");
const bucketId = "bucket00000000000000000000000000";
const realId = "jx70000000000000000000000000test";
useInboxStore.setState({
  sessions: {}, conversations: {}, buckets: { [bucketId]: { _id: bucketId, name: "Product", created_at: 1, updated_at: 1 } },
  bucketAssignments: {}, pending: {}, activeBucketFilter: null, chipFilterExclude: false,
});
useInboxStore.getState()._setDispatch(async () => undefined);
const session = useInboxStore.getState().beginOptimisticSession({ agentType: "claude_code", deferCreate: true, create: async () => realId });
const container = document.getElementById("root")!;
const root = createRoot(container);
let closes = 0;
const render = (key: string) => root.render(<ActionSubmenu key={key} mode="bucket" targets={[useInboxStore.getState().sessions[session.stubId]]} targetType="session" onClose={() => { closes++; }} onBack={() => {}} />);
const button = (text: string) => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((element) => element.textContent?.includes(text))!;
try {
  await act(() => render("pick"));
  assert.ok(button("Product"), "the label choice is rendered");
  await act(() => button("Product").click());
  assert.equal(convBucketMap(useInboxStore.getState().bucketAssignments)[session.stubId], bucketId);
  assert.equal(closes, 1);
  assert.deepEqual(errors, []);
  await act(() => render("remove"));
  assert.ok(button('Remove "Product"'), "the selected label can be removed");
  await act(() => button('Remove "Product"').click());
  assert.equal(convBucketMap(useInboxStore.getState().bucketAssignments)[session.stubId], undefined);
  assert.equal(closes, 2);
  assert.deepEqual(errors, []);
  console.log("PASS: a real label-picker click files a deferred blank immediately and removal works without a creation error");
} finally {
  await act(() => root.unmount());
  dom.window.close();
}
