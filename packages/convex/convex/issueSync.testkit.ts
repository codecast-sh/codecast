import { makeFakeDb } from "./testDb";
import { normalizeLinearIssue } from "./lib/issueMapping";
import { applyRemote } from "./issueSync";

export const LINEAR_ISSUE_CREATE = {
  action: "create",
  type: "Issue",
  webhookId: "wh_01",
  webhookTimestamp: 1_760_000_000_000,
  actor: { id: "user_1", name: "Ada Lovelace" },
  data: {
    id: "issue_uuid_1",
    identifier: "LIN-482",
    number: 482,
    url: "https://linear.app/acme/issue/LIN-482/fix-the-sync",
    title: "Fix the sync",
    description: "It drops events under load.",
    priority: 2,
    state: { id: "s_todo", name: "Todo", type: "unstarted" },
    team: { id: "team_abc", key: "LIN" },
    project: { id: "project_xyz" },
    labels: [{ id: "l1", name: "bug" }],
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
  },
};

/** A ctx with a fake db and a scheduler that records instead of running. */
export function engineCtx(tables: Record<string, any[]>) {
  const db: any = makeFakeDb(tables);
  if (!db.normalizeId) db.normalizeId = () => null;
  const scheduled: Array<{ fn: any; args: any }> = [];
  return {
    ctx: { db, scheduler: { runAfter: async (_ms: number, fn: any, args: any) => { scheduled.push({ fn, args }); } } },
    db,
    scheduled,
    tables,
  };
}

export const SOURCE = {
  _id: "src_1",
  provider: "linear",
  kind: "linear_team",
  external_id: "team_abc",
  project_id: "proj_1",
  user_id: "user_owner",
  team_id: "team_cc",
  workspace: "team:team_cc",
  status: "active",
  auto_spawn: false,
  push_new_tasks: false,
};

export const TASK = {
  _id: "task_1",
  short_id: "ct-1",
  title: "Fix the sync",
  description: "It drops events under load.",
  status: "open",
  priority: "high",
  assignee: "user_ada",
  labels: ["bug"],
  team_id: "team_cc",
  project_id: "proj_1",
  user_id: "user_owner",
  conversation_ids: [],
  external: {
    provider: "linear",
    id: "issue_uuid_1",
    identifier: "LIN-482",
    url: "https://linear.app/acme/issue/LIN-482/fix-the-sync",
    number: 482,
    team_id: "team_abc",
    team_key: "LIN",
    project_id: "project_xyz",
    source_id: "src_1",
    remote_updated_at: 1_000,
    synced_at: 1_000,
    assignee_label: "Ada Lovelace",
    state_name: "Todo",
  },
};

export const ADA = { _id: "user_ada", email: "ada@acme.dev", name: "Ada Lovelace" };

export const sameIssue = (over: Record<string, any> = {}) => normalizeLinearIssue({
  ...LINEAR_ISSUE_CREATE.data,
  state: { id: "s_todo", name: "Todo", type: "unstarted" },
  assignee: { id: "u1", name: "Ada Lovelace", email: "ada@acme.dev" },
  updatedAt: "2026-09-01T11:00:00.000Z",
  ...over,
});

export const apply = (ctx: any, args: Record<string, any>) => (applyRemote as any)._handler(ctx, args);
