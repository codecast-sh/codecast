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

/** Rows past the deadline, dated in the future (a moved deadline), or not a real YYYY-MM-DD day. */
export function expired(rows: Array<{ test: string; date: string }>, now: number): string[] {
  return rows.filter(({ date }) => {
    const at = Date.parse(`${date}T00:00:00Z`);
    const real = /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === date;
    return !real || at > now || now - at > DEADLINE_DAYS * DAY;
  }).map(({ test: name, date }) => `${name} (quarantined ${date})`);
}

const MARKER = "quarantined: see QUARANTINE.md";

/** Files under packages/ that carry the quarantine marker, relative to the repo root. */
function markedFiles(root: string): string[] {
  const glob = new Bun.Glob("packages/**/*.{ts,tsx,js,jsx,mjs,cjs}");
  const out: string[] = [];
  for (const file of glob.scanSync({ cwd: root })) {
    if (file.includes("node_modules/")) continue;
    if (readFileSync(join(root, file), "utf8").includes(MARKER)) out.push(file);
  }
  return out;
}

const ROOT = join(import.meta.dir, "..", "..");

test("no quarantined test is past its 14-day deadline, and every row has a real past YYYY-MM-DD date", () => {
  const rows = quarantineRows(readFileSync(join(ROOT, "QUARANTINE.md"), "utf8"));
  expect(expired(rows, Date.now())).toEqual([]);
});

test("every skipped test marked as quarantined has a row, and every row names a marked file", () => {
  const rows = quarantineRows(readFileSync(join(ROOT, "QUARANTINE.md"), "utf8"));
  const marked = markedFiles(ROOT);
  const fileOf = (row: { test: string }) => row.test.split(" > ")[0].trim();
  expect(marked.filter((file) => !rows.some((row) => fileOf(row) === file))).toEqual([]);
  expect(rows.filter((row) => !marked.includes(fileOf(row))).map((row) => row.test)).toEqual([]);
});

test("the deadline check reads the table the way the policy describes it", () => {
  const md = "# Q\n\n## List\n\n| Test | Date | Owner | Symptom | Link |\n|------|------|-------|---------|------|\n| a.test.ts > one | 2026-11-01 | ashot | flaky | ct-1 |\n| b.test.ts > two | 2026-10-01 | ashot | flaky | ct-2 |\n| c.test.ts > three | soon | ashot | flaky | ct-3 |\n| d.test.ts > four | 2026-02-30 | ashot | flaky | ct-4 |\n| e.test.ts > five | 2099-01-01 | ashot | flaky | ct-5 |\n";
  const rows = quarantineRows(md);
  expect(rows.map((r) => r.test)).toEqual(["a.test.ts > one", "b.test.ts > two", "c.test.ts > three", "d.test.ts > four", "e.test.ts > five"]);
  expect(expired(rows, Date.parse("2026-11-07T12:00:00Z"))).toEqual([
    "b.test.ts > two (quarantined 2026-10-01)", "c.test.ts > three (quarantined soon)",
    "d.test.ts > four (quarantined 2026-02-30)", "e.test.ts > five (quarantined 2099-01-01)",
  ]);
});
