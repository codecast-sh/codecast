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

import { INGEST_TRIGGER_EVENTS, isIngestTriggerEvent } from "./triggerEvents";

describe("the derived ingestion vocabulary", () => {
  test("every ingestion name is a derived shorthand with a label", () => {
    for (const name of INGEST_TRIGGER_EVENTS) {
      expect(TRIGGER_EVENT_SHORTHANDS[name]).toEqual({ event_type: name });
      expect(TRIGGER_EVENT_LABELS[name]).toBeDefined();
      expect(triggerEventShorthand({ event_type: name })).toBe(name);
    }
  });

  test("isIngestTriggerEvent knows its own and nothing else", () => {
    expect(isIngestTriggerEvent("error_new")).toBe(true);
    expect(isIngestTriggerEvent("deploy")).toBe(true);
    expect(isIngestTriggerEvent("pr_merged")).toBe(false);
    expect(isIngestTriggerEvent(undefined)).toBe(false);
    for (const name of INGEST_TRIGGER_EVENTS) expect(isPrTriggerEvent(name)).toBe(false);
  });
});

import { describeEventScope, eventFilterForSave } from "./triggerEvents";

describe("a trigger's scope, said and saved", () => {
  test("a source event names its source, a pull request event its repository", () => {
    expect(describeEventScope({ event_type: "error_new", source: "web" })).toBe("on error_new from source web");
    expect(describeEventScope({ event_type: "check_failed" })).toBe("on check_failed from every source you can see");
    expect(describeEventScope({ event_type: "pr_opened", repository: "a/b", pr_number: 4 })).toBe("on pr_opened in a/b#4");
    expect(describeEventScope({ event_type: "pr_opened" })).toBe("on pr_opened in every repository you can see");
  });

  test("saving keeps the narrowings that still apply to the chosen event", () => {
    expect(eventFilterForSave("error_new", { event_type: "error_new", source: "web" })).toEqual({ event_type: "error_new", source: "web" });
    expect(eventFilterForSave("job_failed", { event_type: "error_new", source: "web" })).toEqual({ event_type: "job_failed", source: "web" });
    expect(eventFilterForSave("pr_opened", { event_type: "pr_merged", repository: "a/b", pr_number: 2 })).toEqual({ event_type: "pr_opened", repository: "a/b", pr_number: 2 });
  });

  test("a narrowing that does not apply to the new event is dropped, and an unknown event saves nothing", () => {
    expect(eventFilterForSave("pr_opened", { event_type: "error_new", source: "web" })).toEqual({ event_type: "pr_opened" });
    expect(eventFilterForSave("error_new", { event_type: "pr_opened", repository: "a/b" })).toEqual({ event_type: "error_new" });
    expect(eventFilterForSave("error_new", undefined)).toEqual({ event_type: "error_new" });
    expect(eventFilterForSave("nope", undefined)).toBeUndefined();
  });

  test("--repo on a push or issue event survives a save, and --pr stays with pull request events", () => {
    const push = eventFilterForSave("push", { event_type: "push", repository: "owner/x" });
    expect(push?.repository).toBe("owner/x");
    const issue = eventFilterForSave("issue_opened", { event_type: "issues", repository: "owner/x" });
    expect(issue?.repository).toBe("owner/x");
    const fromPr = eventFilterForSave("push", { event_type: "pull_request", repository: "owner/x", pr_number: 4 });
    expect(fromPr?.repository).toBe("owner/x");
    expect(fromPr?.pr_number).toBeUndefined();
  });
});
