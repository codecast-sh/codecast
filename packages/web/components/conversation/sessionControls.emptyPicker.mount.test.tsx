// ct-101479: the new-session folder picker, opened with nothing typed on a
// machine whose folders have no person-started sessions (every recent folder
// has count 0: machine-root suggestions, agent-only folders), listed nothing
// and said `no match for “”`, hiding every folder behind the expander. A blank
// filter is not a miss: the opened picker must offer folders, not a no-match.
// Run: bun test packages/web/components/conversation/sessionControls.emptyPicker.mount.test.tsx
import { test, expect, afterAll, mock } from "bun:test";
import { closeDomWindow } from "../../test-helpers/domGlobals";

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://local.codecast.sh", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Element", "Node", "Event", "KeyboardEvent", "MouseEvent", "getComputedStyle", "localStorage", "sessionStorage"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => closeDomWindow(dom));

// A first-time account on one machine: four folders known on it, none of
// which the person has started a session in.
const RECENTS = [
  { path: "/Users/me/src/alpha", count: 0, suggested: true },
  { path: "/Users/me/src/beta", count: 0, suggested: true },
  { path: "/Users/me/src/gamma", count: 0 },
  { path: "/Users/me/src/delta", count: 0 },
];

const realScoped = { ...(await import("../../hooks/useScopedRecentProjects")) };
mock.module("../../hooks/useScopedRecentProjects", () => ({ ...realScoped, useScopedRecentProjects: () => RECENTS }));
const realFs = { ...(await import("../../lib/fsBrowse")) };
mock.module("../../lib/fsBrowse", () => ({ ...realFs, useDirListing: () => ({ listing: null, home: null }) }));
const realConvex = { ...(await import("convex/react")) };
const fakeConvex = { query: async () => null, mutation: async () => null, action: async () => null, watchQuery: () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined }) };
mock.module("convex/react", () => ({
  ...realConvex,
  useConvex: () => fakeConvex,
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useQuery: () => undefined,
  useMutation: () => async () => null,
  useAction: () => async () => null,
  useConvexConnectionState: () => ({ isWebSocketConnected: true, hasEverConnected: true }),
}));
const realLocalDevice = { ...(await import("../../hooks/useLocalDeviceId")) };
mock.module("../../hooks/useLocalDeviceId", () => ({ ...realLocalDevice, useLocalDeviceId: () => "dev-mac" }));

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { ProjectSwitcher } = await import("./sessionControls");

test("the folder picker opened with nothing typed lists folders, not `no match for “”`", async () => {
  const handleRef: { current: any } = { current: null };
  const root = createRoot(document.getElementById("root")!);
  const conversation = { _id: "conv-new", title: "New session" } as any;
  await React.act(async () => root.render(React.createElement(ProjectSwitcher, { conversation, handleRef })));
  expect(handleRef.current).not.toBeNull();
  await React.act(async () => { handleRef.current.focus(); });
  expect(handleRef.current.isOpen()).toBe(true);

  const text = document.body.textContent ?? "";
  // The miss: a blank filter reported as a failed search.
  expect(text).not.toContain("no match for “”");
  // And the opened picker offers at least one folder to pick right away.
  const folderNames = RECENTS.map((p) => p.path.split("/").pop()!);
  const chips = [...document.querySelectorAll("button")].map((b) => b.textContent ?? "");
  expect(chips.some((c) => folderNames.some((n) => c.includes(n)))).toBe(true);

  await React.act(async () => root.unmount());
});
