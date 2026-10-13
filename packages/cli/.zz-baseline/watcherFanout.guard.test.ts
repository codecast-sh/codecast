// The daemon watches a tree with ONE recursive watch per root, never a watch
// per file. chokidar (without its native backend, which v4 dropped) opens an
// fs.watch for every file and directory it walks, and under bun on macOS
// each fs.watch stops, rebuilds and restarts the process's single FSEvents
// stream while holding the lock the JS thread needs: ~200ms per call when
// fseventsd is busy, so the ~4000 watches the daemon opened at boot froze
// its event loop for 119s and tripped the backend-outage self-heal into a
// restart loop (2026-09-15).
//
// RecursiveWatcher is the one place that decides per platform: a native
// recursive fs.watch where the OS offers one (macOS, Windows), chokidar
// where it does not. Everything else asks it. When this fails on your code,
// build a RecursiveWatcher (path, filter, maxDepth, debounceMs) instead of
// importing chokidar.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { codeLines } from "./test-helpers/sourceRegion.js";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const SKIP_DIRS = new Set(["node_modules", "__fixtures__", "dist"]);
const ALLOWED = new Set(["recursiveWatcher.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("tree watching goes through RecursiveWatcher", () => {
  test("only recursiveWatcher.ts imports chokidar", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file);
      if (ALLOWED.has(rel)) continue;
      for (const { line, n } of codeLines(fs.readFileSync(file, "utf8"))) {
        if (/from\s+["']chokidar["']|require\(\s*["']chokidar["']\s*\)/.test(line)) {
          offenders.push(`${rel}:${n} imports chokidar — build a RecursiveWatcher instead`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
