// The attribution cache keeps each transcript's credits as they were read and reads only what was appended since
// (attribute.ts CACHE_VERSION). Changing how a line is read without bumping the version leaves every daemon with
// credits made under the old rules: 1.1.252 did, and a session went on being told about a file it had only run.
// This pins the code that turns a transcript line into a credit; the pin moves with CACHE_VERSION, or alone when a
// change cannot alter a credit.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { CACHE_RULES_HASH } from "./attribute";

/** The files whose code decides what a cached line credits: reading a line (attribute.ts) and a command's writes (shellWrites.ts). */
const RULES = ["attribute.ts", "shellWrites.ts"];

/** A file's code with comments, blank lines and the pin itself left out, so prose and the pin never move the hash. */
export function rulesText(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\/\/.*$/, "").trimEnd())
    .filter((l) => l.trim() && !l.includes("CACHE_RULES_HASH"))
    .join("\n");
}

export const rulesHash = () =>
  createHash("sha256").update(RULES.map((f) => `${f}\n${rulesText(fs.readFileSync(path.join(import.meta.dir, f), "utf-8"))}`).join("\n")).digest("hex").slice(0, 16);

describe("the attribution cache's rules", () => {
  test("are the ones its version was pinned for", () => {
    const now = rulesHash();
    if (now !== CACHE_RULES_HASH) {
      throw new Error(`attribution rules changed: bump CACHE_VERSION (cached credits were read under the old rules) or, if credits can't change, update the pin. CACHE_RULES_HASH in attribute.ts is ${CACHE_RULES_HASH}; the rules now hash to ${now}.`);
    }
    expect(now).toBe(CACHE_RULES_HASH);
  });

  test("comments and the pin do not move the hash; code does", () => {
    const code = "const a = 1;\n// why\n/** doc */\nexport const CACHE_RULES_HASH = \"x\";\n\nfunction f() { return a; }";
    expect(rulesText(code)).toBe(rulesText(code.replace("// why", "// a better why").replace("\"x\"", "\"y\"")));
    expect(rulesText(code)).not.toBe(rulesText(code.replace("return a", "return a + 1")));
  });
});
