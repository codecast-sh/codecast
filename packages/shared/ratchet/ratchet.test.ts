import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRatchet, codeOnly, countMatches, parseAllowlist, syncAllowlist, type RatchetSpec } from "./index";

// What has to be true for a ratchet to be worth more than the guard test it
// replaces: a swap fails, a stale entry fails, a listed file may not grow, and
// the writer cannot be used to widen anything.

const roots: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ratchet-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, "src", name), body);
  return root;
}

function specFor(root: string, pin: number): RatchetSpec {
  return {
    name: "banned call",
    root,
    dirs: ["src"],
    count: (src) => countMatches(src, /banned\(/),
    allowlist: join(root, "allowlist.txt"),
    pin,
    fix: "Call allowed() instead.",
    pruneCommand: "RATCHET_WRITE=prune bun test x",
    minScanned: 1,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("shrink-only ratchet", () => {
  test("a listed file at its pinned count is clean", () => {
    const root = fixture({ "a.ts": "banned();\n" });
    writeFileSync(join(root, "allowlist.txt"), "src/a.ts 1\n");
    expect(checkRatchet(specFor(root, 1)).problems).toEqual([]);
  });

  test("an unlisted offender fails and the message says what to do instead", () => {
    const root = fixture({ "a.ts": "banned();\n" });
    writeFileSync(join(root, "allowlist.txt"), "");
    const problems = checkRatchet(specFor(root, 0)).problems;
    expect(problems.some((p) => p.includes("src/a.ts") && p.includes("Call allowed() instead."))).toBe(true);
  });

  test("a listed file may not grow", () => {
    const root = fixture({ "a.ts": "banned();\nbanned();\n" });
    writeFileSync(join(root, "allowlist.txt"), "src/a.ts 1\n");
    const problems = checkRatchet(specFor(root, 1)).problems;
    expect(problems.some((p) => p.includes("went from 1 to 2"))).toBe(true);
  });

  test("a stale entry fails, so ground taken cannot be given back", () => {
    const root = fixture({ "a.ts": "allowed();\n" });
    writeFileSync(join(root, "allowlist.txt"), "src/a.ts 1\n");
    const problems = checkRatchet(specFor(root, 0)).problems;
    expect(problems.some((p) => p.includes("src/a.ts") && p.includes("no longer breaks this rule"))).toBe(true);
  });

  test("a swap fails even though the allowlist still balances", () => {
    // The hole a bare allowlist leaves: one file migrates off, another adopts
    // the pattern, the two lists move together and the guard stays green.
    const root = fixture({ "a.ts": "allowed();\n", "b.ts": "banned();\n" });
    writeFileSync(join(root, "allowlist.txt"), "src/a.ts 1\nsrc/b.ts 1\n");
    const problems = checkRatchet(specFor(root, 1)).problems;
    expect(problems.some((p) => p.includes("src/a.ts") && p.includes("no longer breaks this rule"))).toBe(true);
  });

  test("a pin left above reality fails, naming the number to lower it to", () => {
    const root = fixture({ "a.ts": "allowed();\n" });
    writeFileSync(join(root, "allowlist.txt"), "");
    const problems = checkRatchet(specFor(root, 3)).problems;
    expect(problems.some((p) => p.includes("lower the pin in this test from 3 to 0"))).toBe(true);
  });

  test("a scan that walks the wrong tree fails instead of passing vacuously", () => {
    const root = fixture({ "a.ts": "banned();\n" });
    writeFileSync(join(root, "allowlist.txt"), "src/a.ts 1\n");
    const problems = checkRatchet({ ...specFor(root, 1), minScanned: 50 }).problems;
    expect(problems.some((p) => p.includes("guarding nothing"))).toBe(true);
  });

  test("prune drops gone entries and lowers numbers, and adds nothing", () => {
    const root = fixture({ "a.ts": "banned();\n", "b.ts": "banned();\n", "c.ts": "allowed();\n" });
    const spec = specFor(root, 1);
    writeFileSync(join(root, "allowlist.txt"), "src/a.ts 5  # a reason worth keeping\nsrc/c.ts 1\n");
    syncAllowlist(spec, [{ key: "src/a.ts", value: 1 }, { key: "src/b.ts", value: 1 }], "prune");
    const written = parseAllowlist(readFileSync(spec.allowlist, "utf8"));
    expect([...written.keys()]).toEqual(["src/a.ts"]); // b never added, c dropped
    expect(written.get("src/a.ts")).toEqual({ value: 1, note: "a reason worth keeping" });
  });

  test("comments never count as offences", () => {
    const root = fixture({ "a.ts": "// never call banned(\n/* banned( */\nallowed();\n" });
    writeFileSync(join(root, "allowlist.txt"), "");
    expect(checkRatchet(specFor(root, 0)).problems).toEqual([]);
    expect(codeOnly("// banned(\nallowed();").trim()).toBe("allowed();");
  });
});
