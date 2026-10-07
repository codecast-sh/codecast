import { describe, expect, it } from "bun:test";
import { PLANS } from "@codecast/shared/contracts/assistant";
import { disconnectNote, mailboxLine } from "./connectionWords";
import { formatDecisionAnswer } from "@codecast/shared/contracts";
import { calendarTools, mailTools } from "@platform/assistant";
import { codecastTools } from "@codecast/convex/convex/assistant/tools/codecast";
import { searchWebTool, webTools, WEB_SEARCH_TOOL } from "@codecast/convex/convex/assistant/tools/web";
import {
  APPROVAL_LABEL,
  HOME_DONE,
  LANE_COPY,
  connectionControls,
  meterLegend,
  planCard,
  topupLabel,
  workedTimes,
  ledgerLines,
  meterOut,
  meterShort,
  monthPercent,
  monthShare,
  LANE_PATHS,
  LANE_SECTIONS,
  laneSurfaceLabel,
  conversationPath,
  conversationState,
  conversationSubline,
  approvalAsk,
  accountLine,
  answerTone,
  answerNote,
  conversationTitle,
  titleIsAsk,
  dollars,
  answerNotes,
  answersInline,
  isLaneConversation,
  laneOf,
  meterFill,
  planPoints,
  planPrice,
  routineSchedule,
  routineLastRun,
  stepText,
  upgradesFrom,
  usageHeadline,
  whenSaid,
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
    // The same placeholder the server stores at start (promptTitle): whole,
    // capped only for safety, and never with an ellipsis of its own (each
    // surface truncates with CSS).
    expect(conversationTitle({ last_user_message: "x".repeat(300) }).length).toBeLessThanOrEqual(140);
    expect(conversationTitle({ last_user_message: "word ".repeat(60) }).endsWith("…")).toBe(false);
    // The first sentence, cut at a word with no word split.
    expect(conversationTitle({ last_user_message: "Design check: what's on my calendar tomorrow? Also look at Friday." })).toBe("Design check: what's on my calendar tomorrow?");
    expect(conversationTitle({ last_user_message: "Compare the three best rated robot vacuums for a small apartment" })).toBe("Compare the three best rated robot vacuums for a small apartment");
    expect(conversationTitle({ last_user_message: "Plan a trip to Lisbon." })).toBe("Plan a trip to Lisbon");
  });

  it("is done the moment a hosted turn says it ended, and working again on the next ask", () => {
    const NOW = 10_000_000;
    const fresh = { agent_status_updated_at: NOW - 1_000, last_heartbeat: NOW - 1_000, updated_at: NOW - 1_000, message_count: 4, has_pending: false, awaiting_input: false };
    // The answer just landed: inside the idle grace, and still done.
    expect(conversationState({ ...fresh, agent_status: "done", last_role_is_user: false } as any, 0, NOW)).toBe("done");
    // The person replied and the next turn has not begun: on it.
    expect(conversationState({ ...fresh, agent_status: "done", last_role_is_user: true } as any, 0, NOW)).toBe("working");
    expect(conversationState({ ...fresh, agent_status: "working", last_role_is_user: false } as any, 0, NOW)).toBe("working");
    expect(conversationState({ ...fresh, agent_status: "done", last_role_is_user: false } as any, 1, NOW)).toBe("waiting");
  });
});

describe("approvals", () => {
  it("labels a permission as an OK and a choice as an answer", () => {
    const opts = (...labels: string[]) => labels.map((label) => ({ label }));
    expect(APPROVAL_LABEL[approvalAsk({ kind: "single", options: opts("Send it", "Always allow", "Decline") } as any)]).toBe("Needs your OK");
    expect(APPROVAL_LABEL[approvalAsk({ kind: "single", options: opts("Milk", "Eggs", "Bread") } as any)]).toBe("Needs your answer");
    expect(APPROVAL_LABEL[approvalAsk({ kind: "multi", options: opts("Milk", "No thanks") } as any)]).toBe("Needs your answer");
  });

  it("drops the answer note for a decline, which the declined step already says", () => {
    expect(answerNote("Approve")).toBe("You said: Approve");
    expect(answerNote("Always allow")).toBe("You said: Always allow");
    // A plain decline, and a decline the assistant follows with a new ask:
    // the rule reads the answer alone, so neither waits on the step's result.
    expect(answerNote("Decline")).toBeNull();
    expect(answerNote(" Decline ")).toBeNull();
    // The person's own words are more than a no, and always show.
    expect(answerNote("No, make it 9am")).toBe("You said: No, make it 9am");
    expect(answerNote("")).toBeNull();
    expect(answerNote(undefined)).toBeNull();
  });

  it("makes the first answer the yes and a refusal quiet", () => {
    expect(answerTone("Approve", 0)).toBe("yes");
    expect(answerTone("Always allow", 1)).toBe("plain");
    expect(answerTone("Decline", 2)).toBe("no");
    expect(answerTone("Don't send", 1)).toBe("no");
  });
});

// The step wording itself is tested in @platform/assistant (steps.test.ts);
// this checks it covers every tool codecast's assistant offers.
describe("tool steps", () => {
  /** A step that came back fine. */
  const DONE = { content: "ok" };

  it("phrases every tool the hosted assistant has", () => {
    // Factories only build their definitions here; no call runs.
    const names = [
      ...mailTools({} as any, { read_mail: true, modify_mail: true, send_mail: true }),
      ...calendarTools({} as any),
      ...codecastTools({} as any),
      ...webTools(),
      searchWebTool(),
    ].map((t) => t.name).concat(WEB_SEARCH_TOOL.name);
    expect(names.length).toBeGreaterThan(20);
    for (const name of names) {
      const line = stepText({ name }, DONE);
      expect({ name, line }).toEqual({ name, line: expect.not.stringMatching(/^Used |^Did a step$|go-ahead/) });
    }
    expect(stepText({ name: "list_tasks" }, DONE)).toBe("Checked your to-dos");
    expect(stepText({ name: "update_task" }, DONE)).toBe("Updated a to-do");
    expect(stepText({ name: "archive" }, DONE)).toBe("Tidied your inbox");
    expect(stepText({ name: "label" }, DONE)).toBe("Tidied your inbox");
    expect(stepText({ name: "cancel_routine" }, DONE)).toBe("Stopped a routine");
    expect(stepText({ name: "list_routines" }, DONE)).toBe("Checked your routines");
    expect(stepText({ name: "replace_doc" }, DONE)).toBe("Updated a note");
    expect(stepText({ name: "read_doc" }, DONE)).toBe("Read a note");
    expect(stepText({ name: "recall" }, DONE)).toBe("Remembered what you told me");
    expect(stepText({ name: "ask_user" }, DONE)).toBe("Asked for your go-ahead");
    expect(stepText({ name: "suggest_reply" }, DONE)).toBe("Wrote a reply in your voice");
    expect(stepText({ name: "summarize_thread" }, DONE)).toBe("Summed up an email");
    expect(stepText({ name: "draft_reply", input: { to: "Dana <dana@x.com>" } }, DONE)).toBe("Drafted a reply to Dana");
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
  it("leaves the yes and the no of a permission card to say themselves", () => {
    const card = [
      { label: "Approve", description: "Do this once." },
      { label: "Always allow", description: "Set up routines without asking first" },
      { label: "Decline", description: "Don't do it." },
    ];
    expect(answerNotes(card)).toEqual([{ label: "Always allow", note: "Set up routines without asking first" }]);
    // A choice has no refusal, so each described answer keeps its note.
    const choice = [{ label: "Morning", description: "Before 9" }, { label: "Evening", description: "After 6" }];
    expect(answerNotes(choice)).toHaveLength(2);
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

  it("says when", () => {
    expect(whenSaid(new Date(2026, 9, 5, 18, 0).getTime(), now)).toMatch(/^today at 6:00/);
    expect(whenSaid(new Date(2026, 9, 6, 8, 0).getTime(), now)).toMatch(/^tomorrow at 8:00/);
  });

  it("says a schedule the way the web routine row does", () => {
    const tomorrow8 = new Date(2026, 9, 6, 8, 0).getTime();
    expect(routineSchedule({ schedule_type: "recurring", interval_ms: 86_400_000, run_at: tomorrow8, status: "scheduled" }, now)).toMatch(/^Every day at 8:00\sAM\. Tomorrow$/);
    // A weekday routine reads its wall clock, not "every day" from its interval.
    const weekdays = { zone: "America/New_York", minutes: 480, weekdays: [1, 2, 3, 4, 5] };
    expect(routineSchedule({ schedule_type: "recurring", interval_ms: 86_400_000, run_at: tomorrow8, cadence: weekdays, status: "scheduled" }, now)).toBe("Weekdays at 8:00 AM. Tomorrow");
    expect(routineSchedule({ schedule_type: "recurring", interval_ms: 86_400_000, cadence: weekdays, status: "paused" }, now)).toBe("Paused. Weekdays at 8:00 AM when it's on");
    expect(routineSchedule({ schedule_type: "once", run_at: tomorrow8, status: "scheduled" }, now)).toMatch(/^Once, Oct 6 at 8:00/);
    expect(routineSchedule({ schedule_type: "event", event_filter: { event_type: "pr_comment" }, status: "scheduled" }, now)).toMatch(/^On /);
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

  it("holds only when the allowance and the extra credit are both spent", () => {
    const onCredit = { used_usd: 2, reserved_usd: 0, cap_usd: 2, topup_usd: 5 };
    expect(meterOut(onCredit)).toBe(false);
    expect(meterShort(onCredit)).toBe("Allowance used, on extra credit");
    expect(usageHeadline(onCredit)).toBe("This month's allowance is used up, so your extra credit is in use");
    const spent = { ...onCredit, topup_usd: 0 };
    expect(meterOut(spent)).toBe(true);
    expect(meterShort(spent)).toBe("All used this month");
  });

  it("rounds every percent of the month one way, so the sidebar and the Plan page agree", () => {
    const tiny = { used_usd: 0.01, reserved_usd: 0, cap_usd: 3, topup_usd: 0 };
    expect(usageHeadline(tiny)).toBe("Under 1% of this month's allowance used");
    expect(meterShort(tiny)).toBe("Under 1% used this month");
    expect(monthPercent(0)).toBe("0%");
    expect(monthPercent(0.004)).toBe("under 1%");
    expect(monthPercent(0.996)).toBe("99%");
    expect(monthPercent(0.25)).toBe("25%");
    expect(monthShare(0.6, 2)).toBe("30% of a month");
  });

  it("describes each plan from the catalog, in plain words", () => {
    for (const plan of Object.values(PLANS)) {
      for (const line of [...planPoints(plan), planPrice(plan)]) expect(line).not.toMatch(BANNED);
    }
    expect(planPrice(PLANS.free)).toBe("$0 a month");
    expect(planPrice(PLANS.plus)).toBe("$20 a month");
    // The Free month is sized in measured everyday requests ($2 at $0.005 each, said as 400).
    expect(planPoints(PLANS.free)[0]).toBe("Room for about 400 everyday requests a month");
    expect(planPoints(PLANS.plus)[0]).toBe("6 times the Free allowance each month");
    expect(planPoints(PLANS.free)[1]).toBe("3 routines, at most every day");
    // The global hourly floor shows on every plan, so the card promises what the server allows.
    expect(planPoints(PLANS.plus)[1]).toBe("25 routines, at most every hour");
    expect(planPoints(PLANS.pro)[1]).toBe("Unlimited routines, at most every hour");
    expect(upgradesFrom("free").map((p) => p.id)).toEqual(["plus", "pro"]);
    expect(upgradesFrom("pro")).toEqual([]);
    expect(dollars(1.5)).toBe("$1.50");
  });
});

describe("connections", () => {
  it("says a missing mail setup plainly", async () => {
    const { plainConnectError, missingAbilities, MAIL_CONNECT_CLOSED } = await import("./lane");
    expect(plainConnectError("whisk_not_configured")).toBe("Connecting mail and calendar isn't switched on here yet.");
    expect(plainConnectError("Google OAuth not configured (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET)")).toBe("Connecting mail and calendar isn't switched on here yet.");
    expect(plainConnectError("Couldn't reach Gmail")).toBe("Couldn't reach Gmail");
    // A thrown error's text never reaches the person.
    expect(plainConnectError("[CONVEX A(whisk:getConnectUrl)] [Request ID: 1a2b] Server Error ArgumentValidationError: Object contains extra field `origin`")).toBe(MAIL_CONNECT_CLOSED);
    expect(plainConnectError("whisk_invalid_grant")).toContain("expired or was already used");
    // Codes from the connect return read through the connectors' one table.
    expect(plainConnectError("access_denied")).toBe("You declined the authorization.");
    expect(plainConnectError("wrong_account")).toContain("different account");
    expect(plainConnectError(null)).toBeNull();
    expect(missingAbilities({ read_mail: true, modify_mail: true, send_mail: true, calendar: true })).toBe(false);
    expect(missingAbilities({ read_mail: true, modify_mail: true, send_mail: false, calendar: true })).toBe(true);
    // Send alone cannot sort, label or draft: the assistant's mail tools need modify.
    expect(missingAbilities({ read_mail: true, modify_mail: false, send_mail: true, calendar: true })).toBe(true);
    expect(missingAbilities(null)).toBe(true);
  });
});

describe("billing return", () => {
  it("explains where Stripe sent the person back from, and waits for the payment to land", async () => {
    const { billingReturnNote } = await import("./lane");
    expect(billingReturnNote("done", true)).toEqual({ text: "Your plan is updated. Thank you.", tone: "done" });
    expect(billingReturnNote("done", false)?.tone).toBe("pending");
    expect(billingReturnNote("topup", false)?.text).toContain("as soon as Stripe confirms");
    expect(billingReturnNote("canceled", true)).toEqual({ text: "Checkout was canceled, so nothing changed.", tone: "plain" });
    expect(billingReturnNote(null, true)).toBeNull();
    // Past the wait, a payment still missing points to support; a settled one never does.
    const late = billingReturnNote("done", false, true)!;
    expect(late.tone).toBe("late");
    expect(late.support).toEqual({ subject: "My new plan hasn't shown up", link: "write to us", after: " and we'll sort it out." });
    expect(late.text + late.support!.link + late.support!.after).toBe("Your new plan hasn't reached your account yet. If Stripe charged you, write to us and we'll sort it out.");
    expect(billingReturnNote("topup", false, true)?.support?.subject).toBe("My extra credit hasn't shown up");
    expect(billingReturnNote("done", true, true)?.tone).toBe("done");
    expect(billingReturnNote("canceled", true, true)?.support).toBeUndefined();
  });

  it("counts a plan settled once the subscription is live, and a top-up once its credit is on the account", async () => {
    const { billingReturnSettled } = await import("./lane");
    const now = 1_000_000_000;
    const wallet = (subscription_status: string | null, account: { kind: "topup" | "grant"; at: number }[] = []) =>
      ({ subscription_status, account: account.map((line) => ({ ...line, amount_usd: 6 })) });
    expect(billingReturnSettled("done", null, now)).toBe(false);
    expect(billingReturnSettled("done", wallet(null), now)).toBe(false);
    expect(billingReturnSettled("done", wallet("incomplete"), now)).toBe(false);
    expect(billingReturnSettled("done", wallet("active"), now)).toBe(true);
    expect(billingReturnSettled("topup", wallet(null, [{ kind: "topup", at: now - 60 * 60_000 }]), now)).toBe(false);
    expect(billingReturnSettled("topup", wallet(null, [{ kind: "grant", at: now }]), now)).toBe(false);
    // The webhook may land a little before the person is back.
    expect(billingReturnSettled("topup", wallet(null, [{ kind: "topup", at: now - 30_000 }]), now)).toBe(true);
    expect(billingReturnSettled("canceled", null, now)).toBe(true);
  });
});

describe("plan history", () => {
  it("says each line as a sentence, its amount a share of a month on the named plan", () => {
    // Work is a share of the plan's month (Plus: $12 of work), never dollars, and never a signed badge.
    expect(accountLine({ kind: "topup", amount_usd: 15 }, PLANS.plus)).toEqual({ text: "Extra credit you bought: about a month on Plus" });
    expect(accountLine({ kind: "grant", amount_usd: 6 }, PLANS.plus)).toEqual({ text: "Extra credit from us: about half a month on Plus" });
    expect(accountLine({ kind: "refund", amount_usd: 3 }, PLANS.plus)).toEqual({ text: "Refunded extra credit taken back: about a quarter of a month on Plus" });
    expect(accountLine({ kind: "repay", amount_usd: 1.2 }, PLANS.plus)).toEqual({ text: "Paid back what was owed: about 10% of a month on Plus" });
    expect(accountLine({ kind: "grant", amount_usd: 0.05 }, PLANS.plus)).toEqual({ text: "Extra credit from us: under 1% of a month on Plus" });
  });

  it("says what a new month used, and leaves out a refund that took nothing", () => {
    expect(accountLine({ kind: "period_reset", amount_usd: 1.2 }, PLANS.free)).toEqual({ text: "A new month started", detail: "60% of the month before used" });
    expect(accountLine({ kind: "period_reset", amount_usd: 0 }, PLANS.free)).toEqual({ text: "A new month started" });
    expect(accountLine({ kind: "refund", amount_usd: 0 }, PLANS.free)).toBeNull();
  });
});

describe("shared list and fold rules", () => {
  it("says where a live conversation stands, and what came of a settled one", () => {
    const row = { idle_summary: "Sent the reply to Dana", last_user_message: "Answer Dana" };
    expect(conversationSubline(row, "waiting")).toBe("Waiting on you");
    expect(conversationSubline(row, "working")).toBe("Working on it");
    expect(conversationSubline(row, "done")).toBe("Sent the reply to Dana");
    expect(conversationSubline({ title: "Dana's email", last_user_message: "Answer Dana" }, "done")).toBe("Answer Dana");
    // While the title is still the person's ask, the ask is not said twice.
    const untitled = { title: "New session", last_user_message: "Set up a routine: every weekday at 8am, send me the weather for the day ahead" };
    expect(titleIsAsk(untitled)).toBe(true);
    expect(titleIsAsk({ title: "Weekday weather", last_user_message: "Set up a routine" })).toBe(false);
    expect(titleIsAsk({ title: "" })).toBe(false);
    expect(conversationSubline(untitled, "done")).toBe("");
    expect(conversationSubline(untitled, "working")).toBe("Working on it");
    // A row waiting on an answer says what it asks, not a state word.
    expect(conversationSubline(row, "waiting", 'Set up a routine: "Weekday weather"?')).toBe('Set up a routine: "Weekday weather"?');
    expect(conversationSubline(row, "working", "Send it?")).toBe("Working on it");
    expect(conversationSubline({}, "done")).toBe("");
  });

  it("lists every lane surface once, home first", () => {
    expect(LANE_SECTIONS[0].path).toBe(LANE_PATHS.home);
    expect(new Set(LANE_SECTIONS.map((t) => t.path)).size).toBe(LANE_SECTIONS.length);
  });

  it("names every lane page plainly in the window title", () => {
    for (const s of LANE_SECTIONS) expect(laneSurfaceLabel(s.path)).toBe(s.label);
    expect(laneSurfaceLabel(`${LANE_PATHS.approvals}/`)).toBe("Approvals");
    expect(laneSurfaceLabel(conversationPath("abc"))).toBe("Home");
    expect(laneSurfaceLabel(LANE_PATHS.welcome)).toBe("Welcome");
  });
});

describe("page rules shared by the web and the phone", () => {
  it("a plan card offers nothing until the wallet and billing have answered", () => {
    const figures = { known: true, plan: { id: "free" as const }, upgrades: new Set<any>(["plus", "pro"]) };
    expect(planCard("free", figures, { known: true, plans: ["plus"] })).toEqual({ current: true, offer: null });
    expect(planCard("plus", figures, { known: true, plans: ["plus"] })).toEqual({ current: false, offer: "checkout" });
    expect(planCard("pro", figures, { known: true, plans: ["plus"] })).toEqual({ current: false, offer: "ask" });
    expect(planCard("plus", figures, { known: false, plans: [] }).offer).toBeNull();
    expect(planCard("free", { ...figures, known: false }, { known: true, plans: ["plus"] })).toEqual({ current: false, offer: null });
  });

  it("lists where the month went costliest first, with the rest under 1% folded", () => {
    const lines = [{ id: "a", cost_usd: 0.03 }, { id: "b", cost_usd: 0.001 }, { id: "c", cost_usd: 0.2 }, { id: "d", cost_usd: 0 }, { id: "e", cost_usd: 0.005 }];
    // On Free ($2 of work), 1% is two cents.
    const { shown, small } = ledgerLines(lines, 2);
    expect(shown.map((l) => l.id)).toEqual(["c", "a"]);
    expect(small).toBe(3);
    expect(LANE_COPY.plan.smallLines(1)).toBe("1 other conversation, each under 1% of a month");
    expect(ledgerLines([], 2)).toEqual({ shown: [], small: 0 });
  });

  it("says top-ups, turns and the meter in plain words", () => {
    // A top-up's note is what it buys on the person's plan, never a second dollar figure.
    expect(topupLabel(10, PLANS.plus)).toEqual({ label: "Add $10", note: "About half a month on Plus" });
    expect(topupLabel(25, PLANS.plus).note).toBe("About a month on Plus");
    expect(topupLabel(10, PLANS.free).note).toBe("About 3 months on Free");
    expect(workedTimes(1)).toBe("Worked on it once");
    expect(workedTimes(3)).toBe("Worked on it 3 times");
    const legend = meterLegend({ used_usd: 1, cap_usd: 5, reserved_usd: 0.5, topup_usd: -2 }, "October 21", 5);
    expect(legend.map((l) => `${l.strong ?? ""}${l.rest}`)).toEqual([
      "About 10% of a month is set aside for work still running, and comes back when it ends",
      "Refunded extra credit you'd already used (about 40% of a month) comes out of next month first",
      "Starts fresh October 21",
    ]);
    expect(meterLegend({ used_usd: 0, cap_usd: 12, reserved_usd: 0, topup_usd: 6 }, null, 12).map((l) => l.rest)).toEqual(["Extra credit for about half a month more"]);
    // The legend measures in the plan's full month even when a mid-month change prorated the cap.
    expect(meterLegend({ used_usd: 0, cap_usd: 6, reserved_usd: 0, topup_usd: 6 }, null, 12).map((l) => l.rest)).toEqual(["Extra credit for about half a month more"]);
    expect(meterLegend({ used_usd: 0, cap_usd: 12, reserved_usd: 0, topup_usd: 0.01 }, null, 12).map((l) => l.rest)).toEqual(["Extra credit for under 1% of a month more"]);
    expect(meterShort({ used_usd: 3, cap_usd: 12, reserved_usd: 0, topup_usd: 0 })).toBe("25% used this month");
    expect(meterShort({ used_usd: 0, cap_usd: 12, reserved_usd: 0, topup_usd: 0 })).toBe("Nothing used this month");
    expect(monthShare(0.001, 12)).toBe("under 1% of a month");
    expect(monthShare(18, 12)).toBe("1.5 months");
  });

  it("a disconnect question stands alone on the mail row", () => {
    const can = { read_mail: true, modify_mail: false, send_mail: false, calendar: false };
    expect(connectionControls({ connected: false, can: null, canDisconnect: false, available: true }, false)).toEqual({ connect: true, coming: false, allow: false, reconnect: false, confirm: false, disconnect: null });
    expect(connectionControls({ connected: true, can, canDisconnect: true }, false)).toEqual({ connect: false, coming: false, allow: true, reconnect: false, confirm: false, disconnect: "on" });
    expect(connectionControls({ connected: true, can, canDisconnect: true }, true)).toEqual({ connect: false, coming: false, allow: false, reconnect: false, confirm: true, disconnect: null });
    // A connection Whisk refused offers Reconnect, not "allow everything".
    expect(connectionControls({ connected: true, can, canDisconnect: true, needsReconnect: true }, false)).toEqual({ connect: false, coming: false, allow: false, reconnect: true, confirm: false, disconnect: "on" });
    expect(connectionControls({ connected: true, can, canDisconnect: false }, false).disconnect).toBe("off");
  });

  it("names who a disconnect is for", () => {
    expect(LANE_COPY.connections.disconnectAsk("dana@x.com")).toBe("Disconnect dana@x.com?");
    expect(LANE_COPY.connections.disconnectAsk(undefined)).toBe("Disconnect your mail?");
  });
});

describe("the note under the mail card", () => {
  it("reassures someone who has not connected, rather than warning about a disconnect", () => {
    const note = disconnectNote(false);
    expect(note).toBe("You can disconnect any time, and I stop right away.");
    expect(note).not.toContain("Disconnecting");
  });

  it("says what a disconnect stops once connected, and that the mail stays in Whisk", () => {
    expect(disconnectNote(true)).toContain("Disconnecting stops me");
    expect(disconnectNote(true)).toContain("Your mail stays in Whisk");
  });

  it("names the main mailbox and how many more the connection reaches", () => {
    expect(mailboxLine("dana@x.com", ["dana@x.com"])).toBe("dana@x.com");
    expect(mailboxLine("dana@x.com", ["Dana@x.com", "dana@work.com"])).toBe("dana@x.com and 1 more mailbox");
    expect(mailboxLine(undefined, ["a@x.com", "b@x.com", "c@x.com"])).toBe("a@x.com and 2 more mailboxes");
    expect(mailboxLine(undefined, [])).toBeUndefined();
  });
});

describe("the ask-before-acting promise", () => {
  it("is worded once on every surface that makes it", async () => {
    const { ASK_FIRST, askFirst } = await import("./askFirst");
    const { assistantPromise } = await import("./assistantPromise");
    const { LANE_COPY } = await import("./lane");
    expect(ASK_FIRST).toBe(askFirst("send an email or change your calendar"));
    const all = { read_mail: true, modify_mail: true, send_mail: true, calendar: true };
    expect(LANE_COPY.home.lede(all).endsWith(ASK_FIRST)).toBe(true);
    expect(LANE_COPY.connections.lede(all).endsWith(ASK_FIRST)).toBe(true);
    expect(assistantPromise(true).endsWith(ASK_FIRST)).toBe(true);
    expect(assistantPromise(false).endsWith(askFirst("act for you"))).toBe(true);
    for (const line of [ASK_FIRST, assistantPromise(true), assistantPromise(false)]) expect(line).not.toContain("—");
  });
});

describe("the promise follows what the mail connection allows", () => {
  it("promises mail and calendar only where they can be changed", async () => {
    const { ASK_FIRST, askFirst } = await import("./askFirst");
    const { LANE_COPY, askFirstFor } = await import("./lane");
    const all = { read_mail: true, modify_mail: true, send_mail: true, calendar: true };
    expect(askFirstFor(all)).toBe(ASK_FIRST);
    expect(askFirstFor({ ...all, calendar: false })).toBe(askFirst("send an email"));
    expect(askFirstFor({ ...all, send_mail: false })).toBe(askFirst("change your calendar"));
    expect(askFirstFor({ ...all, send_mail: false, calendar: false })).toBe(askFirst("act for you"));
    // Sign in (assistantPromise) and the lane ledes share askFirstFor's fallback.
    const { assistantPromise } = await import("./assistantPromise");
    expect(assistantPromise(false).endsWith(askFirstFor(null))).toBe(true);
    expect(assistantPromise(true).endsWith(askFirstFor(all))).toBe(true);
    // Nothing connected, or a deployment that cannot connect mail: Home and
    // Connections promise nothing about mail, the way /welcome's sign in does.
    expect(LANE_COPY.home.lede(null).endsWith(askFirst("act for you"))).toBe(true);
    expect(LANE_COPY.connections.lede(null)).not.toMatch(/email|calendar/i);
  });

  it("says mail is coming on Connections where it cannot be connected, as /welcome does", () => {
    const off = { connected: false, can: null, canDisconnect: false, available: false };
    expect(connectionControls(off, false)).toEqual({ connect: false, coming: true, allow: false, reconnect: false, confirm: false, disconnect: null });
    // Not answered yet: neither a Connect it may withdraw nor the coming line.
    expect(connectionControls({ ...off, available: undefined }, false)).toEqual({ connect: false, coming: false, allow: false, reconnect: false, confirm: false, disconnect: null });
    expect(connectionControls({ ...off, available: true }, false).connect).toBe(true);
    expect(connectionControls({ ...off, available: true }, false).coming).toBe(false);
  });
});

describe("the inbox's names for whose move it is", () => {
  it("never names a section with the words a row uses for its state", async () => {
    const { MODE_WORDS } = await import("../../lib/surfaceRules");
    const w = MODE_WORDS.hosted;
    const names = [w.sectionQuestions, w.sectionNeedsInput, w.sectionDormant];
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(3);
    const row = { idle_summary: null, last_user_message: null };
    for (const state of ["waiting", "working"] as const) {
      expect(names.map((n) => n.toLowerCase())).not.toContain(conversationSubline(row, state).toLowerCase());
    }
  });
});
