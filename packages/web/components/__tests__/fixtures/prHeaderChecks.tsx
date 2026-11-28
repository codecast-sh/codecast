import assert from "node:assert/strict";
import { mock } from "bun:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost/" });
for (const key of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "MutationObserver", "getComputedStyle"]) {
  Object.defineProperty(globalThis, key, { configurable: true, value: (dom.window as any)[key] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const convexReact = await import("convex/react");
mock.module("convex/react", () => ({ ...convexReact, useAction: () => () => {} }));
mock.module("next/link", () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
mock.module("../../repo/RepoWindowControl", () => ({ RepoWindowControl: () => null }));
mock.module("../../comments/CommentAvatar", () => ({ CommentAvatar: () => null }));
// The production band's hooks boot the store (localStorage, IndexedDB), which this DOM-less process has none of.
mock.module("../../../hooks/usePrDeploy", () => ({ usePrDeploy: () => ({}) }));
// The run review reads the store too: this header renders with no run.
mock.module("../../../hooks/useSyncWorkflows", () => ({ usePullRequestRun: () => null }));
mock.module("../../../lib/ship/changePage", () => ({ reviewOnHead: () => null, reviewEarlier: () => null }));
mock.module("../../pr/PRDeploy", () => ({ PRDeployBand: () => null, PRReachChip: () => null, PRShipsTo: () => null }));
// An open PR's shepherd sits in its Shipping strip, whose run read needs Convex: the strip here is the shepherd it is handed.
mock.module("../../pr/PRShipStrip", () => ({ PRShipStrip: ({ shepherd }: any) => <>{shepherd}</> }));
// The session pill resolves titles from the live store; here it is the link
// it becomes, named by the title the header hands it.
mock.module("../../EntityIdPill", () => ({
  EntityIdPill: ({ id, fallback }: any) => <a href={`/conversation/${id}`}>{fallback}</a>,
}));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { PRHeader } = await import("../../pr/PRHeader");
const container = document.getElementById("root")!;
const root = createRoot(container);
const render = (pr: Record<string, unknown>, checksRead?: boolean) => act(() => root.render(<PRHeader
  pr={{ title: "Fix test", state: "open", ...pr }}
  repository="codecast-sh/codecast" number={79} openComments={0} sessionChoices={[]} onSetShepherd={() => {}}
  {...(checksRead === undefined ? {} : { checksRead })}
/>));
const reading = () => !!container.querySelector("[data-pr-checks-reading]");
const said = () => container.textContent ?? "";

try {
  // Before the page's read answers, a row with no checks yet reads as loading, never "No checks".
  await render({}, false);
  assert.equal(reading(), true);
  assert.equal(said().includes("No checks"), false);
  // Once it has answered, a pull request with nothing to detail (no checks field at all) has no checks.
  await render({}, true);
  assert.equal(reading(), false);
  assert.equal(said().includes("No checks"), true);
  // Checks on the row read as they are, whatever the read.
  await render({ checks: [{ name: "ci", status: "completed", conclusion: "success" }] }, false);
  assert.equal(reading(), false);
  assert.equal(said().includes("1 passed"), true);
  console.log("PR checks figure: loading until read, then none or the checks");
} finally {
  await act(() => root.unmount());
  dom.window.close();
}
