import { describe, test, expect, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { RecursiveWatcher } from "./recursiveWatcher.js";

function tmpDir(prefix: string): string {
  return path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups) {
    try { fn(); } catch {}
  }
  cleanups.length = 0;
});

describe("RecursiveWatcher", () => {
  test("detects new file creation", async () => {
    const root = tmpDir("rw-create");
    fs.mkdirSync(root, { recursive: true });

    const events: { path: string; type: string }[] = [];
    const watcher = new RecursiveWatcher({
      path: root,
      filter: (rel) => rel.endsWith(".jsonl"),
      callback: (filePath, eventType) => events.push({ path: filePath, type: eventType }),
      debounceMs: 50,
    });

    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    watcher.start();

    // Wait a bit for watcher to initialize
    await new Promise(r => setTimeout(r, 200));

    const filePath = path.join(root, "test.jsonl");
    fs.writeFileSync(filePath, '{"test": true}\n');

    // Wait for debounce + processing
    await new Promise(r => setTimeout(r, 500));

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some(e => e.path === filePath)).toBe(true);
  });

  test("detects file modification", async () => {
    const root = tmpDir("rw-modify");
    fs.mkdirSync(root, { recursive: true });

    const filePath = path.join(root, "existing.jsonl");
    fs.writeFileSync(filePath, '{"line": 1}\n');

    const events: { path: string; type: string }[] = [];
    const watcher = new RecursiveWatcher({
      path: root,
      filter: (rel) => rel.endsWith(".jsonl"),
      callback: (filePath, eventType) => events.push({ path: filePath, type: eventType }),
      debounceMs: 50,
    });

    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    fs.appendFileSync(filePath, '{"line": 2}\n');
    await new Promise(r => setTimeout(r, 500));

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some(e => e.path === filePath)).toBe(true);
  });

  test("filters by extension", async () => {
    const root = tmpDir("rw-filter");
    fs.mkdirSync(root, { recursive: true });

    const events: string[] = [];
    const watcher = new RecursiveWatcher({
      path: root,
      filter: (rel) => rel.endsWith(".jsonl"),
      callback: (filePath) => events.push(filePath),
      debounceMs: 50,
    });

    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    // Write a .txt file -- should be filtered out
    fs.writeFileSync(path.join(root, "ignore.txt"), "ignored");
    // Write a .jsonl file -- should be detected
    const goodFile = path.join(root, "good.jsonl");
    fs.writeFileSync(goodFile, '{"ok": true}\n');

    await new Promise(r => setTimeout(r, 500));

    expect(events.some(e => e.includes("ignore.txt"))).toBe(false);
    expect(events.some(e => e.includes("good.jsonl"))).toBe(true);
  });

  test("respects maxDepth", async () => {
    const root = tmpDir("rw-depth");
    fs.mkdirSync(root, { recursive: true });

    const events: string[] = [];
    const watcher = new RecursiveWatcher({
      path: root,
      filter: (rel) => rel.endsWith(".jsonl"),
      callback: (filePath) => events.push(filePath),
      maxDepth: 2,
      debounceMs: 50,
    });

    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    // depth 1: subdir/file.jsonl -- should work
    const shallow = path.join(root, "subdir");
    fs.mkdirSync(shallow, { recursive: true });
    fs.writeFileSync(path.join(shallow, "ok.jsonl"), "{}");

    // depth 3: a/b/c/deep.jsonl -- should be filtered out by maxDepth
    const deep = path.join(root, "a", "b", "c");
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, "deep.jsonl"), "{}");

    await new Promise(r => setTimeout(r, 500));

    expect(events.some(e => e.includes("ok.jsonl"))).toBe(true);
    expect(events.some(e => e.includes("deep.jsonl"))).toBe(false);
  });

  test("debounces rapid writes", async () => {
    const root = tmpDir("rw-debounce");
    fs.mkdirSync(root, { recursive: true });

    const events: string[] = [];
    const watcher = new RecursiveWatcher({
      path: root,
      filter: (rel) => rel.endsWith(".jsonl"),
      callback: (filePath) => events.push(filePath),
      debounceMs: 200,
    });

    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    const filePath = path.join(root, "rapid.jsonl");
    // Write rapidly 5 times
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(filePath, `{"i": ${i}}\n`);
      await new Promise(r => setTimeout(r, 20));
    }

    // Wait for debounce to settle
    await new Promise(r => setTimeout(r, 500));

    // Should have coalesced into fewer events than 5
    const rapidEvents = events.filter(e => e.includes("rapid.jsonl"));
    expect(rapidEvents.length).toBeLessThan(5);
    expect(rapidEvents.length).toBeGreaterThanOrEqual(1);
  });

  test("stop cleans up and no more events fire", async () => {
    const root = tmpDir("rw-stop");
    fs.mkdirSync(root, { recursive: true });

    const events: string[] = [];
    const watcher = new RecursiveWatcher({
      path: root,
      filter: (rel) => rel.endsWith(".jsonl"),
      callback: (filePath) => events.push(filePath),
      debounceMs: 50,
    });

    cleanups.push(() => { fs.rmSync(root, { recursive: true, force: true }); });
    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    watcher.stop();
    expect(watcher.isWatching).toBe(false);

    // Write after stop -- should NOT trigger callback
    fs.writeFileSync(path.join(root, "after-stop.jsonl"), "{}");
    await new Promise(r => setTimeout(r, 300));

    expect(events.some(e => e.includes("after-stop.jsonl"))).toBe(false);
  });

  test("restart works correctly", async () => {
    const root = tmpDir("rw-restart");
    fs.mkdirSync(root, { recursive: true });

    const events: string[] = [];
    const watcher = new RecursiveWatcher({
      path: root,
      filter: (rel) => rel.endsWith(".jsonl"),
      callback: (filePath) => events.push(filePath),
      debounceMs: 50,
    });

    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    watcher.restart();
    expect(watcher.isWatching).toBe(true);
    await new Promise(r => setTimeout(r, 200));

    fs.writeFileSync(path.join(root, "after-restart.jsonl"), "{}");
    await new Promise(r => setTimeout(r, 500));

    expect(events.some(e => e.includes("after-restart.jsonl"))).toBe(true);
  });

  test("handles deleted files gracefully", async () => {
    const root = tmpDir("rw-delete");
    fs.mkdirSync(root, { recursive: true });

    const events: { path: string; type: string }[] = [];
    const watcher = new RecursiveWatcher({
      path: root,
      filter: (rel) => rel.endsWith(".jsonl"),
      callback: (filePath, eventType) => events.push({ path: filePath, type: eventType }),
      debounceMs: 50,
    });

    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    const filePath = path.join(root, "ephemeral.jsonl");
    fs.writeFileSync(filePath, "{}");
    // Delete immediately before debounce fires
    await new Promise(r => setTimeout(r, 10));
    fs.unlinkSync(filePath);

    // Should not crash -- the debounce handler catches the stat error
    await new Promise(r => setTimeout(r, 300));
    // No assertion needed -- just verifying no crash
  });

  test("creates watch directory if missing", async () => {
    const root = tmpDir("rw-missing-dir");

    const watcher = new RecursiveWatcher({
      path: root,
      filter: () => true,
      callback: () => {},
    });

    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });

    expect(fs.existsSync(root)).toBe(false);
    watcher.start();
    expect(fs.existsSync(root)).toBe(true);
  });

  test("detects files in nested subdirectories", async () => {
    const root = tmpDir("rw-nested");
    fs.mkdirSync(root, { recursive: true });

    const events: string[] = [];
    const watcher = new RecursiveWatcher({
      path: root,
      filter: (rel) => rel.endsWith(".jsonl"),
      callback: (filePath) => events.push(filePath),
      debounceMs: 50,
    });

    cleanups.push(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    watcher.start();
    await new Promise(r => setTimeout(r, 200));

    // Create a new subdirectory and write a file into it
    const subDir = path.join(root, "new-project");
    fs.mkdirSync(subDir, { recursive: true });
    const filePath = path.join(subDir, "session.jsonl");
    fs.writeFileSync(filePath, '{"msg": "hello"}\n');

    await new Promise(r => setTimeout(r, 500));

    expect(events.some(e => e.includes("session.jsonl"))).toBe(true);
  });
});
