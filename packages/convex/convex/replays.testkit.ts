// The fake world the replay tests share: a team, its member, and the tables a
// replay touches, on the fake db with the schema's indexes.
import { getFunctionName } from "convex/server";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { createSource } from "./ingest";

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
      replays: [],
      replay_timelines: [],
    },
    { indexes: schemaIndexes(schema as any) },
  );
  const scheduler = { runAfter: async (_ms: number, fn: any, args: any) => void scheduled.push({ name: getFunctionName(fn), args }) };
  const as = (userId: string) => ({ auth: { getUserIdentity: async () => ({ subject: `${userId}|sess` }) }, db, scheduler }) as any;
  return { db: db as any, scheduled, as, internalCtx: { db, scheduler } as any };
}

export async function teamSource(w: ReturnType<typeof world>) {
  const out = await h(createSource)(w.as("u1"), { workspace: "team", team_id: "team_1", name: "shop", provider: "sdk" });
  return { source: w.db._tables.event_sources[0], key: out.ingest_key as string };
}

