import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MAX_SYNC_CONTINUATIONS, continueSyncPass, cursorPassBoundary, readCompleteLines } from "./daemon.js";
import { parseCursorTranscriptFile, parseTranscriptFor } from "./parser.js";
import { measureLoopHold } from "./test-helpers/loopHold.js";

// The ingest window: one read per step, the loop free between steps, and a
// line longer than the window growing it one step at a time instead of one
// allocation of the whole remaining file.

const MB = 1024 * 1024;
const SID = "3ed92d44-c5db-441c-a3aa-b307931f3005";
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function tmpFile(name: string, content: string | Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ingest-window-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

async function withFd<T>(p: string, fn: (fd: fs.promises.FileHandle, size: number) => Promise<T>): Promise<T> {
  const fd = await fs.promises.open(p, "r");
  try {
    return await fn(fd, (await fd.stat()).size);
  } finally {
    await fd.close();
  }
}

const claudeLine = (role: "user" | "assistant", text: string) =>
  JSON.stringify({ type: role, sessionId: SID, timestamp: "2026-09-02T10:00:00.000Z", uuid: `${role}-${text.length}`, message: { role, content: [{ type: "text", text }] } });

describe("readCompleteLines", () => {
  test("a 5MB single line grows the window one step per read and never holds the loop long", async () => {
    // The first record is just under 5MB with its newline, so the fifth
    // window is the first one that holds a boundary.
    const big = claudeLine("user", "x".repeat(5 * MB - 200));
    const second = claudeLine("assistant", "done");
    const p = tmpFile("t.jsonl", `${big}\n${second}\n`);
    const { result, maxGapMs, ticks } = await measureLoopHold(async () => {
      const first = await withFd(p, (fd, size) => readCompleteLines(fd, 0, size));
      const rest = await withFd(p, (fd, size) => readCompleteLines(fd, first.bytesConsumed, size - first.bytesConsumed));
      return { first, rest, messages: parseTranscriptFor("claude", first.content + rest.content) };
    }, 1);
    // The fifth window is exactly 5MB and holds the big line's newline; the
    // short second line sits past it and belongs to the next pass.
    expect(result.first.steps).toBe(5);
    expect(result.first.bytesConsumed).toBe(Buffer.byteLength(big) + 1);
    expect(result.first.content).toBe(`${big}\n`);
    expect(result.rest).toEqual({ content: `${second}\n`, bytesConsumed: Buffer.byteLength(second) + 1, steps: 1 });
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(ticks).toBeGreaterThan(0);
    expect(maxGapMs).toBeLessThan(200);
  }, 30_000);

  test("no newline at EOF consumes nothing, so a line still being written is re-read next pass", async () => {
    const head = "{\"type\":\"user\",\"partial\":\"";
    const p = tmpFile("t.jsonl", head + "y".repeat(3 * MB - head.length));
    const r = await withFd(p, (fd, size) => readCompleteLines(fd, 0, size));
    expect(r.bytesConsumed).toBe(0);
    expect(r.content).toBe("");
    expect(r.steps).toBe(3);
  }, 30_000);

  test("a 3MB file of short lines yields exactly the complete lines inside the first 1MB window", async () => {
    const lines: string[] = [];
    let bytes = 0;
    while (bytes < 3 * MB) {
      const l = claudeLine("user", `line ${lines.length}`);
      lines.push(l);
      bytes += Buffer.byteLength(l) + 1;
    }
    const text = lines.join("\n") + "\n";
    const p = tmpFile("t.jsonl", text);
    const r = await withFd(p, (fd, size) => readCompleteLines(fd, 0, size));
    const window = Buffer.from(text).subarray(0, MB);
    const expectedCut = window.lastIndexOf(0x0a) + 1;
    expect(r.steps).toBe(1);
    expect(r.bytesConsumed).toBe(expectedCut);
    expect(r.content).toBe(window.toString("utf8", 0, expectedCut));
    expect(r.content.endsWith("\n")).toBe(true);
    // Every line in the window is complete and parses on its own.
    for (const l of r.content.split("\n").filter(Boolean)) expect(() => JSON.parse(l)).not.toThrow();
  });

  test("a later position and a shrunken file both stay bounded by what exists", async () => {
    const text = "a\nbb\nccc\n";
    const p = tmpFile("t.jsonl", text);
    const r = await withFd(p, (fd) => readCompleteLines(fd, 2, 100));
    expect(r.content).toBe("bb\nccc\n");
    expect(r.bytesConsumed).toBe(7);
  });
});

describe("cursorPassBoundary", () => {
  const messages = [
    "user:\nhéllo wörld, first question\nwith a second line",
    "assistant:\n<think>\nplanning\n</think>\nfirst answer\nspanning\nthree lines",
    "user:\nsecond question",
    "assistant:\nsecond answer with ünïcode",
    "system:\na note",
    "user:\nthird question\n\nwith a blank line inside",
    "assistant:\nfinal answer",
  ];
  const whole = messages.join("\n") + "\n";

  test("windows cut before the last role header, so pieces parse to the same messages as the whole file", async () => {
    const p = tmpFile("t.txt", whole);
    const pieces: string[] = [];
    await withFd(p, async (fd, size) => {
      let position = 0;
      while (position < size) {
        // A tiny step forces the window to grow across several messages.
        const r = await readCompleteLines(fd, position, size - position, { step: 24, boundary: cursorPassBoundary });
        expect(r.bytesConsumed).toBeGreaterThan(0);
        pieces.push(r.content);
        position += r.bytesConsumed;
      }
    });
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join("")).toBe(whole);
    // Every piece but the first starts on a role header, so no message is split.
    for (const piece of pieces.slice(1)) expect(piece).toMatch(/^(user|assistant|system):\n/);
    const strip = (m: { role: string; content: string; thinking?: string }) => ({ role: m.role, content: m.content, thinking: m.thinking });
    expect(pieces.flatMap((piece) => parseCursorTranscriptFile(piece).map(strip)))
      .toEqual(parseCursorTranscriptFile(whole).map(strip));
  });

  test("at EOF the cut is the last newline, and a lone header asks for a bigger window", () => {
    const buf = Buffer.from("user:\nhello\nassistant:\nanswer in progress");
    expect(cursorPassBoundary(buf, buf.length, true)).toBe(buf.lastIndexOf(0x0a));
    const single = Buffer.from("user:\nhello\nstill the same message");
    expect(cursorPassBoundary(single, single.length, false)).toBe(-1);
    const two = Buffer.from("user:\nhéllo\nassistant:\nanswer");
    // Just before "assistant:" is the newline that ends "héllo".
    expect(cursorPassBoundary(two, two.length, false)).toBe(Buffer.byteLength("user:\nhéllo"));
  });
});

describe("continueSyncPass", () => {
  test("calls next only while bytes remain, stops at the continuation cap, and lets timers run between passes", async () => {
    const size = 10;
    const calls: number[] = [];
    let timerFiredAtPass = -1;
    setTimeout(() => { timerFiredAtPass = calls.length; }, 0);
    const pass = async (depth: number): Promise<void> => {
      calls.push(depth);
      // A pass is synchronous work (one window's parse); 2ms here is enough
      // for the timer to expire while the chain runs.
      const until = performance.now() + 2;
      while (performance.now() < until) { /* hold the loop */ }
      // Each pass consumes one byte from position `depth`, so bytes remain
      // until position 9; the cap must stop the chain first.
      await continueSyncPass(depth, 1, size, depth, () => pass(depth + 1));
    };
    await pass(0);
    // Passes at positions 0..9; the one at 9 leaves nothing behind it.
    expect(calls.length).toBe(size);
    expect(timerFiredAtPass).toBeGreaterThan(0);
    expect(timerFiredAtPass).toBeLessThan(calls.length);

    // Nothing consumed: no continuation.
    let nexts = 0;
    await continueSyncPass(0, 0, size, 0, async () => { nexts++; });
    // Caught up: no continuation.
    await continueSyncPass(9, 1, size, 0, async () => { nexts++; });
    // At the cap: no continuation even with bytes left.
    await continueSyncPass(0, 1, size, MAX_SYNC_CONTINUATIONS, async () => { nexts++; });
    expect(nexts).toBe(0);
    // Under the cap with bytes left: exactly one.
    await continueSyncPass(0, 1, size, MAX_SYNC_CONTINUATIONS - 1, async () => { nexts++; });
    expect(nexts).toBe(1);
  });
});
