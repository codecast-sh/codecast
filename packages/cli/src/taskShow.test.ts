// The CLI reading surfaces of the line (the-line.md L10): what `cast task
// show` prints under a task, the `cast workflow runs` table, and the feed row
// `cast org feed` prints for a run. Assertions are on lines, not snapshots.
import { describe, expect, test } from "bun:test";
import type { DecisionRow } from "./decideCommand";
import {
  formatFeedRow,
  formatRunsTable,
  formatTaskDecisions,
  formatTaskEvidence,
  formatTaskRuns,
  isHolding,
  type RunRow,
  type TaskEvidence,
} from "./taskShow";

const now = 10_000_000;
const task = { short_id: "ct-51468", status: "in_review" };

const decision = (over: Partial<DecisionRow> = {}): DecisionRow => ({
  id: "d1",
  short_id: "sd-211",
  question: "Ship the new header?\nThe context follows.",
  options: [{ label: "Approve" }, { label: "Revise" }],
  blocking: true,
  status: "pending",
  created_at: now - 5 * 60_000,
  station: "in_review",
  task_id: "t1",
  ...over,
});

const run = (over: Partial<RunRow> = {}): RunRow => ({
  _id: "r1",
  status: "paused",
  workflow_name: "line",
  task_short_id: "ct-51468",
  current_node_id: "review",
  current_node_label: "Review",
  gate_decision_short_id: "sd-211",
  updated_at: now - 2 * 60_000,
  ...over,
});

const evidence = (over: Partial<TaskEvidence> = {}): TaskEvidence => ({
  task: { id: "t1", short_id: "ct-51468", station: "in_review" },
  pages: [],
  stations: [],
  docs: [],
  images: [],
  files_changed: [],
  verification_evidence: null,
  execution_status: null,
  pr_url: null,
  review_verdict: null,
  ...over,
});

describe("cast task show: decisions", () => {
  test("a pending blocking decision at the task's station holds it", () => {
    expect(isHolding(decision(), task)).toBe(true);
    expect(isHolding(decision({ station: "in_progress" }), task)).toBe(false);
    expect(isHolding(decision({ blocking: false }), task)).toBe(false);
    expect(isHolding(decision({ status: "answered" }), task)).toBe(false);
    // The refined station wins over the category when the team has one.
    expect(isHolding(decision({ station: "st-9" }), { status: "in_review", status_id: "st-9" })).toBe(true);
  });

  test("prints id, status, station, question head and the held marker", () => {
    const out = formatTaskDecisions([decision(), decision({ short_id: "sd-190", status: "answered", answer_index: 0, station: "in_progress" })], task, now).join("\n");
    expect(out).toContain("Decisions (2)");
    expect(out).toContain("sd-211  Ship the new header?");
    expect(out).not.toContain("The context follows");
    expect(out).toContain("open 5m ago at in_review");
    expect(out).toContain("holds the task here");
    expect(out).toContain("sd-190");
    expect(out).toContain("answered: Approve at in_progress");
    // Only the held row carries the marker.
    expect(out.split("holds the task here").length).toBe(2);
  });

  test("an advisory decision says so and nothing prints for none", () => {
    expect(formatTaskDecisions([decision({ blocking: false })], task, now).join("\n")).toContain("(advisory)");
    expect(formatTaskDecisions([], task, now)).toEqual([]);
  });
});

describe("cast task show: runs", () => {
  test("prints status, workflow, node and gate", () => {
    const out = formatTaskRuns([run(), run({ _id: "r0", status: "failed", fail_reason: "gate withdrawn", gate_decision_short_id: undefined, current_node_label: undefined, current_node_id: undefined, updated_at: now - 3 * 3_600_000 })], now).join("\n");
    expect(out).toContain("Runs (2)");
    expect(out).toContain("paused  line  at Review  gate sd-211  2m ago");
    expect(out).toContain("failed  line  gate withdrawn  3h ago");
    expect(formatTaskRuns([], now)).toEqual([]);
  });
});

describe("cast task show: evidence", () => {
  test("pages by station with /a/ urls, docs, files, PR, verification, verdict", () => {
    const page = { slug: "s1", title: "Header report", version: 2, kind: "html", station: "implement", href: "/a/s1", updated_at: now };
    const ev = evidence({
      pages: [page],
      stations: [{ station: "implement", pages: [page] }],
      docs: [{ id: "doc1", title: "Handoff notes", doc_type: "note", updated_at: now, href: "/docs/doc1" }],
      files_changed: ["a.ts", "b.ts"],
      verification_evidence: "bun test taskShow: 6 pass\nscreenshot attached",
      pr_url: "https://github.com/x/y/pull/5",
      review_verdict: { verdict: "approve", at: now, note: "Looks right" },
      images: [{ url: "https://img", conversation_id: "c", message_id: "m", timestamp: now }],
    });
    const out = formatTaskEvidence(ev, "https://codecast.sh/").join("\n");
    expect(out).toContain("Evidence");
    expect(out).toContain("implement  Header report  https://codecast.sh/a/s1");
    expect(out).toContain("Handoff notes  https://codecast.sh/docs/doc1");
    expect(out).toContain("Images: 1");
    expect(out).toContain("Files changed: a.ts, b.ts");
    expect(out).toContain("PR: https://github.com/x/y/pull/5");
    expect(out).toContain("Verification:\n    bun test taskShow: 6 pass\n    screenshot attached");
    expect(out).toContain("Review: approve Looks right");
  });

  test("an unfiled page prints under unfiled; empty evidence prints nothing", () => {
    const page = { slug: "s2", title: "Loose page", version: 1, kind: "html", station: null, href: "/a/s2", updated_at: now };
    expect(formatTaskEvidence(evidence({ pages: [page], stations: [{ station: "", pages: [page] }] }), "https://codecast.sh").join("\n")).toContain("unfiled  Loose page");
    expect(formatTaskEvidence(evidence(), "https://codecast.sh")).toEqual([]);
    expect(formatTaskEvidence(null, "https://codecast.sh")).toEqual([]);
  });
});

describe("cast workflow runs", () => {
  test("one table: age, status, workflow, task, node, gate", () => {
    const out = formatRunsTable([run(), run({ _id: "r2", status: "running", task_short_id: undefined, plan_short_id: "pl-682", current_node_label: "Implement", gate_decision_short_id: undefined, updated_at: now - 60_000 })], now);
    const lines = out.split("\n");
    expect(lines[0]).toBe("age     status   workflow  task      node       gate");
    expect(lines[1]).toBe("2m ago  paused   line      ct-51468  Review     sd-211");
    expect(lines[2]).toBe("1m ago  running  line      pl-682    Implement  -");
    expect(formatRunsTable([], now)).toBe("No runs.");
  });
});

describe("cast org feed", () => {
  test("a run row prints like the other kinds: kind, status and node, actor, age", () => {
    const out = formatFeedRow({ kind: "run", title: "line", state: "paused · Review", actor: { name: "Head of Growth" }, preview: "Ship the new header?" }, "2m ago", "");
    expect(out[0]).toBe("run               line · paused · Review · Head of Growth 2m ago");
    expect(out[1]).toBe("         Ship the new header?");
  });
  test("a task row keeps its short id column", () => {
    const out = formatFeedRow({ kind: "task", short_id: "ct-51468", title: "CLI surfaces", state: "in_review" }, "1h ago", "");
    expect(out).toEqual(["task     ct-51468 CLI surfaces · in_review 1h ago"]);
  });
});
