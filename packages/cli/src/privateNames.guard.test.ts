// codecast is a public repository. CLI tests, fixtures and test helpers once
// carried a private customer repository's paths, deploy targets and people's
// home directories (ct-101913). Use synthetic ones instead (acme-app, server/,
// /Users/dev): when this fails on your file, rename what it names.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const CLI = path.resolve(path.dirname(THIS_FILE), "..");

/** Spelled in pieces so this file does not match itself. */
const PRIVATE = [
  ["union", "-mobile"],
  ["outreach", "/"],
  ["aiv", "ery"],
  ["/Users/", "ashot"],
  ["/Users/", "jasonbenn"],
].map((parts) => parts.join(""));

const SKIP_DIRS = new Set(["node_modules", "dist"]);

function isTestFile(rel: string): boolean {
  return /\.test\.tsx?$/.test(rel) || /(^|\/)(__fixtures__|test-helpers)\//.test(rel) || /\.testkit\.ts$/.test(rel);
}

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

describe("CLI tests name no private repository", () => {
  test("no test, fixture or test helper names a private path or target", () => {
    const hits: string[] = [];
    for (const file of walk(path.join(CLI, "src"))) {
      const rel = path.relative(CLI, file);
      if (file === THIS_FILE || !isTestFile(rel)) continue;
      const text = fs.readFileSync(file, "utf8").toLowerCase();
      for (const name of PRIVATE) if (text.includes(name.toLowerCase())) hits.push(`${rel}: ${name}`);
    }
    expect(hits).toEqual([]);
  });
});
