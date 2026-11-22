// ct-97195: a plan opened beside a conversation (a stage split pane) closes
// in one press. Its ✕ closes the pane; it never re-points the pane at the
// Plans list (a pane has no trail of its own, so useNavCloseTarget fell back
// to "up" and sent the pane to /plans, costing a second press on "Close pane").
// Run: cd packages/web && bun test --isolate components/stage/__tests__/paneDetailClose.test.tsx
import { afterEach, expect, test } from "bun:test";
import { installModernDom, styleValue } from "../../../test-helpers/modernDom";

installModernDom("https://app.test/inbox?s=jx70000000000000000000000000000s1");

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { ThemeContext } = await import("../../ThemeProvider");
const { TabParamsCtx, parseTabLocation } = await import("../../../lib/tabParams");
const { useInboxStore } = await import("../../../store/inboxStore");
const { leavesOf } = await import("../../../store/stageSplit");
const { stageNavigateLeaf } = await import("../../../lib/stage");
const { PlanPanelTitleRow } = await import("../../PlanPanelHead");

const SESSION = "jx70000000000000000000000000000s1";
const PLAN_PATH = "/plans/pl-1";
const host = document.createElement("div");
document.body.append(host);
let root: ReturnType<typeof createRoot> | null = null;
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = null;
});

const activeTab = () => {
  const s = useInboxStore.getState();
  return s.tabs.find((t) => t.id === s.activeTabId)!;
};

test("the ✕ on a plan opened beside a conversation closes the pane in one press", async () => {
  useInboxStore.setState({
    sessions: { [SESSION]: { _id: SESSION, title: "Slack bot rebuild", message_count: 4, agent_type: "claude_code" } },
    plans: { pl1: { _id: "pl1", short_id: "pl-1", title: "Verification suite" } },
    tabs: [{ id: "t1", path: `/inbox?s=${SESSION}`, title: "", createdAt: 0 }],
    activeTabId: "t1",
  } as any);
  // Open the plan beside the conversation: a two-pane split.
  useInboxStore.getState().stageInsertLeaf("root", "right", PLAN_PATH);
  const planLeaf = leavesOf(activeTab().layout!).find((l) => l.path === PLAN_PATH)!;
  expect(planLeaf).toBeTruthy();
  useInboxStore.getState().stageFocusLeaf(planLeaf.id);

  // The plan pane's scope, as StageSplitView gives a route pane in a split.
  const ctx = {
    tabId: "t1",
    ...parseTabLocation(PLAN_PATH),
    params: { id: "pl-1" },
    isActive: true,
    isVisible: true,
    navigate: (p: string, m: "push" | "replace") => stageNavigateLeaf(planLeaf.id, p, m),
    leafId: planLeaf.id,
  };
  root = createRoot(host);
  await act(() => root!.render(
    <ThemeContext.Provider value={styleValue("classic")}>
      <MemoryRouter initialEntries={[PLAN_PATH]}>
        <TabParamsCtx.Provider value={ctx}>
          <PlanPanelTitleRow
            plan={{ _id: "pl1", short_id: "pl-1", title: "Verification suite" }}
            status={{ icon: () => null, color: "", label: "Active" } as any}
            storeShareToken={null}
            closeHref="/plans"
          />
        </TabParamsCtx.Provider>
      </MemoryRouter>
    </ThemeContext.Provider>,
  ));

  const close = host.querySelector<HTMLElement>("[aria-label='Close']");
  expect(close).toBeTruthy();
  await act(async () => close!.click());

  const tab = activeTab();
  const paths = tab.layout ? leavesOf(tab.layout).map((l) => l.path) : [tab.path];
  // Not swapped to the Plans list...
  expect(paths).not.toContain("/plans");
  // ...but closed: only the conversation remains.
  expect(paths).toEqual([`/inbox?s=${SESSION}`]);
});

// A pane that came to the detail from its parent is not closed by the detail's
// close: a task opened inside a project pane goes back up to the project.
const { useNavCloseTarget } = await import("../../../hooks/useNavTrail");
function CloseButton({ closeHref }: { closeHref: string }) {
  const { close } = useNavCloseTarget(closeHref);
  return <button aria-label="Close" onClick={close} />;
}

test("a task opened inside a project pane closes back to the project, not the pane", async () => {
  const PROJECT = "/projects/pj-1";
  const TASK = "/projects/pj-1/ct-1";
  useInboxStore.setState({
    tabs: [{ id: "t1", path: `/inbox?s=${SESSION}`, title: "", createdAt: 0 }],
    activeTabId: "t1",
  } as any);
  useInboxStore.getState().stageInsertLeaf("root", "right", PROJECT);
  const leaf = leavesOf(activeTab().layout!).find((l) => l.path === PROJECT)!;
  useInboxStore.getState().stageFocusLeaf(leaf.id);
  // The person opens one of the project's tasks inside the pane.
  stageNavigateLeaf(leaf.id, TASK, "push");
  expect(leavesOf(activeTab().layout!).map((l) => l.path)).toContain(TASK);

  const ctx = {
    tabId: "t1",
    ...parseTabLocation(TASK),
    params: { id: "pj-1", taskId: "ct-1" },
    isActive: true,
    isVisible: true,
    navigate: (p: string, m: "push" | "replace") => stageNavigateLeaf(leaf.id, p, m),
    leafId: leaf.id,
  };
  root = createRoot(host);
  await act(() => root!.render(
    <MemoryRouter initialEntries={[TASK]}>
      <TabParamsCtx.Provider value={ctx}>
        <CloseButton closeHref={PROJECT} />
      </TabParamsCtx.Provider>
    </MemoryRouter>,
  ));
  await act(async () => host.querySelector<HTMLElement>("[aria-label='Close']")!.click());

  const tab = activeTab();
  const paths = tab.layout ? leavesOf(tab.layout).map((l) => l.path) : [tab.path];
  // The pane stays, back on the project beside the conversation.
  expect(paths).toEqual([`/inbox?s=${SESSION}`, PROJECT]);
});
