import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Every new conversation says whether it runs inside its parent's process
// (conversations.runs_in_parent): every process gate reads it, and a row born
// without it falls back to the legacy guess that made `cast spawn --subagent`
// workers look like in-process subagents (left out of revive and hibernation,
// their limit parks routed to a parent that could not redo their work). So
// every insert into conversations names the field. Test worlds (test*.ts) are
// not inserts the deployment makes.

const convexDir = import.meta.dir;
const sources = [...new Bun.Glob("**/*.ts").scanSync(convexDir)]
  .filter((f) => !f.startsWith("_generated/") && (f.split("/").pop()!.match(/\./g) ?? []).length === 1 && !/(^|\/)test[A-Z]\w*\.ts$/.test(f));

function insertLiterals(src: string): string[] {
  const out: string[] = [];
  const marker = 'insert("conversations", {';
  for (let at = src.indexOf(marker); at !== -1; at = src.indexOf(marker, at + 1)) {
    let depth = 0;
    const start = at + marker.length - 1;
    for (let i = start; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) { out.push(src.slice(start, i + 1)); break; }
    }
  }
  return out;
}

describe("every conversation insert writes runs_in_parent", () => {
  test("found the inserts", () => {
    const total = sources.reduce((n, f) => n + insertLiterals(readFileSync(join(convexDir, f), "utf8")).length, 0);
    expect(total).toBeGreaterThanOrEqual(12);
  });

  for (const file of sources) {
    const literals = insertLiterals(readFileSync(join(convexDir, file), "utf8"));
    if (literals.length === 0) continue;
    test(file, () => {
      for (const literal of literals) expect(literal).toMatch(/\bruns_in_parent\s*:/);
    });
  }
});
