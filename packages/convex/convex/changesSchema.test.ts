import { describe, expect, test } from "bun:test";
import schema from "./schema";
import { validateArgs } from "./simValidate.testing";
import { TEAM_FEATURE_KEYS, teamFeatureEnabled } from "@codecast/shared/contracts";

// The Changes tables and the reshaped digests, checked against the schema's
// own validators: a row layer 0 or the edition writes must be storable, and a
// person's digest written before the reshape must still be valid.
const tables = (schema as any).tables;
const valid = (table: string, row: Record<string, unknown>) => () => validateArgs(tables[table].validator.json, row);

const RELEASE = { surface: "cli", version: "1.1.163", sha: "ca172db32", at: 1 };

describe("digests", () => {
  test("a person's digest from before the reshape stays valid", () => {
    expect(valid("digests", {
      user_id: "u1", scope: "day", date: "2026-10-01", narrative: "n",
      events: [{ time: 1, t: "09:00", event: "e", type: "commit" }], generated_at: 1,
    })).not.toThrow();
  });

  test("a team edition has no user_id and no events", () => {
    expect(valid("digests", {
      team_id: "t1", repository: "codecast-sh/codecast", scope: "day", date: "2026-10-02",
      narrative: "standfirst", generated_at: 1, headline: "h", lead_story_key: "k1",
      section_order: ["cli", "web"], brief_story_keys: ["k2"], releases: [RELEASE],
      stats: { commits: 16, stories: 9, releases: 3, people: 4, sessions: 11, private_sessions: 4 },
      inputs_hash: "x", model: "m", input_tokens: 1, output_tokens: 1, cost_usd: 0.01, status: "final",
    })).not.toThrow();
    expect(valid("digests", { team_id: "t1", scope: "day", date: "d", narrative: "", generated_at: 1, status: "draft" })).toThrow();
  });

  test("has the team edition index", () => {
    const names = tables.digests.indexes.map((i: any) => i.indexDescriptor);
    expect(names).toContain("by_team_repo_scope_date");
    expect(names).toContain("by_user_scope_date");
  });
});

describe("change tables", () => {
  const story = {
    team_id: "t1", repository: "codecast-sh/codecast", date: "2026-10-02", story_key: "k1",
    area: "cli", branch: "main", on_default_branch: true, commit_shas: ["3d5b5984f"],
    conversation_ids: [], pr_ids: [], author_names: ["A"], actor_user_ids: [],
    insertions: 412, deletions: 88, files_changed: 6, area_counts: { cli: 6 },
    risks: [{ code: "schema", evidence: ["3d5b5984f"] }], first_at: 1, last_at: 2,
    headline: "Restamp daemon build id", dek: "", kind: "chore", importance: 2,
    prose_status: "pending", inputs_hash: "h", private_session_count: 0,
  };

  test("a deterministic layer 0 story and a written one", () => {
    expect(valid("change_stories", story)).not.toThrow();
    expect(valid("change_stories", {
      ...story, release: RELEASE, body: "b", why_source: "session", risk_lines: { schema: "line" },
      prose_status: "written", generated_at: 3, model: "m", input_tokens: 1, output_tokens: 1, cost_usd: 0.001,
    })).not.toThrow();
    expect(valid("change_stories", { ...story, why_source: "guess" })).toThrow();
  });

  test("inputs and dirty rows", () => {
    expect(valid("change_story_inputs", { story_id: "s1", team_id: "t1", conversation_id: "c1", owner_id: "u1" })).not.toThrow();
    expect(valid("change_dirty", { team_id: "t1", repository: "r", date: "2026-10-02", since: 1 })).not.toThrow();
    expect(valid("change_dirty", { team_id: "t1", repository: "r", date: "2026-10-02", since: 1, scheduled_id: "s" })).not.toThrow();
  });

  test("indexes the spec names", () => {
    const names = (t: string) => tables[t].indexes.map((i: any) => i.indexDescriptor);
    expect(names("change_stories")).toEqual(expect.arrayContaining(["by_team_repo_date", "by_team_date", "by_story_key", "by_team_generated_at"]));
    expect(names("change_story_inputs")).toEqual(expect.arrayContaining(["by_story", "by_conversation", "by_owner"]));
    expect(names("change_dirty")).toEqual(["by_key"]);
  });
});

describe("teams", () => {
  test("stores a timezone and the changes flag, which reads off by default", () => {
    expect(valid("teams", {
      name: "T", created_at: 1, invite_code: "x", timezone: "America/Los_Angeles",
      features: { org: true, changes: true },
    })).not.toThrow();
    expect(TEAM_FEATURE_KEYS).toContain("changes");
    expect(teamFeatureEnabled({ features: { org: true } }, "changes")).toBe(false);
    expect(teamFeatureEnabled({ features: { changes: true } }, "changes")).toBe(true);
  });

  test("the schema's flag bag names every catalog feature", () => {
    const bag = tables.teams.validator.json.value.features.fieldType.value;
    expect(Object.keys(bag).sort()).toEqual([...TEAM_FEATURE_KEYS].sort());
  });
});
