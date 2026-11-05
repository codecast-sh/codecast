// Fixtures the ingest test files share: a fake world, a team source, a batch.
import schema from "./schema";
import { getFunctionName } from "convex/server";
import { armedTriggerRows, makeFakeDb, schemaIndexes } from "./testDb";
import { applyBatch, createSource } from "./ingest";

export const h = (fn: any) => fn._handler;

export function world() {
  const scheduled: Array<{ name: string; args: any }> = [];
  const db = makeFakeDb(
    {
      users: [{ _id: "u1", active_team_id: "team_1" }, { _id: "u2" }],
      teams: [{ _id: "team_1", name: "Acme" }],
      team_memberships: [{ _id: "m1", user_id: "u1", team_id: "team_1" }],
      counters: [],
      projects: [],
      event_sources: [],
      event_groups: [],
      event_samples: [],
      external_events: [],
      agent_tasks: [],
      conversations: [],
    },
    { indexes: schemaIndexes(schema as any) },
  );
  const scheduler = { runAfter: async (_ms: number, fn: any, args: any) => void scheduled.push({ name: getFunctionName(fn), args }) };
  const as = (userId: string) => ({ auth: { getUserIdentity: async () => ({ subject: `${userId}|sess` }) }, db, scheduler }) as any;
  return { db: db as any, scheduled, as, internalCtx: { db, scheduler } as any };
}

/** A world with a trigger armed on every name an ingest transition fires. */
export async function armedWorld() {
  const w = world();
  for (const row of armedTriggerRows("error_new", "error_regressed", "error_spike", "check_failed", "check_recovered", "job_failed", "metric_alert", "metric_recovered", "deploy")) {
    await w.db.insert("agent_tasks", row);
  }
  return w;
}

export const TEAM = { workspace: "team" as const, team_id: "team_1" as any };

export async function teamSource(w: ReturnType<typeof world>, extra: Record<string, unknown> = {}) {
  const out = await h(createSource)(w.as("u1"), { ...TEAM, name: " Union ", provider: "sdk", ...extra });
  return out as { source: any; ingest_key: string };
}

export const NOW = Date.now();
export const err = (message: string, over: Record<string, unknown> = {}) => ({ type: "error", message, at: NOW, ...over });
export const batch = (w: ReturnType<typeof world>, sourceId: string, items: unknown[], extra: Record<string, unknown> = {}) =>
  h(applyBatch)(w.internalCtx, { source_id: sourceId, items_json: JSON.stringify(items), ...extra });
export const names = (w: ReturnType<typeof world>) => w.scheduled.map((s) => s.name);
/** A group as a detail reader sees it: the row with its tally (occurrences held off the row) laid over. */
export const live = (w: ReturnType<typeof world>, i = 0) => {
  const g = w.db._tables.event_groups[i];
  const t = (w.db._tables.event_group_tallies ?? []).find((x: any) => x.group_id === g._id);
  if (!t) return g;
  return { ...g, ...Object.fromEntries(Object.entries(JSON.parse(t.fields_json)).map(([k, value]) => [k, value ?? undefined])) };
};
/** A source's counters, which live on event_source_stats. */
export const stats = (w: ReturnType<typeof world>, i = 0) => (w.db._tables.event_source_stats ?? []).find((x: any) => x.source_id === w.db._tables.event_sources[i]._id) ?? {};

