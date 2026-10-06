// Approval rules over the package's own tool scopes: what an allow or refuse
// rule decides, how outside content narrows them, and what the card shows.
import { describe, expect, test } from "bun:test";
import { allowScopeIn, approvalContext, plainEvery, plainSchedule, withRules, type AllowScopes, type RuleView } from "./rules";
import { MAIL_SCOPES } from "./mail";
import { CALENDAR_SCOPES } from "./calendar";
import { WEB_SCOPES } from "./web";

const SCOPES: AllowScopes = { ...MAIL_SCOPES, ...CALENDAR_SCOPES, ...WEB_SCOPES };

const verdict = (rules: RuleView[], readOutside = false) => {
  const gate = withRules(() => "ask", rules, SCOPES, () => readOutside);
  return async (name: string, input: Record<string, unknown>, risk: "read" | "write" = "write") => {
    const decided = await gate({ id: "c", name, input, risk });
    return typeof decided === "string" ? decided : decided.verdict;
  };
};

describe("withRules", () => {
  test("an allow or refuse rule decides only a write the gate would ask about", async () => {
    const call = verdict([
      { tool: "send_mail", decision: "allow", match: "dana@example.com" },
      { tool: "archive", decision: "refuse" },
      { tool: "label", decision: "allow" },
      { tool: "create_event", decision: "allow", match: "dana@example.com" },
      { tool: "update_event", decision: "allow", match: "no one" },
      { tool: "fetch_page", decision: "allow" },
      { tool: "unknown_tool", decision: "allow" },
    ]);
    expect(await call("send_mail", { to: ["Dana <Dana@Example.com>"] })).toBe("allow");
    expect(await call("send_mail", { to: ["dana@example.com"], cc: ["lee@example.com"] })).toBe("ask");
    expect(await call("send_mail", { to: ['"<dana@example.com>" <eve@evil.example>'] })).toBe("ask");
    expect(await call("archive", { thread_ids: ["t"] })).toBe("refuse");
    expect(await call("label", { thread_ids: ["t"] })).toBe("allow");
    expect(await call("create_event", { attendees: ["dana@example.com"] })).toBe("allow");
    expect(await call("create_event", { attendees: ["dana@example.com"], notify: true })).toBe("ask");
    expect(await call("update_event", { event_id: "e" })).toBe("allow");
    expect(await call("update_event", { event_id: "e", remove_attendees: ["x@example.com"] })).toBe("ask");
    expect(await call("fetch_page", { url: "https://example.com" })).toBe("ask");
    expect(await call("unknown_tool", {})).toBe("ask");
    expect(await call("label", {}, "read")).toBe("ask");
  });

  test("with outside content in view, only rules that reach no one apply", async () => {
    const call = verdict([
      { tool: "send_mail", decision: "allow", match: "dana@example.com" },
      { tool: "create_event", decision: "allow", match: "no one" },
      { tool: "archive", decision: "allow" },
    ], true);
    expect(await call("send_mail", { to: ["dana@example.com"] })).toBe("ask");
    expect(await call("create_event", { title: "Focus" })).toBe("allow");
    expect(await call("archive", { thread_ids: ["t"] })).toBe("allow");
  });

  test("a scope names exactly the people a call reaches", () => {
    expect(allowScopeIn(SCOPES, { name: "send_mail", input: { to: ['"Lee, Q" <Lee@Example.com>', "dana@example.com"], cc: ["DANA@example.com"] } })).toMatchObject({
      kind: "match",
      match: "dana@example.com, lee@example.com",
    });
    expect(allowScopeIn(SCOPES, { name: "toString", input: {} }).kind).toBe("never");
  });
});

describe("approvalContext", () => {
  test("shows every field literally, long text whole", () => {
    const md = approvalContext({ to: ["a@x.com", "b@x.com"], subject: "Hi *there*", location: "`Room` 4", body: "One\nTwo ``` fence", notify: false });
    expect(md).toContain("**To:** `a@x.com, b@x.com`");
    expect(md).toContain("**Subject:** `Hi *there*`");
    expect(md).toContain("**Location:** `` `Room` 4 ``");
    expect(md).toContain("**Notify:** No");
    expect(md).toContain("````text\nOne\nTwo ``` fence\n````");
  });

  test("reads a time on the person's clock and a repeat in plain words", () => {
    const now = Date.parse("2026-10-06T12:00:00Z");
    const input = { title: "Daily plan", first_run: "2026-10-07T08:00:00-04:00", repeat_every_hours: 24 };
    const md = approvalContext(input, { timezone: "America/New_York", now });
    expect(md).toContain("**When:** Every day at 8:00 AM, starting Wednesday, October 7");
    expect(md).not.toContain("2026-10-07T");
    // A start alone says its own name.
    expect(approvalContext({ first_run: input.first_run }, { timezone: "America/New_York", now })).toBe("**First run:** Wednesday, October 7 at 8:00 AM");
    // The same instant on another clock, and with no zone known it says UTC.
    expect(approvalContext(input, { timezone: "America/Los_Angeles", now })).toContain("Every day at 5:00 AM, starting Wednesday, October 7");
    expect(approvalContext(input, { now })).toContain("Every day at 12:00 PM UTC, starting");
    // Another year is named; text that only looks like a date stays literal.
    expect(approvalContext({ first_run: "2027-01-04T09:30:00Z" }, { timezone: "UTC", now })).toContain("Monday, January 4, 2027 at 9:30 AM");
    expect(approvalContext({ note: "2026-10-07" })).toContain("**Note:** `2026-10-07`");
  });

  test("says each fact once, with the when lines together", () => {
    const input = { first_run: "2026-10-07T08:00:00-04:00", instruction: "Tell me the weather", repeat_every_hours: 24, title: "Morning weather" };
    const md = approvalContext(input, { timezone: "America/New_York", question: 'Set up a routine: "Morning weather"?' });
    // The question already quotes the title; the schedule reads as one pair.
    expect(md).not.toContain("Title");
    expect(md).toBe("**What I'll do**\n\n> Tell me the weather\n\n**When:** Every day at 8:00 AM, starting Wednesday, October 7");
    // A text the question shows only as part of a longer word still shows.
    expect(approvalContext({ to: "Dan" }, { question: "Send an email to Dana?" })).toContain("**To:** `Dan`");
    expect(approvalContext({ to: "Dana" }, { question: "Send an email to Dana?" })).toBe("");
    // Long text is the draft itself and always shows, whatever the question says.
    const body = "x".repeat(130);
    expect(approvalContext({ body }, { question: `Send ${body}?` })).toContain(body);
  });

  test("a routine's plan reads as a quote in plain words, its markdown shown as written", () => {
    const md = approvalContext({ instruction: "Remind you to plan the week.\n- a [short](https://x.example) *checklist*" });
    expect(md).toBe("**What I'll do**\n\n> Remind you to plan the week\\.\n> \\- a \\[short\\]\\(https://x\\.example\\) \\*checklist\\*");
  });

  test("a weekly routine names its weekday and hour on the person's clock", () => {
    const now = Date.parse("2026-10-06T12:00:00Z");
    const monday = Date.parse("2026-10-12T09:00:00-04:00");
    expect(plainSchedule(monday, 168, "America/New_York", now)).toBe("every Monday at 9:00 AM, starting October 12");
    expect(plainSchedule(monday, 336, "America/New_York", now)).toBe("every 2 weeks on Monday at 9:00 AM, starting October 12");
    expect(plainSchedule(monday, 6, "America/New_York", now)).toBe("every 6 hours, starting Monday, October 12 at 9:00 AM");
    expect(plainSchedule(monday, 168, undefined, now)).toBe("every Monday at 1:00 PM UTC, starting October 12");
  });

  test("says a repeat by its largest whole unit", () => {
    expect(plainEvery(1)).toBe("every hour");
    expect(plainEvery(6)).toBe("every 6 hours");
    expect(plainEvery(48)).toBe("every 2 days");
    expect(plainEvery(168)).toBe("every week");
    expect(plainEvery(336)).toBe("every 2 weeks");
  });
});
