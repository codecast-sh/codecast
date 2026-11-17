import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { onGithubIssue, onGithubIssueComment, onLinearEvent } from "./issueSync";
import { ADA, LINEAR_ISSUE_CREATE, SOURCE, TASK, apply, engineCtx, sameIssue } from "./issueSync.testkit";

const withLabel = (name: string) => sameIssue({ labels: [{ id: "l_agent", name }] });
const spawnsOf = (scheduled: Array<{ fn: any; args: any }>) =>
  scheduled.filter((s) => getFunctionName(s.fn) === "tasks:spawnSessionForTaskInternal").map((s) => s.args);

async function delegate(source: Record<string, any>, issue: any, task: Record<string, any> = {}, installs: any[] = []) {
  const w = engineCtx({
    tasks: [{ ...structuredClone(TASK), ...task }],
    issue_sync_sources: [{ ...SOURCE, ...source }],
    users: [ADA], task_history: [], task_comments: [],
    app_installations: installs,
  });
  await apply(w.ctx, { source_id: "src_1", issue });
  return spawnsOf(w.scheduled);
}

describe("maybeDelegate", () => {
  test("the delegate label starts a session for the task", async () => {
    const spawns = await delegate({ auto_spawn: true }, withLabel("agent"));
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({ task_id: "task_1", user_id: "user_owner" });
    expect(spawns[0].initial_message).toContain("LIN-482");
  });

  test("a custom delegate label is matched case-insensitively and the default no longer is", async () => {
    expect(await delegate({ auto_spawn: true, delegate_label: "Robot" }, withLabel("robot"))).toHaveLength(1);
    expect(await delegate({ auto_spawn: true, delegate_label: "Robot" }, withLabel("agent"))).toHaveLength(0);
  });

  test("the delegate assignee starts a session", async () => {
    const spawns = await delegate({ auto_spawn: true, delegate_assignee: "ada@acme.dev" }, sameIssue());
    expect(spawns).toHaveLength(1);
  });

  test("the delegate assignee also matches the provider user id", async () => {
    expect(await delegate({ auto_spawn: true, delegate_assignee: "u1" }, sameIssue())).toHaveLength(1);
    expect(await delegate({ auto_spawn: true, delegate_assignee: "Ada Lovelace" }, sameIssue())).toHaveLength(1);
  });

  describe("delegation to the Codecast app", () => {
    const teamConn = (over: Record<string, any> = {}) =>
      ({ _id: "inst_team", provider: "linear", team_id: "team_cc", app_user_id: "app_1", ...over });
    const personalConn = (over: Record<string, any> = {}) =>
      ({ _id: "inst_user", provider: "linear", scope_user_id: "user_owner", app_user_id: "app_2", ...over });
    const delegatedTo = (id: string | undefined) => sameIssue({ delegate: id ? { id, name: "Codecast" } : null });

    test("a delegate equal to the team connection's app user starts a session", async () => {
      expect(await delegate({ auto_spawn: true }, delegatedTo("app_1"), {}, [teamConn()])).toHaveLength(1);
    });

    test("with no team connection the personal connection's app user matches", async () => {
      expect(await delegate({ auto_spawn: true }, delegatedTo("app_2"), {}, [personalConn()])).toHaveLength(1);
    });

    test("a different delegate starts nothing", async () => {
      expect(await delegate({ auto_spawn: true }, delegatedTo("someone_else"), {}, [teamConn()])).toHaveLength(0);
    });

    test("with both connections present the team connection's app user decides", async () => {
      const both = [teamConn(), personalConn()];
      expect(await delegate({ auto_spawn: true }, delegatedTo("app_2"), {}, both)).toHaveLength(0);
      expect(await delegate({ auto_spawn: true }, delegatedTo("app_1"), {}, both)).toHaveLength(1);
    });

    test("no delegate and no app user on the connection starts nothing", async () => {
      expect(await delegate({ auto_spawn: true }, delegatedTo(undefined), {}, [teamConn({ app_user_id: undefined })])).toHaveLength(0);
    });

    test("a delegate with auto_spawn off starts nothing", async () => {
      expect(await delegate({ auto_spawn: false }, delegatedTo("app_1"), {}, [teamConn()])).toHaveLength(0);
    });

    test("a pending connection is no connection", async () => {
      expect(await delegate({ auto_spawn: true }, delegatedTo("app_1"), {}, [teamConn({ pending_confirm_hash: "h" })])).toHaveLength(0);
    });
  });

  test("an issue with neither the label nor the assignee starts nothing", async () => {
    expect(await delegate({ auto_spawn: true, delegate_assignee: "bob@acme.dev" }, sameIssue())).toHaveLength(0);
  });

  test("auto_spawn off starts nothing", async () => {
    expect(await delegate({ auto_spawn: false }, withLabel("agent"))).toHaveLength(0);
  });

  test("a task that already has a session starts nothing", async () => {
    expect(await delegate({ auto_spawn: true }, withLabel("agent"), { conversation_ids: ["conv_1"] })).toHaveLength(0);
  });

  test("isolation is on unless the source turns it off", async () => {
    expect((await delegate({ auto_spawn: true }, withLabel("agent")))[0].isolated).toBe(true);
    expect((await delegate({ auto_spawn: true, spawn_isolated: true }, withLabel("agent")))[0].isolated).toBe(true);
    expect((await delegate({ auto_spawn: true, spawn_isolated: false }, withLabel("agent")))[0].isolated).toBe(false);
  });

  test("the source's device and definition ride the spawn, and are absent when unset", async () => {
    const set = (await delegate({ auto_spawn: true, spawn_device: "dev_linux", spawn_definition: "reviewer" }, withLabel("agent")))[0];
    expect(set).toMatchObject({ target_device_id: "dev_linux", definition: "reviewer" });
    const unset = (await delegate({ auto_spawn: true }, withLabel("agent")))[0];
    expect(unset.target_device_id).toBeUndefined();
    expect(unset.definition).toBeUndefined();
  });
});

describe("a paused source on the inbound webhook path", () => {
  const REPO = "acme/widgets";
  const ghSource = (over: Record<string, any> = {}) => ({
    _id: "src_gh", provider: "github", kind: "github_repo", external_id: REPO, project_id: "proj_1",
    user_id: "user_owner", team_id: "team_cc", workspace: "team:team_cc", status: "active",
    auto_spawn: true, push_new_tasks: false, ...over,
  });
  const ghDelivery = (extra: Record<string, any> = {}) => ({
    action: "labeled",
    installation: { id: 7 },
    repository: { full_name: REPO },
    sender: { login: "ada", type: "User" },
    issue: {
      id: 1, node_id: "I_1", number: 12, title: "Add widgets", body: "please", state: "open",
      html_url: `https://github.com/${REPO}/issues/12`, labels: [{ name: "agent" }],
      updated_at: "2026-09-01T10:00:00Z", created_at: "2026-09-01T10:00:00Z",
    },
    ...extra,
  });
  const world = (source: Record<string, any>, payload: any, eventTable = "github_webhook_events") => {
    const w = engineCtx({
      issue_sync_sources: [source],
      github_app_installations: [{ _id: "inst_1", team_id: "team_cc", installation_id: 7, account_login: "acme", account_type: "Organization", repository_selection: "all" }],
      [eventTable]: [{ _id: "evt_1", payload: JSON.stringify(payload), event_type: eventTable === "github_webhook_events" ? "issues" : "Issue", action: payload.action, processed: false }],
      projects: [{ _id: "proj_1", short_id: "p-1", user_id: "user_owner", team_id: "team_cc", workspace: "team:team_cc" }],
      users: [{ _id: "user_owner", active_team_id: "team_cc" }],
      tasks: [], task_history: [], task_comments: [], counters: [],
    });
    return w;
  };

  test("a paused source files no task and starts no session", async () => {
    const w = world(ghSource({ status: "paused" }), ghDelivery());
    expect(await (onGithubIssue as any)._handler(w.ctx, { event_id: "evt_1" })).toEqual({ skipped: "source_paused" });
    expect(w.tables.tasks).toEqual([]);
    expect(spawnsOf(w.scheduled)).toEqual([]);
    expect(w.tables.issue_sync_sources[0].last_webhook_at).toBeUndefined();
  });

  test("the same delivery on an active source files the task and starts a session", async () => {
    const w = world(ghSource(), ghDelivery());
    expect(await (onGithubIssue as any)._handler(w.ctx, { event_id: "evt_1" })).toEqual({ applied: true });
    expect(w.tables.tasks).toHaveLength(1);
    expect(spawnsOf(w.scheduled)).toHaveLength(1);
  });

  test("a source in error keeps flowing", async () => {
    const w = world(ghSource({ status: "error" }), ghDelivery());
    expect(await (onGithubIssue as any)._handler(w.ctx, { event_id: "evt_1" })).toEqual({ applied: true });
  });

  test("a comment on a paused source's issue is skipped", async () => {
    const w = world(ghSource({ status: "paused" }), ghDelivery({ action: "created", comment: { id: 5, body: "hi", user: { login: "ada" }, html_url: "https://github.com/x", created_at: "2026-09-01T10:00:00Z", updated_at: "2026-09-01T10:00:00Z" } }));
    expect(await (onGithubIssueComment as any)._handler(w.ctx, { event_id: "evt_1" })).toEqual({ skipped: "source_paused" });
    expect(w.tables.tasks).toEqual([]);
  });

  test("a Linear event on a paused source is marked processed and applies nothing", async () => {
    const linearSource = { ...SOURCE, status: "paused", auto_spawn: true };
    const w = engineCtx({
      issue_sync_sources: [linearSource],
      linear_webhook_events: [{ _id: "evt_1", payload: JSON.stringify(LINEAR_ISSUE_CREATE), event_type: "Issue", action: "create", processed: false }],
      tasks: [], task_history: [], task_comments: [],
    });
    expect(await (onLinearEvent as any)._handler(w.ctx, { event_id: "evt_1" })).toEqual({ skipped: "source_paused" });
    expect(w.tables.linear_webhook_events[0].processed).toBe(true);
    expect(w.tables.tasks).toEqual([]);
    expect(spawnsOf(w.scheduled)).toEqual([]);
  });

  test("a Linear update delegating the issue to the app starts one session", async () => {
    const payload = {
      ...LINEAR_ISSUE_CREATE,
      action: "update",
      organizationId: "org_1",
      data: { ...LINEAR_ISSUE_CREATE.data, delegateId: "app_1" },
      updatedFrom: { delegateId: null },
    };
    const w = engineCtx({
      issue_sync_sources: [{ ...SOURCE, auto_spawn: true }],
      linear_webhook_events: [{ _id: "evt_1", payload: JSON.stringify(payload), event_type: "Issue", action: "update", processed: false }],
      app_installations: [{ _id: "inst_team", provider: "linear", team_id: "team_cc", account_id: "org_1", app_user_id: "app_1" }],
      projects: [{ _id: "proj_1", short_id: "p-1", user_id: "user_owner", team_id: "team_cc", workspace: "team:team_cc" }],
      users: [{ _id: "user_owner", active_team_id: "team_cc" }],
      tasks: [], task_history: [], task_comments: [], counters: [],
    });
    expect(await (onLinearEvent as any)._handler(w.ctx, { event_id: "evt_1" })).toEqual({ skipped: "applied" });
    expect(w.tables.tasks).toHaveLength(1);
    expect(spawnsOf(w.scheduled)).toHaveLength(1);
  });
});
