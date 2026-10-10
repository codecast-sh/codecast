import { describe, expect, test } from "bun:test";
import { diffGapRows, promptDiff, promptParts, promptSections } from "../promptText";

const PROMPT = [
  "You read one cluster of findings and decide whether it is already explained.",
  "",
  "## Inputs",
  "The cluster's title is $task_title. Read `findings.json` first.",
  "",
  "$shared.json.rulings",
  "",
  "## Decide",
  "",
  "**Dissolve** when a proven cause covers every quote. Otherwise keep it open.",
].join("\n");

describe("a prompt as an outline", () => {
  test("the text before the first heading is the Role, and each heading is a section with a plain lead", () => {
    const s = promptSections(PROMPT);
    expect(s.map((x) => x.title)).toEqual(["Role", "Inputs", "Decide"]);
    expect(s[1].lead).toBe("The cluster's title is task title.");
    expect(s[2].lead).toBe("Dissolve when a proven cause covers every quote.");
    expect(s[1].start).toBe(3);
    expect(s[1].end).toBe(7);
  });

  test("a heading with nothing under it drops out", () => {
    expect(promptSections("## Empty\n\n## Real\nText.").map((x) => x.title)).toEqual(["Real"]);
  });

  test("a shared section alone on its line is cut out to fold in place", () => {
    const parts = promptParts(PROMPT);
    expect(parts.map((p) => p.kind)).toEqual(["text", "include", "text"]);
    expect(parts[1]).toEqual({ kind: "include", name: "rulings", from: "shared" });
  });
});

describe("a prompt diff", () => {
  const before = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
  const after = before.replace("line 6", "line six").concat("\nline 12");

  test("counts lines and folds the unchanged stretch", () => {
    const d = promptDiff(before, after);
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    expect(d.rows[0]).toEqual({ op: "gap", count: 4, from: 0 });
    expect(d.rows.filter((r) => r.op === "del")).toEqual([{ op: "del", text: "line 6" }]);
    expect([...d.changedAfter]).toEqual([6, 12]);
  });

  test("a gap opens to the rows it folded", () => {
    expect(diffGapRows(before, after, 0, 2)).toEqual([{ op: "ctx", text: "line 0" }, { op: "ctx", text: "line 1" }]);
  });

  test("the same text has nothing to show", () => {
    const d = promptDiff(before, before);
    expect(d.added + d.removed).toBe(0);
    expect(d.rows).toEqual([{ op: "gap", count: 12, from: 0 }]);
  });
});

test("a section that opens with a list of facts leads with what it names, not its placeholders", () => {
  const facts = "## Facts\n- Cause task: $task_id\n- Cluster: $cluster_id ($finding_count findings, judged by $judge)\n- Severity: $severity\n- Window: $window\n- Owner: $owner";
  expect(promptSections(facts)[0].lead).toBe("Cause task, cluster, severity and 2 more");
  expect(promptSections("## Facts\n- Cause task: $task_id\n- Cluster: $cluster_id")[0].lead).toBe("Cause task and cluster");
  // An item wrapped onto an indented line is still one item.
  const wrapped = "## Facts\n\n- Cause task: $task_id\n- Cluster: $bind.json.cluster_id ($bind.json.finding_count findings, judge\n  $bind.json.judge_kind), $bind.json.cluster_url\n- Attempt: $bind.json.attempt_id\n- What the first look concluded: $dissolve.json.evidence\n- Findings left to explain: $dissolve.json.residue";
  expect(promptSections(wrapped)[0].lead).toBe("Cause task, cluster, attempt and 2 more");
});
