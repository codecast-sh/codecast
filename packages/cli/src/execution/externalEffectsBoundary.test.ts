import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const executionRoot = path.dirname(fileURLToPath(import.meta.url));

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(full);
  }
  return files;
}

describe("fenced execution external-effect boundary", () => {
  test("coordinator and control-plane code cannot directly inject into tmux or Codex", () => {
    const forbiddenOutsideDrivers = [
      /\binjectViaTmux\b/,
      /\bturnStart\s*\(/,
      /\binjectDelivery\s*\(/,
      /\blaunchLiteral\s*\(/,
      /send-keys/,
      /paste-buffer/,
      /from\s+["'](?:\.\.\/)+(?:daemon|tmux|codexAppServer)\.js["']/,
    ];
    const violations: string[] = [];
    for (const file of sourceFiles(executionRoot)) {
      if (file.includes(`${path.sep}drivers${path.sep}`)) continue;
      const source = fs.readFileSync(file, "utf8");
      for (const pattern of forbiddenOutsideDrivers) {
        if (pattern.test(source)) {
          violations.push(`${path.relative(executionRoot, file)} matched ${pattern}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("the fenced coordinator reaches external effects only through RuntimeDriver.deliver", () => {
    const source = fs.readFileSync(path.join(executionRoot, "coordinator.ts"), "utf8");
    expect(source).toContain("driver.deliver({ binding, permit, delivery })");
    expect(source).not.toContain(".turnStart(");
    expect(source).not.toContain("injectViaTmux");
    expect(source).not.toContain("send-keys");
  });

  test("legacy daemon effects are explicitly outside this dormant rail until migration", () => {
    const indexSource = fs.readFileSync(path.join(executionRoot, "index.ts"), "utf8");
    const daemonSource = fs.readFileSync(path.join(executionRoot, "..", "daemon.ts"), "utf8");
    expect(indexSource).not.toContain("daemon");
    // This assertion makes the migration boundary honest: the guard above covers
    // fenced-v2 today; legacy injection remains and cannot be relabeled as fenced.
    expect(daemonSource).toContain("injectViaTmux");
  });
});
