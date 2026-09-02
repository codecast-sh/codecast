import { describe, expect, test } from "bun:test";
import { PARK_VERBS, FILE_VERBS, TRIAGE_VERBS, PRIMARY_VERBS, SECONDARY_VERBS } from "../triage/verbs";
import { isTriageBarCompact } from "../triage/graduation";
import { SHORTCUTS } from "../../shortcuts/registry";

// The triage bar and the intro tour render keycaps straight from this
// catalog. A verb pointing at an action with no binding would render a
// button with no chord — the whole point of the surface is teaching the
// chord, so that is a broken promise, not a cosmetic gap.

describe("triage verb catalog", () => {
  test("every verb's action has a registry binding", () => {
    const bound = new Set(SHORTCUTS.map((s) => s.action));
    for (const verb of TRIAGE_VERBS) {
      expect(bound.has(verb.action)).toBe(true);
    }
  });

  test("verb ids are unique", () => {
    const ids = TRIAGE_VERBS.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("the parking verbs are the five backspace-family chords", () => {
    // Order matters: the bar reads left to right by escalation.
    expect(PARK_VERBS.map((v) => v.action)).toEqual([
      "session.deferAdvance",
      "session.dormantAdvance",
      "session.stash",
      "session.stashHide",
      "session.kill",
    ]);
  });

  test("filing verbs are pin and label", () => {
    expect(FILE_VERBS.map((v) => v.action)).toEqual([
      "session.pin",
      "session.moveToBucket",
    ]);
  });

  test("the bar's top level is defer, stash, kill; the rest sits behind more", () => {
    expect(PRIMARY_VERBS.map((v) => v.id)).toEqual(["defer", "stash", "kill"]);
    expect([...PRIMARY_VERBS, ...SECONDARY_VERBS].length).toBe(TRIAGE_VERBS.length);
    for (const v of SECONDARY_VERBS) expect(PRIMARY_VERBS).not.toContain(v);
  });

  test("every verb carries a label, a past tense, and a blurb", () => {
    for (const verb of TRIAGE_VERBS) {
      expect(verb.label.length).toBeGreaterThan(0);
      expect(verb.done.length).toBeGreaterThan(0);
      expect(verb.blurb.length).toBeGreaterThan(10);
    }
  });
});

describe("isTriageBarCompact", () => {
  test("defaults to expanded", () => {
    expect(isTriageBarCompact(undefined)).toBe(false);
    expect(isTriageBarCompact({})).toBe(false);
  });

  test("the compact toggle wins outright", () => {
    expect(isTriageBarCompact({ triage_bar_compact: true })).toBe(true);
    expect(isTriageBarCompact({ triage_bar_compact: false, inbox_shortcuts_hidden: true })).toBe(false);
  });

  test("legacy hint dismissal maps to compact until the toggle is touched", () => {
    expect(isTriageBarCompact({ inbox_shortcuts_hidden: true })).toBe(true);
  });
});
