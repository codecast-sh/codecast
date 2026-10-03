// THE TASKS BOARD PAINTS ITS CACHED TASKS WHEN ITS BACKEND IS MISSING.
//
// /tasks mounted in the dashboard shell over a convex transport that answers
// every query "Could not find public function" (test-helpers/
// missingBackend.tsx), the live site between a web push and its convex
// deploy. The board paints the workspace's tasks collection; the active
// session map, the mention index, the workflow runs and the paged backfill
// only refresh or annotate it, so a cached task stays on the board and no
// part of the page falls into an ErrorBoundary.
// Run: cd packages/web && bun test --isolate components/__tests__/tasks.degrade.test.tsx
import { expect, test } from "bun:test";
import { describeFailures, fixtureId, installDom, installMissingBackend, seedViewer, TEAM_ID, VIEWER_ID } from "../../test-helpers/missingBackend";

const { mountPage } = installDom("https://app.test/tasks");
const backend = await installMissingBackend();
await seedViewer();

const { useInboxStore } = await import("../../store/inboxStore");
const { default: TasksPage } = await import("../../app/tasks/page");

const now = Date.now();
useInboxStore.getState().syncTable("tasks", [{
  _id: fixtureId("taskcached"),
  short_id: "ct-4102",
  title: "Pin the flaky auth test seed",
  status: "open",
  priority: "high",
  task_type: "task",
  creator_id: VIEWER_ID,
  assignee: VIEWER_ID,
  team_id: TEAM_ID,
  workspace: `team:${TEAM_ID}`,
  created_at: now - 86_400_000,
  updated_at: now - 60_000,
}] as any);

test("the tasks board paints its cached task with every query missing", async () => {
  const page = await mountPage("/tasks", { tasks: <TasksPage /> });
  try {
    expect(describeFailures(page)).toBe("");
    expect(page.text()).toContain("Pin the flaky auth test seed");
    for (const fn of ["tasks:webActiveSessions", "tasks:webMentionList", "tasks:webListPaginated", "workflow_runs:listRuns"]) {
      expect(backend.refused).toContain(fn);
    }
  } finally {
    await page.unmount();
  }
}, 120_000);
