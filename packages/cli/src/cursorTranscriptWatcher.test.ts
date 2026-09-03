import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CursorTranscriptWatcher, isCursorTranscriptPath, type CursorTranscriptEvent } from "./cursorTranscriptWatcher.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups) {
    try { fn(); } catch {}
  }
  cleanups.length = 0;
});

function tmpDir(prefix: string): string {
  const root = path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

describe("CursorTranscriptWatcher", () => {
  test("start() resolves at once when the projects root is missing", async () => {
    const watcher = new CursorTranscriptWatcher(path.join(os.tmpdir(), "cursor-missing-" + Date.now()));
    cleanups.push(() => watcher.stop());
    await watcher.start();
    await watcher.whenPrimed();
  });

  test("the file filter accepts transcripts and rejects terminals (the precedence fix)", () => {
    expect(isCursorTranscriptPath(path.join("p1", "agent-transcripts", "abc", "abc.txt"))).toBe(true);
    expect(isCursorTranscriptPath("p1/agent-transcripts/abc/abc.txt")).toBe(true);
    // Before the fix `a && b || c` let any path containing "agent-transcripts/"
    // through regardless of extension, and a .txt anywhere else was rejected
    // only by luck of the operand order.
    expect(isCursorTranscriptPath(path.join("p1", "terminals", "1.txt"))).toBe(false);
    expect(isCursorTranscriptPath(path.join("p1", "agent-transcripts", "abc", "abc.json"))).toBe(false);
  });

  test("priming emits only transcripts and never opens the terminals or canvases dirs", async () => {
    const root = tmpDir("cursor-tw");
    const proj = path.join(root, "1781228044385");
    const transcript = path.join(proj, "agent-transcripts", "abc", "abc.txt");
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.mkdirSync(path.join(proj, "terminals"), { recursive: true });
    fs.mkdirSync(path.join(proj, "canvases"), { recursive: true });
    fs.writeFileSync(transcript, "user:\nhi\n");
    fs.writeFileSync(path.join(proj, "terminals", "1.txt"), "$ ls\n");
    fs.writeFileSync(path.join(proj, "canvases", "x.txt"), "canvas");

    // The walk reads a directory only to list it; a readdir on terminals or
    // canvases shows up as an access time bump only on some filesystems, so
    // instead prove it through the emitted set AND the dirFilter contract:
    // a file the filter would accept, planted under a pruned dir, must not
    // be emitted either.
    fs.mkdirSync(path.join(proj, "terminals", "agent-transcripts"), { recursive: true });
    fs.writeFileSync(path.join(proj, "terminals", "agent-transcripts", "decoy.txt"), "decoy");

    const events: CursorTranscriptEvent[] = [];
    const watcher = new CursorTranscriptWatcher(root);
    cleanups.push(() => watcher.stop());
    watcher.on("session", (e) => events.push(e));
    await watcher.start();

    expect(events.map((e) => e.filePath)).toEqual([transcript]);
    expect(events[0].sessionId).toBe("abc");
  });
});
