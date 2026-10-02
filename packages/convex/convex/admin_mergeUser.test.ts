import { describe, expect, test } from "bun:test";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import { mergeDuplicateUser } from "./admin_mergeUser";

const FROM = "user_from" as any;
const TO = "user_to" as any;
const TEAM = "team_1" as any;

describe("mergeDuplicateUser and digests", () => {
  test("moves a person's digest and leaves a team edition (no user_id) alone", async () => {
    const tables: Record<string, any[]> = {
      users: [
        { _id: FROM, _creationTime: 1, name: "Dup", email: "same@example.test" },
        { _id: TO, _creationTime: 2, name: "Keep", email: "same@example.test" },
      ],
      digests: [
        { _id: "d_person", _creationTime: 3, user_id: FROM, scope: "day", date: "2026-10-01", narrative: "mine", events: [], generated_at: 1 },
        { _id: "d_team", _creationTime: 4, team_id: TEAM, repository: "acme/app", scope: "day", date: "2026-10-01", narrative: "edition", generated_at: 1, status: "facts" },
      ],
    };
    // Reads follow the real schema indexes, so an index or field the merge
    // names that the schema lacks fails here rather than in prod.
    const ctx = { db: makeFakeDb(tables, { indexes: schemaIndexes(schema as any) }) };
    const res = await (mergeDuplicateUser as any)._handler(ctx, {
      from_user_id: FROM,
      to_user_id: TO,
      dry_run: false,
      delete_source: true,
    });
    expect(res.per_table["digests.user_id"]).toBe(1);
    expect(res.source_deleted).toBe(true);
    const byId = Object.fromEntries(tables.digests.map((d) => [d._id, d]));
    expect(byId.d_person.user_id).toBe(TO);
    expect(byId.d_team.user_id).toBeUndefined();
    expect(byId.d_team.team_id).toBe(TEAM);
  });
});
