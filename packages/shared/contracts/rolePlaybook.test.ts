import { describe, expect, test } from "bun:test";
import { BRIEF_BUDGET_CHARS, WAKE_TUNE, briefBudget, briefOverBudgetMessage, msToEvery, parsePlaybook, playbookCounts, playbookGuideLines, playbookIsEmpty, roleFocusBlock, threadOverdue, wakeTuneRefusal, wakeWords } from "./rolePlaybook";
import { parseStandingSection } from "./briefStanding";
import { orgEveryToMs } from "./orgProposal";

// A role's playbook (org-staffing.md S38): five sections of its brief, one
// dated line per entry, read by one parser.

const BRIEF = [
  "Growth: intros hold at 3.7 a day",
  "Status: working",
  "",
  "## Where it stands",
  "- Outreach: the third market fills this week. (2026-10-03)",
  "",
  "## North metric",
  "Introductions sent per day, seven day average.",
  "- 2026-10-04: 3.7/day, 26 in 7 days",
  "- 2026-07-28: 0.9/day",
  "- 2026-09-11: 4.4/day (milestone: first week above 4)",
  "- 1,290 first touches on the best day (2026-08-14)",
  "",
  "## Rules learned",
  "- Read the threads before the counters. Learned from: three diagnoses made from totals were wrong. (2026-09-12)",
  "* Judge a search on what its current predicate bought (2026-09-20)",
  "",
  "## Refuted, do not chase again",
  "- The reply rate fell because the audience changed: the mix of replies by week is flat. (2026-09-06)",
  "",
  "## Standing decisions",
  "- Never deploy past a red gate. (Mara, 2026-09-05)",
  "- Keep buying at today's rate (2026-09-29)",
  "",
  "## Open threads",
  "- The pricing page waits on legal. (opened 2026-09-21, due 2026-10-21)",
  "- The fleet ramp is theirs; ask again when it lands, due 2026-10-01",
  "- Counterpart side test (2026-09-30)",
  "",
  "## Goals: Mara",
  "- Not a playbook line (2026-10-01)",
].join("\n");

describe("parsePlaybook", () => {
  const p = parsePlaybook(BRIEF);

  test("the metric is named by the lines above its readings, and the readings come back oldest first", () => {
    expect(p.metric?.name).toBe("Introductions sent per day, seven day average.");
    expect(p.metric?.readings.map((r) => r.written_on)).toEqual(["2026-07-28", "2026-08-14", "2026-09-11", "2026-10-04"]);
    expect(p.metric?.readings.map((r) => r.number)).toEqual([0.9, 1290, 4.4, 3.7]);
    expect(p.metric?.readings.filter((r) => r.milestone).map((r) => r.written_on)).toEqual(["2026-09-11"]);
    expect(p.metric?.readings.at(-1)?.text).toBe("3.7/day, 26 in 7 days");
  });

  test("a rule carries the mistake that taught it, and one without it still reads", () => {
    expect(p.rules).toHaveLength(2);
    expect(p.rules[0]).toMatchObject({ text: "Read the threads before the counters.", mistake: "three diagnoses made from totals were wrong", written_on: "2026-09-12" });
    expect(p.rules[1]).toMatchObject({ text: "Judge a search on what its current predicate bought", mistake: null, written_on: "2026-09-20" });
  });

  test("the refuted heading may say more than its name", () => {
    expect(p.refuted).toHaveLength(1);
    expect(p.refuted[0].written_on).toBe("2026-09-06");
    expect(p.refuted[0].text).toStartWith("The reply rate fell");
  });

  test("a decision names who decided and when", () => {
    expect(p.decisions[0]).toMatchObject({ text: "Never deploy past a red gate.", who: "Mara", written_on: "2026-09-05" });
    expect(p.decisions[1]).toMatchObject({ text: "Keep buying at today's rate", who: null, written_on: "2026-09-29" });
  });

  test("a thread reads when it opened and when it is due, in the closing parentheses or in the sentence", () => {
    expect(p.threads[0]).toMatchObject({ text: "The pricing page waits on legal.", written_on: "2026-09-21", due_on: "2026-10-21" });
    expect(p.threads[1]).toMatchObject({ written_on: "2026-10-01", due_on: "2026-10-01" });
    expect(p.threads[2]).toMatchObject({ text: "Counterpart side test", written_on: "2026-09-30", due_on: null });
    const noon = Date.parse("2026-10-21T12:00:00Z");
    expect(threadOverdue(p.threads[0], noon)).toBe(false);
    expect(threadOverdue(p.threads[0], noon + 86_400_000)).toBe(true);
    expect(threadOverdue(p.threads[2], noon)).toBe(false);
  });

  test("a date reads wherever a role puts it: among other words in the closing parentheses, or before a full stop", () => {
    const loose = parsePlaybook([
      "## North metric: pages past a month unreviewed",
      "- 2026-10-04: 11",
      "- 2026-10-05: 9 (billing page, six SDK pages)",
      "## Rules learned",
      "- Compare the page against the schema. Learned from: a clean exit was read as complete (2026-10-05).",
      "## Refuted",
      "- The section was complete: 19 of 23 events were there (shown by Mara's check, 2026-10-05)",
      "## Standing decisions",
      "- Keep the v1 table until the guides move. (Mara, 2026-10-05, sd-55)",
      "- Guides are hers to edit (Mara, sd-12, 2026-09-10).",
      "## Open threads",
      "- Verify the page lists all 23 events (opened 2026-10-05, due next check).",
      "- Billing PR, then check the live page (opened 2026-09-27, due 2026-10-07).",
    ].join("\n"));
    expect(loose.metric).toMatchObject({ name: "pages past a month unreviewed" });
    expect(loose.metric?.readings.map((r) => [r.written_on, r.number])).toEqual([["2026-10-04", 11], ["2026-10-05", 9]]);
    expect(loose.rules[0]).toMatchObject({ written_on: "2026-10-05", mistake: "a clean exit was read as complete" });
    expect(loose.refuted[0]).toMatchObject({ written_on: "2026-10-05", text: "The section was complete: 19 of 23 events were there (shown by Mara's check)" });
    expect(loose.decisions[0]).toMatchObject({ text: "Keep the v1 table until the guides move.", who: "Mara, sd-55", written_on: "2026-10-05" });
    expect(loose.decisions[1]).toMatchObject({ text: "Guides are hers to edit", who: "Mara, sd-12", written_on: "2026-09-10" });
    expect(loose.threads[0]).toMatchObject({ text: "Verify the page lists all 23 events", written_on: "2026-10-05", due_on: null });
    expect(loose.threads[1]).toMatchObject({ written_on: "2026-09-27", due_on: "2026-10-07" });
  });

  test("the playbook leaves the standing section and other sections alone", () => {
    expect(parseStandingSection(BRIEF)).toHaveLength(1);
    expect(playbookCounts(p)).toEqual({ metric: 4, rules: 2, refuted: 1, decisions: 2, threads: 3 });
  });

  test("a brief with no playbook is empty, never an error", () => {
    expect(playbookIsEmpty(parsePlaybook("Docs: quiet week\n\n## Where it stands\n- Docs site: fine (2026-10-01)"))).toBe(true);
    expect(playbookIsEmpty(parsePlaybook(null))).toBe(true);
    expect(playbookIsEmpty(p)).toBe(false);
  });
});

describe("the budget", () => {
  test("a brief is near its budget past three quarters and over it past the whole", () => {
    expect(briefBudget("x".repeat(100))).toMatchObject({ over: false, near: false });
    expect(briefBudget("x".repeat(BRIEF_BUDGET_CHARS * 0.8))).toMatchObject({ over: false, near: true });
    const over = briefBudget("x".repeat(BRIEF_BUDGET_CHARS + 1));
    expect(over.over).toBe(true);
    expect(briefOverBudgetMessage(over)).toContain("12.0 KB of 12.0 KB");
  });

  test("cast brief prints the shape of every section, and how full the brief is once that matters", () => {
    const bare = playbookGuideLines("Docs: quiet week");
    expect(bare).toHaveLength(6);
    expect(bare[1]).toStartWith("  ## North metric: ");
    expect(bare[2]).toContain("Learned from:");
    expect(playbookGuideLines(BRIEF)).toEqual(bare);
    const full = playbookGuideLines(`${BRIEF}\n${"x".repeat(BRIEF_BUDGET_CHARS)}`);
    expect(full).toHaveLength(7);
    expect(full[6]).toContain("over its budget");
  });
});

describe("how a role wakes", () => {
  test("a cadence word and its interval are each other's inverse", () => {
    for (const every of ["1h", "12h", "1d", "7d", "90m"]) expect(msToEvery(orgEveryToMs(every)!)).toBe(every);
  });

  test("a role sets its own cadence between an hour and a week, and is told where to go outside that", () => {
    expect(wakeTuneRefusal(WAKE_TUNE.min_ms)).toBeNull();
    expect(wakeTuneRefusal(WAKE_TUNE.max_ms)).toBeNull();
    expect(wakeTuneRefusal(30 * 60_000)).toContain("30m is outside that");
    expect(wakeTuneRefusal(14 * 86_400_000)).toContain("cast org propose");
  });

  test("the wake reads in one line, from the trigger's own fields", () => {
    expect(wakeWords({ every_ms: 86_400_000, precheck: null, focus: null, why: null, tuned_at: null })).toBe("every day");
    expect(wakeWords({ every_ms: 12 * 3_600_000, precheck: "git diff --quiet", focus: "the launch queue", why: "sessions land twice a day now", tuned_at: Date.parse("2026-10-01T09:00:00Z") }))
      .toBe("every 12 hours · only when `git diff --quiet` passes · focus: the launch queue · changed 2026-10-01: sessions land twice a day now");
  });

  test("the frame carries a focus only when the role set one", () => {
    expect(roleFocusBlock(null)).toBeNull();
    expect(roleFocusBlock("  ")).toBeNull();
    expect(roleFocusBlock("the launch queue")).toEndWith(": the launch queue");
  });
});
