import { afterAll, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";

// A run's nodes render as session rows: a node with an attached session is
// the task page's session row and links to that conversation whatever its
// status; a node with only a daemon handle links by that handle; a node with
// neither is a plain step. Run: bun test components/__tests__/workflowRunNodes.mount.test.tsx

mock.module("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={String(href)} {...props}>{children}</a>,
}));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "https://codecast.sh/tasks/ct-1" });
const restoreGlobals = replaceGlobals({
  window: Object.assign(dom.window, { innerWidth: 1400 }),
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { TooltipProvider } = await import("../ui/tooltip");
const { WorkflowRunNodes } = await import("../WorkflowRunNodes");

afterAll(() => { closeDomWindow(dom); restoreGlobals(); });

const CONV_ID = "kc1abcdefabcdefabcdefabcdefabcde";
const now = Date.now();

const run = {
  _id: "kw1abcdefabcdefabcdefabcdefabcde",
  status: "running",
  current_node_id: "web-client",
  node_statuses: [
    {
      node_id: "protocol-package", status: "completed", outcome: "success",
      started_at: now - 600_000, completed_at: now - 300_000,
      session: { _id: CONV_ID, session_id: "sess-protocol", title: "Define the wire protocol", message_count: 42, is_active: false, updated_at: now - 300_000, agent_type: "claude_code" },
    },
    { node_id: "integrate-deploy", status: "failed", session_id: "sess-deploy", started_at: now - 200_000, completed_at: now - 100_000 },
    { node_id: "web-client", status: "running", activity: "Editing packages/web/app/page.tsx" },
    { node_id: "independent-verify", status: "pending" },
  ],
};

const workflow = {
  _id: "kf1abcdefabcdefabcdefabcdefabcde",
  name: "desiredb-build",
  nodes: [
    { id: "start", label: "start", type: "start" },
    { id: "protocol-package", label: "protocol-package", type: "agent" },
    { id: "integrate-deploy", label: "integrate-deploy", type: "agent" },
    { id: "web-client", label: "web-client", type: "agent" },
    { id: "independent-verify", label: "independent-verify", type: "command" },
    { id: "exit", label: "exit", type: "exit" },
  ],
};

async function mount(props: { run: any; workflow?: any }) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => root.render(
    <MemoryRouter>
      <TooltipProvider><WorkflowRunNodes {...props} /></TooltipProvider>
    </MemoryRouter>,
  ));
  return { container, unmount: () => act(() => root.unmount()) };
}

describe("WorkflowRunNodes", () => {
  test("a completed node with a session is a session row that links to its conversation", async () => {
    const { container, unmount } = await mount({ run, workflow });
    try {
      const row = container.querySelector(`[data-session-id="${CONV_ID}"]`)!;
      expect(row).not.toBeNull();
      expect(row.querySelector(`a[href="/conversation/${CONV_ID}"]`)).not.toBeNull();
      // The session's own title leads; the node label rides as a chip.
      expect(row.textContent).toContain("Define the wire protocol");
      expect(row.textContent).toContain("protocol-package");
      expect(row.textContent).toContain("42 msgs");
      expect(row.querySelector('[data-step-status="completed"]')).not.toBeNull();
    } finally {
      unmount();
    }
  });

  test("a node with only a daemon handle still opens by that handle", async () => {
    const { container, unmount } = await mount({ run, workflow });
    try {
      const row = container.querySelector('[data-step="integrate-deploy"]')!;
      expect(row.querySelector('a[href="/conversation/sess-deploy"]')).not.toBeNull();
      expect(row.querySelector('[data-step-status="failed"]')).not.toBeNull();
    } finally {
      unmount();
    }
  });

  test("the current node shows what it is doing; a pending node is a plain step", async () => {
    const { container, unmount } = await mount({ run, workflow });
    try {
      const current = container.querySelector('[data-step="web-client"]')!;
      expect(current.textContent).toContain("Editing packages/web/app/page.tsx");
      expect(current.querySelector('[data-step-status="running"]')).not.toBeNull();
      const pending = container.querySelector('[data-step="independent-verify"]')!;
      expect(pending.querySelector("a")).toBeNull();
      // start and exit never render.
      expect(container.querySelector('[data-step="start"]')).toBeNull();
      expect(container.querySelector('[data-step="exit"]')).toBeNull();
    } finally {
      unmount();
    }
  });

  test("a dynamic run groups its agents under the phases it declared", async () => {
    const dynamic = {
      _id: "kw2abcdefabcdefabcdefabcdefabcde",
      status: "completed",
      run_kind: "workflow",
      phases: [{ title: "Review" }, { title: "Verify" }],
      node_statuses: [
        { node_id: "a1", status: "completed", label: "review:bugs", phase: "Review", tokens: 12_400, result_preview: "3 findings" },
        { node_id: "a2", status: "completed", label: "verify:bugs", phase: "Verify", tokens: 800 },
      ],
    };
    const { container, unmount } = await mount({ run: dynamic });
    try {
      const text = container.textContent ?? "";
      expect(text.indexOf("Review")).toBeGreaterThanOrEqual(0);
      expect(text.indexOf("Review")).toBeLessThan(text.indexOf("Verify"));
      expect(text).toContain("3 findings");
      expect(text).toContain("12k tok");
    } finally {
      unmount();
    }
  });
});
