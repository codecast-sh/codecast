// Story and edition prose (docs/proposals/changes-page.md T7, 7.4, 7.5, 7.8).
// The pure half (request builders, reply parsers, the skip and settle rules)
// is tested directly; the pass runs under convex-test through rebuildDay with
// the Messages API stubbed at fetch, so the real reads, the gate, the writes
// and callModel all run. Covered: prose and its cost land, a private session's
// text never reaches a request, an unusable reply keeps the deterministic text,
// the daily cap stops every call, an unsettled story brings its day back, a
// live edition waits out its hour, and a reply whose inputs moved is dropped.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";
import { PROSE_ATTEMPTS } from "./changes";
import type { Doc, Id } from "./_generated/dataModel";
import type { ChangeCommit } from "@codecast/shared/changes";
import { STRONG_MODEL, modelCost } from "./lib/anthropic";
import { isInstructionEdit } from "./lib/sessionMedia";
import { dayBounds, localDate } from "./lib/teamDay";
import {
  DAILY_CAP_USD,
  PROSE_WALL_MS,
  EDITION_INTERVAL_MS,
  SETTLE_MS,
  editionRequest,
  parseEditionReply,
  parseStoryReply,
  settlesAt,
  sentences,
  skipHeadline,
  storyPromptInput,
  articleBody,
  storyRequest,
  type EditionPromptInput,
  type GatedSession,
  type StoryFacts,
} from "./changesProse";

setDefaultTimeout(60_000);

// ── Pure ─────────────────────────────────────────────────────────────────

const commitOf = (sha: string, subject: string, areas: Record<string, [number, number, number]>, extra: Partial<ChangeCommit> = {}): ChangeCommit => ({
  sha,
  subject,
  author_name: "Ana",
  author_email: "ana@acme.dev",
  timestamp: 1_000,
  insertions: Object.values(areas).reduce((n, a) => n + a[1], 0),
  deletions: Object.values(areas).reduce((n, a) => n + a[2], 0),
  areas: Object.fromEntries(Object.entries(areas).map(([a, [touches, insertions, deletions]]) => [a, { touches, insertions, deletions }])),
  ...extra,
});

const facts = (over: Partial<StoryFacts> = {}): StoryFacts => ({
  area: "cli",
  branch: "main",
  commit_shas: ["c1", "c2"],
  area_counts: { cli: 3 },
  risks: [],
  ...over,
});

const session = (over: Partial<GatedSession> = {}): GatedSession => ({
  conversation_id: "conv1" as Id<"conversations">,
  mode: "full",
  outcome_type: "shipped",
  headline: "Fixed slot starvation with launchd priority",
  summary: "Helpers inherited background priority; they now start as interactive jobs.",
  turns: Array.from({ length: 12 }, (_, i) => ({ ask: `ask ${i}`, did: [`did ${i} ${"x".repeat(300)}`] })),
  ...over,
});

describe("storyPromptInput", () => {
  test("orders commits largest first, keeps a batch commit's slice to the story's areas, and filters paths by area", () => {
    const small = commitOf("c1", "fix(cli): retry", { cli: [1, 5, 1] }, { top_paths: ["packages/cli/a.ts"] });
    const batch = commitOf("c2", "feat: everything", { cli: [2, 40, 4], web: [5, 300, 20], convex: [4, 90, 9] }, {
      top_paths: ["packages/web/big.tsx", "packages/cli/b.ts", "packages/convex/c.ts"],
    });
    const input = storyPromptInput(facts(), [small, batch], [], []);
    expect(input.commits.map((c) => c.sha)).toEqual(["c2", "c1"]);
    expect(input.commits[0]).toMatchObject({ insertions: 40, deletions: 4, partial: ["cli"] });
    expect(input.commits[1].partial).toBeUndefined();
    expect(input.areas).toEqual([{ area: "cli", files: 3, insertions: 45, deletions: 5 }]);
    expect(input.top_paths).toEqual(["packages/cli/b.ts", "packages/cli/a.ts"]);
  });

  test("turns pass only at full, the first two and last six, with did items trimmed", () => {
    const full = storyPromptInput(facts(), [], [session()], []);
    const turns = full.sessions[0].turns!;
    expect(turns.map((t) => t.ask)).toEqual(["ask 0", "ask 1", "ask 6", "ask 7", "ask 8", "ask 9", "ask 10", "ask 11"]);
    expect(turns.every((t) => t.did.every((d) => d.length <= 160))).toBe(true);
    expect(storyPromptInput(facts(), [], [session({ mode: "summary" })], []).sessions[0].turns).toBeUndefined();
  });

  test("a blocked risk is worded from the session's headline, never its id", () => {
    const input = storyPromptInput(
      facts({ risks: [{ code: "blocked", evidence: ["conv1"] }, { code: "revert", evidence: ["a".repeat(40)] }] }),
      [],
      [session({ outcome_type: "blocked", headline: "Replay fails on rewritten jsonl" })],
      [],
    );
    expect(input.risks[0].evidence).toEqual(["a session reports it is blocked: Replay fails on rewritten jsonl"]);
    expect(input.risks[1].evidence).toEqual(["aaaaaaaaa"]);
    expect(JSON.stringify(input)).not.toContain("conv1");
  });
});

describe("storyRequest", () => {
  test("is a strong-model request at 4000 tokens offering only the why sources the story has", () => {
    const bare = storyRequest(storyPromptInput(facts(), [commitOf("c1", "fix(cli): retry", { cli: [1, 5, 1] })], [], []));
    expect(bare).toMatchObject({ model: STRONG_MODEL, max_tokens: 4000 });
    // The strong model refuses any temperature; the request names none.
    expect("temperature" in bare).toBe(false);
    expect(bare.prompt).toContain(`"commit", "none"`);
    expect(bare.prompt).not.toContain(`"session"`);
    expect(bare.prompt).not.toContain("Notes from the agent sessions");
    expect(bare.prompt).not.toContain("—");

    const rich = storyRequest(storyPromptInput(facts(), [], [session()], [{ number: 412, title: "Line pages", body: "Because users asked." }]));
    expect(rich.prompt).toContain(`"session", "commit", "pr", "none"`);
    expect(rich.prompt).toContain("#412 Line pages");
    expect(rich.prompt).toContain("Asked: ask 0");
  });
});

describe("parseStoryReply", () => {
  const input = { sessions: [], prs: [], risks: [{ code: "schema", evidence: [] }] };
  const fallback = { kind: "fix", importance: 2 };

  test("reads a fenced reply and holds it to the schema", () => {
    const reply = "```json\n" + JSON.stringify({
      headline: "x".repeat(120),
      dek: "Uploads retry. ".repeat(20),
      body: "One. Two. Three. Four.",
      kind: "nonsense",
      importance: 9,
      why_source: "commit",
      risk_lines: { schema: "Watch the migration.", skew: "not ours" },
    }) + "\n```";
    const prose = parseStoryReply(reply, input, fallback)!;
    // Within the slack a headline stays whole; past it, one with no clause or word to stop at is cut at the slack.
    expect(prose.headline).toBe("x".repeat(120));
    expect(parseStoryReply(JSON.stringify({ headline: "x".repeat(121), why_source: "commit" }), input, fallback)!.headline).toBe("x".repeat(120));
    expect(prose.dek.length).toBeLessThanOrEqual(200);
    expect(prose.dek).not.toContain("…");
    expect(prose.body).toBe("One. Two. Three. Four.");
    expect(prose.kind).toBe("fix");
    expect(prose.importance).toBe(2);
    expect(prose.risk_lines).toEqual({ schema: "Watch the migration." });
  });

  test("prose is cut at a clause or a sentence, never mid-clause with an ellipsis", () => {
    const reply = (over: Record<string, unknown>) => JSON.stringify({ headline: "Uploads retry", why_source: "commit", ...over });
    const headline = "Outreach stops emailing people never pitched, and the tip engine scores job seekers with five signals instead of two, with a backfill for every past send";
    const cut = parseStoryReply(reply({ headline }), input, fallback)!.headline;
    expect(cut).toBe("Outreach stops emailing people never pitched, and the tip engine scores job seekers with five signals instead of two");
    expect(cut).not.toContain("…");

    const first = "The migration adds a contact_effort column that is not null, so a deploy of the old backend against the new table fails every insert until both ship together.";
    const second = "Run the backfill before the web deploy, check the row counts against the outreach log, and keep the old column for a week in case the cadence change has to be rolled back in a hurry.";
    expect(`${first} ${second}`.length).toBeGreaterThan(320);
    // Both sentences do not fit, so the line ends on the first, whole.
    expect(parseStoryReply(reply({ risk_lines: { schema: `${first} ${second}` } }), input, fallback)!.risk_lines).toEqual({ schema: first });
    // A dek past its slack ends on its last whole clause, as a headline does.
    const dek = "The tip engine now ranks job seekers with five signals instead of two, weighting recent replies over profile completeness, and keeps the old score only as a tiebreak for accounts that have never replied to a single message";
    expect(dek.length).toBeGreaterThanOrEqual(200);
    const fitted = parseStoryReply(reply({ dek }), input, fallback)!.dek;
    expect(fitted).toBe("The tip engine now ranks job seekers with five signals instead of two, weighting recent replies over profile completeness");
    expect(fitted).not.toContain("…");
    // A single sentence too long to keep whole is dropped; the risk shows by its code.
    expect(parseStoryReply(reply({ risk_lines: { schema: `${"word ".repeat(80)}end.` } }), input, fallback)!.risk_lines).toBeUndefined();
  });

  test("no JSON, no headline, or a why source the story lacks is unusable", () => {
    expect(parseStoryReply("I cannot help with that", input, fallback)).toBeNull();
    expect(parseStoryReply(JSON.stringify({ headline: "", why_source: "none" }), input, fallback)).toBeNull();
    expect(parseStoryReply(JSON.stringify({ headline: "Uploads retry", why_source: "session" }), input, fallback)).toBeNull();
    expect(parseStoryReply(JSON.stringify({ headline: "Uploads retry", why_source: "none" }), input, fallback)?.why_source).toBe("none");
  });
});

describe("skip and settle", () => {
  const long = "fix(cli): uploads retry three times before giving up on a flaky network";
  const row = { commit_shas: ["c1"], conversation_ids: [] as Id<"conversations">[], area_counts: { cli: 1 } };

  test("one whole fix or feature commit with a sentence subject and no session skips the call", () => {
    const c = commitOf("c1", long, { cli: [1, 5, 1] });
    expect(skipHeadline(row, [c])).toBe("Uploads retry three times before giving up on a flaky network");
    expect(skipHeadline({ ...row, conversation_ids: ["x" as Id<"conversations">] }, [c])).toBeNull();
    expect(skipHeadline(row, [commitOf("c1", "fix(cli): retry uploads", { cli: [1, 5, 1] })])).toBeNull();
    expect(skipHeadline(row, [commitOf("c1", "chore(cli): " + "tidy ".repeat(15), { cli: [1, 5, 1] })])).toBeNull();
    // A slice of a batch commit: its subject speaks for every area.
    expect(skipHeadline(row, [commitOf("c1", long, { cli: [1, 5, 1], web: [1, 5, 1], convex: [1, 5, 1] })])).toBeNull();    // A list of changes, or one too long to fit unclipped, goes to the model.
    expect(skipHeadline(row, [commitOf("c1", "feat(cli): palette search results, PR review popover, composer pill radius", { cli: [1, 5, 1] })])).toBeNull();
    expect(skipHeadline(row, [commitOf("c1", "fix(cli): record a mirror's synced set when a pass has nothing to send; version skew test", { cli: [1, 5, 1] })])).toBeNull();
    expect(skipHeadline(row, [commitOf("c1", "fix(cli): " + "uploads retry patiently ".repeat(5), { cli: [1, 5, 1] })])).toBeNull();
  });

  test("a story settles 20 minutes after its last commit, or when its day ends", () => {
    expect(settlesAt({ last_at: 1_000 }, 10_000_000)).toBe(1_000 + SETTLE_MS);
    expect(settlesAt({ last_at: 1_000 }, 5_000)).toBe(5_000);
  });
});

describe("edition request and reply", () => {
  const story = (n: number) => ({
    key: `s${n}`, area: n % 2 ? "web" : "cli", kind: "feature", importance: 3, headline: `Story ${n}`, dek: "", insertions: 10, deletions: 1, authors: 1, sessions: 1, risks: [],
  });
  const input = (n: number): EditionPromptInput => ({ date: "2026-09-01", stats: null, releases: [], stories: Array.from({ length: n }, (_, i) => story(i + 1)), branches: [], blocked: [] });

  test("editions of any size ask the strong model and name no temperature", () => {
    for (const n of [1, 80]) {
      const req = editionRequest(input(n));
      expect(req.model).toBe(STRONG_MODEL);
      expect("temperature" in req).toBe(false);
    }
  });

  test("maps refs back to story keys, keeps known areas in order and completes them", () => {
    const keys = { s1: "key-1", s2: "key-2", s3: "key-3" };
    const reply = JSON.stringify({
      edition_headline: "Line pages land",
      standfirst: Array.from({ length: 80 }, (_, i) => (i === 30 ? "end." : "word")).join(" "),
      lead_story_key: "s2",
      section_order: ["cli", "mobile", "cli"],
      brief_story_keys: ["s3", "s2", "s9"],
    });
    const out = parseEditionReply(reply, input(3), keys)!;
    expect(out).toMatchObject({ headline: "Line pages land", lead_story_key: "key-2", section_order: ["cli", "web"], brief_story_keys: ["key-3"] });
    expect(out.standfirst.split(" ").length).toBe(31);
    expect(parseEditionReply(JSON.stringify({ edition_headline: "x", lead_story_key: "s9" }), input(3), keys)).toBeNull();
    expect(parseEditionReply("nope", input(3), keys)).toBeNull();
  });
});

// ── The pass, under convex-test ──────────────────────────────────────────

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./changes.ts": () => import("./changes"),
  "./changesSchedule.ts": () => import("./changesSchedule"),
  "./changesProse.ts": () => import("./changesProse"),
  "./changesWeek.ts": () => import("./changesWeek"),
};

const REPO = "acme/app";
const PAST = "2026-09-01";
const at = (hhmm: string, date = PAST) => Date.parse(`${date}T${hhmm}:00Z`);
const SECRET = "the walrus protocol";
const LONG_FEAT = "feat(shared): uploads retry three times before giving up on a flaky network";
const USAGE = { input_tokens: 2000, output_tokens: 300 };

type Sent = { model: string; system?: string; prompt: string; temperature?: number };
type Replies = { story?: (prompt: string) => string; edition?: (prompt: string) => string };

const goodStory = (prompt: string) => JSON.stringify({
  headline: "Line pages arrive on the web", dek: "Each line gets its own page.", body: "", kind: "feature", importance: 4,
  why_source: prompt.includes(`"session"`) ? "session" : "commit", risk_lines: {},
});
const goodEdition = (prompt: string) => JSON.stringify({
  edition_headline: "Line pages arrive",
  standfirst: "A web day.",
  lead_story_key: /- (s\d+) \[web/.exec(prompt)?.[1] ?? "s1",
  section_order: ["web", "docs"],
  brief_story_keys: [],
});

let sent: Sent[];
let replies: Replies;
const realFetch = globalThis.fetch;
const realKey = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  sent = [];
  replies = {};
  process.env.ANTHROPIC_API_KEY = "test-key";
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const req: Sent = { model: body.model, system: body.system, prompt: body.messages[0].content, ...("temperature" in body ? { temperature: body.temperature } : {}) };
    sent.push(req);
    const edition = req.system?.includes("editor");
    const text = edition ? (replies.edition ?? goodEdition)(req.prompt) : (replies.story ?? goodStory)(req.prompt);
    return new Response(JSON.stringify({ content: [{ type: "text", text }], usage: USAGE }));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = realKey;
});

const storyCalls = () => sent.filter((s) => !s.system?.includes("editor"));
const editionCalls = () => sent.filter((s) => s.system?.includes("editor"));

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const now = at("00:00");
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
    const priv = await conv(ben, "jx7bbbb", { is_private: true, title: `private ${SECRET}` });
    const insight = (conversation: Id<"conversations">, actor: Id<"users">, summary: string, turns: unknown[] = []) => ctx.db.insert("session_insights", {
      conversation_id: conversation, team_id: team, actor_user_id: actor, source: "idle", generated_at: now + 1,
      summary, headline: summary, outcome_type: "shipped", themes: [], turns,
    } as any);
    await insight(vis, ana, "Line pages for the web app", [{ ask: "give each line a page", did: ["added line routes"] }]);
    await insight(priv, ben, `Worked on ${SECRET}`, [{ ask: `do ${SECRET}`, did: [SECRET] }]);
    return { team, ana, ben, vis, priv };
  });

  const commit = (sha: string, message: string, timestamp: number, files: string[], fields: Record<string, unknown> = {}) =>
    t.run(async (ctx) => ctx.db.insert("commits", {
      sha, message, author_name: "Ana", author_email: "ana@acme.dev", timestamp,
      files_changed: files.length, insertions: 10 * files.length, deletions: 2 * files.length,
      repository: REPO, team_id: ids.team, branch: "main",
      files: files.map((filename) => ({ filename, status: "modified", additions: 10, deletions: 2, changes: 12 })),
      ...fields,
    } as any));

  const day = async (date: string) => {
    await commit(`a1-${date}`, "feat(web): line pages", at("09:00", date), ["packages/web/line.tsx", "packages/web/page.tsx"], { conversation_id: ids.vis });
    await commit(`a2-${date}`, "fix(web): line page scroll", at("09:30", date), ["packages/web/line.tsx"], { conversation_id: ids.vis });
    await commit(`b1-${date}`, `fix(cli): ${SECRET} upload\n\nBody of the private fix.`, at("10:00", date), ["packages/cli/upload.ts"], {
      conversation_id: ids.priv, author_name: "Ben", author_email: "ben@acme.dev",
    });
    await commit(`d1-${date}`, "docs: refresh the guide", at("11:00", date), ["docs/guide.md"]);
    await commit(`e1-${date}`, LONG_FEAT, at("12:00", date), ["packages/shared/retry.ts"]);
    await commit(`f1-${date}`, "wip: branch work", at("13:00", date), ["packages/mobile/app.tsx"], { branch: "ana/mobile" });
  };

  const rebuild = (date = PAST) => t.action(internal.changesSchedule.rebuildDay, { team_id: ids.team, repository: REPO, date });
  const stories = (date = PAST) => t.run(async (ctx) => ctx.db
    .query("change_stories")
    .withIndex("by_team_repo_date", (q) => q.eq("team_id", ids.team).eq("repository", REPO).eq("date", date))
    .collect());
  const byShas = async (sha: string, date = PAST): Promise<Doc<"change_stories">> => (await stories(date)).find((s) => s.commit_shas.includes(`${sha}-${date}`))!;
  const digest = (date = PAST) => t.run(async (ctx) => ctx.db
    .query("digests")
    .withIndex("by_team_repo_scope_date", (q) => q.eq("team_id", ids.team).eq("repository", REPO).eq("scope", "day").eq("date", date))
    .first());
  const rebuildJobs = () => t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect())
    .filter((j) => j.name.includes("rebuildDay") && j.state.kind === "pending"));
  return { t, ids, commit, day, rebuild, stories, byShas, digest, rebuildJobs };
}

const storyCost = modelCost(STRONG_MODEL, USAGE);

describe("runProse through rebuildDay", () => {
  test("a pass past PROSE_WALL_MS starts no new batch, leaves the rest pending and comes back", async () => {
    const s = await setup();
    await s.day(PAST);
    // Twelve more single-area stories, so the day needs more than one batch of 8.
    for (let i = 0; i < 12; i++) {
      await s.commit(`z${i}-${PAST}`, `fix(a${i}): adjust widget ${i}`, at(`14:${String(i).padStart(2, "0")}`, PAST), [`packages/a${i}/x.ts`]);
    }
    const realNow = Date.now;
    let calls = 0;
    replies.story = (prompt) => {
      calls += 1;
      // The first batch ends after the wall: the clock jumps past it.
      const start = realNow();
      Date.now = () => start + PROSE_WALL_MS + 1;
      return goodStory(prompt);
    };
    try {
      await s.rebuild();
    } finally {
      Date.now = realNow;
    }
    const rows = (await s.stories()).filter((r) => r.on_default_branch);
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(8);
    expect(rows.filter((r) => r.prose_status === "pending").length).toBeGreaterThan(0);
    expect(editionCalls()).toEqual([]);
    expect((await s.rebuildJobs()).length).toBeGreaterThan(0);
  });

  test("a failed story is retried by later rebuilds until PROSE_ATTEMPTS, and prose clears the count", async () => {
    const s = await setup();
    await s.day(PAST);
    replies.story = () => '{"headline": "cut off mid';
    await s.rebuild();
    expect(await s.byShas("a1")).toMatchObject({ prose_status: "failed", prose_attempts: 1 });

    // A passing failure: the next rebuild writes it, and the count goes.
    replies.story = undefined;
    await s.rebuild();
    const written = await s.byShas("a1");
    expect(written.prose_status).toBe("written");
    expect(written.prose_attempts).toBeUndefined();

    // A lasting one: retried until the cap, then left on layer 0's text with no more calls.
    const fresh = await setup();
    await fresh.day(PAST);
    replies.story = () => "not json";
    for (let i = 0; i < PROSE_ATTEMPTS; i++) await fresh.rebuild();
    expect((await fresh.byShas("a1")).prose_attempts).toBe(PROSE_ATTEMPTS);
    sent = [];
    await fresh.rebuild();
    expect(storyCalls()).toEqual([]);
  });

  test("writes story prose and the final edition, with tokens and cost on each row", async () => {
    const s = await setup();
    await s.day(PAST);
    await s.rebuild();

    const web = await s.byShas("a1");
    expect(web).toMatchObject({
      headline: "Line pages arrive on the web",
      dek: "Each line gets its own page.",
      why_source: "session",
      kind: "feature",
      importance: 4,
      prose_status: "written",
      model: STRONG_MODEL,
      input_tokens: USAGE.input_tokens,
      output_tokens: USAGE.output_tokens,
    });
    expect(web.cost_usd).toBeCloseTo(storyCost, 10);
    expect(web.body).toBeUndefined();

    // The visible session's insight and turns reached its story's prompt.
    const webPrompt = storyCalls().find((c) => c.prompt.includes("line pages"))!;
    expect(webPrompt.prompt).toContain("Line pages for the web app");
    expect(webPrompt.prompt).toContain("Asked: give each line a page");

    // The skip path: no call, the subject is the headline, the commit is the why.
    const skip = await s.byShas("e1");
    expect(skip).toMatchObject({ prose_status: "skipped", why_source: "commit", headline: "Uploads retry three times before giving up on a flaky network" });
    expect(skip.cost_usd).toBeUndefined();
    expect(storyCalls().some((c) => c.prompt.includes("uploads retry three times"))).toBe(false);

    // Branch work gets no prose and keeps following layer 0.
    const branch = await s.byShas("f1");
    expect(branch.prose_status).toBe("skipped");
    expect(branch.why_source).toBeUndefined();
    expect(storyCalls().some((c) => c.prompt.includes("wip: branch work"))).toBe(false);

    // The private session's notes never left: only its commit text did.
    expect(sent.some((c) => c.prompt.includes(`Worked on ${SECRET}`) || c.prompt.includes(`do ${SECRET}`))).toBe(false);
    expect(sent.every((c) => c.model === STRONG_MODEL && c.temperature === undefined)).toBe(true);

    // The day has ended, so the edition is final.
    const edition = (await s.digest())!;
    expect(edition).toMatchObject({
      headline: "Line pages arrive",
      narrative: "A web day.",
      lead_story_key: web.story_key,
      status: "final",
      model: STRONG_MODEL,
    });
    expect(edition.section_order!.slice(0, 2)).toEqual(["web", "docs"]);
    expect(edition.cost_usd).toBeCloseTo(storyCost, 10);
    expect(editionCalls()).toHaveLength(1);
    expect(editionCalls()[0].prompt).not.toContain("wip: branch work");
    expect(editionCalls()[0].prompt).toContain("ana/mobile: 1 commit, mostly mobile");

    // Nothing moved: a rerun spends nothing.
    sent = [];
    await s.rebuild();
    expect(sent).toEqual([]);
  });

  test("an unusable reply keeps the deterministic text, marks the row failed and still counts its cost", async () => {
    const s = await setup();
    await s.day(PAST);
    replies = { story: () => "Sorry, here is a summary instead.", edition: () => "{not json" };
    await s.rebuild();

    const web = await s.byShas("a1");
    expect(web).toMatchObject({ headline: "Line pages", dek: "Line page scroll", prose_status: "failed" });
    expect(web.why_source).toBeUndefined();
    expect(web.cost_usd).toBeCloseTo(storyCost, 10);

    const edition = (await s.digest())!;
    expect(edition.status).toBe("failed");
    expect(edition.headline).toMatch(/commits/);
    expect(edition.cost_usd).toBeCloseTo(storyCost, 10);

    // A failed story is retried by the next rebuild (attempts left), not on its own.
    expect((await s.byShas("a1")).prose_attempts).toBe(1);

    // With no prose, the headline is the stats line and follows the counts.
    await s.commit(`g1-${PAST}`, "docs: one more page", at("14:00"), ["docs/more.md"]);
    await s.rebuild();
    const after = (await s.digest())!;
    expect(after.status).toBe("failed");
    expect(after.headline).not.toBe(edition.headline);
    expect(after.headline).toContain(`${after.stats!.commits} commits`);
  });

  test("at the daily cap no call is made, stories stay pending and the day is marked capped", async () => {
    const s = await setup();
    await s.day(PAST);
    await s.t.action(internal.changes.buildDay, { team_id: s.ids.team, repository: REPO, date: PAST });
    const docs = await s.byShas("d1");
    await s.t.run(async (ctx) => ctx.db.patch(docs._id, { cost_usd: DAILY_CAP_USD }));

    await s.rebuild();
    expect(sent).toEqual([]);
    expect((await s.byShas("a1")).prose_status).toBe("pending");
    expect((await s.byShas("e1")).prose_status).toBe("skipped");
    const edition = (await s.digest())!;
    expect(edition.status).toBe("facts");
    expect(edition.capped_at).toBeNumber();

    // Later passes keep the first mark.
    await s.rebuild();
    expect((await s.digest())!.capped_at).toBe(edition.capped_at);
  });

  test("a written edition the cap stops keeps its prose and is marked capped", async () => {
    const s = await setup();
    await s.day(PAST);
    await s.rebuild();
    const written = (await s.digest())!;
    expect(written).toMatchObject({ status: "final", headline: "Line pages arrive" });
    expect(written.capped_at).toBeUndefined();

    sent = [];
    await s.commit(`g1-${PAST}`, "feat(web): line search", at("14:00"), ["packages/web/search.tsx"]);
    const docs = await s.byShas("d1");
    await s.t.run(async (ctx) => ctx.db.patch(docs._id, { cost_usd: DAILY_CAP_USD }));
    await s.rebuild();
    expect(sent).toEqual([]);
    expect((await s.byShas("g1")).prose_status).toBe("pending");
    const capped = (await s.digest())!;
    expect(capped).toMatchObject({ status: "final", headline: "Line pages arrive" });
    expect(capped.capped_at).toBeNumber();
  });

  test("a story that has not settled waits, and its day comes back when it will have", async () => {
    const s = await setup();
    const last = Date.now() - 60_000;
    const date = localDate(last, "UTC");
    await s.commit("live1", "feat(web): line pages", last - 30 * 60_000, ["packages/web/line.tsx"], { conversation_id: s.ids.vis });
    await s.commit("live2", "fix(web): line page scroll", last, ["packages/web/line.tsx"], { conversation_id: s.ids.vis });

    await s.rebuild(date);
    expect(storyCalls()).toEqual([]);
    const story = (await s.stories(date)).find((x) => x.commit_shas.includes("live2"))!;
    expect(story.prose_status).toBe("pending");

    const due = settlesAt(story, dayBounds(date, "UTC").end);
    const jobs = await s.rebuildJobs();
    expect(jobs.some((j) => j.args[0].date === date && Math.abs(j.scheduledTime - Math.max(due, Date.now() + 60_000)) < 5_000)).toBe(true);
  });

  test("a live day's edition is rewritten at most once an hour", async () => {
    const s = await setup();
    const now = Date.now();
    const date = localDate(now, "UTC");
    const end = dayBounds(date, "UTC").end;
    if (end - now < 2 * 60_000) return; // the day ends under the test: nothing live to hold back
    await s.commit("w1", "feat(web): line pages", now - 2 * SETTLE_MS, ["packages/web/line.tsx"], { conversation_id: s.ids.vis });
    await s.rebuild(date);
    expect(editionCalls()).toHaveLength(1);
    const first = (await s.digest(date))!;
    expect(first.status).toBe("written");

    sent = [];
    await s.commit("w2", "docs: a new guide", now - 2 * SETTLE_MS, ["docs/new.md"]);
    await s.rebuild(date);
    expect(editionCalls()).toEqual([]);
    expect((await s.digest(date))!.inputs_hash).toBe(first.inputs_hash);
    const jobs = await s.rebuildJobs();
    expect(jobs.some((j) => j.args[0].date === date && Math.abs(j.scheduledTime - (first.generated_at + EDITION_INTERVAL_MS)) < 5_000)).toBe(true);
  });

  test("a reply whose session went private while it was out is dropped, though its cost counts", async () => {
    const s = await setup();
    await s.day(PAST);
    await s.t.action(internal.changes.buildDay, { team_id: s.ids.team, repository: REPO, date: PAST });
    const web = await s.byShas("a1");
    await s.t.run(async (ctx) => ctx.db.patch(s.ids.vis, { is_private: true }));

    const usage = { model: STRONG_MODEL, input_tokens: 10, output_tokens: 5, cost_usd: 0.25 };
    const write = (inputs_hash: string) => s.t.mutation(internal.changesProse.writeStoryProse, {
      story_id: web._id,
      inputs_hash,
      used: [{ conversation_id: s.ids.vis, mode: "full" }],
      outcome: { status: "written", headline: `Leaked ${SECRET}`, dek: "", kind: "feature", importance: 3, why_source: "session" },
      usage,
    });
    expect(await write(web.inputs_hash)).toBe("stale");
    await s.t.run(async (ctx) => ctx.db.patch(s.ids.vis, { is_private: false }));
    expect(await write("another-hash")).toBe("stale");

    const after = (await s.t.run(async (ctx) => ctx.db.get(web._id)))!;
    expect(after.headline).toBe("Line pages");
    expect(after.prose_status).toBe("pending");
    expect(after.cost_usd).toBeCloseTo(0.5, 10);
  });

  test("an edition written over stories that changed meanwhile is dropped", async () => {
    const s = await setup();
    await s.day(PAST);
    await s.t.action(internal.changes.buildDay, { team_id: s.ids.team, repository: REPO, date: PAST });
    const r = await s.t.mutation(internal.changesProse.writeEditionProse, {
      team_id: s.ids.team, repository: REPO, date: PAST, inputs_hash: "stale-hash",
      outcome: { status: "written", final: true, headline: "Old news", standfirst: "", lead_story_key: "x", section_order: [], brief_story_keys: [] },
    });
    expect(r).toBe("stale");
    expect((await s.digest())!.status).toBe("facts");
  });

  test("with no model key nothing is called and nothing is marked failed", async () => {
    const s = await setup();
    await s.day(PAST);
    delete process.env.ANTHROPIC_API_KEY;
    await s.rebuild();
    expect(sent).toEqual([]);
    expect((await s.byShas("a1")).prose_status).toBe("pending");
    expect((await s.digest())!.status).toBe("facts");
  });
});

describe("sentences", () => {
  test("a dot inside a file name or version does not end a sentence or drop the text before it", () => {
    const body = "Each workspace now stores a timezone (migration 0042_workspace_timezone.sql). It shipped in cli 1.1.163. The schedule reads it. A fourth sentence.";
    expect(sentences(body, 3)).toBe("Each workspace now stores a timezone (migration 0042_workspace_timezone.sql). It shipped in cli 1.1.163. The schedule reads it.");
    expect(sentences("One. Two! Three? Four.", 2)).toBe("One. Two!");
    expect(sentences("No terminator at all", 3)).toBe("No terminator at all");
  });
});

describe("story articles", () => {
  const urls = { img1: "https://convex.example/api/storage/a", img2: "https://convex.example/api/storage/b" };

  test("listed screenshots are placed by ref; unknown refs and outside URLs never reach the page", () => {
    const body = articleBody(
      "### Calls\n\nThe call card shows the contact first.\n\n![The new call card](img1)\n\n![a guess](img9) ![tracker](https://evil.example/x.png)\n\n\n\nDone.",
      urls,
    );
    expect(body).toBe("### Calls\n\nThe call card shows the contact first.\n\n![The new call card](https://convex.example/api/storage/a)\n\nDone.");
  });

  test("an embed line becomes the page or the canvas it names; unknown refs go, and embeds do not count toward the cut", () => {
    const canvas = "```cast-canvas\n<div data-canvas-title=\"Before and after\">" + "x".repeat(5000) + "</div>\n```";
    const embeds = { page1: "https://codecast.sh/a/eval-report", canvas1: canvas };
    const body = articleBody("The eval report:\n\nembed: page1\n\nThe flow, before and after:\n\nembed: canvas1\n\nembed: page7", {}, embeds);
    expect(body).toBe(`The eval report:\n\nhttps://codecast.sh/a/eval-report\n\nThe flow, before and after:\n\n${canvas}`);
  });

  test("a long article is cut at the last paragraph that fits", () => {
    const para = "word ".repeat(150).trim();
    const body = articleBody([para, para, para, para, para].join("\n\n"), {});
    expect(body.length).toBeLessThanOrEqual(3200);
    expect(body.endsWith("word")).toBe(true);
    expect(body.split("\n\n").every((p) => p === para)).toBe(true);
  });

  test("images and instruction edits come only from sessions seen in full, numbered, with URLs kept out of the prompt", () => {
    const media = (url: string, at: number) => ({ images: [{ url, timestamp: at, context: `shot at ${at}` }], edits: [{ path: "prompts/story.md", before: "Be brief.", after: "Write an article.", timestamp: at }] });
    const sessions: GatedSession[] = [
      { conversation_id: "c1" as any, mode: "full", outcome_type: null, summary: "s1", media: media("https://convex.example/u2", 2) },
      { conversation_id: "c2" as any, mode: "summary", outcome_type: null, summary: "s2", media: media("https://convex.example/secret", 1) },
      { conversation_id: "c3" as any, mode: "full", outcome_type: null, summary: "s3", media: media("https://convex.example/u1", 1) },
    ];
    const input = storyPromptInput(facts(), [commitOf("c1", "feat(web): article", { web: [1, 5, 1] })], sessions, []);
    expect(input.images.map((i) => i.ref)).toEqual(["img1", "img2"]);
    expect(input.image_urls).toEqual({ img1: "https://convex.example/u1", img2: "https://convex.example/u2" });
    expect(Object.values(input.image_urls)).not.toContain("https://convex.example/secret");
    expect(input.edits).toHaveLength(2);
    const prompt = storyRequest(input).prompt;
    expect(prompt).toContain("img1");
    expect(prompt).toContain("Write an article.");
    expect(prompt).not.toContain("https://convex.example/");
  });
});

describe("isInstructionEdit", () => {
  test("instruction paths and prose count; code, data and tests do not", () => {
    expect(isInstructionEdit("packages/x/prompts/story.md", "Be brief.")).toBe(true);
    expect(isInstructionEdit("CLAUDE.md", "x")).toBe(true);
    const prose = "Write for a teammate who was not there. Say what changed for the people who use the product, in plain words. Give a reason only when an input states one, and say which input it came from. Leave out the files and the mechanics.";
    expect(isInstructionEdit("packages/convex/convex/changesProse.ts", prose)).toBe(true);
    expect(isInstructionEdit("packages/convex/convex/changesProse.ts", "const x = a.map((b) => b.c).filter(Boolean); return { x, y: z ?? 1 };".repeat(4))).toBe(false);
    expect(isInstructionEdit("packages/convex/convex/changesProse.test.ts", prose)).toBe(false);
  });
});

