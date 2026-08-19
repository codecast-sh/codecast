import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { THREAD_STATE_NUDGE_MSGS, THREAD_STATE_RECRUIT_MSGS } from "@codecast/shared/contracts";
import { THREAD_STATE_HOOK } from "./threadStateHook.js";

// Run the installed hook exactly as Claude Code would: pipe a hook-event JSON
// to it with HOME pointed at a scratch dir that holds the stamp `cast state`
// writes, plus a fake transcript whose message count we control.
let home: string;
let hookFile: string;
let n = 0;

function transcript(sessionId: string, messages: number): string {
  const file = path.join(home, `${sessionId}.jsonl`);
  const lines: string[] = ['{"type":"file-history-snapshot","x":1}'];
  for (let i = 0; i < messages; i++) {
    lines.push(i % 2 ? '{"type":"assistant","message":{"content":[{"type":"tool_use"}]}}' : '{"type":"user","message":{"content":"hi"}}');
    // Noise entries that are NOT messages must not count.
    if (i % 5 === 0) lines.push('{"type":"progress","data":{}}');
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function stamp(sessionId: string): void {
  const dir = path.join(home, ".codecast", "thread-state");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify({ at: Date.now() }));
}

/** What `cast state` does on every write: drop the mark so the baseline resets. */
function rewriteState(sessionId: string): void {
  fs.rmSync(path.join(home, ".codecast", "thread-state", "counters", sessionId), { force: true });
}

function run(sessionId: string, event: "Stop" | "UserPromptSubmit", messages: number, extra: Record<string, unknown> = {}): string {
  return execFileSync("bash", [hookFile], {
    input: JSON.stringify({ session_id: sessionId, hook_event_name: event, transcript_path: transcript(sessionId, messages), ...extra }),
    env: { ...process.env, HOME: home },
  }).toString();
}

function fresh(): string {
  return `s${++n}`;
}

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-thread-state-hook-"));
  hookFile = path.join(home, "thread-state.sh");
  fs.writeFileSync(hookFile, THREAD_STATE_HOOK, { mode: 0o755 });
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("thread-state hook", () => {
  test("a short session with no pinned state is never nudged", () => {
    const id = fresh();
    expect(run(id, "Stop", 0)).toBe("");
    expect(run(id, "Stop", THREAD_STATE_RECRUIT_MSGS - 1)).toBe("");
    expect(run(id, "UserPromptSubmit", 500)).toBe("");
  });

  test("a substantial undeclared session is recruited ONCE, at Stop, to declare who acts next", () => {
    const id = fresh();
    const out = run(id, "Stop", THREAD_STATE_RECRUIT_MSGS);
    const json = JSON.parse(out);
    expect(json.decision).toBe("block");
    expect(json.reason).toContain("cast state --status");
    expect(json.reason).toContain("dormant");
    // Once per session — never nagged again however long it runs, and never
    // while the Stop hook is already holding it.
    expect(run(id, "Stop", THREAD_STATE_RECRUIT_MSGS + 300)).toBe("");
    const other = fresh();
    expect(run(other, "Stop", THREAD_STATE_RECRUIT_MSGS, { stop_hook_active: true })).toBe("");
  });

  test("once it declares, the ordinary staleness reminder takes over", () => {
    const id = fresh();
    expect(JSON.parse(run(id, "Stop", THREAD_STATE_RECRUIT_MSGS)).decision).toBe("block");
    stamp(id);
    expect(run(id, "Stop", THREAD_STATE_RECRUIT_MSGS + 2)).toBe(""); // baseline recorded
    expect(JSON.parse(run(id, "Stop", THREAD_STATE_RECRUIT_MSGS + 2 + THREAD_STATE_NUDGE_MSGS)).reason).toContain("messages old");
  });

  test("first event after a write records the baseline; the nudge fires on the crossing only", () => {
    const id = fresh();
    stamp(id);
    // The turn that wrote the state ends here at 30 messages: that is "zero since".
    expect(run(id, "Stop", 30)).toBe("");
    expect(run(id, "Stop", 30 + THREAD_STATE_NUDGE_MSGS - 1)).toBe("");
    const out = run(id, "Stop", 30 + THREAD_STATE_NUDGE_MSGS);
    const json = JSON.parse(out);
    expect(json.decision).toBe("block");
    expect(json.reason).toContain(`${THREAD_STATE_NUDGE_MSGS} messages old`);
    expect(json.reason).toContain("cast state");
    // Ignored: not nagged again, however far the thread runs.
    expect(run(id, "Stop", 30 + THREAD_STATE_NUDGE_MSGS + 300)).toBe("");
    expect(run(id, "UserPromptSubmit", 30 + THREAD_STATE_NUDGE_MSGS + 300)).toBe("");
  });

  test("cast state re-arms it: a maintained state is reminded again later", () => {
    const id = fresh();
    stamp(id);
    run(id, "Stop", 10);
    expect(JSON.parse(run(id, "Stop", 10 + THREAD_STATE_NUDGE_MSGS)).decision).toBe("block");
    rewriteState(id);
    // New baseline at the end of the turn that rewrote it.
    expect(run(id, "Stop", 10 + THREAD_STATE_NUDGE_MSGS + 5)).toBe("");
    expect(run(id, "Stop", 10 + 2 * THREAD_STATE_NUDGE_MSGS + 4)).toBe("");
    expect(JSON.parse(run(id, "Stop", 10 + 2 * THREAD_STATE_NUDGE_MSGS + 5)).decision).toBe("block");
  });

  test("a Stop already continuing from a stop hook never blocks again, and keeps the nudge armed", () => {
    const id = fresh();
    stamp(id);
    run(id, "Stop", 0);
    expect(run(id, "Stop", THREAD_STATE_NUDGE_MSGS, { stop_hook_active: true })).toBe("");
    // The next ordinary Stop still fires — nothing was consumed.
    expect(JSON.parse(run(id, "Stop", THREAD_STATE_NUDGE_MSGS)).decision).toBe("block");
  });

  test("UserPromptSubmit is the fallback voice: plain context, not a block", () => {
    const id = fresh();
    stamp(id);
    run(id, "UserPromptSubmit", 0);
    const out = run(id, "UserPromptSubmit", THREAD_STATE_NUDGE_MSGS + 3);
    expect(out.startsWith("<thread-state>")).toBe(true);
    expect(out).toContain(`${THREAD_STATE_NUDGE_MSGS + 3} messages old`);
  });

  test("a missing transcript path counts as zero, never crashes", () => {
    const id = fresh();
    stamp(id);
    const out = execFileSync("bash", [hookFile], {
      input: JSON.stringify({ session_id: id, hook_event_name: "Stop" }),
      env: { ...process.env, HOME: home },
    }).toString();
    expect(out).toBe("");
  });
});
