// The priorities list's glyphs as registered marks (lib/marks, components/Mark),
// mounted in jsdom over the list's fixtures. Proves: every glyph the list and
// an opened milestone draw is a registered mark; the shared icon legend, led by
// Priorities, lists the ones drawn without their word (the bordered Needs you
// beside a session's, New session, the milestone states, task states and a task
// still loading, a workflow run, the ten-day strip); and the ones drawn beside
// their word (a session row's state, a pull request's, a deploy's, the Branches
// and Plans headings) are marked labeled, so the legend leaves them out. Every
// id the priorities UI can name, for every state it can draw, is registered.
// Run: cd packages/web && bun test --isolate components/priorities/PriorityMarks.mount.test.tsx
import { expect, test } from "bun:test";
import { TEAM_ID, installDom, installMissingBackend, seedViewer } from "../../test-helpers/missingBackend";

installDom("https://app.test/priorities");
(globalThis as any).NodeFilter ??= (window as any).NodeFilter;
const answers: Record<string, unknown> = {};
await installMissingBackend({ answers });
await seedViewer();

const React = await import("react");
const { act } = React as any;
const { useInboxStore } = await import("../../store/inboxStore");
const { MARK_BY_ID } = await import("../../lib/marks");
const { deployMarkId, taskStatusMarkId } = await import("../../lib/marks/work");
const { deployPillState } = await import("../../lib/deploys/deployPill");
const { legendGroups, readMarks } = await import("../../lib/iconLegend");
const { SESSION_STATUSES } = await import("../../lib/sessionStatus");
const { HOUR, NOW, PL_1075, block, links, mount, row, seedNeedsYou, sess, step, view } = await import("../../test-helpers/prioritiesList");

const r = row(31, "Every mark", 1, [
  step("s1", "Asks you", "critical"),
  step("s2", "Nobody on it", "critical"),
  step("s4", "Nobody on this either", "critical"),
  step("s3", "Wired", "critical", false, { refs: [{ kind: "task", id: "ct-8101" }, { kind: "task", id: "ct-8199" }, { kind: "pr", id: "codecast-sh/codecast#4581" }] }),
], {
  links: [
    links("s1", [sess("markask", "Asking session", "needs_you", 1)]),
    links("s2", []),
    links("s4", []),
    links("s3", [sess("markwork", "Working session", "working", 0), sess("markflow", "Review · run", "dormant", 2, { workflow: true })], { plan: PL_1075 }),
  ],
});

function seed() {
  useInboxStore.setState({ tasks: { tk8101: { _id: "tk8101", short_id: "ct-8101", title: "A task", status: "in_progress" } } } as any);
  const dep = (id: string, status: string) => ({ _id: id, short_id: `dp-${id}`, workspace: `team:${TEAM_ID}`, target: `t-${id}`, status, live_at: NOW - HOUR, created_at: NOW - 2 * HOUR, sessions: [], tasks: [{ short_id: "ct-8101" }] });
  useInboxStore.getState().syncTable("teamDeploys", [dep("81", "live"), dep("82", "failed"), dep("83", "running")] as any, { isDelta: true });
  useInboxStore.getState().syncTable("sessions", [{ _id: "markwork-row", title: "x", worktree_branch: "feat/marks", updated_at: NOW - HOUR }] as any, { isDelta: true });
  return seedNeedsYou("markask");
}

async function openAll() {
  const unseed = seed();
  const page = await mount(view({ rows: [r] }));
  const b = block(page.container, "pri-31");
  await act(async () => { (b.querySelector('[data-milestone="s3"] [role=button]') as HTMLElement).click(); });
  return { page, b, done: async () => { await page.unmount(); unseed(); useInboxStore.setState({ tasks: {} } as any); } };
}
const marksIn = (el: ParentNode) => [...el.querySelectorAll<HTMLElement>("[data-mark]")].map((m) => `${m.dataset.mark}${m.hasAttribute("data-mark-labeled") ? " labeled" : ""}`);

test("every glyph the list and an opened milestone draw is a registered mark", async () => {
  const { b, done } = await openAll();
  try {
    const all = [...b.querySelectorAll<HTMLElement>("[data-mark]")].map((m) => m.dataset.mark!);
    expect(all.length).toBeGreaterThan(8);
    expect(all.filter((id) => !MARK_BY_ID.has(id))).toEqual([]);
  } finally {
    await done();
  }
}, 60_000);

test("the Priorities legend lists what the list draws without its word, Priorities first", async () => {
  const { b, done } = await openAll();
  try {
    const groups = legendGroups(readMarks(b, () => true), "Priorities");
    expect(groups[0].group).toBe("Priorities");
    const ids = groups.flatMap((g) => g.rows.map((row) => row.def.id));
    expect(ids).toEqual(expect.arrayContaining([
      "priority.new_session", "priority.ten_days", "priority.task_loading",
      "session.needs_you", "session.working",
      "task.in_progress", "inbox.flow",
    ]));
    const rows = groups.flatMap((g) => g.rows);
    // The milestone's bordered Needs you is a picture of session.needs_you, on the same row as the bare glyph.
    const needs = rows.find((row) => row.def.id === "session.needs_you")!;
    expect(needs.glyphs.some((g) => g.seen.markup.includes("border-sol-yellow"))).toBe(true);
    // Two milestones' New session buttons are one glyph: the mark is the button's face, never its link (which differs by href).
    expect(rows.find((row) => row.def.id === "priority.new_session")!.glyphs).toHaveLength(1);
    expect(b.querySelectorAll('[data-mark="priority.new_session"]')).toHaveLength(2);
  } finally {
    await done();
  }
}, 60_000);

test("a glyph beside its word is labeled: a session row's state, a PR's, a deploy's, and the Branches and Plans headings' glyphs", async () => {
  const { b, done } = await openAll();
  try {
    const c = b.querySelector('[data-milestone="s3"] [data-connected]')!;
    const got = marksIn(c);
    expect(got).toEqual(expect.arrayContaining([
      "session.working labeled", "pr.open labeled", "entity.plan labeled",
      "deploy.live labeled", "deploy.failed labeled", "deploy.going_out labeled",
    ]));
    // A task's state and the workflow glyph carry no word, so the legend names them.
    expect(got).toEqual(expect.arrayContaining(["task.in_progress", "priority.task_loading", "inbox.flow"]));
    expect(got).not.toContain("session.working");
    // Each deploy state is its own shape: a plain rocket, the error mark, a dashed rocket.
    expect(c.querySelector('[data-mark="deploy.live"] [data-deploy-mark="live"]')).not.toBeNull();
    expect(c.querySelector('[data-deploy-mark="failed"] [data-mark="deploy.failed"] [data-status-mark="error"]')).not.toBeNull();
    expect(c.querySelector('[data-mark="deploy.going_out"] [data-deploy-mark="pending"]')!.getAttribute("stroke-dasharray")).toBe("3 2");
  } finally {
    await done();
  }
}, 60_000);

test("every id the priorities UI can name is registered, for every state it can draw", () => {
  const ids = [
    "priority.new_session", "priority.ten_days", "priority.task_loading",
    "entity.priority", "entity.plan", "git.branch", "inbox.flow",
    ...SESSION_STATUSES.map((s) => `session.${s}`),
    ...["backlog", "open", "in_progress", "in_review", "done", "dropped", undefined].map((s) => taskStatusMarkId(s)),
    ...["open", "merged", "closed"].map((s) => `pr.${s}`),
    ...["live", "failed", "running", "requested", "cancelled", "anything"].map((s) => deployMarkId(deployPillState({ status: s } as any))),
  ];
  expect(ids.filter((id) => !MARK_BY_ID.has(id))).toEqual([]);
});
