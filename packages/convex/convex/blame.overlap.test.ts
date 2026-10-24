import { describe, expect, test } from "bun:test";
import { inferCommitsByOverlap, resolveCommitSessions, newResolveCaches, type CommitDescriptor } from "./blame";
import { matchCommitByOverlap } from "./blameCore";
import { makeFakeDb } from "./testDb";

// A commit nothing names (no trailer, no commits row, no stored hash, no
// matching subject) is traced to the session whose edits wrote its lines,
// when the overlap clears the gate.

const FILE = "/Users/me/src/app/convex/decisions.ts";
const HUMAN_SHA = "a".repeat(40);
const NAMED_SHA = "b".repeat(40);
const AGENT = "c".repeat(32);
const OTHER = "d".repeat(32);
const HIDDEN = "e".repeat(32);
const COMMITTER = "f".repeat(32);
const T = 1_800_000_000_000;

const QUERY = `export const listOpenDecisions = query({
  args: { team_id: v.id("teams"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("decisions")
      .withIndex("by_team_status", (q) => q.eq("team_id", args.team_id).eq("status", "open"))
      .order("desc")
      .take(args.limit ?? 50);
    return {
      rows,
      more: rows.length === (args.limit ?? 50),
    };
  },
});`;

const UNRELATED = `export function formatAge(ms: number): string {
  if (ms < 60_000) return "just now";
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? \`\${minutes}m\` : \`\${Math.round(minutes / 60)}h\`;
}`;

const edit = (conversation_id: string, new_content: string, timestamp: number, n: number) => ({
  _id: `fc${n}`,
  conversation_id,
  message_id: `m${n}`,
  change_key: `k${n}`,
  file_path: FILE,
  change_type: "edit",
  new_content,
  timestamp,
});

function ctx(fileChanges: any[]) {
  return {
    db: makeFakeDb({
      users: [{ _id: "me", name: "Me" }, { _id: "other", name: "Other" }],
      conversations: [
        { _id: AGENT, user_id: "me", title: "Agent wrote the query" },
        { _id: OTHER, user_id: "me", title: "Agent wrote a helper" },
        { _id: HIDDEN, user_id: "other", title: "Someone else's", is_private: true },
        { _id: COMMITTER, user_id: "me", title: "Committer" },
      ],
      commits: [{ _id: "c1", sha: NAMED_SHA, conversation_id: COMMITTER }],
      file_changes: fileChanges,
      file_change_bodies: [],
      session_owners: [],
      team_memberships: [],
      share_redemptions: [],
    }),
  };
}

// The person's commit: the agent's query, reindented, plus two lines of their own.
const humanLines = [...QUERY.split("\n").map((l) => `\t${l.trim()}`), "// reviewed by hand", "export default listOpenDecisions;"];

async function resolve(db: ReturnType<typeof ctx>, descriptors: CommitDescriptor[]) {
  const caches = newResolveCaches();
  const resolved = await resolveCommitSessions(db, "me" as any, descriptors, caches);
  await inferCommitsByOverlap(db, "me" as any, [FILE], descriptors, resolved, caches);
  return resolved;
}

describe("commit attribution by line overlap", () => {
  test("a person's commit of agent-written code resolves to the writing session", async () => {
    const db = ctx([edit(OTHER, UNRELATED, T - 5000, 1), edit(AGENT, QUERY, T - 60_000, 2)]);
    const out = await resolve(db, [{ sha: HUMAN_SHA, summary: "Add decisions query", author_time: T, lines: humanLines }]);
    expect(out[HUMAN_SHA]).toMatchObject({ conversation_id: AGENT, via: "overlap", message_id: "m2" });
    expect(out[HUMAN_SHA].overlap!.matched).toBe(14);
    expect(out[HUMAN_SHA].overlap!.total).toBe(16);
  });

  test("a commit some session is named for keeps that answer", async () => {
    const db = ctx([edit(AGENT, QUERY, T - 60_000, 1)]);
    const out = await resolve(db, [{ sha: NAMED_SHA, author_time: T, lines: humanLines }]);
    expect(out[NAMED_SHA]).toMatchObject({ conversation_id: COMMITTER, via: "commit" });
  });

  test("an edit made after the commit cannot claim it", async () => {
    const db = ctx([edit(AGENT, QUERY, T + 60 * 60_000, 1)]);
    const out = await resolve(db, [{ sha: HUMAN_SHA, author_time: T, lines: humanLines }]);
    expect(out[HUMAN_SHA]).toBeUndefined();
  });

  test("a session the viewer may not see claims nothing", async () => {
    const db = ctx([edit(HIDDEN, QUERY, T - 60_000, 1)]);
    const out = await resolve(db, [{ sha: HUMAN_SHA, author_time: T, lines: humanLines }]);
    expect(out[HUMAN_SHA]).toBeUndefined();
  });

  test("boilerplate shared with an agent's edit does not claim a long commit", async () => {
    const db = ctx([edit(AGENT, QUERY, T - 60_000, 1)]);
    const own = Array.from({ length: 30 }, (_, i) => `const field${i} = row.values[${i}] ?? defaults[${i}];`);
    const lines = ["handler: async (ctx, args) => {", "return {", "};", "},", "});", ...own];
    const out = await resolve(db, [{ sha: HUMAN_SHA, author_time: T, lines }]);
    expect(out[HUMAN_SHA]).toBeUndefined();
  });
});

describe("matchCommitByOverlap", () => {
  test("pools a session's edits and answers its newest qualifying one", () => {
    const [head, tail] = [QUERY.split("\n").slice(0, 7).join("\n"), QUERY.split("\n").slice(7).join("\n")];
    const rows = [edit(AGENT, head, T - 9000, 1), edit(AGENT, tail, T - 3000, 2), edit(AGENT, "late();", T + 3_600_000, 3)];
    const match = matchCommitByOverlap(QUERY.split("\n"), T, rows);
    expect(match).toMatchObject({ row: { message_id: "m2" }, matched: 14, total: 14 });
  });
});
