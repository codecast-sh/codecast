// The Changes dirty scheduler under convex-test (docs/proposals/changes-page.md
// T5, 7.7, 8.4): a push of 45 commits schedules one rebuild, every hook does
// nothing with the team's flag off, a visibility flip or a membership change
// takes story prose down in the same mutation, and rebuildDay, the reconcile
// and the flag-on backfill mark and clear the right days.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";
import { patchConversationVisibility } from "./lib/access";
import { applyMembershipVisibilityChange, endMembership } from "./teams";
import { upsertLocalCommit } from "./repos";
import { recordExternalEvent } from "./externalEvents";
import {
  INVALIDATE_DELAY_MS,
  MEMBER_PAGE,
  REBUILD_DELAY_MS,
  claimDirtyDay,
  finishDirtyDay,
  markChangesDirty,
  rebuildDates,
} from "./lib/changesDirty";

setDefaultTimeout(60_000);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./changes.ts": () => import("./changes"),
  "./changesSchedule.ts": () => import("./changesSchedule"),
  "./changesProse.ts": () => import("./changesProse"),
  "./githubWebhooks.ts": () => import("./githubWebhooks"),
  "./sessionInsights.ts": () => import("./sessionInsights"),
  "./teamFeatures.ts": () => import("./teamFeatures"),
};

const REPO = "acme/app";
const DATE = "2026-10-02";
const at = (hhmm: string, date = DATE) => Date.parse(`${date}T${hhmm}:00Z`);
const SECRET = "the walrus protocol";

async function setup(opts: { flag: boolean }) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = at("00:00");
    const team = await ctx.db.insert("teams", {
      name: "Acme", created_at: now, invite_code: "acme", ...(opts.flag ? { features: { changes: true } } : {}),
    } as any);
    const ana = await ctx.db.insert("users", { name: "Ana" } as any);
    await ctx.db.insert("team_memberships", { user_id: ana, team_id: team, role: "admin", joined_at: now - 1, visibility: "full" } as any);
    await ctx.db.insert("github_app_installations", {
      team_id: team, installation_id: 7, account_login: "acme", account_type: "Organization", account_id: 1, repository_selection: "all",
    } as any);
    const vis = await ctx.db.insert("conversations", {
      user_id: ana, team_id: team, agent_type: "claude_code", session_id: "s-jx7aaaa", short_id: "jx7aaaa", title: "session jx7aaaa",
      started_at: at("08:00"), updated_at: at("08:00"), message_count: 3, is_private: false, status: "active", project_path: "/repo",
    } as any);
    await ctx.db.insert("session_insights", {
      conversation_id: vis, team_id: team, actor_user_id: ana, source: "idle", generated_at: at("09:45"),
      summary: `Built ${SECRET}`, headline: `Built ${SECRET}`, outcome_type: "progress", themes: [],
    } as any);
    return { team, ana, vis };
  });

  const commit = (sha: string, message: string, timestamp: number, fields: Record<string, unknown> = {}) =>
    t.run(async (ctx) => ctx.db.insert("commits", {
      sha, message, author_name: "Ana", author_email: "ana@acme.dev", timestamp,
      files_changed: 1, insertions: 10, deletions: 2, repository: REPO, team_id: ids.team, branch: "main",
      files: [{ filename: "packages/web/line.tsx", status: "modified", additions: 10, deletions: 2, changes: 12 }],
      ...fields,
    } as any));

  const push = async (shas: string[], date = DATE) => {
    const payload = {
      ref: "refs/heads/main",
      after: shas[shas.length - 1],
      repository: { full_name: REPO },
      pusher: { name: "ana" },
      commits: shas.map((sha, i) => ({
        id: sha, message: `fix(web): line ${sha}`, timestamp: new Date(at("09:00", date) + i * 60_000).toISOString(),
        author: { name: "Ana", email: "ana@acme.dev", username: "ana" }, modified: ["packages/web/line.tsx"], distinct: true,
      })),
    };
    const event_id = await t.run(async (ctx) => ctx.db.insert("github_webhook_events", {
      delivery_id: `d-${shas[0]}`, event_type: "push", payload: JSON.stringify(payload), processed: false, created_at: at("09:00", date),
    }));
    return t.mutation(internal.githubWebhooks.processPushEvent, { event_id });
  };

  const dirty = () => t.run(async (ctx) => ctx.db.query("change_dirty").collect());
  const jobs = () => t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect())
    .filter((j) => j.state.kind === "pending"));
  const rebuilds = async () => (await jobs()).filter((j) => j.name.includes("rebuildDay"));
  const stories = () => t.run(async (ctx) => ctx.db.query("change_stories").collect());
  const build = () => t.action(internal.changes.buildDay, { team_id: ids.team, repository: REPO, date: DATE });

  return { t, ids, commit, push, dirty, jobs, rebuilds, stories, build };
}

const shas = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, "0")}`);

/** A day built from one shared session, its story and edition then given prose naming SECRET. */
async function writtenDay(s: Awaited<ReturnType<typeof setup>>) {
  await s.commit("a1", "feat(web): line pages", at("09:00"), { conversation_id: s.ids.vis });
  await s.commit("a2", "fix(web): line page scroll", at("09:30"), { conversation_id: s.ids.vis });
  await s.build();
  const [story] = await s.stories();
  await s.t.run(async (ctx) => {
    await ctx.db.patch(story._id, {
      headline: `Shipped ${SECRET}`, dek: `Because ${SECRET}`, body: `Prose about ${SECRET}.`, why_source: "session",
      risk_lines: { schema: SECRET }, prose_status: "written",
    });
    const edition = (await ctx.db.query("digests").collect())[0];
    await ctx.db.patch(edition._id, { headline: `The day of ${SECRET}`, narrative: `All about ${SECRET}.`, status: "written", inputs_hash: "h" });
  });
  return story;
}

const everything = (s: Awaited<ReturnType<typeof setup>>) => s.t.run(async (ctx) => JSON.stringify({
  stories: await ctx.db.query("change_stories").collect(),
  digests: await ctx.db.query("digests").collect(),
}));

describe("markChangesDirty", () => {
  test("a push of 45 commits schedules one rebuild of its day; a later push rides it", async () => {
    const s = await setup({ flag: true });
    const result = await s.push(shas(45, "c"));
    expect(result.commits_created).toBe(45);

    const rows = await s.dirty();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ team_id: s.ids.team, repository: REPO, date: DATE });
    const runs = await s.rebuilds();
    expect(runs).toHaveLength(1);
    expect(runs[0]._id).toBe(rows[0].scheduled_id!);
    expect(runs[0].args[0]).toEqual({ team_id: s.ids.team, repository: REPO, date: DATE });
    expect(runs[0].scheduledTime - rows[0].since).toBeGreaterThanOrEqual(REBUILD_DELAY_MS - 1000);

    await s.push(shas(5, "d"));
    expect(await s.dirty()).toHaveLength(1);
    expect(await s.rebuilds()).toHaveLength(1);

    // A push on the next day is another day.
    await s.push(shas(2, "e"), "2026-10-03");
    expect((await s.dirty()).map((r) => r.date).sort()).toEqual([DATE, "2026-10-03"]);
    expect(await s.rebuilds()).toHaveLength(2);
  });

  test("the team's zone decides the day", async () => {
    const s = await setup({ flag: true });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.ids.team, { timezone: "America/Los_Angeles" });
      // 03:00 UTC on the 2nd is still the 1st in Los Angeles.
      await markChangesDirty(ctx, s.ids.team, REPO, at("03:00"));
    });
    expect((await s.dirty()).map((r) => r.date)).toEqual(["2026-10-01"]);
  });

  test("checkout commits mark their day; a harness scratch branch does not", async () => {
    const s = await setup({ flag: true });
    await s.t.run(async (ctx) => {
      const commit = (sha: string, branch: string) => upsertLocalCommit(ctx, {
        userId: s.ids.ana, teamId: s.ids.team, repository: REPO,
        commit: { sha, message: "fix: x", author_name: "Ana", author_email: "ana@acme.dev", timestamp: at("10:00"), files_changed: 1, insertions: 1, deletions: 0, branch } as any,
      });
      await commit("s1", "worktree-agent-abc");
      expect(await ctx.db.query("change_dirty").collect()).toHaveLength(0);
      await commit("l1", "main");
    });
    expect((await s.dirty()).map((r) => r.date)).toEqual([DATE]);
  });

  test("a mark while a rebuild runs schedules the next one; the finished run leaves the row", async () => {
    const s = await setup({ flag: true });
    const key = { team_id: s.ids.team, repository: REPO, date: DATE };
    await s.t.run(async (ctx) => markChangesDirty(ctx, s.ids.team, REPO, at("10:00")));
    await s.t.run(async (ctx) => {
      expect(await claimDirtyDay(ctx, key)).toBe("UTC");
      // The row is claimed: the run owns these marks.
      expect((await ctx.db.query("change_dirty").first())?.scheduled_id).toBeUndefined();
      await markChangesDirty(ctx, s.ids.team, REPO, at("11:00"));
      await finishDirtyDay(ctx, key);
    });
    const rows = await s.dirty();
    expect(rows).toHaveLength(1);
    expect(rows[0].scheduled_id).toBeDefined();

    // With nothing new during a run, finishing clears the row.
    await s.t.run(async (ctx) => {
      await claimDirtyDay(ctx, key);
      await finishDirtyDay(ctx, key);
    });
    expect(await s.dirty()).toHaveLength(0);
  });

  test("rebuildDay builds the day and clears its row", async () => {
    const s = await setup({ flag: true });
    await s.commit("a1", "feat(web): line pages", at("09:00"));
    await s.t.run(async (ctx) => markChangesDirty(ctx, s.ids.team, REPO, at("09:00")));
    const result = await s.t.action(internal.changesSchedule.rebuildDay, { team_id: s.ids.team, repository: REPO, date: DATE });
    expect("built" in result && result.built.map((b) => b.date)).toEqual([DATE]);
    expect((await s.stories()).map((r) => r.commit_shas)).toEqual([["a1"]]);
    expect(await s.dirty()).toHaveLength(0);
  });

  test("a release marks its day and the earlier days that have an edition; a merged pull request its day", async () => {
    const s = await setup({ flag: true });
    await s.t.run(async (ctx) => {
      for (const date of ["2026-09-30", "2026-10-01"]) {
        await ctx.db.insert("digests", { team_id: s.ids.team, repository: REPO, scope: "day", date, narrative: "", generated_at: 0, status: "facts" } as any);
      }
      await recordExternalEvent(ctx, {
        source: "github", team_id: s.ids.team, repository: REPO, kind: "release", title: "cli-v1.2.3", sha: "r1",
        meta: { surface: "cli", version: "1.2.3" }, dedupe_key: "release:1", created_at: at("12:00"),
      } as any);
    });
    expect((await s.dirty()).map((r) => r.date).sort()).toEqual(["2026-09-30", "2026-10-01", DATE]);

    await s.t.run(async (ctx) => {
      await recordExternalEvent(ctx, {
        source: "github", team_id: s.ids.team, repository: REPO, kind: "pr_merged", title: "Merged", dedupe_key: "pr:1", created_at: at("09:00", "2026-10-05"),
      } as any);
    });
    expect((await s.dirty()).map((r) => r.date)).toContain("2026-10-05");
  });

  test("a written insight marks the days of the stories its session feeds", async () => {
    const s = await setup({ flag: true });
    await s.commit("a1", "feat(web): line pages", at("09:00"), { conversation_id: s.ids.vis });
    await s.build();
    await s.t.mutation(internal.sessionInsights.upsertSessionInsight, {
      conversation_id: s.ids.vis, team_id: s.ids.team, actor_user_id: s.ids.ana, source: "idle", generated_at: at("11:00"),
      summary: "Line pages", outcome_type: "shipped", themes: [],
    });
    expect((await s.dirty()).map((r) => r.date)).toEqual([DATE]);
  });

  test("an insight written for another team marks nothing", async () => {
    const s = await setup({ flag: true });
    await s.commit("a1", "feat(web): line pages", at("09:00"), { conversation_id: s.ids.vis });
    await s.build();
    const other = await s.t.run(async (ctx) => ctx.db.insert("teams", { name: "Other", created_at: at("00:00"), invite_code: "o" } as any));
    await s.t.mutation(internal.sessionInsights.upsertSessionInsight, {
      conversation_id: s.ids.vis, team_id: other, actor_user_id: s.ids.ana, source: "idle", generated_at: at("11:00"),
      summary: "Line pages", outcome_type: "shipped", themes: [],
    });
    expect(await s.dirty()).toHaveLength(0);
  });
});

describe("with the flag off", () => {
  test("every hook does nothing", async () => {
    const s = await setup({ flag: false });
    await s.push(shas(45, "c"));
    await s.commit("a1", "feat(web): line pages", at("09:00"), { conversation_id: s.ids.vis });
    await s.t.mutation(internal.sessionInsights.upsertSessionInsight, {
      conversation_id: s.ids.vis, team_id: s.ids.team, actor_user_id: s.ids.ana, source: "idle", generated_at: at("11:00"),
      summary: "Line pages", outcome_type: "shipped", themes: [],
    });
    await s.t.run(async (ctx) => {
      await recordExternalEvent(ctx, {
        source: "github", team_id: s.ids.team, repository: REPO, kind: "release", title: "v1", sha: "r1", dedupe_key: "r", created_at: at("12:00"),
      } as any);
      const conv = (await ctx.db.get(s.ids.vis))!;
      await patchConversationVisibility(ctx, conv, { is_private: true });
      await applyMembershipVisibilityChange(ctx, s.ids.ana, s.ids.team, "hidden");
      expect(await markChangesDirty(ctx, s.ids.team, REPO, at("09:00"))).toBe(false);
    });
    expect(await s.dirty()).toHaveLength(0);
    expect(await s.rebuilds()).toHaveLength(0);
    expect(await s.stories()).toHaveLength(0);
  });

  test("rebuildDay of a team that turned Changes off drops its row and builds nothing", async () => {
    const s = await setup({ flag: true });
    await s.commit("a1", "feat(web): line pages", at("09:00"));
    await s.t.run(async (ctx) => {
      await markChangesDirty(ctx, s.ids.team, REPO, at("09:00"));
      await ctx.db.patch(s.ids.team, { features: { changes: false } });
    });
    const result = await s.t.action(internal.changesSchedule.rebuildDay, { team_id: s.ids.team, repository: REPO, date: DATE });
    expect(result).toEqual({ skipped: "Changes is off for this team" });
    expect(await s.dirty()).toHaveLength(0);
    expect(await s.stories()).toHaveLength(0);
  });
});

describe("invalidation", () => {
  test("a visibility flip takes the session's prose out of stories and the edition in the same mutation", async () => {
    const s = await setup({ flag: true });
    const story = await writtenDay(s);
    expect(await everything(s)).toContain(SECRET);
    // A commit already scheduled the day's rebuild ten minutes out.
    await s.t.run(async (ctx) => markChangesDirty(ctx, s.ids.team, REPO, at("09:00")));

    await s.t.run(async (ctx) => {
      const conv = (await ctx.db.get(s.ids.vis))!;
      await patchConversationVisibility(ctx, conv, { is_private: true });
      // Same transaction: nothing written from the session is left.
      const row = (await ctx.db.get(story._id))!;
      expect(JSON.stringify(row)).not.toContain(SECRET);
      expect(row).toMatchObject({ prose_status: "pending", conversation_ids: [], actor_user_ids: [], headline: "2 commits in web" });
      expect(row.body).toBeUndefined();
      expect(row.why_source).toBeUndefined();
      expect(row.risk_lines).toBeUndefined();
      expect(await ctx.db.query("change_story_inputs").collect()).toEqual([]);
      const edition = (await ctx.db.query("digests").collect())[0];
      expect(edition).toMatchObject({ status: "facts", narrative: "", headline: "2 commits, 1 story" });
    });
    expect(await everything(s)).not.toContain(SECRET);

    // That run moved up: the day rebuilds soon, once, and the rebuild keeps the session out.
    const runs = await s.rebuilds();
    expect(runs).toHaveLength(1);
    expect((await s.dirty())[0].scheduled_id).toBe(runs[0]._id);
    expect(runs[0].scheduledTime - Date.now()).toBeLessThanOrEqual(INVALIDATE_DELAY_MS);
    await s.build();
    const [rebuilt] = await s.stories();
    expect(rebuilt.headline).toBe("Line pages");
    expect(rebuilt.conversation_ids).toEqual([]);
    expect(await everything(s)).not.toContain(SECRET);
  });

  test("narrowing to summary resets the prose and keeps the session at summary", async () => {
    const s = await setup({ flag: true });
    const story = await writtenDay(s);
    await s.t.run(async (ctx) => {
      await patchConversationVisibility(ctx, (await ctx.db.get(s.ids.vis))!, { team_visibility: "summary" });
      const row = (await ctx.db.get(story._id))!;
      expect(row.conversation_ids).toEqual([s.ids.vis]);
      expect(row.body).toBeUndefined();
      expect(row.prose_status).toBe("pending");
      expect((await ctx.db.query("change_story_inputs").collect()).map((i) => i.mode)).toEqual(["summary"]);
    });
  });

  test("a widening keeps the prose and marks the day", async () => {
    const s = await setup({ flag: true });
    const story = await writtenDay(s);
    await s.t.run(async (ctx) => ctx.db.patch(s.ids.vis, { team_visibility: "summary" } as any));
    await s.t.run(async (ctx) => {
      await patchConversationVisibility(ctx, (await ctx.db.get(s.ids.vis))!, { team_visibility: undefined });
      expect((await ctx.db.get(story._id))!.body).toBe(`Prose about ${SECRET}.`);
    });
    expect((await s.dirty()).map((r) => r.date)).toEqual([DATE]);
  });

  test("a member going hidden takes their sessions' prose out at once", async () => {
    const s = await setup({ flag: true });
    const story = await writtenDay(s);
    await s.t.run(async (ctx) => {
      await applyMembershipVisibilityChange(ctx, s.ids.ana, s.ids.team, "hidden");
      const row = (await ctx.db.get(story._id))!;
      expect(JSON.stringify(row)).not.toContain(SECRET);
      expect(row.conversation_ids).toEqual([]);
    });
    expect(await everything(s)).not.toContain(SECRET);
    expect((await s.dirty()).map((r) => r.date)).toEqual([DATE]);
  });

  test("a member leaving the team narrows their sessions to the default level at once", async () => {
    const s = await setup({ flag: true });
    const story = await writtenDay(s);
    await s.t.run(async (ctx) => {
      await endMembership(ctx, s.ids.ana, s.ids.team);
      const row = (await ctx.db.get(story._id))!;
      expect(JSON.stringify(row)).not.toContain(SECRET);
      expect(row.prose_status).toBe("pending");
      expect((await ctx.db.query("change_story_inputs").collect()).map((i) => i.mode)).toEqual(["summary"]);
    });
    expect(await everything(s)).not.toContain(SECRET);
  });

  test("a member with many story inputs withdraws one page inline and the rest in scheduled pages", async () => {
    const s = await setup({ flag: true });
    await writtenDay(s);
    await s.t.run(async (ctx) => {
      const [{ _id, _creationTime, ...input }] = await ctx.db.query("change_story_inputs").collect();
      for (let i = 0; i < MEMBER_PAGE + 10; i++) await ctx.db.insert("change_story_inputs", input);
    });
    await s.t.run(async (ctx) => applyMembershipVisibilityChange(ctx, s.ids.ana, s.ids.team, "hidden"));
    const left = () => s.t.run(async (ctx) => (await ctx.db.query("change_story_inputs").collect()).length);
    expect(await left()).toBe(MEMBER_PAGE + 11 - MEMBER_PAGE);
    expect((await s.jobs()).filter((j) => j.name.includes("invalidateForMember"))).toHaveLength(1);
    await s.t.mutation(internal.changesSchedule.invalidateForMember, { owner_id: s.ids.ana, team_id: s.ids.team, cursor: null });
    expect(await left()).toBe(0);
  });

  test("with the flag turned off after stories exist, the privacy reset still runs and nothing is scheduled", async () => {
    const s = await setup({ flag: true });
    await writtenDay(s);
    await s.t.run(async (ctx) => ctx.db.patch(s.ids.team, { features: { changes: false } }));
    await s.t.run(async (ctx) => patchConversationVisibility(ctx, (await ctx.db.get(s.ids.vis))!, { is_private: true }));
    expect(await everything(s)).not.toContain(SECRET);
    expect(await s.dirty()).toHaveLength(0);
    expect(await s.rebuilds()).toHaveLength(0);
  });
});

describe("reconcile and backfill", () => {
  const today = () => new Date().toISOString().slice(0, 10);
  const daysAgo = (n: number) => Date.now() - n * 24 * 3_600_000;

  test("turning the flag on backfills the days with commits in the last two weeks, 5 seconds apart", async () => {
    const s = await setup({ flag: false });
    for (const [sha, n] of [["b0", 0], ["b1", 1], ["b13", 13], ["b20", 20]] as const) await s.commit(sha, "fix: x", daysAgo(n));
    await s.commit("bx", "fix: x", daysAgo(2), { branch: "worktree-agent-abc" });
    await s.t.mutation(internal.teamFeatures.setTeamFeatureInternal, { team_id: s.ids.team, feature: "changes", enabled: true });
    expect((await s.jobs()).map((j) => j.name)).toEqual(["changesSchedule:backfill"]);

    const { marked } = await s.t.action(internal.changesSchedule.backfill, { team_id: s.ids.team });
    expect(marked).toBe(3);
    const rows = (await s.dirty()).sort((a, b) => b.date.localeCompare(a.date));
    expect(rows.map((r) => r.date)).toEqual([today(), new Date(daysAgo(1)).toISOString().slice(0, 10), new Date(daysAgo(13)).toISOString().slice(0, 10)]);
    const times = await Promise.all(rows.map(async (r) => (await s.rebuilds()).find((j) => j._id === r.scheduled_id)!.scheduledTime));
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(4_000);
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(4_000);

    // Turning it on again while on schedules no second backfill.
    await s.t.mutation(internal.teamFeatures.setTeamFeatureInternal, { team_id: s.ids.team, feature: "changes", enabled: true });
    expect((await s.jobs()).filter((j) => j.name.includes("backfill"))).toHaveLength(1);
  });

  test("the reconcile marks recent days without a final edition and reschedules a dead rebuild", async () => {
    const s = await setup({ flag: true });
    const yesterday = new Date(daysAgo(1)).toISOString().slice(0, 10);
    await s.commit("r0", "fix: x", daysAgo(0));
    await s.commit("r1", "fix: x", daysAgo(1));
    await s.commit("r5", "fix: x", daysAgo(5));
    await s.t.run(async (ctx) => {
      await ctx.db.insert("digests", { team_id: s.ids.team, repository: REPO, scope: "day", date: yesterday, narrative: "", generated_at: 0, status: "final" } as any);
      // A rebuild that died an hour ago: a row with no pending run.
      await ctx.db.insert("change_dirty", { team_id: s.ids.team, repository: "acme/old", date: "2026-01-01", since: Date.now() - 3_600_000 });
    });
    const result = await s.t.action(internal.changesSchedule.reconcile, {});
    expect(result).toEqual({ teams: 1, marked: 1, rescheduled: 1 });
    const rows = await s.dirty();
    expect(rows.map((r) => r.date).sort()).toEqual(["2026-01-01", today()]);
    expect(rows.every((r) => r.scheduled_id)).toBe(true);
  });
});

describe("rebuildDates", () => {
  test("today rebuilds yesterday too until 03:00 team-local", () => {
    expect(rebuildDates(DATE, "UTC", at("02:59"))).toEqual([DATE, "2026-10-01"]);
    expect(rebuildDates(DATE, "UTC", at("03:00"))).toEqual([DATE]);
    expect(rebuildDates("2026-10-01", "UTC", at("01:00"))).toEqual(["2026-10-01"]);
    // 08:30 UTC is 01:30 in Los Angeles.
    expect(rebuildDates("2026-10-02", "America/Los_Angeles", at("08:30"))).toEqual(["2026-10-02", "2026-10-01"]);
  });
});
