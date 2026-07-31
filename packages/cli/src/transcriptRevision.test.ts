import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TranscriptRevisionClock } from "./transcriptRevision.js";

describe("TranscriptRevisionClock", () => {
  test("is monotonic within a process", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-revision-"));
    try {
      const clock = new TranscriptRevisionClock(path.join(dir, "clock.json"), () => 100, 10);
      expect([clock.next(), clock.next(), clock.next()]).toEqual([
        100_000,
        100_001,
        100_002,
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a restart jumps beyond the entire previously reserved range", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-revision-"));
    const statePath = path.join(dir, "clock.json");
    try {
      const first = new TranscriptRevisionClock(statePath, () => 100, 10);
      const emitted = first.next();
      const restarted = new TranscriptRevisionClock(statePath, () => 90, 10);
      expect(restarted.next()).toBeGreaterThan(emitted);
      expect(restarted.next()).toBe(100_011);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
