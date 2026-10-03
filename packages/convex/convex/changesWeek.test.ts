// The week edition (docs/proposals/changes-page.md 3, level 4; T14). The pure
// half (facts, the prompt, the reply parser) is tested directly; the build
// runs under convex-test from real day builds, with the Messages API stubbed
// at fetch so callModel, the reads and the writes all run. Covered: a day
// edition finalizing schedules one build for its week, the build writes facts
// and then prose on the strong model from day editions and story text only,
// a rerun spends nothing, an unusable reply keeps the facts, the week cap
// stops the call, a reply over moved inputs is dropped, and a session going
// private takes the week's prose with its day's.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { STRONG_MODEL, modelCost } from "./lib/anthropic";
import { patchConversationVisibility } from "./lib/access";
import { weekWindow } from "./changesQueries";
import {
  WEEK_CAP_USD,
  WEEK_DELAY_MS,
  parseWeekReply,
  weekFacts,
  weekPromptInput,
  weekRequest,
  type WeekDay,
  type WeekStory,
} from "./changesWeek";

setDefaultTimeout(60_000);

// ── Pure ─────────────────────────────────────────────────────────────────

const story = (key: string, date: string, area: string, importance: number, lines: number, over: Partial<WeekStory> = {}): WeekStory => ({
  _id: `id-${key}` as Id<"change_stories">,
  story_key: key,
  date,
  area,
  kind: "feature",
  importance,
  headline: `Headline ${key}`,
  dek: `Dek ${key}`,
  insertions: lines,
  deletions: 0,
  area_counts: { [area]: 2 },
  author_names: ["Ana"],
  ...over,
});

const stats = (commits: number, stories: number) => ({ commits, stories, releases: 0, people: 1, sessions: 1, private_sessions: 0 });

const fakeDays = (): WeekDay[] => [
  {
    date: "2026-09-28",
    end: 1,
    edition: {
      date: "2026-09-28", status: "final", headline: "Line pages land", narrative: "A web day.", inputs_hash: "h1", stats: stats(5, 2),
      releases: [{ surface: "cli", version: "1.1.157", sha: "c1", at: 100 }],
    },
    stories: [story("a", "2026-09-28", "web", 4, 300), story("b", "2026-09-28", "docs", 1, 5)],
  },
  {
    date: "2026-09-29",
    end: 2,
    edition: {
      date: "2026-09-29", status: "facts", headline: "3 commits, 1 story", narrative: "", inputs_hash: undefined, stats: stats(3, 1),
      releases: [{ surface: "cli", version: "1.1.159", sha: "c3", at: 300 }, { surface: "cli", version: "1.1.157", sha: "c1", at: 100 }],
    },
    stories: [story("c", "2026-09-29", "cli", 3, 80, { release: { surface: "cli", version: "1.1.159", sha: "c3", at: 300 } })],
  },
  { date: "2026-09-30", end: 3, edition: null, stories: [] },
];

describe("week facts and prompt", () => {
  test("facts sum the days, ledger the ships once, total areas and rank the heaviest", () => {
    const f = weekFacts(fakeDays());
    expect(f.stats).toMatchObject({ commits: 8, stories: 3, releases: 2, people: 1 });
    expect(f.releases.map((r) => r.version)).toEqual(["1.1.157", "1.1.159"]);
    expect(f.area_totals).toEqual([{ area: "cli", stories: 1, files: 2 }, { area: "docs", stories: 1, files: 2 }, { area: "web", stories: 1, files: 2 }]);
    expect(f.top_story_keys).toEqual(["a", "c", "b"]);
  });

  test("the prompt reads day prose only where a day has it, the ledger, and stories by ref, on the strong model", () => {
    const days = fakeDays();
    const load = weekPromptInput("2026-W40", days, weekFacts(days))!;
    expect(load.keys).toEqual({ w1: "a", w2: "c", w3: "b" });
    expect(load.candidates).toEqual(["id-a", "id-c", "id-b"] as any);
    expect(load.input.days.map((d) => d.headline)).toEqual(["Line pages land", null]);
    expect(load.input.ledger).toEqual(["cli 1.1.157 to 1.1.159, 2 releases"]);

    const req = weekRequest(load.input);
    expect(req.model).toBe(STRONG_MODEL);
    expect(req.prompt).toContain("- Mon 2026-09-28 (5 commits, 2 stories): Line pages land");
    expect(req.prompt).toContain("    A web day.");
    // A day without prose gives its counts, never its stats-line headline.
    expect(req.prompt).toContain("- Tue 2026-09-29 (3 commits, 1 story)\n");
    expect(req.prompt).toContain("- w2 [Tue 2026-09-29; cli; feature; importance 3; +80 -0; shipped in cli 1.1.159] Headline c");
    expect(req.prompt).toContain('"top_story_keys"');
  });

  test("the hash follows the inputs, and a week with no default-branch story has no prompt", () => {
    const days = fakeDays();
    const a = weekPromptInput("2026-W40", days, weekFacts(days))!;
    days[0].stories[0].dek = "A new dek";
    const b = weekPromptInput("2026-W40", days, weekFacts(days))!;
    expect(b.hash).not.toBe(a.hash);
    expect(b.sources).not.toBe(a.sources);
    const empty: WeekDay[] = [{ date: "2026-09-28", end: 1, edition: null, stories: [] }];
    expect(weekPromptInput("2026-W40", empty, weekFacts(empty))).toBeNull();
  });

  test("a reply maps refs back to keys, fills five from the heaviest, and keeps at most five sentences", () => {
    const load = { keys: { w1: "a", w2: "c", w3: "b", w4: "d", w5: "e", w6: "f" } };
    const fallback = ["a", "c", "b", "d", "e"];
    const reply = (o: unknown) => JSON.stringify(o);
    expect(parseWeekReply(reply({ week_headline: "CLI week", standfirst: "One. Two. Three. Four. Five. Six.", top_story_keys: ["w6", "w9", "w2"] }), load, fallback)).toEqual({
      headline: "CLI week",
      standfirst: "One. Two. Three. Four. Five.",
      top_story_keys: ["f", "c", "a", "b", "d"],
    });
    expect(parseWeekReply(reply({ week_headline: "x".repeat(300), standfirst: "S.", top_story_keys: [] }), load, ["a"])!.headline.length).toBeLessThanOrEqual(110);
    expect(parseWeekReply(reply({ week_headline: "", standfirst: "S." }), load, fallback)).toBeNull();
    expect(parseWeekReply(reply({ week_headline: "H", standfirst: "" }), load, fallback)).toBeNull();
    expect(parseWeekReply("not json", load, fallback)).toBeNull();
  });
});

describe("week editions on the wire", () => {
  test("listEditions takes ISO weeks for scope week: ordered, clamped, junk refused", () => {
    expect(weekWindow("2026-W40", "2026-W40", 20)).toEqual({ from: "2026-W40", to: "2026-W40" });
    expect(weekWindow("2026-W41", "2026-W38", 20)).toEqual({ from: "2026-W38", to: "2026-W41" });
    expect(weekWindow("2025-W01", "2026-W02", 4)).toEqual({ from: "2025-W51", to: "2026-W02" });
    expect(weekWindow("2026-09-28", "2026-W40", 20)).toBeNull();
    expect(weekWindow("2025-W53", "2026-W01", 20)).toBeNull();
  });
});

// ── The build, under convex-test ─────────────────────────────────────────

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./changes.ts": () => import("./changes"),
  "./changesSchedule.ts": () => import("./changesSchedule"),
  "./changesProse.ts": () => import("./changesProse"),
  "./changesWeek.ts": () => import("./changesWeek"),
};

const REPO = "acme/app";
const MON = "2026-08-31";
const TUE = "2026-09-01";
const WEEK = "2026-W36";
const at = (hhmm: string, date: string) => Date.parse(`${date}T${hhmm}:00Z`);
const SECRET = "the walrus protocol";
const USAGE = { input_tokens: 4000, output_tokens: 500 };

type Sent = { model: string; system?: string; prompt: string };

const goodStory = (prompt: string) => JSON.stringify({
  headline: prompt.includes("line pages") ? "Line pages arrive on the web" : "A story is written",
  dek: "It is told.", body: "", kind: "feature", importance: prompt.includes("line pages") ? 4 : 2,
  why_source: prompt.includes(`"session"`) ? "session" : "commit", risk_lines: {},
});
const goodEdition = (prompt: string) => JSON.stringify({
  edition_headline: "A day of line pages",
  standfirst: "A web day.",
  lead_story_key: /- (s\d+) \[/.exec(prompt)?.[1] ?? "s1",
  section_order: [],
  brief_story_keys: [],
});
const goodWeek = () => JSON.stringify({
  week_headline: "Line pages and two CLI releases",
  standfirst: "The web got line pages. The CLI shipped twice. Docs caught up.",
  top_story_keys: ["w2", "w1", "nope"],
});

let sent: Sent[];
let weekReply: () => string;
const realFetch = globalThis.fetch;
const realKey = process.env.ANTHROPIC_API_KEY;
const isWeek = (s: Sent) => !!s.system?.includes("once a week");

beforeEach(() => {
  sent = [];
  weekReply = goodWeek;
  process.env.ANTHROPIC_API_KEY = "test-key";
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const req: Sent = { model: body.model, system: body.system, prompt: body.messages[0].content };
    sent.push(req);
    const text = isWeek(req) ? weekReply() : req.system?.includes("editor") ? goodEdition(req.prompt) : goodStory(req.prompt);
    return new Response(JSON.stringify({ content: [{ type: "text", text }], usage: USAGE }));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = realKey;
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = at("00:00", MON);
    const team = await ctx.db.insert("teams", { name: "Acme", created_at: now, invite_code: "acme", features: { changes: true } } as any);
    const ana = await ctx.db.insert("users", { name: "Ana" } as any);
    const ben = await ctx.db.insert("users", { name: "Ben" } as any);
    for (const u of [ana, ben]) {
      await ctx.db.insert("team_memberships", { user_id: u, team_id: team, role: u === ana ? "admin" : "member", joined_at: now - 1, visibility: "full" } as any);
    }
    const conv = (owner: Id<"users">, shortId: string, fields: Record<string, unknown> = {}) => ctx.db.insert("conversations", {
      user_id: owner, team_id: team, agent_type: "claude_code", session_id: `s-${shortId}`, short_id: shortId, title: `session ${shortId}`,
      started_at: now, updated_at: now, message_count: 3, is_private: false, status: "active", project_path: "/repo", ...fields,
    } as any);
    const vis = await conv(ana, "jx7aaaa");
    const priv = await conv(ben, "jx7bbbb", { is_private: true });
    const insight = (conversation: Id<"conversations">, actor: Id<"users">, summary: string) => ctx.db.insert("session_insights", {
      conversation_id: conversation, team_id: team, actor_user_id: actor, source: "idle", generated_at: now + 1,
      summary, headline: summary, outcome_type: "shipped", themes: [], turns: [],
    } as any);
    await insight(vis, ana, "Line pages for the web app");
    await insight(priv, ben, `Worked on ${SECRET}`);
    return { team, vis, priv };
  });

  const commit = (sha: string, message: string, timestamp: number, files: string[], fields: Record<string, unknown> = {}) =>
    t.run(async (ctx) => ctx.db.insert("commits", {
      sha, message, author_name: "Ana", author_email: "ana@acme.dev", timestamp,
      files_changed: files.length, insertions: 10 * files.length, deletions: 2 * files.length,
      repository: REPO, team_id: ids.team, branch: "main",
      files: files.map((filename) => ({ filename, status: "modified", additions: 10, deletions: 2, changes: 12 })),
      ...fields,
    } as any));

  const seed = async () => {
    await commit("m1", "feat(web): line pages", at("09:00", MON), ["packages/web/line.tsx", "packages/web/page.tsx"], { conversation_id: ids.vis });
    await commit("m2", "chore(cli): bump version to 1.1.157", at("15:00", MON), ["packages/cli/package.json"]);
    await commit("t1", `fix(cli): ${SECRET} upload`, at("10:00", TUE), ["packages/cli/upload.ts"], { conversation_id: ids.priv, author_name: "Ben", author_email: "ben@acme.dev" });
    await commit("t2", "docs: refresh the guide", at("11:00", TUE), ["docs/guide.md"]);
    await commit("t3", "chore(cli): bump version to 1.1.158", at("15:00", TUE), ["packages/cli/package.json"]);
  };
  const rebuildDay = (date: string) => t.action(internal.changesSchedule.rebuildDay, { team_id: ids.team, repository: REPO, date });
  const rebuildWeek = () => t.action(internal.changesWeek.rebuildWeek, { team_id: ids.team, repository: REPO, week: WEEK });
  const week = () => t.run(async (ctx) => ctx.db
    .query("digests")
    .withIndex("by_team_repo_scope_date", (q) => q.eq("team_id", ids.team).eq("repository", REPO).eq("scope", "week").eq("date", WEEK))
    .first());
  const storyOf = (sha: string) => t.run(async (ctx) => (await ctx.db.query("change_stories").collect()).find((s) => s.commit_shas.includes(sha))!);
  const weekJobs = () => t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect())
    .filter((j) => j.name.includes("rebuildWeek") && j.state.kind === "pending"));
  const built = async () => {
    await seed();
    await rebuildDay(MON);
    await rebuildDay(TUE);
    sent = [];
  };
  return { t, ids, commit, rebuildDay, rebuildWeek, week, storyOf, weekJobs, built };
}

const weekCost = modelCost(STRONG_MODEL, USAGE);

describe("the week build", () => {
  test("finalized days schedule one build of their week; later days ride it", async () => {
    const s = await setup();
    await s.built();
    const jobs = await s.weekJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].args[0]).toEqual({ team_id: s.ids.team, repository: REPO, week: WEEK });
    expect(Math.abs(jobs[0].scheduledTime - (jobs[0]._creationTime + WEEK_DELAY_MS))).toBeLessThan(5_000);
    const row = (await s.week())!;
    expect(row.scheduled_id).toBe(jobs[0]._id);
    expect(row.status).toBe("facts");
    // Nothing was called for the week yet: the build waits for the debounce.
    expect(sent.filter(isWeek)).toEqual([]);
  });

  test("writes facts, then prose on the strong model from day editions and story text, and a rerun spends nothing", async () => {
    const s = await setup();
    await s.built();
    expect(await s.rebuildWeek()).toBe("final");

    const calls = sent.filter(isWeek);
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(STRONG_MODEL);
    expect(calls[0].prompt).toContain("cli 1.1.157 to 1.1.158, 2 releases");
    expect(calls[0].prompt).toContain("A day of line pages");
    // The private session's notes never reached any prompt; only its commit text did.
    expect(sent.some((c) => c.prompt.includes(`Worked on ${SECRET}`))).toBe(false);

    const web = await s.storyOf("m1");
    const row = (await s.week())!;
    expect(row).toMatchObject({
      headline: "Line pages and two CLI releases",
      narrative: "The web got line pages. The CLI shipped twice. Docs caught up.",
      status: "final",
      model: STRONG_MODEL,
      input_tokens: USAGE.input_tokens,
      output_tokens: USAGE.output_tokens,
    });
    expect(row.cost_usd).toBeCloseTo(weekCost, 10);
    expect(row.scheduled_id).toBeUndefined();
    expect(row.top_story_keys![1]).toBe(web.story_key);
    expect(new Set(row.top_story_keys).size).toBe(row.top_story_keys!.length);
    expect(row.releases!.map((r) => r.version)).toEqual(["1.1.157", "1.1.158"]);
    expect(row.stats).toMatchObject({ releases: 2, people: 2 });
    expect(row.area_totals!.find((a) => a.area === "web")).toMatchObject({ stories: 1, files: 2 });

    sent = [];
    expect(await s.rebuildWeek()).toBe("unchanged");
    expect(sent).toEqual([]);
  });

  test("an unusable reply keeps the stats headline, marks the week failed and counts its cost", async () => {
    const s = await setup();
    await s.built();
    weekReply = () => "Here is your week!";
    expect(await s.rebuildWeek()).toBe("failed");
    const row = (await s.week())!;
    expect(row.status).toBe("failed");
    expect(row.headline).toMatch(/^\d+ commits, 2 releases, \d+ stories$/);
    expect(row.narrative).toBe("");
    expect(row.top_story_keys).toHaveLength(Math.min(5, row.stats!.stories));
    expect(row.cost_usd).toBeCloseTo(weekCost, 10);
  });

  test("at the week cap no call is made and the week is marked capped", async () => {
    const s = await setup();
    await s.built();
    const row = (await s.week())!;
    await s.t.run(async (ctx) => ctx.db.patch(row._id, { cost_usd: WEEK_CAP_USD }));
    expect(await s.rebuildWeek()).toBe("capped");
    expect(sent).toEqual([]);
    const after = (await s.week())!;
    expect(after.status).toBe("facts");
    expect(after.capped_at).toBeNumber();
  });

  test("with no model key the facts land and nothing is called", async () => {
    const s = await setup();
    await s.built();
    delete process.env.ANTHROPIC_API_KEY;
    expect(await s.rebuildWeek()).toBe("held");
    expect(sent).toEqual([]);
    expect((await s.week())!).toMatchObject({ status: "facts" });
    expect((await s.week())!.stats!.commits).toBeGreaterThan(0);
  });

  test("prose over day editions or stories that moved meanwhile is dropped, though its cost counts", async () => {
    const s = await setup();
    await s.built();
    await s.rebuildWeek();
    const before = (await s.week())!;
    const usage = { model: STRONG_MODEL, input_tokens: 1, output_tokens: 1, cost_usd: 0.01 };
    const r = await s.t.mutation(internal.changesWeek.writeWeekProse, {
      team_id: s.ids.team, repository: REPO, week: WEEK, inputs_hash: "h", sources: "old-sources", candidates: [],
      outcome: { status: "written", final: true, headline: "Old news", standfirst: "Old.", top_story_keys: [] },
      usage,
    });
    expect(r).toBe("stale");
    const after = (await s.week())!;
    expect(after.headline).toBe(before.headline);
    expect(after.cost_usd).toBeCloseTo(before.cost_usd! + 0.01, 10);
  });

  test("a session going private takes the week's prose with its day's, in the same transaction", async () => {
    const s = await setup();
    await s.built();
    await s.rebuildWeek();
    expect((await s.week())!.status).toBe("final");
    expect((await s.week())!.top_story_keys!.length).toBeGreaterThan(0);

    await s.t.run(async (ctx) => patchConversationVisibility(ctx, (await ctx.db.get(s.ids.vis))!, { is_private: true }));
    const row = (await s.week())!;
    expect(row).toMatchObject({ status: "facts", narrative: "" });
    expect(row.headline).toMatch(/commits/);
    expect(row.inputs_hash).toBeUndefined();
    // The editor's pick read the withdrawn text; the heaviest five lead until the rebuild.
    expect(row.top_story_keys).toBeUndefined();
  });
});
