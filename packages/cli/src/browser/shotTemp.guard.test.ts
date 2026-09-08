/**
 * No screenshot may be written into the shared temp directory again.
 *
 * The whole point of the scratch policy (tempFiles.ts) is that a capture of
 * the human's page is readable only by them and does not live forever. A new
 * command that reaches for `os.tmpdir()` and a `.png` reopens that hole
 * quietly, because nothing about it looks wrong at review — which is why this
 * is a test and not a note (ct-49556).
 *
 * If this fails on your code, take the path from `defaultShotPath()` or
 * `agentTempPath(SHOT_TEMP_KIND, …)` rather than widening the allowlist.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC = path.resolve(import.meta.dir, "..");

/** Every non-test .ts file under packages/cli/src. */
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "dist") sources(file, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
      out.push(file);
    }
  }
  return out;
}

describe("screenshots stay out of the shared temp directory", () => {
  test("no source builds an image path from os.tmpdir()", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const text = fs.readFileSync(file, "utf-8");
      text.split("\n").forEach((line, i) => {
        if (!line.includes("os.tmpdir()")) return;
        if (!/\.(png|jpe?g|webp)\b/i.test(line)) return;
        if (/^\s*(\*|\/\/|\/\*)/.test(line)) return; // a comment naming the old path
        offenders.push(`${path.relative(SRC, file)}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test("the helper the offenders should use is exported where they can reach it", () => {
    const shotFile = fs.readFileSync(path.join(SRC, "browser", "shotFile.ts"), "utf-8");
    expect(shotFile).toContain("export function defaultShotPath");
    const temp = fs.readFileSync(path.join(SRC, "tempFiles.ts"), "utf-8");
    expect(temp).toContain("export function agentTempPath");
  });
});
