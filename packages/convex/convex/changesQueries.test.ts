// The public Changes reads under convex-test (docs/proposals/changes-page.md
// T9): a non-member, a member of another team and a team with the flag off
// get nothing; a member of team A never sees team B's rows; In the works
// leaves out a hidden-level member's blocked insight; and over a week of
// Littlebird-sized days every query reads under 1 MiB, counted on the
// documents ctx.db hands back.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { buildLayerZero } from "@codecast/shared/changes";
import { littlebirdDay } from "../../shared/changes/__fixtures__/littlebird";
import { addDays, localDate } from "./lib/teamDay";
import { dateWindow, inTheWorks, listEditions, listStories, liveStatus, storyEvidence, STALE_AFTER_MS } from "./changesQueries";
import type { StoryWrite } from "./changes";

setDefaultTimeout(120_000);

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./changes.ts": () => import("./changes"),
  "./changesQueries.ts": () => import("./changesQueries"),
};

const REPO = "acme/app";
const NOW = Date.now();
const TODAY = localDate(NOW, "UTC");
const YESTERDAY = addDays(TODAY, -1);
const HOUR = 3_600_000;
const SECRET = "the walrus protocol";

type Seed = Awaited<ReturnType<typeof seed>>;

function storyRow(team: Id<"teams">, date: string, key: string, over: Record<string, unknown> = {}) {
  return {
    team_id: team, repository: REPO, date, story_key: key, area: "web", branch: "main", on_default_branch: true,
    commit_shas: [], conversation_ids: [], pr_ids: [], author_names: ["Ana"], actor_user_ids: [],
    insertions: 10, deletions: 2, files_changed: 1, area_counts: { web: 1 }, risks: [],
    first_at: NOW - 5 * HOUR, last_at: NOW - 4 * HOUR, headline: `story ${key}`, dek: "", kind: "feature", importance: 2,
    prose_status: "pending", inputs_hash: `hash-${key}`, private_session_count: 0, model: "haiku", cost_usd: 0.01, ...over,
  } as any;
}

async function seed() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const team = (name: string, changes: boolean) =>
      ctx.db.insert("teams", { name, created_at: NOW, invite_code: name, ...(changes ? { features: { changes: true } } : {}) } as any);
    const a = await team("acme", true);
    const b = await team("bravo", true);
    const off = await team("off", false);
    const user = (name: string) => ctx.db.insert("users", { name } as any);
    const ana = await user("Ana");
    const ben = await user("Ben");
    const bea = await user("Bea");
    const cid = await user("Cid");
    const outsider = await user("Out");
    const member = (u: Id<"users">, team: Id<"teams">, visibility = "full") =>
      ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: "member", joined_at: NOW - 30 * 24 * HOUR, visibility } as any);
    await member(ana, a);
    await member(ben, a, "hidden");
    await member(bea, b);
    await member(cid, off);

    const conv = (owner: Id<"users">, team: Id<"teams">, shortId: string, over: Record<string, unknown> = { git_remote_url: "git@github.com:acme/app.git" }) => ctx.db.insert("conversations", {
      user_id: owner, team_id: team, agent_type: "claude_code", session_id: `s-${shortId}`, short_id: shortId, title: `session ${shortId}`,
      started_at: NOW - 6 * HOUR, updated_at: NOW - HOUR, message_count: 3, is_private: false, status: "active", project_path: "/repo", ...over,
    } as any);
    const insight = (conversation: Id<"conversations">, team: Id<"teams">, actor: Id<"users">, headline: string, outcome: string) =>
      ctx.db.insert("session_insights", {
        conversation_id: conversation, team_id: team, actor_user_id: actor, source: "idle", generated_at: NOW - HOUR,
        summary: headline, headline, outcome_type: outcome, themes: [],
      } as any);
    const stuck = await conv(ana, a, "jx7stuk");
    const building = await conv(ana, a, "jx7bild");
    const landed = await conv(ana, a, "jx7land");
    const hidden = await conv(ben, a, "jx7hide");
    const bravo = await conv(bea, b, "jx7brav");
    await insight(stuck, a, ana, "Fixture replay fails on rewritten jsonl", "blocked");
    await insight(building, a, ana, "Zoom support for image pills", "progress");
    await insight(landed, a, ana, "Line pages", "progress");
    await insight(hidden, a, ben, `Blocked on ${SECRET}`, "blocked");
    await insight(bravo, b, bea, "Bravo's own blocker", "blocked");
    // Repositories: a session in another repository, one with no remote whose
    // checkout the owner publishes as acme/app, and one nobody can place.
    const elsewhere = await conv(ana, a, "jx7else", { git_remote_url: "https://github.com/acme/other" });
    const cloned = await conv(ana, a, "jx7clon", { project_path: "/work/app-clone" });
    const unplaced = await conv(ana, a, "jx7nowh", { project_path: "/tmp/scratch" });
    await insight(elsewhere, a, ana, "Other repo is stuck", "blocked");
    await insight(cloned, a, ana, "Clone without a remote is stuck", "blocked");
    await insight(unplaced, a, ana, "Nobody knows where this ran", "blocked");
    await ctx.db.insert("repo_sources", {
      user_id: ana, team_id: a, repository: REPO, root: "/work/app-clone", enabled: true, last_synced_at: NOW, created_at: NOW, updated_at: NOW,
    } as any);

    // Stories: today's main and branch work in A, yesterday's, and B's.
    const s1 = await ctx.db.insert("change_stories", storyRow(a, TODAY, "a-web", { commit_shas: ["s1", "s2"], area: "convex", area_counts: { convex: 3 } }));
    await ctx.db.insert("change_stories", storyRow(a, TODAY, "a-cli", { area: "cli", area_counts: { cli: 2 } }));
    await ctx.db.insert("change_stories", storyRow(a, TODAY, "a-branch-1", { branch: "ana/zoom", on_default_branch: false, commit_shas: ["z1", "z2"], area: "web", area_counts: { web: 4, cli: 1 } }));
    await ctx.db.insert("change_stories", storyRow(a, TODAY, "a-branch-2", { branch: "ana/zoom", on_default_branch: false, commit_shas: ["z2", "z3"], area: "cli", area_counts: { cli: 2 } }));
    await ctx.db.insert("change_stories", storyRow(a, YESTERDAY, "a-old", { last_at: NOW - 30 * HOUR }));
    const landedStory = await ctx.db.insert("change_stories", storyRow(a, YESTERDAY, "a-landed", { conversation_ids: [landed], last_at: NOW - 28 * HOUR }));
    await ctx.db.insert("change_story_inputs", { story_id: landedStory, team_id: a, conversation_id: landed, owner_id: ana, mode: "full" });
    const sB = await ctx.db.insert("change_stories", storyRow(b, TODAY, "b-web", { commit_shas: ["s1"] }));
    // The building session also fed B's main-branch story: that landing is B's, not A's.
    await ctx.db.insert("change_story_inputs", { story_id: sB, team_id: b, conversation_id: building, owner_id: ana, mode: "full" });

    // Editions: A's day edition, a personal digest in A, B's edition.
    await ctx.db.insert("digests", {
      team_id: a, repository: REPO, scope: "day", date: TODAY, narrative: "", headline: "3 commits, 2 stories", generated_at: NOW,
      status: "facts", releases: [{ surface: "cli", version: "1.2.3", sha: "r1", at: NOW - 3 * HOUR }], cost_usd: 0.02,
    } as any);
    await ctx.db.insert("digests", { team_id: a, repository: REPO, scope: "day", date: YESTERDAY, narrative: "", headline: "yesterday", generated_at: NOW, status: "written" } as any);
    await ctx.db.insert("digests", { user_id: ana, team_id: a, scope: "day", date: TODAY, narrative: "Ana's own day", generated_at: NOW, events: [] } as any);
    await ctx.db.insert("digests", { team_id: b, repository: REPO, scope: "day", date: TODAY, narrative: "", headline: "bravo day", generated_at: NOW, status: "facts" } as any);
    await ctx.db.insert("change_dirty", { team_id: a, repository: REPO, date: TODAY, since: NOW - STALE_AFTER_MS - 60_000 });
    await ctx.db.insert("change_dirty", { team_id: a, repository: REPO, date: YESTERDAY, since: NOW - 60_000 });

    // Ships: a backend deploy in A, a release in B on the same repository.
    const event = (team: Id<"teams">, kind: string, at: number, fields: Record<string, unknown> = {}) => ctx.db.insert("external_events", {
      team_id: team, source: "codecast", repository: REPO, kind, title: kind, dedupe_key: `${team}:${kind}:${at}`, created_at: at, ...fields,
    } as any);
    await event(a, "deploy", NOW - 6 * HOUR, { sha: "dep1", meta: { surface: "backend" } });
    await event(b, "release", NOW - HOUR, { sha: "bravo1", meta: { surface: "cli", version: "9.9.9" } });

    // Pull requests: one open and one merged in A, one open in B.
    const pr = (team: Id<"teams">, number: number, state: string) => ctx.db.insert("pull_requests", {
      team_id: team, github_pr_id: 1000 + number, repository: REPO, number, title: `PR ${number}`, body: "", state,
      author_github_username: "ana", linked_session_ids: [], created_at: NOW - 2 * HOUR, updated_at: NOW - HOUR, checks_state: "failure", head_ref: `ana/pr-${number}`,
    } as any);
    const openPr = await pr(a, 412, "open");
    const mergedPr = await pr(a, 411, "merged");
    const bravoPr = await pr(b, 7, "open");
    await event(a, "pr_opened", NOW - 2 * HOUR, { pr_id: openPr });
    await event(a, "pr_merged", NOW - 2 * HOUR, { pr_id: mergedPr });
    await event(b, "pr_opened", NOW - 2 * HOUR, { pr_id: bravoPr });

    // Commits: the story's two in A, and B's commit sharing a sha.
    const commit = (team: Id<"teams">, sha: string, at: number) => ctx.db.insert("commits", {
      sha, message: `feat: ${sha}`, author_name: "Ana", author_email: "ana@acme.dev", timestamp: at, files_changed: 1, insertions: 1, deletions: 0,
      repository: REPO, team_id: team, branch: "main", files: [{ filename: "packages/convex/x.ts", status: "modified", additions: 1, deletions: 0, changes: 1 }],
    } as any);
    await commit(a, "s1", NOW - 5 * HOUR);
    await commit(a, "s2", NOW - 4 * HOUR);
    await commit(b, "s1", NOW - 5 * HOUR);

    return { a, b, off, ana, ben, bea, cid, outsider, stuck, building, hidden, s1, sB };
  });
  const as = (u: Id<"users">) => t.withIdentity({ subject: `${u}|test` });
  return { t, ids, as };
}

const day = (s: Seed) => ({ team_id: s.ids.a, repository: REPO, from_date: YESTERDAY, to_date: TODAY });

describe("who may read", () => {
  test("signed out, an outsider, another team's member and a flag-off team get null from every query", async () => {
    const s = await seed();
    const { a, off, outsider, bea, cid, s1 } = s.ids;
    for (const caller of [s.t, s.as(outsider), s.as(bea)]) {
      expect(await caller.query(api.changesQueries.listStories, day(s))).toBeNull();
      expect(await caller.query(api.changesQueries.listEditions, { ...day(s), scope: "day" })).toBeNull();
      expect(await caller.query(api.changesQueries.liveStatus, { team_id: a, repository: REPO })).toBeNull();
      expect(await caller.query(api.changesQueries.storyEvidence, { story_id: s1 })).toBeNull();
      expect(await caller.query(api.changesQueries.inTheWorks, { team_id: a })).toBeNull();
    }
    const flagOff = s.as(cid);
    expect(await flagOff.query(api.changesQueries.listStories, { ...day(s), team_id: off })).toBeNull();
    expect(await flagOff.query(api.changesQueries.inTheWorks, { team_id: off })).toBeNull();
  });
});

describe("a member of team A", () => {
  test("listStories returns A's window, newest first, without generation accounting", async () => {
    const s = await seed();
    const r = (await s.as(s.ids.ana).query(api.changesQueries.listStories, day(s)))!;
    expect(r.complete).toBe(true);
    expect(r.covered_from).toBe(YESTERDAY);
    expect(r.stories.map((x) => x.story_key).sort()).toEqual(["a-branch-1", "a-branch-2", "a-cli", "a-landed", "a-old", "a-web"]);
    expect(r.stories.every((x) => String(x.team_id) === String(s.ids.a))).toBe(true);
    expect(r.stories[0].date).toBe(TODAY);
    expect(r.stories[0]).not.toHaveProperty("inputs_hash");
    expect(r.stories[0]).not.toHaveProperty("cost_usd");
    // A window of one day, and a window across repositories.
    const today = (await s.as(s.ids.ana).query(api.changesQueries.listStories, { team_id: s.ids.a, from_date: TODAY, to_date: TODAY }))!;
    expect(today.stories.map((x) => x.story_key).sort()).toEqual(["a-branch-1", "a-branch-2", "a-cli", "a-web"]);
  });

  test("listEditions returns A's team editions with the dirty state, never a personal digest or B's", async () => {
    const s = await seed();
    const rows = (await s.as(s.ids.ana).query(api.changesQueries.listEditions, { ...day(s), scope: "day" }))!;
    expect(rows.map((r) => [r.date, r.headline, r.stale]).sort()).toEqual([
      [YESTERDAY, "yesterday", false],
      [TODAY, "3 commits, 2 stories", true],
    ]);
    const today = rows.find((r) => r.date === TODAY)!;
    expect(today.dirty_since).toBe(NOW - STALE_AFTER_MS - 60_000);
    expect(today).not.toHaveProperty("cost_usd");
    expect(today).not.toHaveProperty("user_id");
  });

  test("liveStatus: latest ship per surface from events and editions, with waiting stories, and nothing of B's", async () => {
    const s = await seed();
    const rows = (await s.as(s.ids.ana).query(api.changesQueries.liveStatus, { team_id: s.ids.a, repository: REPO }))!;
    expect(rows.map((r) => ({ surface: r.surface, sha: r.sha, kind: r.kind, version: r.version, waiting: r.waiting, exact: r.waiting_exact }))).toEqual([
      // The deploy at -6h: a-web (convex, last at -4h) waits behind it. B's 9.9.9 cli release is not A's.
      { surface: "backend", sha: "dep1", kind: "deploy", version: undefined, waiting: 1, exact: true },
      // The edition's cli 1.2.3 at -3h: a-cli landed before it, so nothing waits.
      { surface: "cli", sha: "r1", kind: "release", version: "1.2.3", waiting: 0, exact: true },
    ]);
  });

  test("storyEvidence returns the story's commits in A, not B's row sharing a sha", async () => {
    const s = await seed();
    const rows = (await s.as(s.ids.ana).query(api.changesQueries.storyEvidence, { story_id: s.ids.s1 }))!;
    expect(rows.map((c) => c.sha)).toEqual(["s2", "s1"]);
    expect(rows.every((c) => String(c.team_id) === String(s.ids.a))).toBe(true);
    expect(await s.as(s.ids.ana).query(api.changesQueries.storyEvidence, { story_id: s.ids.sB })).toBeNull();
  });

  test("inTheWorks: stuck and building through the gate, open PRs and today's branches, and no hidden-level member", async () => {
    const s = await seed();
    const rows = (await s.as(s.ids.ana).query(api.changesQueries.inTheWorks, { team_id: s.ids.a, repository: REPO }))!;
    const of = (kind: string) => rows.filter((r) => r.kind === kind) as any[];
    expect(of("stuck").map((r) => r.headline).sort()).toEqual(["Clone without a remote is stuck", "Fixture replay fails on rewritten jsonl"]);
    expect(of("stuck").every((r) => r.repository === REPO)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("Other repo");
    expect(JSON.stringify(rows)).not.toContain("Nobody knows");
    // The team-wide read keeps every repository's sessions, and names none.
    const wide = (await s.as(s.ids.ana).query(api.changesQueries.inTheWorks, { team_id: s.ids.a }))!;
    expect(wide.filter((r) => r.kind === "stuck").map((r: any) => r.headline)).toContain("Other repo is stuck");
    expect(wide.some((r: any) => r.kind === "stuck" && "repository" in r)).toBe(false);
    // "Line pages" has a story on main, so it has landed and is not building. Zoom
    // landed only in team B's story, which says nothing about team A.
    expect(of("building").map((r) => [r.conversation_id, r.headline])).toEqual([[s.ids.building, "Zoom support for image pills"]]);
    expect(of("review").map((r) => [r.number, r.url, r.checks_state])).toEqual([[412, "https://github.com/acme/app/pull/412", "failure"]]);
    expect(of("branch").map((r) => [r.branch, r.commits, r.stories, r.top_area])).toEqual([["ana/zoom", 3, 2, "web"]]);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(String(s.ids.hidden));
    expect(text).not.toContain("Bravo");
    expect(rows.some((r) => "summary" in r || "turns" in r)).toBe(false);
  });
});

describe("dateWindow", () => {
  test("orders, clamps and rejects", () => {
    expect(dateWindow("2026-10-02", "2026-09-30", 31)).toEqual({ from: "2026-09-30", to: "2026-10-02" });
    expect(dateWindow("2026-01-01", "2026-10-02", 7)).toEqual({ from: "2026-09-26", to: "2026-10-02" });
    expect(dateWindow("yesterday", "2026-10-02", 7)).toBeNull();
  });
});

// ── Read size at Littlebird scale ────────────────────────────────────────

/** A ctx.db whose reads add the size of every document they return to `tally`. */
function countingDb(db: any, tally: { bytes: number }): any {
  const size = (x: any): number => {
    if (Array.isArray(x)) return x.reduce((n, d) => n + size(d), 0);
    if (x && Array.isArray(x.page)) return size(x.page);
    return x && typeof x === "object" && "_id" in x ? JSON.stringify(x).length : 0;
  };
  const wrap = (target: any): any => new Proxy(target, {
    get(obj, prop) {
      const value = Reflect.get(obj, prop, obj);
      if (typeof value !== "function") return value;
      return (...args: any[]) => {
        const r = value.apply(obj, args);
        if (r && typeof r.then === "function") return r.then((out: any) => { tally.bytes += size(out); return out; });
        return r && typeof r === "object" ? wrap(r) : r;
      };
    },
  });
  return wrap(db);
}

describe("a week of Littlebird-sized days", () => {
  test("every query reads under 1 MiB", async () => {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const team = await ctx.db.insert("teams", { name: "lb", created_at: NOW, invite_code: "lb", features: { changes: true } } as any);
      const user = await ctx.db.insert("users", { name: "Dev" } as any);
      await ctx.db.insert("team_memberships", { user_id: user, team_id: team, role: "member", joined_at: NOW - 30 * 24 * HOUR, visibility: "full" } as any);
      await ctx.db.insert("external_events", { team_id: team, source: "codecast", repository: REPO, kind: "deploy", title: "deploy", sha: "dep1", meta: { surface: "backend" }, dedupe_key: "d", created_at: NOW - 6 * 24 * HOUR } as any);
      return { team, user };
    });

    // Seven days of stories written through buildDay's own writer, prose on the main ones.
    const commits = littlebirdDay();
    const dates = Array.from({ length: 7 }, (_, i) => addDays(TODAY, -i));
    let written = 0;
    for (const date of dates) {
      const r = buildLayerZero({ team_id: String(ids.team), repository: REPO, date, commits, visible: [] });
      const stories: StoryWrite[] = r.stories.map((s) => ({
        story_key: s.story_key, area: s.area, branch: s.branch, on_default_branch: s.on_default_branch, commit_shas: s.commit_shas,
        conversation_ids: [], pr_ids: [], author_names: s.author_names, actor_user_ids: [], insertions: s.insertions, deletions: s.deletions,
        files_changed: s.files_changed, area_counts: s.area_counts,
        ...(s.release ? { release: { surface: s.release.surface, ...(s.release.version ? { version: s.release.version } : {}), sha: s.release.sha, at: s.release.at } } : {}),
        risks: s.risks, first_at: s.first_at, last_at: s.last_at, headline: s.headline, dek: s.dek, kind: s.kind, importance: s.importance,
        inputs_hash: `h-${s.story_key}`, private_session_count: s.private_conversation_count, inputs: [],
      }));
      for (let i = 0; i < stories.length; i += 40) {
        await t.mutation(internal.changes.writeStories, { team_id: ids.team, repository: REPO, date, stories: stories.slice(i, i + 40) });
      }
      written += stories.length;
    }
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("change_stories").collect();
      for (const row of rows) {
        if (row.on_default_branch) await ctx.db.patch(row._id, { body: "A three sentence body of prose. ".repeat(6), why_source: "commit", prose_status: "written" });
      }
    });
    expect(written).toBeGreaterThan(1000);

    const MiB = 1024 * 1024;
    const measure = async (fn: any, args: any) => {
      const tally = { bytes: 0 };
      const out = await t.withIdentity({ subject: `${ids.user}|test` }).run((ctx: any) => fn._handler({ ...ctx, db: countingDb(ctx.db, tally) }, args));
      return { out, bytes: tally.bytes };
    };
    const week = await measure(listStories, { team_id: ids.team, repository: REPO, from_date: dates[6], to_date: TODAY });
    expect(week.bytes).toBeLessThan(MiB);
    // The week does not fit one call: the newest days come back whole and say where they stop.
    expect(week.out.complete).toBe(false);
    expect(week.out.covered_from > dates[6]).toBe(true);
    const whole = week.out.stories.filter((x: any) => x.date >= week.out.covered_from).length;
    const stored = await t.run((ctx) => ctx.db.query("change_stories").collect());
    expect(whole).toBe(stored.filter((x) => x.date >= week.out.covered_from).length);

    const one = await measure(listStories, { team_id: ids.team, repository: REPO, from_date: TODAY, to_date: TODAY });
    expect(one.out.complete).toBe(true);
    expect(one.bytes).toBeLessThan(MiB);

    for (const [fn, args] of [
      [listEditions, { team_id: ids.team, repository: REPO, scope: "day", from_date: dates[6], to_date: TODAY }],
      [liveStatus, { team_id: ids.team, repository: REPO }],
      [inTheWorks, { team_id: ids.team, repository: REPO }],
      [inTheWorks, { team_id: ids.team }],
    ] as const) {
      const r = await measure(fn, args);
      expect(r.out).not.toBeNull();
      expect(r.bytes).toBeLessThan(MiB);
    }
  });
});
