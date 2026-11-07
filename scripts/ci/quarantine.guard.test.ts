// QUARANTINE.md's rule, enforced: a quarantined test is fixed or deleted
// within 14 days, so a row past its deadline fails CI and names the test.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEADLINE_DAYS = 14;
const DAY = 24 * 60 * 60 * 1000;

export function quarantineRows(markdown: string): Array<{ test: string; date: string }> {
  const list = markdown.split(/^## List\s*$/m)[1] ?? "";
  return list.split("\n")
    .filter((line) => line.startsWith("|") && !/^\|\s*(Test|-+)\s*\|/.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 2 && cells[0])
    .map(([testName, date]) => ({ test: testName, date }));
}

export function expired(rows: Array<{ test: string; date: string }>, now: number): string[] {
  return rows.filter(({ date }) => {
    const at = Date.parse(`${date}T00:00:00Z`);
    return !Number.isFinite(at) || now - at > DEADLINE_DAYS * DAY;
  }).map(({ test: name, date }) => `${name} (quarantined ${date})`);
}

test("no quarantined test is past its 14-day deadline, and every row has a YYYY-MM-DD date", () => {
  const rows = quarantineRows(readFileSync(join(import.meta.dir, "..", "..", "QUARANTINE.md"), "utf8"));
  expect(expired(rows, Date.now())).toEqual([]);
});

test("the deadline check reads the table the way the policy describes it", () => {
  const md = "# Q\n\n## List\n\n| Test | Date | Owner | Symptom | Link |\n|------|------|-------|---------|------|\n| a.test.ts > one | 2026-11-01 | ashot | flaky | ct-1 |\n| b.test.ts > two | 2026-10-01 | ashot | flaky | ct-2 |\n| c.test.ts > three | soon | ashot | flaky | ct-3 |\n";
  const rows = quarantineRows(md);
  expect(rows.map((r) => r.test)).toEqual(["a.test.ts > one", "b.test.ts > two", "c.test.ts > three"]);
  expect(expired(rows, Date.parse("2026-11-07T12:00:00Z"))).toEqual(["b.test.ts > two (quarantined 2026-10-01)", "c.test.ts > three (quarantined soon)"]);
});
