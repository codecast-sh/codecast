import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BRIEF_BUDGET_CHARS, parsePlaybook } from "@codecast/shared/contracts/rolePlaybook";
import { RolePlaybook, RoleWakeLine } from "./RolePlaybook";

// The playbook on a role's Overview (org-staffing.md S38): the page paints
// what the brief's sections hold, and how the role wakes from its trigger.

const NOW = Date.parse("2026-10-04T09:00:00Z");
const BRIEF = [
  "Growth: intros hold at 3.7 a day",
  "",
  "## North metric",
  "Introductions sent per day, seven day average.",
  "- 2026-07-28: 0.9/day",
  "- 2026-09-11: 4.4/day (milestone: first week above 4)",
  "- 2026-10-02: 4.0/day",
  "- 2026-10-04: 3.7/day",
  "",
  "## Rules learned",
  "- Read the threads before the counters. Learned from: three diagnoses made from totals were wrong. (2026-09-12)",
  "",
  "## Refuted",
  "- The reply rate fell because the audience changed: the mix by week is flat. (2026-09-06)",
  "",
  "## Standing decisions",
  "- Never deploy past a red gate. (Mara, 2026-09-05)",
  "",
  "## Open threads",
  "- The pricing page waits on legal. (opened 2026-09-21, due 2026-10-01)",
  "- Counterpart side test. (opened 2026-09-30, due 2026-10-21)",
].join("\n");
const render = (narrative: string) => renderToStaticMarkup(<RolePlaybook playbook={parsePlaybook(narrative)} narrative={narrative} now={NOW} />);

test("each section the role wrote is painted, with its dates and who decided", () => {
  const html = render(BRIEF);
  for (const section of ["metric", "rules", "refuted", "decisions", "threads"]) expect(html).toContain(`data-playbook="${section}"`);
  expect(html).toContain("Introductions sent per day, seven day average.");
  expect(html).toContain('data-playbook-latest="2026-10-04"');
  expect(html).toContain('data-playbook-milestone="2026-09-11"');
  expect(html).toContain("4.4/day · first week above 4");
  expect(html).toContain('data-playbook-trend="4"');
  expect(html).toContain("Read the threads before the counters.");
  expect(html).toContain("Learned from: three diagnoses made from totals were wrong");
  expect(html).toContain("Mara · Sep 5");
  expect(html).not.toContain("data-playbook-budget");
});

test("a thread past its due day says so; one ahead of it does not", () => {
  const html = render(BRIEF);
  expect(html).toContain('data-playbook-due="overdue">was due Oct 1');
  expect(html).toContain('data-playbook-due="ahead">due Oct 21');
});

test("a section the role left out is not drawn, and two readings draw no trend", () => {
  const html = render("Docs: quiet\n\n## North metric\nStale pages.\n- 2026-10-01: 4\n- 2026-10-04: 3\n\n## Rules learned\n- A rule with no mistake (2026-10-01)");
  expect(html).toContain('data-playbook="metric"');
  expect(html).not.toContain("data-playbook-trend");
  expect(html).not.toContain("Learned from");
  for (const section of ["refuted", "decisions", "threads"]) expect(html).not.toContain(`data-playbook="${section}"`);
});

test("a brief near its budget says how full it is", () => {
  expect(render(`${BRIEF}\n${"x".repeat(BRIEF_BUDGET_CHARS * 0.8)}`)).toContain('data-playbook-budget="near"');
  expect(render(`${BRIEF}\n${"x".repeat(BRIEF_BUDGET_CHARS)}`)).toContain('data-playbook-budget="over"');
});

test("how it wakes reads from the trigger: cadence, gate, focus, and the role's own reason", () => {
  const plain = renderToStaticMarkup(<RoleWakeLine wake={{ every_ms: 86_400_000, precheck: null, focus: null, why: null, tuned_at: null }} />);
  expect(plain).toContain("every day");
  expect(plain).not.toContain("data-role-wake-why");
  const tuned = renderToStaticMarkup(<RoleWakeLine wake={{ every_ms: 3 * 86_400_000, precheck: "git diff --quiet", focus: "the launch queue", why: "the area is frozen until the launch", tuned_at: Date.parse("2026-10-01T09:00:00Z") }} />);
  expect(tuned).toContain("every 3 days");
  expect(tuned).toContain("only when `git diff --quiet` passes");
  expect(tuned).toContain("focus: the launch queue");
  expect(tuned).toContain("It set this itself on Oct 1: the area is frozen until the launch");
});
