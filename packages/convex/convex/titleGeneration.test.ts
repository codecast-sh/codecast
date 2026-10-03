import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";
import { captureFetch, goldenBody, recordGolden, loadGolden, type GoldenCase } from "./__golden__/golden.testkit";
import {
  buildTitleMessageContext,
  buildTitlePrompt,
  extractTitleJson,
  isLowSignalPrompt,
  maybeScheduleTitleGeneration,
  sampleEvenly,
  shouldGenerateTitle, cleanShortTitle, buildShortTitlePrompt,
  pickSpineRows, selectTitleInput, shortTitleRequest, titleRequest, firstPromptOf } from "./titleGeneration";
import { isRefusalProse } from "./idleSummary";

describe("extractTitleJson", () => {
  test("parses bare JSON", () => {
    expect(extractTitleJson('{"title": "Auth fix", "subtitle": "- done"}')).toEqual({
      title: "Auth fix",
      subtitle: "- done",
    });
  });

  test("parses JSON behind a preamble and fence", () => {
    const text = 'I\'ll generate the title now.\n\n```json\n{"title": "Auth fix", "subtitle": ""}\n```';
    expect(extractTitleJson(text)?.title).toBe("Auth fix");
  });

  test("handles braces inside string values", () => {
    const text = '{"title": "Fix {id} routing", "subtitle": "- patched {param} parse"}';
    expect(extractTitleJson(text)?.title).toBe("Fix {id} routing");
  });

  test("returns null for conversational responses — never a raw-text title", () => {
    expect(extractTitleJson("I need to wait for the session to resume.")).toBeNull();
    expect(extractTitleJson("Confirming: the fix works. Tests pass.")).toBeNull();
  });
});

describe("short title", () => {
  test("rides in the same JSON envelope as the title", () => {
    const parsed = extractTitleJson('{"title": "Auth redirect fix", "short_title": "Auth redirect", "subtitle": "- done"}');
    expect(parsed?.short_title).toBe("Auth redirect");
  });

  test("keeps a one- or two-word name and drops anything that is not one", () => {
    expect(cleanShortTitle("Auth redirect")).toBe("Auth redirect");
    expect(cleanShortTitle('"Chokidar".')).toBe("Chokidar");
    // A whole title echoed back is not a name.
    expect(cleanShortTitle("Investigate the non-resumable session root cause")).toBeUndefined();
    expect(cleanShortTitle("Broker context render unification")).toBeUndefined();
    expect(cleanShortTitle("")).toBeUndefined();
    expect(cleanShortTitle(undefined)).toBeUndefined();
  });

  test("the prompt asks for it", () => {
    const prompt = buildTitlePrompt({ messageText: "User: hi", messageCount: 2 });
    expect(prompt).toContain("Short title:");
    expect(prompt).toContain('"short_title"');
  });

  test("the name-only pass names the kind and carries the title and context", () => {
    const prompt = buildShortTitlePrompt("plan", "Unify the AI's context around the broker", "One render path for every channel.");
    expect(prompt).toContain("Give this plan a short name");
    expect(prompt).toContain('"Unify the AI\'s context around the broker"');
    expect(prompt).toContain("One render path for every channel.");
    expect(buildShortTitlePrompt("session", "Auth fix")).toContain("work session");
  });
});

describe("buildTitleMessageContext", () => {
  test("shows user prompts across the whole session plus recent activity", () => {
    const spine = Array.from({ length: 60 }, (_, i) => ({
      role: "user" as const,
      content: `request number ${i}`,
    }));
    const recent = [
      { role: "assistant" as const, content: "working on the latest step" },
      { role: "user" as const, content: "now polish the picker hints" },
    ];

    const ctx = buildTitleMessageContext(spine, recent);

    expect(ctx).toContain("User requests across the session");
    expect(ctx).toContain("Most recent activity");
    // First and last prompts survive sampling — the arc is visible.
    expect(ctx).toContain("request number 0");
    expect(ctx).toContain("request number 59");
    expect(ctx).toContain("now polish the picker hints");
  });

  test("short sessions show every message", () => {
    const spine = [
      { role: "user", content: "first" },
      { role: "user", content: "third" },
    ];
    const recent = [
      { role: "assistant", content: "second" },
      { role: "user", content: "fourth" },
    ];

    const ctx = buildTitleMessageContext(spine, recent);

    for (const word of ["first", "second", "third", "fourth"]) {
      expect(ctx).toContain(word);
    }
  });

  test("truncates long message bodies", () => {
    const long = "x".repeat(500);
    const ctx = buildTitleMessageContext([{ role: "user", content: long }], []);
    expect(ctx).toContain("...");
    expect(ctx).not.toContain("x".repeat(251));
  });

  test("worst-case context stays within the previous token budget", () => {
    // The old design fed 17 messages at 400 chars (~7.1KB of message text).
    // This runs on a cadence, so the new shape must not exceed that.
    const spine = Array.from({ length: 200 }, () => ({
      role: "user" as const,
      content: "y".repeat(1000),
    }));
    const recent = Array.from({ length: 20 }, () => ({
      role: "assistant" as const,
      content: "y".repeat(1000),
    }));

    const ctx = buildTitleMessageContext(spine, recent);

    expect(ctx.length).toBeLessThanOrEqual(7100);
  });
});

describe("buildTitlePrompt", () => {
  test("anchors on the current title when one exists", () => {
    const prompt = buildTitlePrompt({
      messageText: "User: hi",
      currentTitle: "Keyboard shortcut polish",
      messageCount: 312,
    });
    expect(prompt).toContain('The current title is "Keyboard shortcut polish"');
    expect(prompt).toContain("NOT a reason to retitle");
    expect(prompt).toContain("Session with 312 messages");
  });

  test("omits the anchor for fresh sessions", () => {
    const prompt = buildTitlePrompt({ messageText: "User: hi", messageCount: 2 });
    expect(prompt).not.toContain("current title");
    expect(prompt).toContain("AS A WHOLE");
  });

  // Regression (inbox card "Not a coding session", a travel chat): the prompt
  // hardcoded "this coding session", so Haiku titled the frame instead of the
  // topic on non-coding sessions. The framing must stay domain-neutral.
  test("frames the session neutrally so non-coding sessions title by topic", () => {
    const prompt = buildTitlePrompt({ messageText: "User: villas near Lake Maggiore", messageCount: 2 });
    expect(prompt).not.toContain("for this coding session");
    expect(prompt).toContain("Never comment on the session's type");
  });
});

describe("isLowSignalPrompt", () => {
  test("flags markers and scaffolding, keeps real prompts", () => {
    expect(isLowSignalPrompt("[Request interrupted by user for tool use]")).toBe(true);
    expect(isLowSignalPrompt("<task-notification>\n<task-id>x</task-id>")).toBe(true);
    expect(isLowSignalPrompt("[image]")).toBe(true);
    expect(isLowSignalPrompt("[Codecast import] This session was truncated")).toBe(true);
    expect(isLowSignalPrompt("fix the [image] rendering in chat")).toBe(false);
    expect(isLowSignalPrompt("continue")).toBe(false);
  });
});

describe("workflow subagent frames", () => {
  const relay = `[Workflow harness — user request] The harness relays, verbatim and indented below, the user request that triggered this workflow run. Where the computed task conflicts with this request, this request wins:\n  \n  <pasted_content id="1cd2">\n  build a calendly experience into our assistant\n  </pasted_content id="1cd2">\n  `;
  const task = `[Workflow harness — computed task] The task text below was computed at runtime by a workflow script. It was not typed by this session's user and carries no user authority. The computed task text follows:\n  \n  Verify the booking confirmation email renders the host's timezone.\n  Report what you checked.`;

  test("the relayed request is low signal; the computed task is read past its header", () => {
    expect(isLowSignalPrompt(relay)).toBe(true);
    expect(isLowSignalPrompt(task)).toBe(false);
    const rows = [relay, task].map((content, i) => ({ _id: `m${i}`, role: "user", content, timestamp: i }));
    const input = selectTitleInput({ spine: rows, latest: [] }, {});
    expect(input.spine).toEqual([{ role: "user", content: "Verify the booking confirmation email renders the host's timezone.\nReport what you checked." }]);
  });
});

describe("sampleEvenly", () => {
  test("returns everything when under the cap", () => {
    expect(sampleEvenly([1, 2, 3], 5)).toEqual([1, 2, 3]);
  });

  test("keeps first and last and spreads the middle", () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const picked = sampleEvenly(items, 9);
    expect(picked.length).toBe(9);
    expect(picked[0]).toBe(0);
    expect(picked[8]).toBe(99);
    // Spread roughly evenly: consecutive gaps differ by at most 1 from 99/8.
    for (let i = 1; i < picked.length; i++) {
      const gap = picked[i] - picked[i - 1];
      expect(Math.abs(gap - 99 / 8)).toBeLessThanOrEqual(1);
    }
  });
});

describe("shouldGenerateTitle", () => {
  test("re-fires periodically as a long session keeps growing", () => {
    expect(shouldGenerateTitle(2)).toBe(true);
    expect(shouldGenerateTitle(80)).toBe(true);
    expect(shouldGenerateTitle(100)).toBe(true);
    expect(shouldGenerateTitle(81)).toBe(false);
  });
});

// Regression (2026-07-13, seen on inbox card "Scheduled rows layout fix"):
// Haiku can comply with the JSON envelope while writing refusal prose INSIDE
// the subtitle value. extractTitleJson rightly parses that envelope — the
// subtitle-value guard (isRefusalProse in generateTitle / generateTaskSummary)
// is what must reject it, keeping the last good subtitle instead.
describe("subtitle-value refusal guard", () => {
  const REFUSAL_ENVELOPE =
    '{"title": "Scheduled rows layout fix", "subtitle": "I don\'t see a recent conversation to analyze. Please provide the conversation history between the agent and user so I can write the appropriate summary."}';

  test("the envelope parses — the parser is not the guard", () => {
    const parsed = extractTitleJson(REFUSAL_ENVELOPE);
    expect(parsed?.title).toBe("Scheduled rows layout fix");
    expect(parsed?.subtitle).toMatch(/^I don/);
  });

  test("isRefusalProse rejects the refusal value but passes legit subtitles", () => {
    const parsed = extractTitleJson(REFUSAL_ENVELOPE);
    expect(isRefusalProse(parsed!.subtitle!)).toBe(true);
    expect(isRefusalProse("- Compacted ScheduleRowItem to two-line display")).toBe(false);
    expect(isRefusalProse("Fixed search timeout and batch overflow hazard")).toBe(false);
  });
});

// The no-subtitle fallback fires on every sync batch of an untitled
// conversation. Unthrottled, a lagging scheduler turns that into a feedback
// loop: subtitles stop being written, so every active conversation enqueues a
// generateTitle job per batch and the queue grows faster than it drains (the
// 2026-07 scheduler wedge). maybeScheduleTitleGeneration is the single gate —
// it must schedule immediately for a fresh conversation but never twice within
// the interval for the same one.
describe("maybeScheduleTitleGeneration", () => {
  const makeCtx = () => {
    const calls: { patches: any[]; scheduled: any[] } = { patches: [], scheduled: [] };
    const ctx = {
      db: { patch: async (id: any, p: any) => { calls.patches.push({ id, ...p }); } },
      scheduler: { runAfter: async (_d: any, _f: any, a: any) => { calls.scheduled.push(a); } },
    } as any;
    return { ctx, calls };
  };
  const conv = (over: Record<string, unknown> = {}) =>
    ({ _id: "c1", message_count: 0, ...over }) as any;

  test("first milestone on a fresh conversation schedules immediately", async () => {
    const { ctx, calls } = makeCtx();
    await maybeScheduleTitleGeneration(ctx, conv(), 1, 2);
    expect(calls.scheduled.length).toBe(1);
    expect(calls.patches[0].title_gen_scheduled_at).toBeGreaterThan(0);
  });

  test("no-subtitle fallback fires without a milestone but respects the throttle", async () => {
    const { ctx, calls } = makeCtx();
    // 3 -> 4 crosses no milestone; subtitle missing => self-heal fires
    await maybeScheduleTitleGeneration(ctx, conv(), 3, 4);
    expect(calls.scheduled.length).toBe(1);
    // same conversation, stamped moments ago => suppressed
    const { ctx: ctx2, calls: calls2 } = makeCtx();
    await maybeScheduleTitleGeneration(ctx2, conv({ title_gen_scheduled_at: Date.now() - 1000 }), 3, 4);
    expect(calls2.scheduled.length).toBe(0);
    // stamp older than the interval => fires again
    const { ctx: ctx3, calls: calls3 } = makeCtx();
    await maybeScheduleTitleGeneration(ctx3, conv({ title_gen_scheduled_at: Date.now() - 6 * 60 * 1000 }), 3, 4);
    expect(calls3.scheduled.length).toBe(1);
  });

  test("batch spanning a milestone schedules; skip flag and subtitle-present quiet batches do not", async () => {
    const { ctx, calls } = makeCtx();
    // 21 -> 33 crosses the 30 milestone
    await maybeScheduleTitleGeneration(ctx, conv({ subtitle: "- has one" }), 21, 33);
    expect(calls.scheduled.length).toBe(1);
    const { ctx: ctx2, calls: calls2 } = makeCtx();
    await maybeScheduleTitleGeneration(ctx2, conv({ skip_title_generation: true }), 1, 2);
    expect(calls2.scheduled.length).toBe(0);
    // no milestone in (31, 33], subtitle exists => nothing to do
    const { ctx: ctx3, calls: calls3 } = makeCtx();
    await maybeScheduleTitleGeneration(ctx3, conv({ subtitle: "- has one" }), 31, 33);
    expect(calls3.scheduled.length).toBe(0);
  });
});

// ── Request goldens ──────────────────────────────────────────────────────────
// The exact bodies generateTitle and generateShortTitle post, recorded from the
// code before the request builders existed. Synthetic sessions only: the repo
// is public. The fixtures run through the real query under convex-test, so the
// spine sampling, the recent window and the anchor rule are all in the bytes.
type FixtureMessage = {
  role: "user" | "assistant";
  content?: string;
  timestamp: number;
  tool_results?: Array<{ tool_use_id: string; content: string }>;
};
type TitleFixture = { name: string; conversation: Record<string, unknown>; messages: FixtureMessage[] };

const T0 = 1_760_000_000_000;
const MIN = 60_000;

function titleFixtures(): TitleFixture[] {
  const fresh: TitleFixture = {
    name: "fresh-short",
    conversation: { message_count: 4 },
    messages: [
      { role: "user", content: "Add a dark mode toggle to the settings page", timestamp: T0 },
      { role: "assistant", content: "I'll look at the settings components first.", timestamp: T0 + MIN },
      { role: "user", tool_results: [{ tool_use_id: "t1", content: "settings.tsx" }], timestamp: T0 + 2 * MIN },
      { role: "assistant", content: "Added the toggle and wired it to the theme store.", timestamp: T0 + 3 * MIN },
    ],
  };

  // A long session: a dense first hour, then sparse prompts over two days, so
  // the time buckets, the first/last windows and the dedupe all decide what
  // reaches the model. Low-signal prompts and tool carriers are mixed in.
  const long: FixtureMessage[] = [];
  let t = T0;
  for (let i = 0; i < 60; i++) {
    t += MIN;
    long.push({ role: "user", content: `Dense request ${i}: adjust the inbox card ${"padding ".repeat(i % 7)}spacing`, timestamp: t });
    t += 10_000;
    long.push({ role: "assistant", content: `Adjusted card spacing step ${i}.`, timestamp: t });
    if (i % 5 === 0) long.push({ role: "user", tool_results: [{ tool_use_id: `r${i}`, content: "ok" }], timestamp: (t += 1000) });
    if (i % 9 === 0) long.push({ role: "user", content: "[Request interrupted by user]", timestamp: (t += 1000) });
  }
  for (let i = 0; i < 30; i++) {
    t += 97 * MIN;
    long.push({ role: "user", content: `Sparse request ${i}: ${"move the unread badge and keep the avatar row aligned with the title. ".repeat(1 + (i % 5))}`, timestamp: t });
    t += 30_000;
    long.push({ role: "assistant", content: `Done with sparse step ${i}. ${"The badge now sits beside the title. ".repeat(i % 12)}`, timestamp: t });
  }
  long.push({ role: "user", content: "<task-notification>build finished</task-notification>", timestamp: (t += MIN) });
  long.push({ role: "user", content: "[image]", timestamp: (t += MIN) });
  long.push({ role: "assistant", content: "Final polish on the card: hover state, focus ring, and the empty state copy.", timestamp: (t += MIN) });

  const titled: TitleFixture = {
    name: "llm-titled-long",
    conversation: { title: "Inbox card redesign", subtitle: "- Reworked card spacing\n- In progress", message_count: long.length },
    messages: long,
  };

  const custom: TitleFixture = {
    name: "custom-title-quotes",
    conversation: { title: "My own name", title_is_custom: true, subtitle: "- earlier", message_count: 7 },
    messages: [
      { role: "user", content: 'Plan the "Q3 pricing" research: compare tiers\nand list risks', timestamp: T0 },
      { role: "assistant", content: "Here is a first pass at the tiers — free, team, enterprise.", timestamp: T0 + MIN },
      { role: "user", content: "Use the café survey numbers ☕ and keep it under a page", timestamp: T0 + 2 * MIN },
      { role: "assistant", content: `Draft: ${"Tier analysis with margins and churn assumptions. ".repeat(12)}`, timestamp: T0 + 3 * MIN },
      { role: "user", content: "<fork-boilerplate>ignore</fork-boilerplate>", timestamp: T0 + 4 * MIN },
      { role: "user", content: "Now turn it into a table with a recommendation row", timestamp: T0 + 5 * MIN },
      { role: "assistant", content: "Table added with a recommendation: raise team tier by 10%.", timestamp: T0 + 6 * MIN },
    ],
  };
  return [fresh, titled, custom];
}

const titleModules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./titleGeneration.ts": () => import("./titleGeneration"),
};

async function seedTitleFixture(fx: TitleFixture) {
  const t = convexTest(schema, titleModules);
  const ids = await t.run(async (ctx) => {
    const user_id = await ctx.db.insert("users", { name: "Fixture" } as any);
    const conversation_id = await ctx.db.insert("conversations", {
      user_id, agent_type: "claude_code", session_id: `s-${fx.name}`, started_at: T0, updated_at: T0,
      is_private: true, status: "active", ...fx.conversation,
    } as any);
    for (const m of fx.messages) await ctx.db.insert("messages", { conversation_id, ...m } as any);
    const task = await ctx.db.insert("tasks", {
      user_id, short_id: "ct-1", title: "Replace chokidar with fs.watch", task_type: "task", priority: "medium", source: "human",
      created_at: T0, updated_at: T0, description: `Cut file descriptor use. ${"The watcher holds one FD per directory. ".repeat(12)}`,
    } as any);
    const plan = await ctx.db.insert("plans", {
      user_id, short_id: "pl-1", title: "Unify the AI's context around the broker", status: "active", source: "human",
      created_at: T0, updated_at: T0, goal: "One render path for every channel.",
    } as any);
    return { conversation_id, task, plan };
  });
  return { t, ...ids };
}

describe("title request goldens", () => {
  const fetchStub = captureFetch();
  beforeEach(() => fetchStub.install());
  afterEach(() => fetchStub.restore());

  test("generateTitle posts the recorded body for each fixture", async () => {
    const actual: GoldenCase[] = [];
    for (const fx of titleFixtures()) {
      const { t, conversation_id } = await seedTitleFixture(fx);
      fetchStub.bodies.length = 0;
      await t.action(internal.titleGeneration.generateTitle, { conversation_id });
      expect(fetchStub.bodies.length).toBe(1);
      actual.push({ case: fx.name, body: fetchStub.bodies[0] });
    }
    expect(actual).toEqual(recordGolden("title", actual));
  });

  test("generateShortTitle posts the recorded body for a task, a plan and a session", async () => {
    const actual: GoldenCase[] = [];
    const { t, conversation_id, task, plan } = await seedTitleFixture(titleFixtures()[2]);
    for (const [name, id] of [["task", task], ["plan", plan], ["session", conversation_id]] as const) {
      fetchStub.bodies.length = 0;
      await t.action(internal.titleGeneration.generateShortTitle, { id });
      expect(fetchStub.bodies.length).toBe(1);
      actual.push({ case: name, body: fetchStub.bodies[0] });
    }
    expect(actual).toEqual(recordGolden("short-title", actual));
  });
});

// The evals hold a transcript, not a database: pickSpineRows plus
// selectTitleInput over the same rows must post the bytes the query path posts.
describe("title request from rows", () => {
  test("pickSpineRows + selectTitleInput + titleRequest equal the golden", () => {
    const golden = loadGolden("title");
    for (const fx of titleFixtures()) {
      const rows = fx.messages.map((m, i) => ({ _id: `m${i}`, ...m }));
      const input = selectTitleInput({ spine: pickSpineRows(rows), latest: rows.slice(-20).reverse() }, fx.conversation);
      const body = goldenBody(titleRequest(input));
      expect(body).toBe(golden.find((g) => g.case === fx.name)!.body);
    }
  });

  test("shortTitleRequest is the name-only pass on the cheap model", () => {
    const req = shortTitleRequest({ kind: "plan", title: "Unify the AI's context around the broker", context: "One render path for every channel." });
    expect(goldenBody(req)).toBe(loadGolden("short-title").find((g) => g.case === "plan")!.body);
  });
});

describe("firstPromptOf", () => {
  test("the first thing a person wrote, past tool results and harness noise", () => {
    expect(firstPromptOf([
      { role: "user", content: "tool output", tool_results: [{}] },
      { role: "user", content: "[Request interrupted by user]" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "  build a k pop\n music video  " },
      { role: "user", content: "later prompt" },
    ])).toBe("build a k pop music video");
  });

  test("a workflow subagent opens with its computed task, without the frame line", () => {
    expect(firstPromptOf([
      { role: "user", content: "[Workflow harness — user request] The harness relays...\n  lets go with twosaidyes.com" },
      { role: "user", content: "[Workflow harness — computed task] The task text below...\n  You are the creative director\n  making the final call" },
    ])).toBe("You are the creative director making the final call");
  });

  test("bounded, and absent when nobody wrote anything", () => {
    expect(firstPromptOf([{ role: "user", content: "x".repeat(900) }])!.length).toBe(400);
    expect(firstPromptOf([{ role: "assistant", content: "hi" }])).toBeUndefined();
  });
});

describe("a replaced title stays findable", () => {
  test("setTitleAndSubtitle keeps the generated title it replaces, and the sweep stamps the opening prompt", async () => {
    const t = convexTest(schema, titleModules);
    const conversation_id = await t.run(async (ctx) => {
      const user_id = await ctx.db.insert("users", { name: "Fixture" } as any);
      const id = await ctx.db.insert("conversations", {
        user_id, agent_type: "claude_code", session_id: "s-drift", started_at: 1, updated_at: 1,
        is_private: true, status: "active", message_count: 2, title: "build e2e a music vid",
      } as any);
      await ctx.db.insert("messages", { conversation_id: id, role: "user", content: "build e2e a music video with a k pop song", timestamp: 1 } as any);
      await ctx.db.insert("messages", { conversation_id: id, role: "assistant", content: "on it", timestamp: 2 } as any);
      return id;
    });
    const set = (title: string) => t.mutation(internal.titleGeneration.setTitleAndSubtitle, { conversation_id, title, subtitle: `about ${title}` });
    const read = () => t.run((ctx) => ctx.db.get(conversation_id)) as Promise<any>;

    // The daemon's placeholder is the prompt cut short: not a title worth keeping.
    await set("Union K-pop music video");
    expect((await read()).earlier_titles).toBeUndefined();
    await set("Warmintro landing site");
    await set("Warmintro landing site");
    expect((await read()).earlier_titles).toEqual(["Union K-pop music video"]);

    const swept = await t.mutation(internal.titleGeneration.sweepFirstPrompts, { cursor: 0 });
    expect(swept).toMatchObject({ stamped: 1, done: true });
    expect((await read()).first_prompt).toBe("build e2e a music video with a k pop song");
  });
});
