// Tool steps in plain words: the vocabulary, a tool's own sentence, people's
// names, Gmail's search syntax, rows' JSON text, and the fold rule.
import { describe, expect, it } from "bun:test";
import { declineText, notRunText, refusalText, startedText } from "@platform/agent/outcome";
import { calendarTools } from "./calendar";
import { mailTools } from "./mail";
import { searchWebTool, webTools } from "./web";
import { mailSearch, personName, stepAsk, stepCount, stepOutcome, stepText, visibleSteps, STEPS_SHOWN } from "./steps";

/** A result that came back fine, with nothing to count. */
const OK = { content: "ok" };

describe("tool steps", () => {
  it("reads common tools as plain lines", () => {
    expect(stepText({ name: "send_email", input: { to: "dana@example.com", body: "hi" } }, OK)).toBe("Sent an email to Dana");
    expect(stepText({ name: "draft_reply", input: JSON.stringify({ to: "Dana Ruiz <dana@x.org>" }) }, OK)).toBe("Drafted a reply to Dana Ruiz");
    expect(stepText({ name: "search_mail", input: { q: "newer_than:7d" } }, { content: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] })).toBe("Read 12 emails from the past week");
    expect(stepText({ name: "read_calendar", input: {} }, OK)).toBe("Checked your calendar");
    expect(stepText({ name: "create_event", input: { title: "Dinner with Sam" } }, OK)).toBe('Added "Dinner with Sam" to your calendar');
    expect(stepText({ name: "web_search", input: { query: "flights to Lisbon" } }, OK)).toBe('Searched the web for "flights to Lisbon"');
    expect(stepText({ name: "web_fetch", input: { url: "https://www.example.com/a" } }, OK)).toBe("Read a page on example.com");
  });

  it("reads a result stored as JSON text, as a transcript row keeps it", () => {
    expect(stepText({ name: "search_mail", input: '{"query":"is:unread"}' }, { content: JSON.stringify({ results: [1, 2] }) })).toBe("Read 2 unread emails");
    expect(stepText({ name: "list_events", input: "{}" }, { content: "[1]" })).toBe("Checked your calendar (1 event)");
    expect(stepText({ name: "search_mail", input: "{" }, { content: "not json" })).toBe("Looked through your email");
  });

  it("prefers the sentence a tool wrote for itself", () => {
    expect(stepText({ name: "search_mail" }, { summary: "Read 12 emails from this week" })).toBe("Read 12 emails from this week");
  });

  it("never says a tool's name, even for one nobody has phrased", () => {
    expect(stepText({ name: "frobnicateWidgets" }, OK)).toBe("Did a step");
    expect(stepText({}, OK)).toBe("Did a step");
  });

  it("phrases every mail, calendar and web tool", () => {
    // Factories only build their definitions here; no call runs.
    const names = [
      ...mailTools({} as any, { read_mail: true, modify_mail: true, send_mail: true }),
      ...calendarTools({} as any),
      ...webTools({} as any),
      searchWebTool({} as any),
    ].map((t) => t.name);
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) expect({ name, line: stepText({ name }, OK) }).toEqual({ name, line: expect.not.stringMatching(/^Did a step$|go-ahead/) });
    expect(stepText({ name: "archive" }, OK)).toBe("Tidied your inbox");
    expect(stepText({ name: "suggest_reply" }, OK)).toBe("Wrote a reply in your voice");
    expect(stepText({ name: "summarize_thread" }, OK)).toBe("Summed up an email");
  });

  it("names people from addresses", () => {
    expect(personName("sam.lee@x.org")).toBe("Sam");
    expect(personName(["a@x.org", "b@x.org", "c@x.org"])).toBe("A and 2 others");
    expect(personName("")).toBeNull();
  });
});

describe("how a step came out", () => {
  const replace = { name: "replace_doc", input: { title: "Groceries" } };
  const text = (t: string) => [{ type: "text", text: t }];

  const BUDGET = notRunText("the person's plan had no usage left to run it");

  it("reads the outcome from the result the engine wrote", () => {
    expect(stepOutcome(undefined)).toBe("pending");
    expect(stepOutcome(OK)).toBe("done");
    expect(stepOutcome({ content: text(declineText("replace_doc")), is_error: true })).toBe("declined");
    expect(stepOutcome({ content: JSON.stringify(text(refusalText("send_email"))), is_error: true })).toBe("declined");
    expect(stepOutcome({ content: BUDGET, is_error: true })).toBe("not_run");
    expect(stepOutcome({ content: startedText("replace_doc"), is_error: true })).toBe("not_run");
    expect(stepOutcome({ content: "Doc not found", is_error: true })).toBe("failed");
  });

  it("never says a step happened when it did not", () => {
    expect(stepText(replace, OK)).toBe("Updated a note");
    expect(stepText(replace)).toBe("Updating a note");
    expect(stepText({ name: "web_search", input: { query: "chickpea dinners" } })).toBe('Searching the web for "chickpea dinners"');
    expect(stepText({ name: "summarize_thread" })).toBe("Summing up an email");
    expect(stepText({ name: "write_doc" })).toBe("Writing a note");
    expect(stepText({ name: "schedule_routine", input: { title: "Water the plants" } }, undefined, { asking: true })).toBe('Waiting for your go-ahead to set up the routine "Water the plants"');
    expect(stepText(replace, undefined, { asking: true })).toBe("Waiting for your go-ahead to update a note");
    expect(stepText(replace, { content: declineText("replace_doc", "not now"), is_error: true })).toBe("Didn't update a note (you said no)");
    expect(stepText(replace, { content: BUDGET, is_error: true })).toBe("Didn't update a note");
    expect(stepText(replace, { content: "Doc not found", is_error: true })).toBe("Couldn't update a note");
    expect(stepText({ name: "send_email", input: { to: "dana@x.org" } }, undefined, { asking: true })).toBe("Waiting for your go-ahead to send an email to Dana");
    expect(stepText({ name: "frobnicate" }, { content: "boom", is_error: true })).toBe("Couldn't do a step");
  });

  it("asks for approval in the words the receipt will use", () => {
    expect(stepAsk(replace)).toBe("Update a note");
    expect(stepAsk({ name: "send_email", input: { to: "dana@x.org" } })).toBe("Send an email to Dana");
    expect(stepAsk({ name: "frobnicate" })).toBeNull();
  });

  it("keeps a call's own past-tense sentence for a step that happened", () => {
    const call = { name: "replace_doc", summary: "Updated your groceries note" };
    expect(stepText(call, OK)).toBe("Updated your groceries note");
    expect(stepText(call, { content: declineText("replace_doc"), is_error: true })).toBe("Didn't update a note (you said no)");
  });
});

describe("mail searches", () => {
  it("reads Gmail's search syntax as plain words", () => {
    expect(mailSearch("from:dana is:unread newer_than:7d")).toEqual({ unread: true, scope: " from Dana from the past week" });
    expect(mailSearch('from:"Dana Ruiz <dana@ruiz.studio>" subject:"kitchen plans"')).toEqual({ unread: false, scope: ' from Dana Ruiz about "kitchen plans"' });
    expect(mailSearch("invoice newer_than:3d -label:spam")).toEqual({ unread: false, scope: ' matching "invoice" from the past 3 days' });
    expect(mailSearch("has:attachment in:inbox")).toEqual({ unread: false, scope: "" });
    // A wildcard or lone punctuation is syntax, never shown as a word.
    expect(mailSearch("*")).toEqual({ unread: false, scope: "" });
    expect(mailSearch("( - ) {")).toEqual({ unread: false, scope: "" });
    expect(mailSearch("in:inbox")).toEqual({ unread: false, scope: "" });
    expect(stepText({ name: "search_mail", input: { query: "*" } }, OK)).toBe("Looked through your email");
  });

  it("says a search with no count by what it looked for", () => {
    expect(stepText({ name: "search_mail", input: { query: "from:sam@x.org" } }, OK)).toBe("Looked for emails from Sam");
    expect(stepText({ name: "search_mail", input: {} }, OK)).toBe("Looked through your email");
  });
});

describe("folding a run of steps", () => {
  const run = (n: number) => Array.from({ length: n }, (_, i) => i);

  it("never folds away a single step", () => {
    expect(visibleSteps(run(STEPS_SHOWN + 1), false)).toEqual({ shown: run(STEPS_SHOWN + 1), more: 0 });
    expect(visibleSteps(run(STEPS_SHOWN + 2), false)).toEqual({ shown: run(STEPS_SHOWN - 1), more: 3 });
    expect(visibleSteps(run(9), true).more).toBe(0);
  });

  it("takes a shorter limit for a one-line receipt", () => {
    expect(visibleSteps(run(4), false, 2)).toEqual({ shown: [0], more: 3 });
    expect(visibleSteps(run(3), false, 3)).toEqual({ shown: run(3), more: 0 });
  });

  it("counts steps in plain words", () => {
    expect(stepCount(1)).toBe("1 step");
    expect(stepCount(3, true)).toBe("3 more steps");
  });
});
