import { afterEach, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { findUnsyncedFiles, findUnsyncedFilesAsync } from "./syncLedger.js";

// findUnsyncedFilesAsync is the daemon's non-blocking twin of findUnsyncedFiles:
// same decision per file, but promise-based fs plus event-loop yields so a
// ~3.5k-file scan of ~/.claude/projects interleaves with live work instead of
// freezing the loop for seconds. These tests pin the two walkers to identical
// answers and prove the async one actually yields.

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTree(fileCount: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unsynced-walk-"));
  tempDirs.push(root);
  for (let i = 0; i < fileCount; i++) {
    const dir = path.join(root, `-proj-${i % 7}`, i % 3 === 0 ? "subagents" : "");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `s-${i}.jsonl`), `{"i":${i}}\n`);
    if (i % 5 === 0) fs.writeFileSync(path.join(dir, `s-${i}.meta.json`), "{}"); // non-jsonl noise
  }
  return root;
}

test("async walker returns exactly the sync walker's file set", async () => {
  const root = makeTree(120);
  const sync = findUnsyncedFiles(root).sort();
  const asyncRes = (await findUnsyncedFilesAsync(root)).sort();
  expect(asyncRes).toEqual(sync);
  expect(asyncRes.length).toBe(120);
  expect(asyncRes.every((p) => p.endsWith(".jsonl"))).toBe(true);
});

test("both walkers honor the includeFile filter and a missing baseDir", async () => {
  const root = makeTree(30);
  const onlySubagents = (p: string) => p.includes(`${path.sep}subagents${path.sep}`);
  const sync = findUnsyncedFiles(root, undefined, onlySubagents).sort();
  const asyncRes = (await findUnsyncedFilesAsync(root, undefined, onlySubagents)).sort();
  expect(asyncRes).toEqual(sync);
  expect(asyncRes.length).toBe(10);
  expect(await findUnsyncedFilesAsync(path.join(root, "nope"))).toEqual([]);
});

test("async walker yields to the event loop mid-scan", async () => {
  const root = makeTree(400);
  let visited = 0;
  let visitedAtYield = -1;
  let probe: ReturnType<typeof setImmediate> | undefined;
  try {
    const files = await findUnsyncedFilesAsync(root, undefined, () => {
      if (++visited === 1) probe = setImmediate(() => { visitedAtYield = visited; });
      return true;
    });
    expect(files).toHaveLength(400);
    expect(visitedAtYield).toBeGreaterThan(0);
    expect(visitedAtYield).toBeLessThan(visited);
  } finally {
    if (probe) clearImmediate(probe);
  }
});

test("async walker honors a dirFilter and skips the pruned subtrees entirely", async () => {
  const root = makeTree(30);
  const noSubagents = (rel: string) => path.basename(rel) !== "subagents";
  const all = (await findUnsyncedFilesAsync(root)).length;
  const pruned = await findUnsyncedFilesAsync(root, undefined, undefined, noSubagents);
  expect(all).toBe(30);
  expect(pruned.length).toBe(20);
  expect(pruned.some((p) => p.includes(`${path.sep}subagents${path.sep}`))).toBe(false);
});
