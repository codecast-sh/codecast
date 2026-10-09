// Links that do not block (docs/architecture/task-graph.md TG5): found_during
// fills itself from the creating session's bound task, superseding and
// marking a duplicate move the old task's dependents to the replacement (and
// refuse a loop) and reopening or unmarking moves them back, related is
// mirrored on both rows, and every link reaches `cast task show`/`context`
// resolved.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { addDepCore, adminDeleteTask, context, create, get, moveTaskStatus, update, updateTaskAs } from "./tasks";
import { cutCrossedEdges, relate, supersede, unrelate } from "./taskLinks";
import { hashToken } from "./apiTokens";
import { dispatch } from "./dispatch";
import { createFromTemplate } from "./plans";
import { applyRemote } from "./issueSync";
import { applyPlanStatus } from "./orgInit";
import { normalizeLinearIssue } from "./lib/issueMapping";
import { GRAPH_LINK_CAP } from "@codecast/shared/tasks";

const USER = "u_user";
const OTHER = "u_other";
const TOKEN = "task-links-test-token";
const SESSION = "sess-bound";

async function makeCtx(tasks: any[], conv: any = {}) {
  const tables: Record<string, any[]> = {
    users: [{ _id: USER, name: "User" }, { _id: OTHER, name: "Other" }],
    api_tokens: [{ _id: "token_1", user_id: USER, token_hash: await hashToken(TOKEN) }],
    conversations: [{ _id: "conv_1", user_id: USER, session_id: SESSION, is_private: true, ...conv }],
    counters: [{ _id: "counter_ct", name: "ct", value: 100 }],
    tasks,
    task_history: [],
    task_comments: [],
  };
  return {
    ctx: {
      auth: { async getUserIdentity() { return { subject: `${USER}|session` }; } },
      db: makeFakeDb(tables),
      scheduler: { runAfter: async () => null, runAt: async () => null },
      runMutation: async () => null,
    } as any,
    tables,
  };
}

const task = (shortId: string, over: any = {}) => ({
  _id: `task_${shortId}`,
  short_id: shortId,
  user_id: USER,
  title: `Title ${shortId}`,
  status: "open",
  priority: "medium",
  source: "human",
  created_at: 1,
  updated_at: 1,
  ...over,
});

const call = (fn: any, ctx: any, args: any) => fn._handler(ctx, { api_token: TOKEN, ...args });
const row = (tables: any, id: string) => tables.tasks.find((t: any) => t.short_id === id);
const commentsOn = (tables: any, id: string) => tables.task_comments.filter((c: any) => c.task_id === `task_${id}`).map((c: any) => c.text);
const historyOf = (tables: any, id: string, field: string) =>
  tables.task_history.filter((h: any) => h.task_id === `task_${id}` && h.field === field).map((h: any) => [h.old_value, h.new_value]);

describe("found_during (TG5)", () => {
  test("fills from the creating session's bound task and records it", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1")], { active_task_id: "task_ct-1" });
    const { short_id } = await call(create, ctx, { title: "Found bug", conversation_id: SESSION });
    expect(row(tables, short_id).found_during).toBe("ct-1");
    expect(tables.task_history.filter((h: any) => h.field === "found_during").map((h: any) => h.new_value)).toEqual(["ct-1"]);
  });

  test("skips the bound task's own subtasks, deep ones included, and its plan's steps", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { plan_id: "plan_1" }),
      task("ct-2", { parent_id: "task_ct-1" }),
    ], { active_task_id: "task_ct-1" });
    tables.plans = [{ _id: "plan_1", short_id: "pl-1", user_id: USER, title: "P", status: "active", task_ids: ["task_ct-1"], created_at: 1, updated_at: 1 }];
    const sub = await call(create, ctx, { title: "Sub", conversation_id: SESSION, parent_id: "ct-1" });
    const deep = await call(create, ctx, { title: "Deeper", conversation_id: SESSION, parent_id: "ct-2" });
    const step = await call(create, ctx, { title: "Step", conversation_id: SESSION, plan_id: "pl-1" });
    for (const r of [sub, deep, step]) expect(row(tables, r.short_id).found_during).toBeUndefined();
  });

  test("an explicit value wins, and none skips the default", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1"), task("ct-5")], { active_task_id: "task_ct-1" });
    const explicit = await call(create, ctx, { title: "A", conversation_id: SESSION, found_during: "ct-5" });
    const none = await call(create, ctx, { title: "B", conversation_id: SESSION, found_during: "none" });
    expect(row(tables, explicit.short_id).found_during).toBe("ct-5");
    expect(row(tables, none.short_id).found_during).toBeUndefined();
  });

  test("an explicit task in another workspace is refused; a bound one there is skipped", async () => {
    const foreign = task("ct-9", { user_id: OTHER, team_id: "team_x", workspace: "team:team_x" });
    const { ctx, tables } = await makeCtx([foreign], { active_task_id: "task_ct-9" });
    tables.team_memberships = [{ _id: "m1", user_id: USER, team_id: "team_x", role: "member" }];
    await expect(call(create, ctx, { title: "A", found_during: "ct-9" })).rejects.toThrow(/another workspace|not found/i);
    const auto = await call(create, ctx, { title: "B", conversation_id: SESSION });
    expect(row(tables, auto.short_id).found_during).toBeUndefined();
  });

  // The server fills the link by itself, so a wrong one must be correctable:
  // update takes the same ref grammar and workspace rule as create.
  test("update rewrites the link the filing session set, and none clears it", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1"), task("ct-5")], { active_task_id: "task_ct-1" });
    const { short_id } = await call(create, ctx, { title: "Found bug", conversation_id: SESSION });
    expect(row(tables, short_id).found_during).toBe("ct-1");

    await call(update, ctx, { short_id, found_during: "CT-5" });
    expect(row(tables, short_id).found_during).toBe("ct-5");
    await call(update, ctx, { short_id, found_during: "none" });
    expect(row(tables, short_id).found_during).toBeUndefined();
    expect(tables.task_history.filter((h: any) => h.field === "found_during").map((h: any) => [h.old_value, h.new_value]))
      .toEqual([["", "ct-1"], ["ct-1", "ct-5"], ["ct-5", ""]]);

    await expect(call(update, ctx, { short_id, found_during: short_id })).rejects.toThrow("cannot be found during itself");
    await expect(call(update, ctx, { short_id, found_during: "ct-404" })).rejects.toThrow("not found");
  });

  // The web is where a person notices a wrong provenance link, so the board
  // repoints it through the same rule and records the same history ("" is the
  // CLI's "none"); a self link and a ref naming no task are refused there too.
  test("the board repoints and clears the link, exactly as the CLI does", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1"), task("ct-5")], { active_task_id: "task_ct-1" });
    const { short_id } = await call(create, ctx, { title: "Found bug", conversation_id: SESSION });

    await updateTaskAs(ctx, USER as any, { short_id, found_during: "CT-5" });
    expect(row(tables, short_id).found_during).toBe("ct-5");
    await updateTaskAs(ctx, USER as any, { short_id, found_during: "" });
    expect(row(tables, short_id).found_during).toBeUndefined();
    expect(tables.task_history.filter((h: any) => h.field === "found_during").map((h: any) => [h.old_value, h.new_value]))
      .toEqual([["", "ct-1"], ["ct-1", "ct-5"], ["ct-5", ""]]);

    await expect(updateTaskAs(ctx, USER as any, { short_id, found_during: short_id })).rejects.toThrow("cannot be found during itself");
    await expect(updateTaskAs(ctx, USER as any, { short_id, found_during: "ct-404" })).rejects.toThrow("not found");
  });

  test("the source lists what was found there; show and context resolve every link", async () => {
    const { ctx } = await makeCtx([
      task("ct-1", { related: ["ct-3"] }),
      task("ct-2", { found_during: "ct-1", superseded_by: "ct-3", status: "dropped" }),
      task("ct-3", { related: ["ct-1"] }),
    ]);
    const shown = await call(get, ctx, { short_id: "ct-2" });
    expect(shown.links.found_during.short_id).toBe("ct-1");
    expect(shown.links.superseded_by.short_id).toBe("ct-3");
    const ctx1 = await call(context, ctx, { short_id: "ct-1" });
    expect(ctx1.links.found_here).toEqual([{ short_id: "ct-2", title: "Title ct-2", status: "dropped" }]);
    expect(ctx1.links.related.map((r: any) => r.short_id)).toEqual(["ct-3"]);
  });

  // The cap counts the rows the reader is SHOWN, as the web's foundHereOf
  // counts the readable rows its store holds: capping the index read first
  // would list a short (or empty) "Found during this" in `cast task show`
  // while the task page listed up to fifty.
  test("found here lists a full page of readable rows past the ones it may not read", async () => {
    const elsewhere = Array.from({ length: 55 }, (_, i) =>
      task(`ct-x${i}`, { found_during: "ct-1", user_id: OTHER, team_id: "team_x", workspace: "team:team_x" }));
    const readable = Array.from({ length: 55 }, (_, i) => task(`ct-m${i}`, { found_during: "ct-1" }));
    const { ctx } = await makeCtx([task("ct-1"), ...elsewhere, ...readable]);
    const shown = await call(context, ctx, { short_id: "ct-1" });
    expect(shown.links.found_here).toHaveLength(GRAPH_LINK_CAP);
    expect(shown.links.found_here.every((r: any) => r.short_id.startsWith("ct-m"))).toBe(true);
  });

  test("show lists every blocker with its live state, done, gone and another workspace's alike", async () => {
    const { ctx } = await makeCtx([
      task("ct-1", { status: "done", blocks: ["ct-4"] }),
      task("ct-2", { workspace: `user:${OTHER}`, user_id: OTHER }),
      task("ct-4", { blocked_by: ["ct-1", "task_ct-1", "ct-9", "ct-2"], blocks: ["ct-5"] }),
      task("ct-5", { blocked_by: ["ct-4"] }),
    ]);
    const shown = await call(get, ctx, { short_id: "ct-4" });
    expect(shown.links.blocked_by).toEqual([
      { kind: "task", ref: "ct-1", status: "done", title: "Title ct-1" },
      { kind: "task", ref: "ct-9", missing: true },
      { kind: "task", ref: "ct-2", status: "unknown" },
    ]);
    expect(shown.links.blocks).toEqual([{ short_id: "ct-5", title: "Title ct-5", status: "open" }]);
  });

  // A task's assignee holds an explicit grant (accessStampFromDoc), so a
  // reader outside its workspace can read the task itself. The blocker's
  // STATUS still follows the workspace rule, so this list and readiness agree;
  // its title is the blocker's own to lend.
  test("a blocker's title needs the reader's own access, not just the task's workspace", async () => {
    const { ctx } = await makeCtx([
      task("ct-1", { user_id: OTHER, workspace: `user:${OTHER}`, assignee: USER, blocked_by: ["ct-2"], related: ["ct-3"] }),
      task("ct-2", { user_id: OTHER, workspace: `user:${OTHER}` }),
      task("ct-3", { user_id: OTHER, workspace: `user:${OTHER}`, related: ["ct-1"] }),
    ]);
    const shown = await call(get, ctx, { short_id: "ct-1" });
    expect(shown.links.blocked_by).toEqual([{ kind: "task", ref: "ct-2", status: "open" }]);
    // Every other link of the same task is left out for this reader, so a
    // title here would be the one thing they could read nowhere else.
    expect(shown.links.related).toEqual([]);
  });

  test("a checks wait carries its PR's checks state, so red CI reads as red on a text surface", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", {
        waits: [
          { id: "w1", kind: "pr_checks_green", repository: "acme/app", pr_number: 42, state: "waiting", created_at: 1 },
          { id: "w2", kind: "pr_merged", repository: "acme/app", pr_number: 42, state: "waiting", created_at: 1 },
          { id: "w3", kind: "pr_checks_green", repository: "acme/app", pr_number: 7, state: "met", created_at: 1 },
        ],
      }),
    ]);
    tables.team_memberships = [{ _id: "tm_1", user_id: USER, team_id: "team_a", role: "member" }];
    tables.pull_requests = [
      { _id: "pr_42", team_id: "team_a", repository: "acme/app", number: 42, state: "open", checks_state: "failure", created_at: 1, updated_at: 1 },
      { _id: "pr_7", team_id: "team_a", repository: "acme/app", number: 7, state: "open", checks_state: "success", created_at: 1, updated_at: 1 },
    ];
    // Only a checks wait still waiting needs the read (checksWaitPr): a merge
    // wait on the same PR and a met checks wait ask for nothing.
    expect((await call(get, ctx, { short_id: "ct-1" })).links.wait_checks).toEqual({ w1: "failure" });
    // A PR in a team the reader is not in lends nothing.
    tables.team_memberships = [];
    expect((await call(get, ctx, { short_id: "ct-1" })).links.wait_checks).toEqual({});
  });

  test("a blocks entry whose task no longer waits on this one is not listed", async () => {
    const { ctx } = await makeCtx([
      task("ct-1", { blocks: ["ct-2", "ct-3", "ct-4"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-3", { blocked_by: ["task_ct-1"] }),
      task("ct-4", { blocked_by: ["ct-9"] }),
    ]);
    const shown = await call(get, ctx, { short_id: "ct-1" });
    expect(shown.links.blocks.map((r: any) => r.short_id)).toEqual(["ct-2", "ct-3"]);
  });
});

describe("supersede (TG5)", () => {
  test("drops the old task with a note, sets superseded_by, and moves its dependents", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2", "ct-3", "ct-4"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-3", { blocked_by: ["task_ct-1", "ct-9"] }),
      task("ct-4", { blocked_by: ["ct-1"], status: "done" }),
      task("ct-5"),
      task("ct-9"),
    ]);
    const res = await call(supersede, ctx, { short_id: "ct-1", by: "ct-5", note: "Rewritten scope." });
    expect(res.moved).toEqual(["ct-2", "ct-3"]);
    const old = row(tables, "ct-1");
    expect([old.status, old.superseded_by, old.blocks]).toEqual(["dropped", "ct-5", ["ct-4"]]);
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-5"]);
    expect(row(tables, "ct-3").blocked_by).toEqual(["ct-9", "ct-5"]);
    // A finished dependent keeps its history.
    expect(row(tables, "ct-4").blocked_by).toEqual(["ct-1"]);
    expect(row(tables, "ct-5").blocks).toEqual(["ct-2", "ct-3"]);
    expect(tables.task_comments.map((c: any) => c.text)).toEqual(["Superseded by ct-5. Rewritten scope. Its dependents now wait on it: ct-2, ct-3."]);
    expect(historyOf(tables, "ct-1", "superseded_by")).toEqual([["", "ct-5"]]);
    expect(historyOf(tables, "ct-2", "blocked_by")).toEqual([["ct-1", "ct-5"]]);
  });

  test("a move that would close a loop is refused and nothing is written", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"], blocks: ["ct-5"] }),
      task("ct-5", { blocked_by: ["ct-2"] }),
    ]);
    await expect(call(supersede, ctx, { short_id: "ct-1", by: "ct-5" })).rejects.toThrow(/loop/);
    expect([row(tables, "ct-1").status, row(tables, "ct-2").blocked_by]).toEqual(["open", ["ct-1"]]);
  });

  test("the replacement's own edge to the old task just goes", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-5"] }),
      task("ct-5", { blocked_by: ["ct-1"] }),
    ]);
    const res = await call(supersede, ctx, { short_id: "ct-1", by: "ct-5" });
    expect(res.moved).toEqual([]);
    expect(row(tables, "ct-5").blocked_by).toEqual([]);
    expect(row(tables, "ct-5").blocks ?? []).toEqual([]);
    expect(row(tables, "ct-1").blocks).toEqual([]);
    expect(commentsOn(tables, "ct-1")).toEqual(["Superseded by ct-5."]);
    // That edge was its last blocker, so it is released and told.
    expect(commentsOn(tables, "ct-5")).toEqual(["Unblocked: ct-1 superseded by ct-5"]);
  });

  test("a blocks entry whose task no longer waits on the old task gains no edge and is dropped", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2", "ct-3"] }),
      task("ct-2", { blocked_by: [] }),
      task("ct-3", { blocked_by: ["ct-1"] }),
      task("ct-5"),
    ]);
    const res = await call(supersede, ctx, { short_id: "ct-1", by: "ct-5" });
    expect(res.moved).toEqual(["ct-3"]);
    expect(row(tables, "ct-2").blocked_by).toEqual([]);
    expect(historyOf(tables, "ct-2", "blocked_by")).toEqual([]);
    expect(row(tables, "ct-5").blocks).toEqual(["ct-3"]);
    expect(row(tables, "ct-1").blocks).toEqual([]);
  });

  test("a done replacement releases the moved dependents and tells them", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2", "ct-3"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-3", { blocked_by: ["ct-1", "ct-9"] }),
      task("ct-5", { status: "done" }),
      task("ct-9"),
    ]);
    await call(supersede, ctx, { short_id: "ct-1", by: "ct-5" });
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-5"]);
    expect(commentsOn(tables, "ct-2")).toEqual(["Unblocked: ct-1 superseded by ct-5"]);
    // Still waits on ct-9.
    expect(commentsOn(tables, "ct-3")).toEqual([]);
  });

  test("superseding an already dropped task re-blocks without an unblocked note", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { status: "dropped", blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-5", { status: "done" }),
    ]);
    await call(supersede, ctx, { short_id: "ct-1", by: "ct-5" });
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-5"]);
    expect(commentsOn(tables, "ct-2")).toEqual([]);
  });

  test("superseding a dropped task tells a released dependent it is blocked again", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { status: "dropped", blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"], status: "in_progress" }),
      task("ct-5"),
    ]);
    await call(supersede, ctx, { short_id: "ct-1", by: "ct-5" });
    expect(commentsOn(tables, "ct-2")).toEqual(["Blocked again: ct-1 superseded by ct-5, so it waits on ct-5"]);
  });

  test("a dependent that already names the replacement by _id gains no second edge", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1", "task_ct-5"] }),
      task("ct-5"),
    ]);
    await call(supersede, ctx, { short_id: "ct-1", by: "ct-5" });
    expect(row(tables, "ct-2").blocked_by).toEqual(["task_ct-5"]);
  });

  test("a dependent the replacement's mirror names by _id is not added a second time", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1", "ct-5"] }),
      task("ct-5", { blocks: ["task_ct-2"] }),
    ]);
    await call(supersede, ctx, { short_id: "ct-1", by: "ct-5" });
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-5"]);
    expect(row(tables, "ct-5").blocks).toEqual(["task_ct-2"]);
  });

  test("a session bound to the old task is released, and its next task is not found there", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1", { conversation_ids: ["conv_1"] }), task("ct-5")], { active_task_id: "task_ct-1" });
    await call(supersede, ctx, { short_id: "ct-1", by: "ct-5", conversation_id: SESSION });
    expect(tables.conversations[0].active_task_id).toBeUndefined();
    tables.conversations[0].active_task_id = "task_ct-1";
    const { short_id } = await call(create, ctx, { title: "Later", conversation_id: SESSION });
    expect(row(tables, short_id).found_during).toBeUndefined();
  });

  test("reopening a superseded task clears superseded_by and takes its dependents back", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2", "ct-3"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-3", { blocked_by: ["ct-1", "ct-5"] }),
      task("ct-5", { blocks: ["ct-3"] }),
    ]);
    await call(supersede, ctx, { short_id: "ct-1", by: "ct-5" });
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", status: "open" });
    const old = row(tables, "ct-1");
    expect([old.status, old.superseded_by, old.blocks]).toEqual(["open", undefined, ["ct-3", "ct-2"]]);
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-1"]);
    // It waited on the replacement before the move too, so it keeps it.
    expect(row(tables, "ct-3").blocked_by).toEqual(["ct-5", "ct-1"]);
    expect(row(tables, "ct-5").blocks).toEqual(["ct-3"]);
    expect(historyOf(tables, "ct-1", "superseded_by")).toEqual([["", "ct-5"], ["ct-5", ""]]);
  });

  test("a supersede from a session is recorded as the agent's", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1"), task("ct-5")]);
    await call(supersede, ctx, { short_id: "ct-1", by: "ct-5", conversation_id: SESSION });
    const h = tables.task_history.find((r: any) => r.field === "superseded_by");
    expect([h.actor_type, h.conversation_id]).toEqual(["agent", "conv_1"]);
  });

  test("a dependent missing from the blocks mirror is found through the plan and moved", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { plan_id: "plan_1" }),
      task("ct-2", { plan_id: "plan_1", blocked_by: ["ct-1"] }),
      task("ct-5"),
    ]);
    const res = await call(supersede, ctx, { short_id: "ct-1", by: "ct-5" });
    expect(res.moved).toEqual(["ct-2"]);
    expect([row(tables, "ct-2").blocked_by, row(tables, "ct-5").blocks]).toEqual([["ct-5"], ["ct-2"]]);
  });

  test("a plan made from a template writes the blocks mirror, so superseding its blocker moves the dependent", async () => {
    const { ctx, tables } = await makeCtx([task("ct-5")]);
    tables.plan_templates = [{
      _id: "tpl_1", user_id: USER, name: "T", goal_template: "G",
      task_templates: [{ title: "First" }, { title: "Second", blocked_by_indices: [0] }],
    }];
    await call(createFromTemplate, ctx, { template_id: "tpl_1" });
    const [first, second] = tables.tasks.filter((t: any) => t.source === "template");
    expect(first.blocks).toEqual([second.short_id]);
    await call(supersede, ctx, { short_id: first.short_id, by: "ct-5" });
    expect(row(tables, second.short_id).blocked_by).toEqual(["ct-5"]);
  });

  test("reopening when the edge back would close a loop leaves that dependent on the replacement and says so", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-5"),
    ]);
    await call(supersede, ctx, { short_id: "ct-1", by: "ct-5" });
    row(tables, "ct-1").blocked_by = ["ct-2"];
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", status: "open" });
    expect([row(tables, "ct-1").status, row(tables, "ct-2").blocked_by]).toEqual(["open", ["ct-5"]]);
    expect(commentsOn(tables, "ct-2")[0]).toMatch(/^Still waits on ct-5: ct-1 was reopened, but waiting on ct-1 again was refused\. .*loop/);
  });

  test("a task already superseded by another is refused until reopened", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-5"),
      task("ct-6"),
    ]);
    await call(supersede, ctx, { short_id: "ct-1", by: "ct-5" });
    await expect(call(supersede, ctx, { short_id: "ct-1", by: "ct-6" })).rejects.toThrow(/already superseded by ct-5/);
    expect(row(tables, "ct-1").superseded_by).toBe("ct-5");
  });

  test("refuses itself, a done task, a parent with open subtasks, and a replacement that was itself superseded", async () => {
    const { ctx } = await makeCtx([
      task("ct-1"), task("ct-2", { status: "done" }), task("ct-3", { superseded_by: "ct-4" }), task("ct-4"),
      task("ct-6"), task("ct-7", { parent_id: "task_ct-6" }), task("ct-8", { status: "dropped" }),
    ]);
    await expect(call(supersede, ctx, { short_id: "ct-1", by: "ct-8" })).rejects.toThrow(/ct-8 is dropped/);
    await expect(call(supersede, ctx, { short_id: "ct-6", by: "ct-4" })).rejects.toThrow(/open subtasks \(ct-7\)/);
    await expect(call(supersede, ctx, { short_id: "ct-1", by: "ct-1" })).rejects.toThrow(/itself/);
    await expect(call(supersede, ctx, { short_id: "ct-2", by: "ct-4" })).rejects.toThrow(/done/);
    await expect(call(supersede, ctx, { short_id: "ct-1", by: "ct-3" })).rejects.toThrow(/superseded by ct-4/);
  });

  test("a replacement that is the old task's own subtask is named as such", async () => {
    const { ctx } = await makeCtx([task("ct-1"), task("ct-5", { parent_id: "task_ct-1" })]);
    await expect(call(supersede, ctx, { short_id: "ct-1", by: "ct-5" })).rejects.toThrow(/ct-5 is a subtask of ct-1, the task it would replace; move it to the top level first/);
  });
});

describe("duplicate (TG5)", () => {
  test("marking a duplicate moves its dependents to the canonical", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7"),
    ]);
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "ct-7" });
    expect(row(tables, "ct-1").duplicate_of).toBe("ct-7");
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-7"]);
    expect(row(tables, "ct-7").blocks).toEqual(["ct-2"]);
  });

  test("marked with a drop in one write, the moved dependents get no unblocked note", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7"),
    ]);
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "ct-7", status: "dropped" });
    expect(row(tables, "ct-1").status).toBe("dropped");
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-7"]);
    expect(commentsOn(tables, "ct-2")).toEqual([]);
  });

  test("a done canonical releases the moved dependents with a note", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7", { status: "done" }),
    ]);
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "ct-7", status: "dropped" });
    expect(commentsOn(tables, "ct-2")).toEqual(["Unblocked: ct-1 duplicate of ct-7"]);
  });

  test("a done duplicate keeps its released dependents where they are", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { status: "done", blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"], status: "in_progress" }),
      task("ct-7"),
    ]);
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "ct-7" });
    expect(row(tables, "ct-1").duplicate_of).toBe("ct-7");
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-1"]);
    expect(row(tables, "ct-7").blocks ?? []).toEqual([]);
  });

  test("undoing a mark (clear plus reopen in one write) puts the dependents back", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7"),
    ]);
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "ct-7", status: "dropped" });
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "", status: "open" });
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-1"]);
    expect(row(tables, "ct-1").blocks).toEqual(["ct-2"]);
    expect(row(tables, "ct-7").blocks).toEqual([]);
  });

  test("undone as two writes (reopen, then clear), a released dependent is blocked again and told", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7", { status: "done" }),
    ]);
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "ct-7" });
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", status: "dropped" });
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", status: "open" });
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "" });
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-1"]);
    expect(row(tables, "ct-7").blocks).toEqual([]);
    expect(commentsOn(tables, "ct-2")).toEqual([
      "Unblocked: ct-1 duplicate of ct-7",
      "Blocked again: ct-1 was reopened, so it waits on ct-1",
    ]);
  });

  test("a mark cleared on an open task takes the dependents back; on a closed one they stay", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-3", { blocks: ["ct-4"] }),
      task("ct-4", { blocked_by: ["ct-3"] }),
      task("ct-7"),
    ]);
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "ct-7" });
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "" });
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-1"]);
    await updateTaskAs(ctx, USER as any, { short_id: "ct-3", duplicate_of: "ct-7", status: "dropped" });
    await updateTaskAs(ctx, USER as any, { short_id: "ct-3", duplicate_of: "" });
    expect(row(tables, "ct-4").blocked_by).toEqual(["ct-7"]);
  });

  test("undoing one of two duplicates folded into one canonical keeps the other's edge", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-4"] }),
      task("ct-2", { blocks: ["ct-4"] }),
      task("ct-4", { blocked_by: ["ct-1", "ct-2"] }),
      task("ct-7"),
    ]);
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "ct-7", status: "dropped" });
    await updateTaskAs(ctx, USER as any, { short_id: "ct-2", duplicate_of: "ct-7", status: "dropped" });
    expect(row(tables, "ct-4").blocked_by).toEqual(["ct-7"]);
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "", status: "open" });
    expect(row(tables, "ct-4").blocked_by).toEqual(["ct-7", "ct-1"]);
    expect(row(tables, "ct-7").blocks).toEqual(["ct-4"]);
  });

  test("dropped again after a reopen, a duplicate moves its dependents to the canonical, not releases them", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7"),
    ]);
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "ct-7", status: "dropped" });
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", status: "open" });
    expect([row(tables, "ct-1").duplicate_of, row(tables, "ct-2").blocked_by]).toEqual(["ct-7", ["ct-1"]]);
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", status: "dropped" });
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-7"]);
    expect(row(tables, "ct-7").blocks).toEqual(["ct-2"]);
    expect(row(tables, "ct-1").blocks).toEqual([]);
    expect(commentsOn(tables, "ct-2").filter((c: string) => c.startsWith("Unblocked"))).toEqual([]);
  });

  test("a dependent added after the mark moves to the canonical when the duplicate is dropped", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1"), task("ct-3"), task("ct-7")]);
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "ct-7" });
    await addDepCore(ctx, USER as any, { short_id: "ct-3", blocked_by: "ct-1" });
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", status: "dropped" });
    expect(row(tables, "ct-3").blocked_by).toEqual(["ct-7"]);
    expect(row(tables, "ct-7").blocks).toEqual(["ct-3"]);
    expect(commentsOn(tables, "ct-3")).toEqual([]);
  });

  test("a duplicate dropped with its parent's cascade moves its dependents too", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1"),
      task("ct-2", { parent_id: "task_ct-1", duplicate_of: "ct-7", blocks: ["ct-3"] }),
      task("ct-3", { blocked_by: ["ct-2"] }),
      task("ct-7"),
    ]);
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", status: "dropped", subtask_resolution: "cascade" });
    expect(row(tables, "ct-2").status).toBe("dropped");
    expect(row(tables, "ct-3").blocked_by).toEqual(["ct-7"]);
  });

  test("a duplicate whose canonical was dropped since releases its dependents on its own drop", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { duplicate_of: "ct-7", blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7", { status: "dropped" }),
    ]);
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", status: "dropped" });
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-1"]);
    expect(commentsOn(tables, "ct-2")).toEqual(["Unblocked: ct-1 dropped"]);
  });

  test("a dropped or replaced canonical is refused and nothing moves", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7", { status: "dropped" }),
      task("ct-8", { superseded_by: "ct-9" }),
      task("ct-9"),
    ]);
    await expect(updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "ct-7", status: "dropped" })).rejects.toThrow(/ct-7 is dropped/);
    await expect(updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "ct-8" })).rejects.toThrow(/superseded by ct-9/);
    expect([row(tables, "ct-1").duplicate_of, row(tables, "ct-2").blocked_by]).toEqual([undefined, ["ct-1"]]);
  });

  test("a duplicate dropped by a line's move with a dependent that would loop completes and notes it", async () => {
    // ct-7 (the canonical) waits on ct-3, which waits on the duplicate ct-1.
    const { ctx, tables } = await makeCtx([
      task("ct-1", { duplicate_of: "ct-7", blocks: ["ct-3", "ct-4"] }),
      task("ct-3", { blocked_by: ["ct-1"], blocks: ["ct-7"] }),
      task("ct-4", { blocked_by: ["ct-1"] }),
      task("ct-7", { blocked_by: ["ct-3"] }),
    ]);
    await moveTaskStatus(ctx, row(tables, "ct-1"), "dropped", { actorUserId: USER as any });
    expect(row(tables, "ct-1").status).toBe("dropped");
    expect([row(tables, "ct-3").blocked_by, row(tables, "ct-4").blocked_by]).toEqual([["ct-1"], ["ct-7"]]);
    expect([row(tables, "ct-1").blocks, row(tables, "ct-7").blocks]).toEqual([["ct-3"], ["ct-4"]]);
    const notes = commentsOn(tables, "ct-3");
    expect(notes[0]).toMatch(/^Released from ct-1 rather than moved to ct-7 \(ct-1 duplicate of ct-7\): ct-7 already waits on ct-3 .*loop/);
    expect(notes[1]).toBe("Unblocked: ct-1 dropped");
  });

  test("a reopened canonical that still carries an old duplicate mark takes the dependents", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { duplicate_of: "ct-7", blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7", { duplicate_of: "ct-9" }),
      task("ct-9"),
    ]);
    await updateTaskAs(ctx, USER as any, { short_id: "ct-1", status: "dropped" });
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-7"]);
    expect(commentsOn(tables, "ct-2")).toEqual([]);
  });

  test("a canonical in another workspace is refused and nothing moves", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-9", { user_id: OTHER, team_id: "team_x", workspace: "team:team_x" }),
    ]);
    tables.team_memberships = [{ _id: "m1", user_id: USER, team_id: "team_x", role: "member" }];
    await expect(updateTaskAs(ctx, USER as any, { short_id: "ct-1", duplicate_of: "ct-9", status: "dropped" })).rejects.toThrow(/another workspace/);
    expect([row(tables, "ct-1").status, row(tables, "ct-1").duplicate_of, row(tables, "ct-2").blocked_by]).toEqual(["open", undefined, ["ct-1"]]);
  });
});

describe("status moves outside tasks.ts (TG5)", () => {
  const external = { provider: "linear", id: "issue_1", identifier: "LIN-1", url: "", synced_at: 1, remote_updated_at: 1 };
  const sync = async (ctx: any, state?: { type: string; name: string }) => {
    ctx.db.normalizeId ??= (_t: string, id: string) => id;
    const issue = normalizeLinearIssue({ id: "issue_1", identifier: "LIN-1", title: "Title ct-1", ...(state ? { state } : { trashed: true }) });
    await (applyRemote as any)._handler(ctx, { issue });
  };

  test("a duplicate dropped by an issue sync moves its dependents to the canonical, as the system", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { duplicate_of: "ct-7", blocks: ["ct-2"], external }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7"),
    ]);
    await sync(ctx);
    expect(row(tables, "ct-1").status).toBe("dropped");
    expect([row(tables, "ct-2").blocked_by, row(tables, "ct-7").blocks]).toEqual([["ct-7"], ["ct-2"]]);
    expect(commentsOn(tables, "ct-2")).toEqual([]);
    expect(tables.task_history.find((h: any) => h.task_id === "task_ct-2" && h.field === "blocked_by")).toMatchObject({ actor_type: "system" });
  });

  test("a superseded task reopened by an issue sync takes its dependents back", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"], external }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-5"),
    ]);
    await call(supersede, ctx, { short_id: "ct-1", by: "ct-5" });
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-5"]);
    await sync(ctx, { type: "unstarted", name: "Todo" });
    expect([row(tables, "ct-1").status, row(tables, "ct-1").superseded_by]).toEqual(["open", undefined]);
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-1"]);
  });

  test("a duplicate dropped by an org plan close moves its dependents to the canonical", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { plan_id: "plan_1", duplicate_of: "ct-7", blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7"),
    ]);
    tables.plans = [{ _id: "plan_1", short_id: "pl-1", user_id: USER, title: "P", status: "active", task_ids: ["task_ct-1"], created_at: 1, updated_at: 1 }];
    await applyPlanStatus(ctx, USER as any, { scope_user_id: USER } as any, { plan: "pl-1", status: "abandoned" } as any, {} as any);
    expect(row(tables, "ct-1").status).toBe("dropped");
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-7"]);
    expect(commentsOn(tables, "ct-2")).toEqual([]);
  });

  test("a drop whose canonical has too much upstream to check still completes and releases the dependent", async () => {
    // 2001 open blockers, one of them waiting further back: the walk stops at its cap.
    const upstream = Array.from({ length: 2001 }, (_, i) => task(`ct-${1000 + i}`, i ? {} : { blocked_by: ["ct-999"] }));
    const { ctx, tables } = await makeCtx([
      task("ct-1", { duplicate_of: "ct-7", blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7", { blocked_by: upstream.map((t) => t.short_id) }),
      task("ct-999"),
      ...upstream,
    ]);
    await moveTaskStatus(ctx, row(tables, "ct-1"), "dropped", { actorUserId: USER as any });
    expect(row(tables, "ct-1").status).toBe("dropped");
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-1"]);
    const notes = commentsOn(tables, "ct-2");
    expect(notes[0]).toMatch(/^Released from ct-1 rather than moved to ct-7 .*: Cannot check ct-7's dependencies/);
    expect(notes[1]).toBe("Unblocked: ct-1 dropped");
  });
});

// A loop can be STORED while one of its tasks is closed: the loop check walks
// open tasks only, because a closed one holds nothing back. The reopen is the
// moment it would hold both ends for good, so it is re-checked there (TG4).
describe("a loop stored through a closed task (TG4)", () => {
  test("an edge accepted onto a done blocker is cut when that blocker reopens, and the newer edge stays", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { status: "done", blocked_by: ["ct-2"], closed_at: 2 }),
      task("ct-2", { blocks: ["ct-1"] }),
    ]);
    // Accepted: ct-1 is done, so nothing waits behind it and no loop is live.
    await addDepCore(ctx, USER as any, { short_id: "ct-2", blocked_by: "ct-1" });
    expect([row(tables, "ct-1").blocked_by, row(tables, "ct-2").blocked_by]).toEqual([["ct-2"], ["ct-1"]]);

    await moveTaskStatus(ctx, row(tables, "ct-1"), "open", { actorUserId: USER as any });
    expect(row(tables, "ct-1").blocked_by).toEqual([]);
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-1"]);
    expect(row(tables, "ct-2").blocks).toEqual([]);
    expect(commentsOn(tables, "ct-1")[0]).toMatch(/^No longer waits on ct-2: ct-1 is open again, and the edge closes a loop\./);
    expect(historyOf(tables, "ct-1", "blocked_by")).toEqual([["ct-2", ""]]);
  });

  test("a dependent moved onto a done replacement is left waiting on it; the replacement's own edge gives way", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-A", { blocked_by: ["ct-B"] }),
      task("ct-B", { blocks: ["ct-A"] }),
      task("ct-C", { status: "done", blocked_by: ["ct-A"], closed_at: 2 }),
    ]);
    await call(supersede, ctx, { short_id: "ct-B", by: "ct-C" });
    expect(row(tables, "ct-A").blocked_by).toEqual(["ct-C"]);

    await moveTaskStatus(ctx, row(tables, "ct-C"), "open", { actorUserId: USER as any });
    expect(row(tables, "ct-C").blocked_by).toEqual([]);
    expect(row(tables, "ct-A").blocked_by).toEqual(["ct-C"]);
    expect(commentsOn(tables, "ct-C").some((t: string) => t.startsWith("No longer waits on ct-A:"))).toBe(true);
  });

  test("a blocker edge that closes no loop survives a reopen", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { status: "done", blocked_by: ["ct-2"], closed_at: 2 }),
      task("ct-2", { blocks: ["ct-1"] }),
    ]);
    await moveTaskStatus(ctx, row(tables, "ct-1"), "open", { actorUserId: USER as any });
    expect(row(tables, "ct-1").blocked_by).toEqual(["ct-2"]);
    expect(commentsOn(tables, "ct-1")).toEqual([]);
  });
});

describe("deleting a task outright (the support path)", () => {
  test("every edge naming the row goes, and the dependent it held is released", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { blocks: ["ct-2"], blocked_by: ["ct-3"], related: ["ct-4"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-3", { blocks: ["ct-1"] }),
      task("ct-4", { related: ["ct-1"] }),
      task("ct-5", { found_during: "ct-1" }),
    ]);
    await (adminDeleteTask as any)._handler(ctx, { short_id: "ct-1" });
    expect(tables.tasks.find((t: any) => t.short_id === "ct-1")).toBeUndefined();
    expect(row(tables, "ct-2").blocked_by).toEqual([]);
    expect(row(tables, "ct-3").blocks).toEqual([]);
    expect(row(tables, "ct-4").related).toEqual([]);
    expect(row(tables, "ct-5").found_during).toBeUndefined();
    // Told, as a removed blocker tells it: a silent release leaves a parked
    // session asleep on a blocker that no longer exists.
    expect(commentsOn(tables, "ct-2")).toEqual(["No longer waits on ct-1: ct-1 was deleted.", "Unblocked: the blocker ct-1 was removed"]);
  });
});

describe("related (TG5)", () => {
  test("relate and unrelate write both rows and their history", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1"), task("ct-2")]);
    await call(relate, ctx, { short_id: "ct-1", other: "ct-2" });
    await call(relate, ctx, { short_id: "ct-2", other: "ct-1" });
    expect([row(tables, "ct-1").related, row(tables, "ct-2").related]).toEqual([["ct-2"], ["ct-1"]]);
    expect(historyOf(tables, "ct-1", "related")).toEqual([["", "ct-2"]]);
    await call(unrelate, ctx, { short_id: "ct-2", other: "ct-1" });
    expect([row(tables, "ct-1").related, row(tables, "ct-2").related]).toEqual([[], []]);
  });

  test("unrelate removes a link whose far side is gone; relate refuses self and missing", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1", { related: ["ct-404"] })]);
    await call(unrelate, ctx, { short_id: "ct-1", other: "ct-404" });
    expect(row(tables, "ct-1").related).toEqual([]);
    await expect(call(relate, ctx, { short_id: "ct-1", other: "ct-1" })).rejects.toThrow(/itself/);
    await expect(call(relate, ctx, { short_id: "ct-1", other: "ct-404" })).rejects.toThrow(/not found/i);
    await expect(call(unrelate, ctx, { short_id: "ct-1", other: "task_ct-404" })).rejects.toThrow(/ct-1 is not related to task_ct-404/);
  });

  test("unrelate clears the far row's mirror after it moved to a workspace the caller cannot read", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-1", { related: ["ct-2"] }),
      task("ct-2", { related: ["ct-1"], user_id: OTHER, workspace: `user:${OTHER}` }),
    ]);
    await call(unrelate, ctx, { short_id: "ct-1", other: "ct-2" });
    expect([row(tables, "ct-1").related, row(tables, "ct-2").related]).toEqual([[], []]);
  });

  test("relate refuses a row already holding the cap", async () => {
    const full = Array.from({ length: 50 }, (_, i) => `ct-${200 + i}`);
    const { ctx, tables } = await makeCtx([task("ct-1", { related: full }), task("ct-2")]);
    await expect(call(relate, ctx, { short_id: "ct-2", other: "ct-1" })).rejects.toThrow(/ct-1 already has 50 related tasks/);
    expect(row(tables, "ct-2").related).toBeUndefined();
  });
});

describe("web side effects (dispatch)", () => {
  const run = (ctx: any, action: string, args: unknown[]) => (dispatch as any)._handler(ctx, { action, args });

  // The allowlist is what reaches webUpdate, so a field left out of it is a
  // write that silently does nothing — which is what found_during was.
  test("updateTask carries found_during from the store's draft to the server", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1"), task("ct-5")]);
    // The fake ctx stubs runMutation away, and what is under test is the
    // ALLOWLIST the side effect passes on, so webUpdate's handler is wired
    // back here for this one call.
    ctx.runMutation = (_ref: unknown, args: any) => updateTaskAs(ctx, USER as any, args);
    await run(ctx, "updateTask", ["ct-1", { found_during: "ct-5" }]);
    expect(row(tables, "ct-1").found_during).toBe("ct-5");
    await run(ctx, "updateTask", ["ct-1", { found_during: "" }]);
    expect(row(tables, "ct-1").found_during).toBeUndefined();
  });

  test("relateTasks and unrelateTasks take the tuples the store sends", async () => {
    const { ctx, tables } = await makeCtx([task("ct-5"), task("ct-6")]);
    await run(ctx, "relateTasks", ["ct-5", "ct-6"]);
    expect([row(tables, "ct-5").related, row(tables, "ct-6").related]).toEqual([["ct-6"], ["ct-5"]]);
    await run(ctx, "unrelateTasks", ["ct-6", "ct-5"]);
    expect([row(tables, "ct-5").related, row(tables, "ct-6").related]).toEqual([[], []]);
    expect(tables.task_history.filter((h: any) => h.field === "related").map((h: any) => h.actor_type)).toEqual(["user", "user", "user", "user"]);
  });

  // The durable outbox replays an entry whose ack never arrived (a tab closed
  // mid-flight). A removal that COMMITTED must not fail on the replay: the
  // attempt would count against the give-up cap, the draft would roll back so
  // the removed line reappeared, and the person would be shown "no such
  // dependency" for a write that succeeded. The adds are idempotent already.
  test("every removal is idempotent, so a replayed entry does not fail", async () => {
    const { ctx, tables } = await makeCtx([
      task("ct-5", { related: ["ct-6"], blocked_by: ["ct-6"] }),
      task("ct-6", { related: ["ct-5"], blocks: ["ct-5"], blocked_by: ["ct-7"] }),
      task("ct-7", { blocks: ["ct-6"] }),
    ]);
    const replay = async (action: string, args: unknown[]) => {
      await run(ctx, action, args);
      await run(ctx, action, args);
    };
    await replay("unrelateTasks", ["ct-5", "ct-6"]);
    await replay("removeBlocker", ["ct-5", "ct-6"]);
    await replay("removeBlocks", ["ct-7", "ct-6"]);

    expect([row(tables, "ct-5").related, row(tables, "ct-6").related]).toEqual([[], []]);
    expect([row(tables, "ct-5").blocked_by, row(tables, "ct-6").blocks]).toEqual([[], []]);
    expect([row(tables, "ct-7").blocks, row(tables, "ct-6").blocked_by]).toEqual([[], []]);
    // One write each, not one per replay.
    expect(tables.task_history.filter((h: any) => h.field === "related")).toHaveLength(2);
    expect(tables.task_history.filter((h: any) => h.field === "blocked_by")).toHaveLength(2);
  });
});

describe("edges across workspaces", () => {
  // A conversation went private, so ct-1 (its task) left the team: readiness
  // cannot read across, so the edges to it are cut and the dependent told.
  test("a task that changed workspace loses its edges into the old one, and a dependent it held is released", async () => {
    const team = { team_id: "team_t", workspace: "team:team_t" };
    const { ctx, tables } = await makeCtx([
      task("ct-1", { workspace: `user:${USER}`, blocks: ["ct-2"], blocked_by: ["ct-3"] }),
      task("ct-2", { ...team, blocked_by: ["ct-1"] }),
      task("ct-3", { ...team, blocks: ["ct-1"] }),
    ]);
    await (cutCrossedEdges as any)._handler(ctx, { task_ids: ["task_ct-1"] });
    expect(row(tables, "ct-2").blocked_by).toEqual([]);
    expect(row(tables, "ct-1").blocks).toEqual([]);
    expect(row(tables, "ct-1").blocked_by).toEqual([]);
    expect(row(tables, "ct-3").blocks).toEqual([]);
    expect(historyOf(tables, "ct-2", "blocked_by")).toEqual([["ct-1", ""]]);
    expect(commentsOn(tables, "ct-2")).toEqual([
      "No longer waits on ct-1: the two tasks are in different workspaces now, so this one could never see it finish.",
      "Unblocked: the blocker ct-1 was removed",
    ]);
  });

  // Readiness reads a parent only in the child's workspace, so a subtask
  // left under a parent elsewhere would never be ready.
  test("a parent link that now crosses workspaces is cut both ways, and the subtask returns to the top level", async () => {
    const team = { team_id: "team_t", workspace: "team:team_t" };
    const { ctx, tables } = await makeCtx([
      task("ct-1", { workspace: `user:${USER}`, parent_id: "task_ct-5" }),
      task("ct-5", team),
      task("ct-6", { ...team, parent_id: "task_ct-1" }),
      task("ct-7", { workspace: `user:${USER}`, parent_id: "task_ct-1" }),
    ]);
    await (cutCrossedEdges as any)._handler(ctx, { task_ids: ["task_ct-1"] });
    expect(row(tables, "ct-1").parent_id).toBeUndefined();
    expect(row(tables, "ct-6").parent_id).toBeUndefined();
    expect(row(tables, "ct-7").parent_id).toBe("task_ct-1");
    expect(historyOf(tables, "ct-1", "parent")).toEqual([["task_ct-5", ""]]);
    expect(commentsOn(tables, "ct-6")).toEqual([
      "No longer a subtask of ct-1: the two tasks are in different workspaces now, so this one could never be ready under it.",
    ]);
  });

  // Private work routed to a team: its parent must share its access key, not
  // the team it is routed to, or the subtask could never be ready.
  test("a reparent checks the parent against the child's access key, never its routing team", async () => {
    const routed = { team_id: "team_t", workspace: `user:${USER}` };
    const { ctx, tables } = await makeCtx([
      task("ct-1", routed),
      task("ct-2", routed),
      task("ct-5", { team_id: "team_t", workspace: "team:team_t" }),
      task("ct-6", routed),
    ]);
    tables.team_memberships = [{ _id: "m1", user_id: USER, team_id: "team_t" }];
    await expect(call(update, ctx, { short_id: "ct-1", parent: "ct-5" })).rejects.toThrow(/another workspace/);
    await expect(updateTaskAs(ctx, USER as any, { short_id: "ct-2", parent: "ct-5" })).rejects.toThrow(/another workspace/);
    await call(update, ctx, { short_id: "ct-1", parent: "ct-6" });
    await updateTaskAs(ctx, USER as any, { short_id: "ct-2", parent: "ct-6" });
    expect([row(tables, "ct-1").parent_id, row(tables, "ct-2").parent_id]).toEqual(["task_ct-6", "task_ct-6"]);
  });

  test("edges inside one workspace are left alone", async () => {
    const { ctx, tables } = await makeCtx([task("ct-1", { blocks: ["ct-2"] }), task("ct-2", { blocked_by: ["ct-1"] })]);
    await (cutCrossedEdges as any)._handler(ctx, { task_ids: ["task_ct-1"] });
    expect(row(tables, "ct-2").blocked_by).toEqual(["ct-1"]);
    expect(tables.task_history).toEqual([]);
  });
});
