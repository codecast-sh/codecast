import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const principles = readFileSync(join(root, "docs/line/principles.md"), "utf8");
const claudeMd = readFileSync(join(root, "CLAUDE.md"), "utf8");

const section = (id: string) => {
  const start = principles.indexOf(`### ${id} `);
  const end = principles.indexOf("\n### ", start + 1);
  return principles.slice(start, end === -1 ? undefined : end);
};

describe("CC-code-1 reaches the agents that build codecast", () => {
  const body = section("CC-code-1");

  test("principles.md names the CLAUDE.md section that records it", () => {
    expect(body.length).toBeGreaterThan(0);
    expect(body).toMatch(/[Rr]ecorded in CLAUDE\.md \(([^)]+)\)/);
  });

  test("that CLAUDE.md section exists and points back to the principle", () => {
    const named = body.match(/[Rr]ecorded in CLAUDE\.md \(([^)]+)\)/)?.[1] ?? "";
    const headings = named.split(";").map((h) => h.split(":")[0].trim()).filter(Boolean);
    expect(headings.length).toBeGreaterThan(0);
    for (const h of headings) expect(claudeMd).toContain(`## ${h}`);
    expect(claudeMd).toContain("CC-code-1");
  });
});
