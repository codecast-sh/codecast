import { describe, expect, it } from "bun:test";
import { PLANS } from "@codecast/shared/contracts/assistant";
import { disconnectNote } from "./connectionWords";
import { formatDecisionAnswer } from "@codecast/shared/contracts";
import { gmailTools } from "@codecast/convex/convex/assistant/tools/gmail";
import { calendarTools } from "@codecast/convex/convex/assistant/tools/calendar";
import { codecastTools } from "@codecast/convex/convex/assistant/tools/codecast";
import { searchWebTool, webTools, WEB_SEARCH_TOOL } from "@codecast/convex/convex/assistant/tools/web";
import {
  APPROVAL_LABEL,
  HOME_DONE,
  LANE_COPY,
  connectionControls,
  homeView,
  meterLegend,
  planCard,
  topupLabel,
  workedTimes,
  LANE_PATHS,
  LANE_SECTIONS,
  STEPS_SHOWN,
  conversationSubline,
  draftIsLong,
  visibleSteps,
  approvalAsk,
  accountLine,
  mailSearch,
  answerTone,
  buildTranscript,
  conversationTitle,
  dollars,
  answerNotes,
  answersInline,
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
  routineLastRun,
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
    expect(conversationTitle({ title: "New session", last_user_message: "Find a time with Sam next week" })).toBe("Find a time with Sam next week");
    expect(conversationTitle({ title: "New session", last_user_message: "Tidy my inbox" })).toBe("Tidy my inbox");
    expect(conversationTitle({ title: "" })).toBe("A new conversation");
    expect(conversationTitle({ last_user_message: "x".repeat(100) }).length).toBeLessThanOrEqual(64);
  });

  it("puts each conversation in one band of home", () => {
    const NOW = 10_000_000;
    const live = { agent_status: "working", agent_status_updated_at: NOW - 1_000, last_heartbeat: NOW - 1_000, message_count: 3, updated_at: NOW - 1_000 };
    const stalled = { agent_status: "working", agent_status_updated_at: NOW - 3_600_000, last_heartbeat: NOW - 3_600_000, message_count: 3 };
    const row = (id: string, updated_at: number, extra: Record<string, unknown> = {}) =>
      ({ _id: id, updated_at, has_pending: false, ...extra }) as any;
    const bands = homeBands(
      [row("a", 1), row("b", 2, live), row("c", 3), row("d", 4, { has_pending: true }), row("e", 5), row("f", 6, stalled)],
      new Map([["c", 1]]),
      NOW,
    );
    expect(bands.waiting.map((r) => r._id)).toEqual(["c"]);
    expect(bands.working.map((r) => r._id)).toEqual(["b", "d"]);
    // A status frozen at "working" with no heartbeat settles, as in the inbox.
    expect(bands.done.map((r) => r._id)).toEqual(["f", "e", "a"]);
  });
});

describe("approvals", () => {
  it("labels a permission as an OK and a choice as an answer", () => {
    const opts = (...labels: string[]) => labels.map((label) => ({ label }));
    expect(APPROVAL_LABEL[approvalAsk({ kind: "single", options: opts("Send it", "Always allow", "Decline") } as any)]).toBe("Needs your OK");
    expect(APPROVAL_LABEL[approvalAsk({ kind: "single", options: opts("Milk", "Eggs", "Bread") } as any)]).toBe("Needs your answer");
    expect(APPROVAL_LABEL[approvalAsk({ kind: "multi", options: opts("Milk", "No thanks") } as any)]).toBe("Needs your answer");
  });

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
    expect(stepText({ name: "search_mail", input: { q: "newer_than:7d" } }, { content: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] })).toBe("Read 12 emails from the past week");
    expect(stepText({ name: "read_calendar", input: {} })).toBe("Checked your calendar");
    expect(stepText({ name: "create_event", input: { title: "Dinner with Sam" } })).toBe('Added "Dinner with Sam" to your calendar');
    expect(stepText({ name: "web_search", input: { query: "flights to Lisbon" } })).toBe('Searched the web for "flights to Lisbon"');
    expect(stepText({ name: "web_fetch", input: { url: "https://www.example.com/a" } })).toBe("Read a page on example.com");
  });

  it("prefers the sentence a tool wrote for itself", () => {
    expect(stepText({ name: "search_mail" }, { summary: "Read 12 emails from this week" })).toBe("Read 12 emails from this week");
  });

  it("never says a tool's name, even for one nobody has phrased", () => {
    expect(stepText({ name: "frobnicateWidgets" })).toBe("Did a step");
    expect(stepText({})).toBe("Did a step");
  });

  it("phrases every tool the hosted assistant has", () => {
    // Factories only build their definitions here; no call runs.
    const names = [
      ...gmailTools({} as any, { read_mail: true, modify_mail: true, send_mail: true }),
      ...calendarTools({} as any),
      ...codecastTools({} as any),
      ...webTools(),
      searchWebTool(),
    ].map((t) => t.name).concat(WEB_SEARCH_TOOL.name);
    expect(names.length).toBeGreaterThan(20);
    for (const name of names) {
      const line = stepText({ name });
      expect({ name, line }).toEqual({ name, line: expect.not.stringMatching(/^Used |^Did a step$|go-ahead/) });
    }
    expect(stepText({ name: "list_tasks" })).toBe("Checked your to-dos");
    expect(stepText({ name: "update_task" })).toBe("Updated a to-do");
    expect(stepText({ name: "archive" })).toBe("Tidied your inbox");
    expect(stepText({ name: "label" })).toBe("Tidied your inbox");
    expect(stepText({ name: "cancel_routine" })).toBe("Stopped a routine");
    expect(stepText({ name: "list_routines" })).toBe("Checked your routines");
    expect(stepText({ name: "replace_doc" })).toBe("Updated a note");
    expect(stepText({ name: "read_doc" })).toBe("Read a note");
    expect(stepText({ name: "recall" })).toBe("Remembered what you told me");
    expect(stepText({ name: "ask_user" })).toBe("Asked for your go-ahead");
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
      ["Read 2 unread emails", "done"],
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

  it("shows a failed send as failed, not pending", () => {
    const items = buildTranscript([{ _id: "p", role: "user", content: "hello", timestamp: 1, _isOptimistic: true, _isFailed: true } as LaneMessage], false);
    expect(items).toEqual([{ kind: "you", id: "p", text: "hello", pending: false, failed: true, at: 1 }]);
  });
});

describe("answering a card", () => {
  const opts = [{ label: "Send it" }, { label: "Always allow", description: "Add events to your calendar without asking first" }];
  it("answers a one-pick card inline and sends anything else to the conversation", () => {
    expect(answersInline({ options: opts })).toBe(true);
    expect(answersInline({ kind: "single", options: opts })).toBe(true);
    expect(answersInline({ kind: "multi", options: opts })).toBe(false);
    expect(answersInline({ kind: "form", options: [] })).toBe(false);
    expect(answersInline({ kind: "single", options: [] })).toBe(false);
  });
  it("shows what an answer means when it says", () => {
    expect(answerNotes(opts)).toEqual([{ label: "Always allow", note: "Add events to your calendar without asking first" }]);
    expect(answerNotes([{ label: "Yes", description: "  " }])).toEqual([]);
  });
});

describe("routines", () => {
  const now = new Date(2026, 9, 5, 10, 0).getTime();
  const lane = new Set(["c1"]);
  const ranAt = new Date(2026, 9, 5, 8, 0).getTime();

  it("says how the last run went, and never dresses a failure as a result", () => {
    expect(routineLastRun({ last_run_at: ranAt, last_run_summary: "Three meetings and a dentist reminder" }, now))
      .toEqual({ trouble: false, text: `Last ran ${whenSaid(ranAt, now)}: Three meetings and a dentist reminder` });
    const failed = routineLastRun({ last_run_at: ranAt, last_run_summary: "Failed: token expired", last_run_failed: true }, now)!;
    expect(failed.trouble).toBe(true);
    expect(failed.text).not.toContain("expired");
    expect(failed.text).not.toMatch(BANNED);
    expect(routineLastRun({ last_run_at: ranAt, last_run_summary: "Two need a reply", last_run_needs_attention: true }, now)!.trouble).toBe(true);
    expect(routineLastRun({ last_run_summary: "x" }, now)).toBeNull();
  });

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
    expect(routineSchedule({ schedule_type: "recurring", interval_ms: 86_400_000, run_at: tomorrow8, status: "scheduled" }, now)).toMatch(/^Runs every day\. Next: tomorrow at 8:00/);
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
    expect(planPrice(PLANS.free)).toBe("$0 a month");
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
    expect(missingAbilities({ read_mail: true, modify_mail: true, send_mail: true, calendar: true })).toBe(false);
    expect(missingAbilities({ read_mail: true, modify_mail: true, send_mail: false, calendar: true })).toBe(true);
    // Send alone cannot sort, label or draft: the assistant's mail tools need modify.
    expect(missingAbilities({ read_mail: true, modify_mail: false, send_mail: true, calendar: true })).toBe(true);
    expect(missingAbilities(null)).toBe(true);
  });
});

describe("billing return", () => {
  it("explains where Stripe sent the person back from", async () => {
    const { billingReturnNote } = await import("./lane");
    expect(billingReturnNote("done")).toBe("Your plan is updated. Thank you.");
    expect(billingReturnNote("canceled")).toBe("Checkout was canceled, so nothing changed.");
    expect(billingReturnNote(null)).toBeNull();
  });
});

describe("plan history", () => {
  it("signs each line by which way it moved extra credit", () => {
    expect(accountLine({ kind: "topup", amount_usd: 15 })).toEqual({ text: "Extra credit you bought", amount: "+$15.00" });
    expect(accountLine({ kind: "grant", amount_usd: 5 })).toEqual({ text: "Extra credit from us", amount: "+$5.00" });
    expect(accountLine({ kind: "refund", amount_usd: 6 })).toEqual({ text: "Refunded extra credit taken back", amount: "-$6.00" });
    expect(accountLine({ kind: "repay", amount_usd: 2.5 })).toEqual({ text: "Paid back what was owed", amount: "$2.50" });
  });

  it("says what a new month forgave, and leaves out a refund that took nothing", () => {
    expect(accountLine({ kind: "period_reset", amount_usd: 1.2 })).toEqual({ text: "A new month started", amount: null, detail: "$1.20 used the month before" });
    expect(accountLine({ kind: "period_reset", amount_usd: 0 })).toEqual({ text: "A new month started", amount: null });
    expect(accountLine({ kind: "refund", amount_usd: 0 })).toBeNull();
  });
});

describe("mail searches", () => {
  it("reads Gmail's search syntax as plain words", () => {
    expect(mailSearch("from:dana is:unread newer_than:7d")).toEqual({ unread: true, scope: " from Dana from the past week" });
    expect(mailSearch('from:"Dana Ruiz <dana@ruiz.studio>" subject:"kitchen plans"')).toEqual({ unread: false, scope: ' from Dana Ruiz about "kitchen plans"' });
    expect(mailSearch("invoice newer_than:3d -label:spam")).toEqual({ unread: false, scope: ' matching "invoice" from the past 3 days' });
    expect(mailSearch("has:attachment in:inbox")).toEqual({ unread: false, scope: "" });
  });

  it("says a search with no count by what it looked for", () => {
    expect(stepText({ name: "search_mail", input: { query: "from:sam@x.org" } })).toBe("Looked for emails from Sam");
    expect(stepText({ name: "search_mail", input: {} })).toBe("Looked through your email");
  });
});

describe("shared list and fold rules", () => {
  it("says where a live conversation stands, and what came of a settled one", () => {
    const row = { idle_summary: "Sent the reply to Dana", last_user_message: "Answer Dana" };
    expect(conversationSubline(row, "waiting")).toBe("Waiting on you");
    expect(conversationSubline(row, "working")).toBe("Working on it");
    expect(conversationSubline(row, "done")).toBe("Sent the reply to Dana");
    expect(conversationSubline({ last_user_message: "Answer Dana" }, "done")).toBe("Answer Dana");
    expect(conversationSubline({}, "done")).toBe("");
  });

  it("folds a long draft by length or by lines", () => {
    expect(draftIsLong("short")).toBe(false);
    expect(draftIsLong("x".repeat(421))).toBe(true);
    expect(draftIsLong(Array(10).fill("a").join("\n"))).toBe(true);
    expect(draftIsLong(Array(9).fill("a").join("\n"))).toBe(false);
  });

  it("never folds away a single step", () => {
    const steps = (n: number) => Array.from({ length: n }, (_, i) => i);
    expect(visibleSteps(steps(STEPS_SHOWN + 1), false)).toEqual({ shown: steps(STEPS_SHOWN + 1), more: 0 });
    const folded = visibleSteps(steps(9), false);
    expect(folded.shown).toEqual(steps(STEPS_SHOWN - 1));
    expect(folded.more).toBe(9 - (STEPS_SHOWN - 1));
    expect(visibleSteps(steps(9), true)).toEqual({ shown: steps(9), more: 0 });
  });

  it("lists every lane surface once, home first", () => {
    expect(LANE_SECTIONS[0].path).toBe(LANE_PATHS.home);
    expect(new Set(LANE_SECTIONS.map((t) => t.path)).size).toBe(LANE_SECTIONS.length);
  });
});

describe("page rules shared by the web and the phone", () => {
  const row = (id: string) => ({ _id: id });
  it("home leaves out waiting rows an approval card already covers", () => {
    const bands = { waiting: [row("a"), row("b")], working: [], done: Array.from({ length: HOME_DONE + 2 }, (_, i) => row(`d${i}`)) };
    const view = homeView(bands as any, new Map([["a", 1]]), 10, true, false);
    expect(view.waitingRows.map((r) => r._id)).toEqual(["b"]);
    expect(view.done.length).toBe(HOME_DONE);
    expect(view.moreDone).toBe(2);
    expect(homeView(bands as any, new Map(), 10, true, true).moreDone).toBe(0);
  });

  it("home tells an empty list from one that has not loaded", () => {
    const empty = { waiting: [], working: [], done: [] };
    expect(homeView(empty, new Map(), 0, true, false)).toMatchObject({ nothingYet: true, loading: false });
    expect(homeView(empty, new Map(), 0, false, false)).toMatchObject({ nothingYet: false, loading: true });
  });

  it("a plan card offers nothing until the wallet and billing have answered", () => {
    const figures = { known: true, plan: { id: "free" as const }, upgrades: new Set<any>(["plus", "pro"]) };
    expect(planCard("free", figures, { known: true, plans: ["plus"] })).toEqual({ current: true, offer: null });
    expect(planCard("plus", figures, { known: true, plans: ["plus"] })).toEqual({ current: false, offer: "checkout" });
    expect(planCard("pro", figures, { known: true, plans: ["plus"] })).toEqual({ current: false, offer: "ask" });
    expect(planCard("plus", figures, { known: false, plans: [] }).offer).toBeNull();
    expect(planCard("free", { ...figures, known: false }, { known: true, plans: ["plus"] })).toEqual({ current: false, offer: null });
  });

  it("says top-ups, turns and the meter in plain words", () => {
    expect(topupLabel(10).label).toBe("Add $10");
    expect(topupLabel(10).note).toMatch(/of extra work$/);
    expect(workedTimes(1)).toBe("Worked on it once");
    expect(workedTimes(3)).toBe("Worked on it 3 times");
    const legend = meterLegend({ used_usd: 1, cap_usd: 5, reserved_usd: 0.5, topup_usd: -2 }, "October 21");
    expect(legend.map((l) => `${l.strong ?? ""}${l.rest}`)).toEqual([
      "$1.00 of $5.00 used",
      "$0.50 set aside for work in progress",
      "$2.00 owed for refunded extra credit, taken from next month's allowance first",
      "Starts fresh October 21",
    ]);
  });

  it("a disconnect question stands alone on the Google row", () => {
    const can = { read_mail: true, modify_mail: false, send_mail: false, calendar: false };
    expect(connectionControls({ connected: false, can: null, canDisconnect: false }, false)).toEqual({ connect: true, allow: false, confirm: false, disconnect: null });
    expect(connectionControls({ connected: true, can, canDisconnect: true }, false)).toEqual({ connect: false, allow: true, confirm: false, disconnect: "on" });
    expect(connectionControls({ connected: true, can, canDisconnect: true }, true)).toEqual({ connect: false, allow: false, confirm: true, disconnect: null });
    expect(connectionControls({ connected: true, can, canDisconnect: false }, false).disconnect).toBe("off");
  });

  it("names who a disconnect is for", () => {
    expect(LANE_COPY.connections.disconnectAsk("dana@x.com")).toBe("Disconnect dana@x.com?");
    expect(LANE_COPY.connections.disconnectAsk(undefined)).toBe("Disconnect Google?");
  });
});

describe("the note under the Google card", () => {
  it("reassures someone who has not connected, rather than warning about a disconnect", () => {
    const note = disconnectNote(false, undefined, []);
    expect(note).toBe("You can disconnect any time, and I stop right away.");
    expect(note).not.toContain("Disconnecting");
  });

  it("says what a disconnect stops once connected", () => {
    expect(disconnectNote(true, "dana@x.com", [])).toContain("Disconnecting stops me");
    expect(disconnectNote(true, "dana@x.com", [{ email: "dana@work.com" }])).toContain("I would use dana@work.com instead");
  });
});

describe("the lane's spoken tab names", () => {
  it("adds what is waiting only when something is", () => {
    expect(LANE_COPY.tabs.label("Approvals", 0)).toBe("Approvals");
    expect(LANE_COPY.tabs.label("Approvals", 2)).toBe("Approvals, 2 waiting");
  });
});
