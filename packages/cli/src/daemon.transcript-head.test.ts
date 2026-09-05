import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readFileHeadLines } from "./daemon.js";
import { extractCodexCwd } from "./parser.js";

// Codex 0.153 writes session_meta with the full base_instructions text inline:
// the real first line of rollout-2026-09-05T16-32-42-01a07345 was 22186 bytes.
// The resume path read a 5000-byte prefix, JSON.parse threw on the torn line,
// and the recorded cwd read as absent (then: refuse → regenerate under `/` →
// Codex's working-directory picker on every delivery).
const tmpFiles: string[] = [];
afterEach(() => { for (const f of tmpFiles.splice(0)) fs.rmSync(f, { force: true }); });

function rolloutWithLongMeta(instructionBytes: number): string {
  const file = path.join(os.tmpdir(), `rollout-head-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
  const meta = {
    timestamp: "2026-09-05T20:32:51.623Z", ordinal: 0, type: "session_meta",
    payload: { id: "01a07345-fe70-73c2-923e-10cbc3aa773b", cwd: "/Users/ashot/src/codecast", originator: "codex-tui", cli_version: "0.153.4",
      base_instructions: { text: "x".repeat(instructionBytes), source: "built-in" } },
  };
  const second = { timestamp: "2026-09-05T20:32:53.563Z", type: "response_item", payload: { type: "message", role: "user", content: [] } };
  fs.writeFileSync(file, JSON.stringify(meta) + "\n" + JSON.stringify(second) + "\n");
  tmpFiles.push(file);
  return file;
}

describe("readFileHeadLines", () => {
  test("returns the whole session_meta line when it is longer than any fixed prefix", () => {
    const file = rolloutWithLongMeta(200_000);
    const head = readFileHeadLines(file, 2);
    expect(head.split("\n").filter(Boolean)).toHaveLength(2);
    expect(extractCodexCwd(head)).toBe("/Users/ashot/src/codecast");
  });

  test("a 5000-byte prefix loses the cwd on the same file (the regression)", () => {
    const file = rolloutWithLongMeta(22_000);
    const torn = fs.readFileSync(file, "utf-8").slice(0, 5000);
    expect(extractCodexCwd(torn)).toBeUndefined();
    expect(extractCodexCwd(readFileHeadLines(file))).toBe("/Users/ashot/src/codecast");
  });

  test("stops at the byte cap instead of reading a huge single-line file", () => {
    const file = rolloutWithLongMeta(300_000);
    expect(readFileHeadLines(file, 8, 65536).length).toBe(65536);
  });

  test("reads a short file whole (fewer lines than asked, no error)", () => {
    const file = rolloutWithLongMeta(10);
    const head = readFileHeadLines(file, 8);
    expect(head).toBe(fs.readFileSync(file, "utf-8"));
  });
});
