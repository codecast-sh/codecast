import { describe, expect, test } from "bun:test";
import {
  TRIGGER_EVENT_SHORTHANDS,
  TRIGGER_EVENT_NAMES,
  TRIGGER_EVENT_LABELS,
  PR_TRIGGER_EVENTS,
  isPrTriggerEvent,
  triggerEventShorthand,
  triggerEventLabel,
} from "./triggerEvents";

// The names prShepherd.firePrTrigger and githubWebhooks.fireTrigger pass to
// matchTaskTriggers. A name the backend fires but the CLI cannot arm is an
// event nobody can wait for, which is what this vocabulary existed to fix.
const FIRED_BY_THE_BACKEND = [
  "pr_opened",
  "pr_synchronize",
  "pr_ready",
  "pr_review_requested",
  "pr_review",
  "pr_approved",
  "pr_changes_requested",
  "pr_check_failed",
  "pr_checks_green",
  "pr_behind",
  "pr_conflict",
  "pr_merged",
  "pr_closed",
];

describe("the derived pull request vocabulary", () => {
  test("every name the backend fires can be armed", () => {
    for (const name of FIRED_BY_THE_BACKEND) {
      expect(TRIGGER_EVENT_SHORTHANDS[name]).toBeDefined();
    }
  });

  test("a derived event filters on its own name, with no action", () => {
    for (const name of FIRED_BY_THE_BACKEND) {
      expect(TRIGGER_EVENT_SHORTHANDS[name]).toEqual({ event_type: name });
    }
  });

  // The bug this replaced: pr_merged armed pull_request:closed, which GitHub
  // also sends when a pull request is closed without ever being merged.
  test("merged and closed are different events", () => {
    expect(TRIGGER_EVENT_SHORTHANDS.pr_merged).toEqual({ event_type: "pr_merged" });
    expect(TRIGGER_EVENT_SHORTHANDS.pr_closed).toEqual({ event_type: "pr_closed" });
    expect(TRIGGER_EVENT_SHORTHANDS.pr_merged).not.toEqual(TRIGGER_EVENT_SHORTHANDS.pr_closed);
  });

  test("no derived name still points at a raw webhook", () => {
    for (const name of FIRED_BY_THE_BACKEND) {
      expect(TRIGGER_EVENT_SHORTHANDS[name].event_type).not.toBe("pull_request");
    }
  });
});

describe("the raw events", () => {
  // Nothing derives these, so they name the webhook GitHub sends.
  test("a review comment and a push stay raw", () => {
    expect(TRIGGER_EVENT_SHORTHANDS.pr_comment).toEqual({
      event_type: "pull_request_review_comment",
      action: "created",
    });
    expect(TRIGGER_EVENT_SHORTHANDS.push).toEqual({ event_type: "push" });
  });

  // issueSync normalizes Linear and GitHub into this pair before matching.
  test("issue events name the provider pair", () => {
    expect(TRIGGER_EVENT_SHORTHANDS.issue_opened).toEqual({ event_type: "issues", action: "opened" });
    expect(TRIGGER_EVENT_SHORTHANDS.issue_commented).toEqual({ event_type: "issue_comment", action: "created" });
  });
});

describe("reading a filter back", () => {
  test("a derived filter reads back as the name it was armed with", () => {
    expect(triggerEventShorthand({ event_type: "pr_check_failed" })).toBe("pr_check_failed");
  });

  test("a raw filter reads back as its shorthand", () => {
    expect(triggerEventShorthand({ event_type: "issues", action: "opened" })).toBe("issue_opened");
  });

  // A trigger armed before the derived names existed still has to render.
  test("a filter nothing names falls back to the raw pair", () => {
    expect(triggerEventShorthand({ event_type: "pull_request", action: "closed" })).toBe("pull_request:closed");
    expect(triggerEventShorthand({ event_type: "deployment" })).toBe("deployment");
  });

  test("an absent filter names nothing", () => {
    expect(triggerEventShorthand(undefined)).toBeUndefined();
    expect(triggerEventLabel(undefined)).toBe("event");
  });
});

describe("labels", () => {
  test("every name has one", () => {
    for (const name of TRIGGER_EVENT_NAMES) {
      expect(TRIGGER_EVENT_LABELS[name]).toBeTruthy();
    }
  });

  test("a name and a filter label the same way", () => {
    expect(triggerEventLabel("pr_checks_green")).toBe("checks went green");
    expect(triggerEventLabel({ event_type: "pr_checks_green" })).toBe("checks went green");
  });

  test("an unknown event reads as words, never as a field name", () => {
    expect(triggerEventLabel("some_new_event")).toBe("some new event");
  });
});

describe("which events a repository narrows", () => {
  test("the pull request events, and not the others", () => {
    expect(isPrTriggerEvent("pr_check_failed")).toBe(true);
    expect(isPrTriggerEvent("pr_comment")).toBe(true);
    expect(isPrTriggerEvent("push")).toBe(false);
    expect(isPrTriggerEvent("issue_opened")).toBe(false);
    expect(isPrTriggerEvent(undefined)).toBe(false);
  });

  test("every pull request event is one of the names", () => {
    for (const name of PR_TRIGGER_EVENTS) {
      expect(TRIGGER_EVENT_NAMES).toContain(name);
    }
  });
});
