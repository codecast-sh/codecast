import { describe, expect, it } from "bun:test";
import { PLANS } from "@codecast/shared/contracts/assistant";
import { formatDecisionAnswer } from "@codecast/shared/contracts";
import {
  answerTone,
  buildTranscript,
  conversationTitle,
  dollars,
  firstAsk,
  greeting,
  homeBands,
  isLaneConversation,
  isLaneRoutine,
  laneOf,
  meterFill,
  personName,
  planPoints,
  planPrice,
  routineSchedule,
  runsToday,
  stepText,
  upgradesFrom,
  usageHeadline,
  whenSaid,
  type LaneMessage,
} from "./lane";

const BANNED = /\b(agent|session|model|token|repo|repository|device)s?\b/i;

describe("lane preference", () => {
  it("is the full app unless set to simple", () => {
    expect(laneOf(undefined)).toBe("full");
    expect(laneOf({})).toBe("full");
    expect(laneOf({ lane: "full" })).toBe("full");
    expect(laneOf({ lane: "simple" })).toBe("simple");
  });
});

describe("conversations", () => {
  it("lists hosted conversations only, and not killed ones", () => {
    expect(isLaneConversation({ agent_type: "codecast" })).toBe(true);
    expect(isLaneConversation({ agent_type: "claude_code" })).toBe(false);
    expect(isLaneConversation({ agent_type: "codecast", inbox_killed_at: 5 })).toBe(false);
  });

  it("names a conversation by its title, then by what was asked", () => {
    expect(conversationTitle({ title: "Planning the Lisbon trip" })).toBe("Planning the Lisbon trip");
    expect(conversationTitle({ title: "New session" }, "Find a time with Sam next week")).toBe("Find a time with Sam next week");
    expect(conversationTitle({ title: "New session", last_user_message: "Tidy my inbox" })).toBe("Tidy my inbox");
    expect(conversationTitle({ title: "" })).toBe("A new conversation");
    expect(conversationTitle(null, "x".repeat(100)).length).toBeLessThanOrEqual(64);
  });

  it("puts each conversation in one band of home", () => {
    const row = (id: string, updated_at: number, extra: Record<string, unknown> = {}) =>
      ({ _id: id, updated_at, has_pending: false, ...extra }) as any;
    const bands = homeBands(
      [row("a", 1), row("b", 2, { agent_status: "working" }), row("c", 3), row("d", 4, { has_pending: true }), row("e", 5)],
      new Map([["c", 1]]),
    );
    expect(bands.waiting.map((r) => r._id)).toEqual(["c"]);
    expect(bands.working.map((r) => r._id)).toEqual(["d", "b"]);
    expect(bands.done.map((r) => r._id)).toEqual(["e", "a"]);
  });
});

describe("approvals", () => {
  it("makes the first answer the yes and a refusal quiet", () => {
    expect(answerTone("Approve", 0)).toBe("yes");
    expect(answerTone("Always allow", 1)).toBe("plain");
    expect(answerTone("Decline", 2)).toBe("no");
    expect(answerTone("Don't send", 1)).toBe("no");
  });
});

describe("tool steps", () => {
  it("reads common tools as plain lines", () => {
    expect(stepText({ name: "send_email", input: { to: "dana@example.com", body: "hi" } })).toBe("Sent an email to Dana");
    expect(stepText({ name: "draft_reply", input: JSON.stringify({ to: "Dana Ruiz <dana@x.org>" }) })).toBe("Drafted a reply to Dana Ruiz");
    expect(stepText({ name: "search_mail", input: { q: "newer_than:7d" } }, { content: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] })).toBe('Read 12 emails matching "newer_than:7d"');
    expect(stepText({ name: "read_calendar", input: {} })).toBe("Checked your calendar");
    expect(stepText({ name: "create_event", input: { title: "Dinner with Sam" } })).toBe('Added "Dinner with Sam" to your calendar');
    expect(stepText({ name: "web_search", input: { query: "flights to Lisbon" } })).toBe('Searched the web for "flights to Lisbon"');
    expect(stepText({ name: "web_fetch", input: { url: "https://www.example.com/a" } })).toBe("Read a page on example.com");
  });

  it("prefers the sentence a tool wrote for itself", () => {
    expect(stepText({ name: "search_mail" }, { summary: "Read 12 emails from this week" })).toBe("Read 12 emails from this week");
  });

  it("falls back to the tool's name in words", () => {
    expect(stepText({ name: "lookupWeather" })).toBe("Used lookup weather");
    expect(stepText({})).toBe("Did a step");
  });

  it("names people from addresses", () => {
    expect(personName("sam.lee@x.org")).toBe("Sam");
    expect(personName(["a@x.org", "b@x.org", "c@x.org"])).toBe("A and 2 others");
    expect(personName("")).toBeNull();
  });
});

describe("transcript", () => {
  const msgs: LaneMessage[] = [
    { _id: "u1", role: "user", content: "What needs a reply from me this week?", timestamp: 1 },
    { _id: "a1", role: "assistant", content: "", timestamp: 2, tool_calls: [{ id: "c1", name: "search_mail", input: { q: "is:unread" } }, { id: "c2", name: "draft_reply", input: { to: "dana@x.org" } }] },
    { _id: "r1", role: "user", timestamp: 3, tool_results: [{ tool_use_id: "c1", content: [1, 2] }, { tool_use_id: "c2", content: "ok", is_error: true }] },
    { _id: "a2", role: "assistant", content: "Two need you. I drafted one for Dana.", timestamp: 4 },
    { _id: "u2", role: "user", content: formatDecisionAnswer({ id: "d1", question: "Send this reply to Dana?", answer: "Approve" }), timestamp: 5 },
    { _id: "a3", role: "assistant", content: "", timestamp: 6, tool_calls: [{ id: "c3", name: "send_email", input: { to: "dana@x.org" } }] },
  ];

  it("folds tool calls into step lists and keeps the words", () => {
    const items = buildTranscript(msgs, true);
    expect(items.map((i) => i.kind)).toEqual(["you", "steps", "said", "answer", "steps"]);
    const steps = items[1] as Extract<(typeof items)[number], { kind: "steps" }>;
    expect(steps.steps.map((s) => [s.text, s.state])).toEqual([
      ['Read 2 emails matching "is:unread"', "done"],
      ["Drafted a reply to Dana", "failed"],
    ]);
    expect((items[3] as any).text).toBe("You said: Approve");
    expect((items[4] as any).steps[0].state).toBe("running");
  });

  it("settles an unanswered step once the turn is over", () => {
    const items = buildTranscript(msgs, false);
    expect((items[4] as any).steps[0].state).toBe("done");
  });

  it("shows an unsent message as pending", () => {
    const items = buildTranscript([{ _id: "p", role: "user", content: "hello", timestamp: 1, _isOptimistic: true }], false);
    expect(items).toEqual([{ kind: "you", id: "p", text: "hello", pending: true, failed: false, at: 1 }]);
  });

  it("finds the first ask", () => {
    expect(firstAsk(msgs)).toBe("What needs a reply from me this week?");
    expect(firstAsk([])).toBeNull();
  });
});

describe("routines", () => {
  const now = new Date(2026, 9, 5, 10, 0).getTime();
  const lane = new Set(["c1"]);

  it("lists live routines bound to the lane's conversations", () => {
    expect(isLaneRoutine({ status: "scheduled", originating_conversation_id: "c1" }, lane)).toBe(true);
    expect(isLaneRoutine({ status: "paused", originating_conversation_id: "c1" }, lane)).toBe(true);
    expect(isLaneRoutine({ status: "completed", originating_conversation_id: "c1" }, lane)).toBe(false);
    expect(isLaneRoutine({ status: "scheduled", originating_conversation_id: "other" }, lane)).toBe(false);
  });

  it("says when", () => {
    expect(whenSaid(new Date(2026, 9, 5, 18, 0).getTime(), now)).toMatch(/^today at 6:00/);
    expect(whenSaid(new Date(2026, 9, 6, 8, 0).getTime(), now)).toMatch(/^tomorrow at 8:00/);
  });

  it("says a schedule in one sentence", () => {
    const tomorrow8 = new Date(2026, 9, 6, 8, 0).getTime();
    expect(routineSchedule({ schedule_type: "recurring", interval_ms: 86_400_000, run_at: tomorrow8, status: "scheduled" }, now)).toMatch(/^Runs every day, next tomorrow at 8:00/);
    expect(routineSchedule({ schedule_type: "recurring", interval_ms: 86_400_000, status: "paused" }, now)).toBe("Paused. Runs every day when it's on");
    expect(routineSchedule({ schedule_type: "once", run_at: tomorrow8, status: "scheduled" }, now)).toMatch(/^Runs once, tomorrow/);
  });

  it("knows what runs today", () => {
    expect(runsToday({ status: "scheduled", run_at: now + 3_600_000 }, now)).toBe(true);
    expect(runsToday({ status: "scheduled", run_at: now + 86_400_000 }, now)).toBe(false);
    expect(runsToday({ status: "paused", run_at: now + 60_000 }, now)).toBe(false);
  });
});

describe("usage", () => {
  it("never fills the meter past full", () => {
    expect(meterFill({ used_usd: 3, reserved_usd: 1, cap_usd: 2, topup_usd: 0 })).toEqual({ used: 1, held: 0 });
    expect(meterFill({ used_usd: 0.5, reserved_usd: 0.5, cap_usd: 2, topup_usd: 0 })).toEqual({ used: 0.25, held: 0.25 });
  });

  it("says how much is used", () => {
    expect(usageHeadline({ used_usd: 0, reserved_usd: 0, cap_usd: 2, topup_usd: 0 })).toBe("Nothing used yet this month");
    expect(usageHeadline({ used_usd: 0.5, reserved_usd: 0, cap_usd: 2, topup_usd: 0 })).toBe("25% of this month's allowance used");
    expect(usageHeadline({ used_usd: 2, reserved_usd: 0, cap_usd: 2, topup_usd: 0 })).toBe("You've used all of this month's allowance");
  });

  it("describes each plan from the catalog, in plain words", () => {
    for (const plan of Object.values(PLANS)) {
      for (const line of [...planPoints(plan), planPrice(plan)]) expect(line).not.toMatch(BANNED);
    }
    expect(planPrice(PLANS.free)).toBe("Free");
    expect(planPrice(PLANS.plus)).toBe("$20 a month");
    expect(planPoints(PLANS.free)[1]).toBe("3 routines, at most every day");
    expect(upgradesFrom("free").map((p) => p.id)).toEqual(["plus", "pro"]);
    expect(upgradesFrom("pro")).toEqual([]);
    expect(dollars(1.5)).toBe("$1.50");
  });
});

describe("greeting", () => {
  it("greets by the time of day and first name", () => {
    expect(greeting(new Date(2026, 9, 5, 9).getTime(), "Ashot Petrosian")).toBe("Good morning, Ashot");
    expect(greeting(new Date(2026, 9, 5, 20).getTime(), null)).toBe("Good evening");
  });
});

describe("connections", () => {
  it("says a missing Google setup plainly", async () => {
    const { plainConnectError, missingAbilities } = await import("./lane");
    expect(plainConnectError("Google OAuth not configured (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET)")).toBe("Connecting Google isn't switched on here yet.");
    expect(plainConnectError("Couldn't reach Gmail")).toBe("Couldn't reach Gmail");
    expect(plainConnectError(null)).toBeNull();
    expect(missingAbilities({ read_mail: true, send_mail: true, calendar: true })).toBe(false);
    expect(missingAbilities({ read_mail: true, send_mail: false, calendar: true })).toBe(true);
    expect(missingAbilities(null)).toBe(true);
  });
});
