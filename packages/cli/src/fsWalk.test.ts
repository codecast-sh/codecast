import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { walkFiles, listFilesByMtime } from "./fsWalk.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups) { try { fn(); } catch {} }
  cleanups.length = 0;
});

function scaffold(): string {
  const root = path.join(os.tmpdir(), `fswalk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(path.join(root, "a", "b", "c"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(root, "top.jsonl"), "1");
  fs.writeFileSync(path.join(root, "a", "one.jsonl"), "1");
  fs.writeFileSync(path.join(root, "a", "skip.txt"), "1");
  fs.writeFileSync(path.join(root, "a", "b", "two.jsonl"), "1");
  fs.writeFileSync(path.join(root, "a", "b", "c", "three.jsonl"), "1");
  fs.writeFileSync(path.join(root, "node_modules", "pkg", "dep.jsonl"), "1");
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

async function rels(root: string, opts: Parameters<typeof walkFiles>[1]): Promise<string[]> {
  const out: string[] = [];
  await walkFiles(root, opts, (f) => out.push(f.rel));
  return out.sort();
}

describe("walkFiles", () => {
  test("reports every file with a stat and its depth", async () => {
    const root = scaffold();
    const depths = new Map<string, number>();
    await walkFiles(root, {}, (f) => {
      expect(f.stat.isFile()).toBe(true);
      depths.set(f.rel, f.depth);
    });
    expect(depths.get("top.jsonl")).toBe(1);
    expect(depths.get(path.join("a", "one.jsonl"))).toBe(2);
    expect(depths.get(path.join("a", "b", "c", "three.jsonl"))).toBe(4);
    expect(depths.size).toBe(6);
  });

  test("maxDepth bounds files by segment count, matching RecursiveWatcher", async () => {
    const root = scaffold();
    expect(await rels(root, { maxDepth: 1 })).toEqual(["top.jsonl"]);
    expect(await rels(root, { maxDepth: 2, fileFilter: (r) => r.endsWith(".jsonl") })).toEqual(
      [path.join("a", "one.jsonl"), path.join("node_modules", "pkg", "dep.jsonl"), "top.jsonl"].filter((r) => r.split(path.sep).length <= 2).sort(),
    );
    expect(await rels(root, { maxDepth: 3, fileFilter: (r) => r.endsWith(".jsonl") })).toContain(path.join("a", "b", "two.jsonl"));
    expect(await rels(root, { maxDepth: 3 })).not.toContain(path.join("a", "b", "c", "three.jsonl"));
  });

  test("dirFilter prunes a subtree before it is read", async () => {
    const root = scaffold();
    const opened: string[] = [];
    const out = await rels(root, {
      dirFilter: (rel) => { opened.push(rel); return !rel.split(path.sep).includes("node_modules"); },
    });
    expect(out.some((r) => r.includes("node_modules"))).toBe(false);
    expect(opened.some((r) => r.startsWith(path.join("node_modules", "pkg")))).toBe(false);
  });

  test("fileFilter skips the stat for rejected files", async () => {
    const root = scaffold();
    const out = await rels(root, { fileFilter: (rel) => rel.endsWith(".jsonl") });
    expect(out).not.toContain(path.join("a", "skip.txt"));
    expect(out).toHaveLength(5);
  });

  test("a missing root reports nothing and does not throw", async () => {
    const out = await rels(path.join(os.tmpdir(), "fswalk-does-not-exist"), {});
    expect(out).toEqual([]);
  });
});

describe("listFilesByMtime", () => {
  test("newest first", async () => {
    const root = scaffold();
    const now = Date.now();
    fs.utimesSync(path.join(root, "top.jsonl"), new Date(now - 30_000), new Date(now - 30_000));
    fs.utimesSync(path.join(root, "a", "one.jsonl"), new Date(now), new Date(now));
    const files = await listFilesByMtime(root, { maxDepth: 2, fileFilter: (r) => r.endsWith(".jsonl") });
    expect(files[0].rel).toBe(path.join("a", "one.jsonl"));
    expect(files[files.length - 1].rel).toBe("top.jsonl");
  });
});
