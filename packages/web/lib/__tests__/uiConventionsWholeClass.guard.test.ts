import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// docs/principles.md PR-code-4: a reported UI defect is one case of a class.
// Sessions load AGENTS.md (CLAUDE.md links to it), so the rule must sit in its
// UI conventions, or it is never read when a UI defect is reported.
const AGENTS = readFileSync(join(import.meta.dir, "..", "..", "..", "..", "AGENTS.md"), "utf8");

function uiConventions(): string[] {
  const start = AGENTS.indexOf("\n## UI conventions\n");
  expect(start).toBeGreaterThan(-1);
  const end = AGENTS.indexOf("\n## ", start + 1);
  return AGENTS.slice(start, end === -1 ? undefined : end).split(/\n(?=- |\*\*)/);
}

test("UI conventions tell the agent to fix a reported UI defect across its whole class", () => {
  const entry = uiConventions().find((p) => /\bclass\b/i.test(p) && /\b(every other|sibling)/i.test(p) && /\breport/i.test(p));
  expect(entry ?? "no UI-conventions entry tells the agent to treat a reported UI defect as one case of a class and sweep its siblings").not.toMatch(/^no UI-conventions entry/);
});
