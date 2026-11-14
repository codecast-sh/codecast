import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readFileHeadLines, transcriptStartedAt } from "./daemon.js";
import { extractCodexCwd } from "./codexSessionMeta.js";

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

  test("a read that stops before EOF ends on a whole line, so every line parses", () => {
    const file = path.join(os.tmpdir(), `head-lines-${process.pid}-${Date.now()}.jsonl`);
    const hook = JSON.stringify({ type: "attachment", attachment: { type: "hook_success", content: "x".repeat(40_000) } });
    const lines = [hook, ...Array.from({ length: 30 }, (_, i) => JSON.stringify({ type: "user", n: i, text: "y".repeat(3000) }))];
    fs.writeFileSync(file, lines.join("\n") + "\n");
    tmpFiles.push(file);
    const head = readFileHeadLines(file, 16, 1024 * 1024);
    expect(head.endsWith("\n")).toBe(true);
    const parsed = head.split("\n").filter(Boolean).map(line => JSON.parse(line));
    expect(parsed[0].attachment.type).toBe("hook_success");
    expect(parsed.length).toBeGreaterThanOrEqual(16);
  });

  test("reads a short file whole (fewer lines than asked, no error)", () => {
    const file = rolloutWithLongMeta(10);
    const head = readFileHeadLines(file, 8);
    expect(head).toBe(fs.readFileSync(file, "utf-8"));
  });
});

// Claude Code 2.1.325 opens a transcript with untimed metadata lines and a
// ~25KB SessionStart hook attachment whose timestamp sits after its content
// (16301 bytes in, observed 2026-11-14). A 512-byte prefix read NaN, and the
// tmux spawn registry dropped the parent of every agent-spawn.sh child.
describe("transcriptStartedAt", () => {
  test("finds the first top-level timestamp past untimed metadata and a long hook line", () => {
    const file = path.join(os.tmpdir(), `claude-head-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
    const sid = "69d51bf1-e194-41ce-ae3a-b1e81a66d93d";
    const lines = [
      { type: "last-prompt", leafUuid: "556d6970", sessionId: sid },
      { type: "mode", mode: "normal", sessionId: sid },
      { type: "permission-mode", permissionMode: "bypassPermissions", sessionId: sid },
      { type: "tools-used", tools: ["ReadMcpResourceTool"], sessionId: sid },
      { parentUuid: null, attachment: { type: "hook_success", content: `x "timestamp": "1999-01-01T00:00:00Z" ${"y".repeat(24_000)}` }, timestamp: "2026-11-14T22:12:03.336Z" },
      { type: "user", timestamp: "2026-11-14T22:12:40.000Z" },
    ];
    fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
    tmpFiles.push(file);
    expect(transcriptStartedAt(file)).toBe(Date.parse("2026-11-14T22:12:03.336Z"));
  });
});
