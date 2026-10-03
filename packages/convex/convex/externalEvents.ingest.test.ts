import { describe, expect, test } from "bun:test";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { listForRepository, listForTeam, recordExternalEvent } from "./externalEvents";

// Ingestion rows (external-data.md X3) carry a workspace key and a source,
// and may come from a personal workspace with no team. Reads judge them by the
// stored key, and the team feed never shows them.

function context(userId = "u1") {
  return {
    auth: { getUserIdentity: async () => ({ subject: `${userId}|sess` }) },
    db: makeFakeDb(
      {
        users: [{ _id: "u1", active_team_id: "team_1" }, { _id: "u2" }],
        team_memberships: [{ _id: "m1", user_id: "u1", team_id: "team_1" }],
        external_events: [],
      },
      { indexes: schemaIndexes(schema as any) },
    ),
  } as any;
}

const git = { team_id: "team_1" as any, source: "github", repository: "acme/app", kind: "pr_opened", title: "pr", dedupe_key: "git" };

describe("ingestion external events", () => {
  test("record keeps the ingestion fields", async () => {
    const ctx = context();
    await recordExternalEvent(ctx, {
      workspace: "user:u1", source: "sdk", repository: "acme/app", kind: "error_new", title: "TypeError",
      source_id: "src_1" as any, group_id: "g_1" as any, data: { transition: "new", group_short_id: "eg-1" }, dedupe_key: "i1",
    });
    const row = ctx.db._tables.external_events[0];
    expect(row).toMatchObject({ workspace: "user:u1", source_id: "src_1", group_id: "g_1", data: { transition: "new", group_short_id: "eg-1" } });
    expect(row.team_id).toBeUndefined();
  });

  test("a personal row is readable by its owner only", async () => {
    const own = context("u1");
    await recordExternalEvent(own, { workspace: "user:u1", source: "sdk", repository: "acme/app", kind: "error_new", title: "e", dedupe_key: "i1" });
    expect((await (listForRepository as any)._handler(own, { repository: "acme/app" })).length).toBe(1);

    const other = context("u2");
    other.db._tables.external_events.push(...own.db._tables.external_events);
    expect((await (listForRepository as any)._handler(other, { repository: "acme/app" })).length).toBe(0);
  });

  test("git rows keep the team rule", async () => {
    const member = context("u1");
    await recordExternalEvent(member, git);
    expect((await (listForRepository as any)._handler(member, { repository: "acme/app" })).length).toBe(1);
    const outsider = context("u2");
    outsider.db._tables.external_events.push(...member.db._tables.external_events);
    expect((await (listForRepository as any)._handler(outsider, { repository: "acme/app" })).length).toBe(0);
  });

  test("the team feed leaves out a team source's ingestion rows", async () => {
    const ctx = context("u1");
    await recordExternalEvent(ctx, { ...git, created_at: 1 });
    await recordExternalEvent(ctx, {
      team_id: "team_1" as any, workspace: "team:team_1", source: "sdk", kind: "error_new", title: "e",
      source_id: "src_1" as any, dedupe_key: "i2", created_at: 2,
    });
    const rows = await (listForTeam as any)._handler(ctx, {});
    expect(rows.map((r: any) => r.dedupe_key)).toEqual(["git"]);
  });
});
