#!/usr/bin/env bun
// Record the Claude SDK backend's test fixtures from the real `claude`:
//
//   bun packages/cli/scripts/record-claude-sdk.ts [scenario ...]   (default: all)
//
// Each scenario drives a ClaudeSdkSession (src/claudeSdk/session.ts) through
// the recorder stand-in (testing/recordClaude.ts), which tees the stream-json
// traffic into src/claudeSdk/__fixtures__/recordings/<scenario>.jsonl with
// thinking, account identity and the home directory scrubbed.
//
// Isolation, as in prompt-dry-run.ts: a private CLAUDE_CONFIG_DIR under a
// scratch directory (so the transcript lands outside ~/.claude/projects and the
// daemon never syncs it), the keychain login handed over as
// CLAUDE_CODE_OAUTH_TOKEN in the child's env only, and a scratch cwd. Both
// directories are removed afterwards. Each scenario is a short haiku turn.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSdkSession } from "../src/claudeSdk/session.js";
import { sdkQueryOptions } from "../src/claudeSdk/options.js";
import { FIXTURE_DIR, recordingPath } from "../src/claudeSdk/testing/recording.js";
import { isolatedEnv, loginToken } from "../src/subscriptionCall.js";
import { resolveClaudeInstall } from "../src/stableClaudeBinary.js";

const real = resolveClaudeInstall();
if (!real) throw new Error("claude is not installed");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "claude-sdk-rec-"));
const configDir = path.join(scratch, "config");
fs.mkdirSync(configDir);
const env = isolatedEnv({ configDir, token: loginToken(), stripModelKeys: true });

const wrapper = path.join(scratch, "claude");
fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(import.meta.dir, "../src/claudeSdk/testing/recordClaude.ts"))} "$@"\n`, { mode: 0o755 });
fs.mkdirSync(FIXTURE_DIR, { recursive: true });

const wait = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timed out: ${what}`)), ms))]);

function open(scenario: string, cwd: string, args: string[], opts: { sessionId?: string; resume?: boolean } = {}) {
  const out = recordingPath(scenario);
  const spec = {
    conversationId: null,
    sessionId: opts.sessionId ?? crypto.randomUUID(),
    resume: !!opts.resume,
    cwd,
    executable: wrapper,
    args: ["--model", "haiku", ...args],
    env: { RECORD_CLAUDE_REAL: real!, RECORD_CLAUDE_OUT: out, RECORD_CLAUDE_SCENARIO: scenario },
  };
  return new ClaudeSdkSession(sdkQueryOptions(spec, env), query as any);
}

const nextResult = (s: ClaudeSdkSession) => new Promise<void>((r) => s.once("result", () => r()));
const idle = (s: ClaudeSdkSession) => new Promise<void>((r) => {
  const check = () => { if (!s.running) { s.off("result", check); r(); } };
  s.on("result", check);
});

const scenarios: Record<string, (cwd: string) => Promise<void>> = {
  async text(cwd) {
    const s = open("text", cwd, ["--permission-mode", "default"]);
    await wait(s.ready, 400_000, "init");
    s.send("Reply with exactly the word pong and nothing else.");
    await wait(idle(s), 120_000, "result");
    await s.stop();
  },
  async resume(cwd) {
    const first = open("resume-first", cwd, ["--permission-mode", "default"]);
    await wait(first.ready, 400_000, "init");
    first.send("Remember the code word avocado. Reply with just: ok");
    await wait(idle(first), 120_000, "result");
    await first.stop();
    const again = open("resume", cwd, ["--permission-mode", "default"], { sessionId: first.sessionId, resume: true });
    await wait(again.ready, 400_000, "init");
    again.send("What was the code word? Reply with just the word.");
    await wait(idle(again), 120_000, "result");
    await again.stop();
  },
  async "tool-allow"(cwd) {
    const s = open("tool-allow", cwd, ["--permission-mode", "default"]);
    s.on("permission", (p) => s.answer(p.requestId, { behavior: "allow" }));
    await wait(s.ready, 400_000, "init");
    s.send("Use the Bash tool to run exactly this command: echo sdk-ok > marker.txt   Then reply with the single word done.");
    await wait(idle(s), 180_000, "result");
    await s.stop();
  },
  async "tool-deny"(cwd) {
    const s = open("tool-deny", cwd, ["--permission-mode", "default"]);
    s.on("permission", (p) => s.answer(p.requestId, { behavior: "deny", message: "The user declined this command." }));
    await wait(s.ready, 400_000, "init");
    s.send("Use the Bash tool to run exactly this command: echo sdk-ok > marker.txt   If it is refused, reply with the single word refused.");
    await wait(idle(s), 180_000, "result");
    await s.stop();
  },
  async ask(cwd) {
    const s = open("ask", cwd, ["--permission-mode", "default"]);
    s.on("permission", (p) => {
      if (p.toolName !== "AskUserQuestion") return s.answer(p.requestId, { behavior: "deny", message: "Only ask the question." });
      const questions = (p.input.questions as Array<{ question: string }>) ?? [];
      s.answer(p.requestId, { behavior: "allow", updatedInput: { ...p.input, answers: Object.fromEntries(questions.map((q) => [q.question, "Blue"])) } });
    });
    await wait(s.ready, 400_000, "init");
    s.send("Call the AskUserQuestion tool once, with one single-select question \"Which color?\" (header \"Color\") and the options Red and Blue. After I answer, reply with only the color I chose.");
    await wait(idle(s), 180_000, "result");
    await s.stop();
  },
  async steer(cwd) {
    const s = open("steer", cwd, ["--permission-mode", "bypassPermissions"]);
    await wait(s.ready, 400_000, "init");
    let steered = false;
    s.on("activity", (a) => {
      if (a.status === "working" && !steered) {
        steered = true;
        s.send("Also: end your final reply with the word STEERED.");
      }
    });
    s.send("Use the Bash tool to run exactly: sleep 5; echo first   Then reply with the output.");
    await wait(idle(s), 180_000, "results");
    await s.stop();
  },
  async interrupt(cwd) {
    const s = open("interrupt", cwd, ["--permission-mode", "bypassPermissions"]);
    await wait(s.ready, 400_000, "init");
    const working = new Promise<void>((r) => s.on("activity", (a) => { if (a.status === "working") r(); }));
    s.send("Use the Bash tool to run exactly: sleep 60   Then reply with the word finished.");
    await wait(working, 120_000, "tool call");
    await wait(s.interrupt(), 60_000, "interrupt drain");
    s.send("Reply with exactly the word after and nothing else.");
    await wait(idle(s), 120_000, "after result");
    await s.stop();
  },
};

const wanted = process.argv.slice(2);
try {
  for (const [name, run] of Object.entries(scenarios)) {
    if (wanted.length && !wanted.includes(name)) continue;
    for (const f of [name, ...(name === "resume" ? ["resume-first"] : [])]) fs.rmSync(recordingPath(f), { force: true });
    const cwd = path.join(scratch, `cwd-${name}`);
    fs.mkdirSync(cwd);
    process.stdout.write(`recording ${name}... `);
    const t = Date.now();
    await run(cwd);
    console.log(`ok (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
