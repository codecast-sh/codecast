import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";

import { closeDomWindow } from "../../test-helpers/domGlobals";
// The conversation header workflow strip starts collapsed, same as the plan
// strip: name, status and progress on the first paint; the node list after a
// click. Run: bun test components/__tests__/workflowContextPanel.mount.test.tsx

mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={String(href)} {...props}>{children}</a>,
}));

const { useInboxStore } = await import("../../store/inboxStore");

const realWorkflows = { ...(await import("../../hooks/useSyncWorkflows")) };
mock.module("../../hooks/useSyncWorkflows", () => ({
  ...realWorkflows,
  useWorkflowRun: (id: string | null | undefined) => useInboxStore((s: any) => (id ? s.workflowRuns[id] ?? null : undefined)),
  useWorkflow: (id: string | null | undefined) => useInboxStore((s: any) => (id ? s.workflows[id] ?? null : undefined)),
}));
afterAll(() => { mock.module("../../hooks/useSyncWorkflows", () => realWorkflows); });

const { WorkflowContextPanel } = await import("../WorkflowContextPanel");

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/inbox" });
const restoreGlobals = replaceGlobals({
  window: Object.assign(dom.window, { innerWidth: 1400 }),
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
// react-dom/client decides at load whether a DOM exists, so it is loaded
// here — after the globals above — not as a static import.
const {createRoot} = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { TooltipProvider } = await import("../ui/tooltip");

afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const RUN_ID = "kw1abcdefabcdefabcdefabcdefabcde";
const WF_ID = "kf1abcdefabcdefabcdefabcdefabcde";

const run = {
  _id: RUN_ID,
  workflow_id: WF_ID,
  workflow_name: "cloud-seamless-land",
  status: "running",
  current_node_id: "polish",
  node_statuses: [
    { node_id: "squash-rebase", status: "completed", label: "squash-rebase" },
    { node_id: "closeout-mirror", status: "completed", label: "closeout-mirror" },
    { node_id: "polish", status: "pending", label: "polish" },
  ],
};

const workflow = {
  _id: WF_ID,
  name: "cloud-seamless-land",
  nodes: [
    { id: "squash-rebase", label: "squash-rebase" },
    { id: "closeout-mirror", label: "closeout-mirror" },
    { id: "polish", label: "polish" },
  ],
};

beforeEach(() => {
  useInboxStore.setState({ workflowRuns: { [RUN_ID]: run }, workflows: { [WF_ID]: workflow }, sessionDecisions: {} } as any);
});

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  // The node rows open sessions through the router, so the panel mounts
  // inside one, the way the pages that host it do.
  await act(() => root.render(
    <MemoryRouter>
      <TooltipProvider><WorkflowContextPanel workflowRunId={RUN_ID as any} /></TooltipProvider>
    </MemoryRouter>,
  ));
  return {
    container,
    unmount: () => act(() => root.unmount()),
  };
}

describe("WorkflowContextPanel", () => {
  test("starts collapsed: name and status, no node list", async () => {
    const { container, unmount } = await mount();
    try {
      expect(container.textContent).toContain("cloud-seamless-land");
      expect(container.textContent).toContain("running");
      expect(container.textContent).toContain("2/3");
      expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
      expect(container.textContent).not.toContain("squash-rebase");
      expect(container.textContent).not.toContain("Open the run");
      // The aggregate header still says where the run is.
      expect(container.textContent).toContain("polish");
    } finally {
      unmount();
    }
  });

  test("a click on the header reveals the nodes", async () => {
    const { container, unmount } = await mount();
    try {
      await act(() => { container.querySelector("button")!.click(); });
      expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
      expect(container.textContent).toContain("squash-rebase");
      expect(container.textContent).toContain("polish");
      expect(container.textContent).toContain("Open the run");
      expect(container.querySelector(`a[href="/workflows/runs/${RUN_ID}"]`)).not.toBeNull();
    } finally {
      unmount();
    }
  });
});
