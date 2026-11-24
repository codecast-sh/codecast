// `cast task stranded` (shared/contracts/strandedHandoff.ts): finished
// handoffs in review that nothing has landed, read from what the server holds.
import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";
import { hashToken } from "./apiTokens";
import { strandedRows } from "./strandedHandoffs";
import { isHandoffComment } from "./lib/runAgentSessions";

const api = anyApi as any;
const TOKEN = "s".repeat(64);
const DAY = 86_400_000;
const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./strandedHandoffs.ts": () => import("./strandedHandoffs"),
};

type Comment = { daysAgo: number; text: string; type?: string; noSession?: boolean };
type Spec = {
  short_id: string;
  status?: string;
  execution_status?: string;
  handoff?: Comment;
  comments?: Comment[];
  guide?: boolean;
  cause?: boolean;
  landed?: { daysAgo: number; repository?: string };
  runMerged?: boolean;
  /** Runs that merged nothing, started before the one that merged. */
  runsBefore?: number;
  /** Days since the task was last touched (the scan reads the least recently touched first). */
  touchedDaysAgo?: number;
  /** The task's handoff comes from a session the viewer can't read. */
  privateHand?: boolean;
  /** Filed in the owner's personal workspace. */
  personal?: boolean;
};
type Pr = { number: number; state: "open" | "closed" | "merged"; task?: string; repository?: string; otherTeam?: boolean };
type Event = { kind: string; task?: string; pr?: number; repository?: string; daysAgo: number; private?: boolean };

async function setup(specs: Spec[], prs: Pr[] = [], events: Event[] = [], opts: { mergedAt?: number } = {}) {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const { teamId, ownerId } = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Founder" } as any);
    const stranger = await ctx.db.insert("users", { name: "Stranger" } as any);
    const team = await ctx.db.insert("teams", { name: "Acme", created_at: now } as any);
    const other = await ctx.db.insert("teams", { name: "Other", created_at: now } as any);
    await ctx.db.patch(owner, { team_id: team, active_team_id: team } as any);
    await ctx.db.insert("team_memberships", { user_id: owner, team_id: team, role: "admin", joined_at: now } as any);
    await ctx.db.insert("api_tokens", { user_id: owner, token_hash: await hashToken(TOKEN), name: "cli", created_at: now, last_used_at: now } as any);
    const conv = (user: any, short_id: string, is_private: boolean) =>
      ctx.db.insert("conversations", { user_id: user, team_id: team, short_id, title: "hand", status: "active", is_private, created_at: now, updated_at: now, message_count: 1 } as any);
    const hand = await conv(owner, "jxhand", false);
    const hidden = await conv(stranger, "jxhidden", true);
    const ids = new Map<string, any>();
    for (const s of specs) {
      const task = await ctx.db.insert("tasks", {
        user_id: owner, ...(s.personal ? { workspace: `user:${owner}` } : { team_id: team, workspace: `team:${team}` }), short_id: s.short_id, title: `Task ${s.short_id}`,
        status: s.status ?? "in_review", execution_status: s.execution_status ?? "done", task_type: "task", priority: "medium", source: "agent",
        ...(s.guide ? { change_guide: { steps: [], written_at: now - (s.handoff?.daysAgo ?? 0) * DAY } } : {}),
        ...(s.cause ? { source: "signal", cause: { signal_count: 1, first_seen: now, last_seen: now, fingerprints: ["f"] } } : {}),
        ...(s.landed ? { landed: { sha: "abc", at: now - s.landed.daysAgo * DAY, url: "u", repository: s.landed.repository ?? "acme/app", branch: "main" } } : {}),
        created_at: now - 30 * DAY, updated_at: now - (s.touchedDaysAgo ?? 0) * DAY,
      } as any);
      ids.set(s.short_id, task);
      for (const c of [...(s.comments ?? []), ...(s.handoff ? [s.handoff] : [])]) {
        await ctx.db.insert("task_comments", {
          task_id: task, author: "agent", text: c.text, comment_type: c.type ?? "review", created_at: now - c.daysAgo * DAY,
          ...(c.noSession ? {} : { conversation_id: s.privateHand ? hidden : hand }),
        } as any);
      }
      for (let i = 0; i < (s.runsBefore ?? 0); i++) {
        await ctx.db.insert("workflow_runs", { user_id: owner, task_id: task, status: "failed", nodes: [], created_at: now, updated_at: now } as any);
      }
      if (s.runMerged) {
        await ctx.db.insert("workflow_runs", {
          user_id: owner, task_id: task, status: "completed", nodes: [], created_at: now, updated_at: now,
          merge: { sha: "def", branch: "b", into: "main", at: now },
        } as any);
      }
    }
    const prIds = new Map<string, any>();
    for (const pr of prs) {
      const repository = pr.repository ?? "acme/app";
      prIds.set(`${repository}#${pr.number}`, await ctx.db.insert("pull_requests", {
        team_id: pr.otherTeam ? other : team, github_pr_id: pr.number, repository, number: pr.number, title: `PR ${pr.number}`, body: "", state: pr.state,
        ...(pr.state === "merged" && opts.mergedAt != null ? { merged_at: now - opts.mergedAt * DAY } : {}),
        author_github_username: "x", head_ref: "b", base_ref: "main", linked_session_ids: [], created_at: now, updated_at: now,
        ...(pr.task ? { task_ids: [ids.get(pr.task)] } : {}),
      } as any));
    }
    for (const e of events) {
      const repository = e.repository ?? "acme/app";
      const task = e.task ? ids.get(e.task) : undefined;
      await ctx.db.insert("external_events", {
        team_id: team, source: "github", repository, kind: e.kind, title: e.kind, dedupe_key: `${e.kind}:${repository}:${e.pr}:${e.daysAgo}`,
        created_at: now - e.daysAgo * DAY,
        ...(e.private ? { workspace: `user:${stranger}` } : {}),
        ...(e.pr != null ? { pr_id: prIds.get(`${repository}#${e.pr}`), pr_number: e.pr } : {}),
        ...(task ? { task_id: task, task_ids: [task] } : {}),
      } as any);
    }
    return { teamId: team, ownerId: owner };
  });
  return { t, teamId, ownerId };
}

/** strandedRows with every table read recorded: "table" per query, "table.index" per index. */
async function counted(t: any, ownerId: any, teamId: any) {
  const looked: string[] = [];
  const rows = await t.run(async (ctx: any) => {
    const db = new Proxy(ctx.db, {
      get(target: any, prop) {
        if (prop !== "query") return typeof target[prop] === "function" ? target[prop].bind(target) : target[prop];
        return (table: string) => {
          looked.push(table);
          const q = target.query(table);
          const withIndex = q.withIndex.bind(q);
          q.withIndex = (index: string, range: any) => (looked.push(`${table}.${index}`), withIndex(index, range));
          return q;
        };
      },
    });
    return (await strandedRows({ db }, { viewerId: ownerId, workspaceKey: `team:${teamId}`, teamId }, Date.now(), 3)).rows;
  });
  return { rows, looked };
}

const answer = (t: any, teamId: any, days?: number) =>
  t.query(api.strandedHandoffs.list, { api_token: TOKEN, workspace: "team", team_id: teamId, ...(days ? { days } : {}) });
const list = async (t: any, teamId: any, days?: number) => (await answer(t, teamId, days)).rows;
// The team's repository is active: a "PR #N" is looked up there.
const push: Event = { kind: "push", repository: "acme/app", daysAgo: 1 };
const ids = async (t: any, teamId: any) => (await list(t, teamId)).map((r: any) => r.short_id);

test("lists finished handoffs in review that nothing has landed, oldest first", async () => {
  const branch = "Handoff: done\n\nBranch acme/fix-a, tests green.";
  const { t, teamId } = await setup([
    { short_id: "ct-1", handoff: { daysAgo: 5, text: branch } },
    { short_id: "ct-2", handoff: { daysAgo: 9, text: "Handoff: done\n\nPR: https://github.com/acme/app/pull/7" } },
    // Too recent.
    { short_id: "ct-3", handoff: { daysAgo: 1, text: branch } },
    // Landed by a commit naming it, or merged by a run.
    { short_id: "ct-4", handoff: { daysAgo: 5, text: branch }, landed: { daysAgo: 5 } },
    { short_id: "ct-5", handoff: { daysAgo: 5, text: branch }, runMerged: true },
    // A pull request the handoff names is merged.
    { short_id: "ct-6", handoff: { daysAgo: 5, text: "Handoff: done\n\nPR #8 green" } },
    // Done: a person's claim it landed.
    { short_id: "ct-7", status: "done", handoff: { daysAgo: 5, text: branch } },
    // Stopped, not finished.
    { short_id: "ct-8", execution_status: "blocked", handoff: { daysAgo: 5, text: branch } },
    // No code to land.
    { short_id: "ct-9", handoff: { daysAgo: 5, text: "Handoff: done\n\nbacktest published" } },
    // In review without a handoff.
    { short_id: "ct-10" },
    // A line problem waits at the line's own review station.
    { short_id: "ct-12", cause: true, handoff: { daysAgo: 5, text: branch } },
    // A change guide is code.
    { short_id: "ct-11", guide: true, handoff: { daysAgo: 4, text: "Handoff: done\n\nverified" } },
  ], [{ number: 7, state: "open" }, { number: 8, state: "merged" }], [push]);

  const rows = await list(t, teamId);
  expect(rows.map((r: any) => r.short_id)).toEqual(["ct-2", "ct-1", "ct-11"]);
  expect(rows[0]).toMatchObject({ handed_off_by: "jxhand", prs: [{ repository: "acme/app", number: 7, state: "open" }], branches: [] });
  expect(rows[1]).toMatchObject({ branches: ["acme/fix-a"], prs: [] });
});

test("only the newest handoff is judged: a merged PR or a landing from an earlier round hides nothing", async () => {
  const round1 = { daysAgo: 10, text: "Handoff: done\n\nBranch acme/round-1" };
  const round2 = { daysAgo: 4, text: "Handoff: done\n\nRound 2 on branch acme/round-2" };
  const { t, teamId } = await setup([
    { short_id: "ct-1", comments: [{ daysAgo: 10, text: "Handoff: done\n\nPR: https://github.com/acme/app/pull/8" }], handoff: round2 },
    { short_id: "ct-2", comments: [round1], handoff: round2, landed: { daysAgo: 9 } },
    // Pushed, then handed off: the landing is the newest handoff's own.
    { short_id: "ct-3", comments: [round1], handoff: round2, landed: { daysAgo: 4.01 } },
  ], [{ number: 8, state: "merged" }]);
  expect(await ids(t, teamId)).toEqual(["ct-1", "ct-2"]);
});

test("a PR #N with no repository counts only when one repository can be meant", async () => {
  const handoff = { daysAgo: 5, text: "Handoff: done\n\nPR #8 green" };
  const { t, teamId } = await setup(
    [{ short_id: "ct-1", handoff }, { short_id: "ct-2", handoff }],
    [{ number: 8, state: "merged" }, { number: 8, state: "open", repository: "acme/web" }],
    // The team's two repositories are both active; ct-2's own events point at acme/app.
    [{ kind: "push", repository: "acme/app", daysAgo: 1 }, { kind: "push", repository: "acme/web", daysAgo: 1 }, { kind: "commit", task: "ct-2", repository: "acme/app", daysAgo: 6 }],
  );
  const rows = await list(t, teamId);
  expect(rows.map((r: any) => [r.short_id, r.prs])).toEqual([["ct-1", [{ number: 8, state: null }]]]);
});

test("a PR #N is looked up in the team's most recently active repositories, not the first ones by name", async () => {
  const repos = Array.from({ length: 11 }, (_, i) => `acme/r${String(i).padStart(2, "0")}`);
  const { t, teamId } = await setup(
    [{ short_id: "ct-1", handoff: { daysAgo: 5, text: "Handoff: done\n\nPR #5 green" } }],
    [...repos.map((repository) => ({ number: 1, state: "open" as const, repository })), { number: 5, state: "merged", repository: "acme/r10" }],
    [{ kind: "push", repository: "acme/r10", daysAgo: 1 }],
  );
  expect(await ids(t, teamId)).toEqual([]);
});

test("a repository only an event the viewer can't read names is not looked in", async () => {
  const { t, teamId } = await setup(
    [{ short_id: "ct-1", handoff: { daysAgo: 5, text: "Handoff: done\n\nPR #8 green" } }],
    [{ number: 8, state: "merged" }, { number: 8, state: "open", repository: "acme/secret" }],
    [push, { kind: "push", repository: "acme/secret", daysAgo: 1, private: true }],
  );
  expect(await ids(t, teamId)).toEqual([]);
});

test("pull requests naming the task are read in every state: one merged in this round clears it", async () => {
  const handoff = { daysAgo: 5, text: "Handoff: done\n\nbacktest published" };
  const { t, teamId } = await setup(
    [{ short_id: "ct-1", guide: true, handoff }, { short_id: "ct-2", handoff }],
    [{ number: 9, state: "merged", task: "ct-1" }, { number: 10, state: "open", task: "ct-2" }],
    [
      { kind: "pr_opened", task: "ct-1", pr: 9, daysAgo: 6 },
      { kind: "pr_merged", task: "ct-1", pr: 9, daysAgo: 3 },
      { kind: "pr_opened", task: "ct-2", pr: 10, daysAgo: 6 },
    ],
  );
  const rows = await list(t, teamId);
  expect(rows.map((r: any) => [r.short_id, r.prs])).toEqual([["ct-2", [{ repository: "acme/app", number: 10, state: "open" }]]]);
});

test("a handoff is the review comment a session wrote; its PR line reads `#21`; origin/main is no branch", async () => {
  const { t, teamId } = await setup([
    // Not handoffs: a note that quotes one, and a handoff-shaped comment with no session.
    { short_id: "ct-1", guide: true, handoff: { daysAgo: 5, text: "Handoff: done\n\nBranch acme/x", type: "note" } },
    { short_id: "ct-2", guide: true, handoff: { daysAgo: 5, text: "Handoff: done\n\nBranch acme/x", noSession: true } },
    // `cast task handoff --pr '#21'`, merged.
    { short_id: "ct-3", guide: true, handoff: { daysAgo: 5, text: "Handoff: done\n\nverified\n\nPR: #21" } },
    // The default branch is not where work waits.
    { short_id: "ct-4", handoff: { daysAgo: 5, text: "Handoff: done\n\nRebased on branch origin/main" } },
  ], [{ number: 21, state: "merged" }], [push]);
  expect(await ids(t, teamId)).toEqual([]);
});

test("a busy thread keeps its handoff", async () => {
  const chatter = Array.from({ length: 60 }, (_, i) => ({ daysAgo: 4 - i / 100, text: `progress ${i}`, type: "progress" }));
  const { t, teamId } = await setup([{ short_id: "ct-1", handoff: { daysAgo: 5, text: "Handoff: done\n\nBranch acme/fix-a" }, comments: chatter }]);
  expect(await ids(t, teamId)).toEqual(["ct-1"]);
});

test("past the cap, the least recently touched tasks in review are the ones read, and the answer says it capped", async () => {
  const fresh = Array.from({ length: 1000 }, (_, i) => ({ short_id: `ct-f${i}`, execution_status: "in_progress" }));
  const { t, teamId } = await setup([...fresh, { short_id: "ct-old", touchedDaysAgo: 20, handoff: { daysAgo: 20, text: "Handoff: done\n\nBranch acme/old" } }]);
  const { rows, capped_at } = await answer(t, teamId);
  expect(rows.map((r: any) => r.short_id)).toEqual(["ct-old"]);
  expect(capped_at).toBe(1000);
}, 30_000);

test("another team's pull request and a session the viewer can't read stay unread", async () => {
  const { t, teamId } = await setup(
    [
      { short_id: "ct-1", guide: true, handoff: { daysAgo: 5, text: "Handoff: done\n\nPR: https://github.com/rival/app/pull/3" } },
      { short_id: "ct-2", privateHand: true, handoff: { daysAgo: 6, text: "Handoff: done\n\nBranch acme/x" } },
    ],
    [{ number: 3, state: "merged", repository: "rival/app", otherTeam: true }],
  );
  const rows = await list(t, teamId);
  expect(rows.map((r: any) => [r.short_id, r.handed_off_by, r.prs])).toEqual([
    ["ct-2", null, []],
    ["ct-1", "jxhand", [{ repository: "rival/app", number: 3, state: null }]],
  ]);
});

test("the wait is the caller's to set", async () => {
  const { t, teamId } = await setup([{ short_id: "ct-1", handoff: { daysAgo: 5, text: "Handoff: done\n\nBranch acme/fix-a" } }]);
  expect((await list(t, teamId, 7)).length).toBe(0);
  expect((await list(t, teamId, 2)).length).toBe(1);
});

test("a stranger's token reads nothing", async () => {
  const { t } = await setup([]);
  await expect(t.query(api.strandedHandoffs.list, { api_token: "x".repeat(64) })).rejects.toThrow("Unauthorized");
});

test("a run that merged is read however many runs came before it", async () => {
  const branch = "Handoff: done\n\nBranch acme/fix-a";
  const { t, teamId } = await setup([{ short_id: "ct-1", handoff: { daysAgo: 5, text: branch }, runsBefore: 20, runMerged: true }]);
  expect(await ids(t, teamId)).toEqual([]);
});

test("a busy pull request's merge is read however many events came before it", async () => {
  const handoff = { daysAgo: 5, text: "Handoff: done\n\nbacktest published" };
  const checks = Array.from({ length: 100 }, (_, i): Event => ({ kind: "pr_check", task: "ct-1", pr: 9, daysAgo: 4.9 - i / 1000 }));
  const { t, teamId } = await setup(
    [{ short_id: "ct-1", guide: true, handoff }],
    [{ number: 9, state: "merged", task: "ct-1" }],
    [{ kind: "pr_opened", task: "ct-1", pr: 9, daysAgo: 6 }, ...checks, { kind: "pr_merged", task: "ct-1", pr: 9, daysAgo: 4 }],
  );
  expect(await ids(t, teamId)).toEqual([]);
});

test("a merge older than the task's newest events is read from the pull request's own", async () => {
  const handoff = { daysAgo: 5, text: "Handoff: done\n\nbacktest published" };
  const commits = Array.from({ length: 100 }, (_, i): Event => ({ kind: "commit", task: "ct-1", daysAgo: 3.9 - i / 1000 }));
  const { t, teamId } = await setup(
    [{ short_id: "ct-1", guide: true, handoff }],
    [{ number: 9, state: "merged", task: "ct-1" }],
    [{ kind: "pr_opened", task: "ct-1", pr: 9, daysAgo: 6 }, { kind: "pr_merged", task: "ct-1", pr: 9, daysAgo: 4 }, ...commits, { kind: "pr_review_comment", task: "ct-1", pr: 9, daysAgo: 1 }],
  );
  expect(await ids(t, teamId)).toEqual([]);
});

test("a closed pull request stays closed through later reviews and checks, until it is reopened", async () => {
  // No code of its own: an open pull request naming it is the only thing that strands it.
  const handoff = { daysAgo: 5, text: "Handoff: done\n\nbacktest published" };
  const { t, teamId } = await setup(
    [{ short_id: "ct-1", handoff }, { short_id: "ct-2", handoff }],
    [{ number: 9, state: "closed", task: "ct-1" }, { number: 10, state: "open", task: "ct-2" }],
    [
      { kind: "pr_opened", task: "ct-1", pr: 9, daysAgo: 6 },
      { kind: "pr_closed", task: "ct-1", pr: 9, daysAgo: 4 },
      { kind: "pr_review", task: "ct-1", pr: 9, daysAgo: 3 },
      { kind: "pr_check", task: "ct-1", pr: 9, daysAgo: 2 },
      { kind: "pr_opened", task: "ct-2", pr: 10, daysAgo: 6 },
      { kind: "pr_closed", task: "ct-2", pr: 10, daysAgo: 4 },
      { kind: "pr_reopened", task: "ct-2", pr: 10, daysAgo: 3 },
      { kind: "pr_review", task: "ct-2", pr: 10, daysAgo: 2 },
    ],
  );
  const rows = await list(t, teamId);
  expect(rows.map((r: any) => [r.short_id, r.prs])).toEqual([["ct-2", [{ repository: "acme/app", number: 10, state: "open" }]]]);
});

test("a pull request row is read once per repository and number, and never for one its events show merged", async () => {
  const bare = { daysAgo: 5, text: "Handoff: done\n\nPR #8 green" };
  const { t, teamId, ownerId } = await setup(
    [
      { short_id: "ct-1", handoff: bare },
      { short_id: "ct-2", handoff: bare },
      { short_id: "ct-3", handoff: bare },
      // Its own events settle the pull request its handoff names.
      { short_id: "ct-4", handoff: { daysAgo: 5, text: "Handoff: done\n\nPR: https://github.com/acme/app/pull/9" } },
    ],
    // The row is stale (read, it would list ct-4 with #9 open): the merge reached codecast as an event.
    [{ number: 8, state: "open" }, { number: 9, state: "open", task: "ct-4" }],
    [{ kind: "push", repository: "acme/app", daysAgo: 1 }, { kind: "push", repository: "acme/web", daysAgo: 1 }, { kind: "pr_merged", task: "ct-4", pr: 9, daysAgo: 4 }],
  );
  const { rows, looked: all } = await counted(t, ownerId, teamId);
  const looked = all.filter((q) => q === "pull_requests");
  expect(rows.map((r: any) => [r.short_id, r.prs])).toEqual([
    ["ct-1", [{ number: 8, state: "open" }]],
    ["ct-2", [{ number: 8, state: "open" }]],
    ["ct-3", [{ number: 8, state: "open" }]],
  ]);
  // acme/app#8 and acme/web#8, each once.
  expect(looked.length).toBe(2);
});

test("a merge only the pull request row knows (synced from GitHub, no event) clears it", async () => {
  const handoff = { daysAgo: 5, text: "Handoff: done\n\nPR: https://github.com/acme/app/pull/12" };
  const { t, teamId } = await setup(
    [{ short_id: "ct-9", guide: true, handoff }, { short_id: "ct-10", guide: true, handoff: { daysAgo: 5, text: "Handoff: done\n\nverified" } }],
    [{ number: 12, state: "merged", task: "ct-9" }, { number: 13, state: "merged", task: "ct-10" }],
    // ct-9's events say only that #12 opened; ct-10's say nothing of #13's state.
    [{ kind: "pr_opened", task: "ct-9", pr: 12, daysAgo: 6 }, { kind: "pr_review", task: "ct-10", pr: 13, daysAgo: 6 }],
    { mergedAt: 3 },
  );
  expect(await ids(t, teamId)).toEqual([]);
});

test("two bare PR #N refs look for the team's repositories once", async () => {
  const { t, teamId, ownerId } = await setup(
    [{ short_id: "ct-1", handoff: { daysAgo: 5, text: "Handoff: done\n\nPR #8 and PR #9 green" } }],
    [{ number: 8, state: "open" }, { number: 9, state: "open" }],
    [push],
  );
  const { rows, looked } = await counted(t, ownerId, teamId);
  expect(rows.map((r: any) => r.short_id)).toEqual(["ct-1"]);
  expect(looked.filter((q) => q === "external_events.by_team_created").length).toBe(1);
});

test("a personal task reads the pull requests of the viewer's teams", async () => {
  const { t } = await setup(
    [
      { short_id: "ct-1", personal: true, handoff: { daysAgo: 5, text: "Handoff: done\n\nPR: https://github.com/acme/app/pull/8" } },
      { short_id: "ct-2", personal: true, handoff: { daysAgo: 5, text: "Handoff: done\n\nPR: https://github.com/acme/app/pull/9" } },
      // Another team's pull request stays unread.
      { short_id: "ct-3", personal: true, handoff: { daysAgo: 5, text: "Handoff: done\n\nPR: https://github.com/rival/app/pull/3" } },
    ],
    [{ number: 8, state: "merged" }, { number: 9, state: "open" }, { number: 3, state: "merged", repository: "rival/app", otherTeam: true }],
  );
  const { rows, capped_at } = await t.query(api.strandedHandoffs.list, { api_token: TOKEN, workspace: "personal" });
  expect(capped_at).toBeNull();
  expect(rows.map((r: any) => [r.short_id, r.prs])).toEqual([
    ["ct-2", [{ repository: "acme/app", number: 9, state: "open" }]],
    ["ct-3", [{ repository: "rival/app", number: 3, state: null }]],
  ]);
});

test("one handoff predicate: a session's review comment in the handoff shape, nothing else", () => {
  const c = { text: "Handoff: done\n\nverified", comment_type: "review", conversation_id: "jx1" };
  expect(isHandoffComment(c)).toBe(true);
  expect(isHandoffComment({ ...c, conversation_id: undefined })).toBe(false);
  expect(isHandoffComment({ ...c, comment_type: "note" })).toBe(false);
  expect(isHandoffComment({ ...c, text: "Quoting: Handoff: done" })).toBe(false);
  expect(isHandoffComment({ ...c, text: undefined })).toBe(false);
});

test("a close is not final: a pull request reopened and merged through a sync, with no event for either, clears it", async () => {
  const { t, teamId } = await setup(
    [
      { short_id: "ct-1", guide: true, handoff: { daysAgo: 5, text: "Handoff: done\n\nPR: https://github.com/acme/app/pull/12" } },
      { short_id: "ct-2", guide: true, handoff: { daysAgo: 5, text: "Handoff: done\n\nverified" } },
    ],
    [{ number: 12, state: "merged", task: "ct-1" }, { number: 13, state: "merged", task: "ct-2" }],
    [
      { kind: "pr_opened", task: "ct-1", pr: 12, daysAgo: 6 },
      { kind: "pr_closed", task: "ct-1", pr: 12, daysAgo: 4.5 },
      { kind: "pr_opened", task: "ct-2", pr: 13, daysAgo: 6 },
      { kind: "pr_closed", task: "ct-2", pr: 13, daysAgo: 4.5 },
    ],
    { mergedAt: 3 },
  );
  expect(await ids(t, teamId)).toEqual([]);
});

test("a repository connected in two teams: the row the event names, or the one the viewer may read, is the one read", async () => {
  const { t, teamId } = await setup(
    [
      // Linked through its events: closed by an event, merged by a sync.
      { short_id: "ct-1", guide: true, handoff: { daysAgo: 5, text: "Handoff: done\n\nverified" } },
      // Named by its handoff, with no event.
      { short_id: "ct-2", guide: true, handoff: { daysAgo: 5, text: "Handoff: done\n\nPR: https://github.com/acme/app/pull/14" } },
    ],
    // The other team's rows come first in the repository and number index.
    [
      { number: 12, state: "closed", otherTeam: true }, { number: 12, state: "merged", task: "ct-1" },
      { number: 14, state: "open", otherTeam: true }, { number: 14, state: "merged" },
    ],
    [{ kind: "pr_opened", task: "ct-1", pr: 12, daysAgo: 6 }, { kind: "pr_closed", task: "ct-1", pr: 12, daysAgo: 4.5 }],
    { mergedAt: 3 },
  );
  expect(await ids(t, teamId)).toEqual([]);
});
