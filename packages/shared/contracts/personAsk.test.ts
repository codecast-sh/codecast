import { describe, expect, test } from "bun:test";
import { askDueAt, personAskDue } from "./personAsk";

const at = (iso: string) => Date.parse(iso);
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

describe("askDueAt", () => {
  // The sentences are Union's escalations of 2026-10-12/13, word for word around the date.
  test("a date after the day it was written is the deadline", () => {
    expect(askDueAt("ASK (decide by Oct 15, Israel morning): (a) send the three consent pitches", at("2026-10-13T06:02:50Z"))).toBe(day("2026-10-15"));
    expect(askDueAt("We also promised him the partner's response, or an honest status, by Thu Oct 15.", at("2026-10-12T09:00:00Z"))).toBe(day("2026-10-15"));
    expect(askDueAt("she will hear from us by Tuesday Oct 20.", at("2026-10-13T02:00:00Z"))).toBe(day("2026-10-20"));
    expect(askDueAt("Please send the entity facts (or a decision to give none) by Oct 16.", at("2026-10-12T08:00:00Z"))).toBe(day("2026-10-16"));
  });
  test("today and tomorrow count from when it was written", () => {
    expect(askDueAt("we promised her an update on Matthew by today (Oct 12).", at("2026-10-12T15:00:00Z"))).toBe(day("2026-10-12"));
    expect(askDueAt("reply by tomorrow", at("2026-10-12T15:00:00Z"))).toBe(day("2026-10-13"));
  });
  test("a date on or before the writing day reports what happened and asks nothing", () => {
    expect(askDueAt("one expired Oct 2, d8df04f1 shows no call by Oct 13. A third identical card", at("2026-10-13T05:00:00Z"))).toBeNull();
    expect(askDueAt("nothing went out by Oct 2; send it by Oct 16", at("2026-10-12T05:00:00Z"))).toBe(day("2026-10-16"));
  });
  test("a weekday alone is the next one; a month behind is next year", () => {
    expect(askDueAt("call him by Friday", at("2026-10-13T05:00:00Z"))).toBe(day("2026-10-16"));
    expect(askDueAt("decide by Jan 5", at("2026-12-20T05:00:00Z"))).toBe(day("2027-01-05"));
    expect(askDueAt("decide by 10/15", at("2026-10-13T05:00:00Z"))).toBe(day("2026-10-15"));
  });
  test("no date, no deadline", () => {
    expect(askDueAt("A person should either phone him directly in Athens business hours", at("2026-10-13T05:00:00Z"))).toBeNull();
    expect(askDueAt(null, 0)).toBeNull();
  });
});

describe("personAskDue", () => {
  const detail = (reason: string) => [
    "1 escalation and difficulty notes under this fingerprint in the last 7 days.",
    'Ask: Deliver, for the problem "approved counterparty pitches unsendable from contact run".',
    "This one: a escalation from broker woken by `proactive`, 2026-10-13T06:02:50.392Z.",
    "",
    "The agent's reason (data, its own words):",
    "```",
    reason,
    "```",
  ].join("\n");
  test("reads the agent's reason of a finding that asks a person", () => {
    expect(personAskDue(detail("ASK (decide by Oct 15, Israel morning)"), at("2026-10-13T06:02:50Z"))).toBe(day("2026-10-15"));
  });
  test("a finding that asks no one has no deadline", () => {
    expect(personAskDue("The judge saw a reply sent by Oct 20 promise", at("2026-10-13T06:02:50Z"))).toBeNull();
  });
});
