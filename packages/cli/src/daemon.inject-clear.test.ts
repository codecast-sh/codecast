// Real-tmux integration test for the stale-input clear bug in injectViaTmux.
//
// Bug summary (root-caused 2026-05-19): the daemon's pre-paste clear sequence
// is `Escape` + a single `C-u`. In Claude Code 2.1.x's TUI input box, that
// sequence does NOT reliably empty the buffer when the input has stale text
// (e.g. a previous prompt recalled via Up arrow, or a partial draft). The
// injected paste-buffer content is then appended to whatever was left over,
// and the trailing Enter submits the concatenated result as a single user
// message. The exact pattern Samvit reported on 2026-05-19 in the
// "AI landing site setup" session — long original prompt visibly merging
// with later one-line follow-ups like "update the plan" and
// "ask me any remaining questions" — was this bug.
//
// Reproduction strategy: spawn a real Claude Code TUI under tmux with an
// invalid API key (so model calls fail but the input box still records to
// JSONL), drive it the same way the daemon would, and assert on the JSONL.
//
// Test is skipped automatically when `tmux` or `claude` isn't on PATH so
// vanilla `bun test` runs without the integration dependency.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { injectViaTmux, TEST_SCRATCH_DIRNAME } from "./daemon.js";
import { tmuxRun } from "./tmux.js";

function hasBin(name: string): boolean {
  const r = spawnSync("which", [name], { encoding: "utf8" });
  return r.status === 0 && !!r.stdout.trim();
}

const CAN_RUN = hasBin("tmux") && hasBin("claude");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function tmux(args: string[]): void {
  // Hardened wrapper: timeout + SIGKILL so a wedged tmux client can't spin forever.
  const r = tmuxRun(args);
  if (r.status !== 0) {
    throw new Error(`tmux ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
}

function getUserMessages(jsonlPath: string): string[] {
  if (!fs.existsSync(jsonlPath)) return [];
  const out: string[] = [];
  for (const line of fs.readFileSync(jsonlPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o.type === "user" && typeof o.message?.content === "string") {
        out.push(o.message.content);
      }
    } catch {}
  }
  return out;
}

// macOS resolves /tmp to /private/tmp, and Claude Code encodes the project dir
// by replacing `/` with `-` (so /private/tmp/foo → -private-tmp-foo). Mirror
// that here so we know where the JSONL will land.
function jsonlPathFor(projectDir: string, sessionUuid: string): string {
  const real = fs.realpathSync(projectDir);
  const encoded = real.replace(/\//g, "-");
  return path.join(os.homedir(), ".claude", "projects", encoded, `${sessionUuid}.jsonl`);
}

describe.skipIf(!CAN_RUN)("injectViaTmux clears stale draft before pasting", () => {
  const sessionUuid = randomUUID();
  const tmuxSession = `cc-inject-clear-test-${process.pid}`;
  // Run under the shared scratch marker dir so the daemon's isProjectAllowedToSync
  // refuses to sync this real claude session — otherwise its transcript lands in
  // ~/.claude/projects like any other and leaks into the inbox as a phantom
  // conversation. Stays under os.tmpdir() and dot-free so jsonlPathFor's
  // slash-only encoding still resolves the transcript location.
  const scratchRoot = path.join(os.tmpdir(), TEST_SCRATCH_DIRNAME);
  const projectDir = path.join(scratchRoot, `inject-clear-${process.pid}-${Date.now()}`);
  const target = `${tmuxSession}:0.0`;
  let jsonlPath = "";

  beforeAll(async () => {
    tmuxRun(["kill-session", "-t", tmuxSession]);
    if (fs.existsSync(projectDir)) fs.rmSync(projectDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    jsonlPath = jsonlPathFor(projectDir, sessionUuid);

    // --bare skips hooks/plugins/auto-memory. Invalid API key keeps the test
    // hermetic — the model call will fail with "Not logged in", but the user
    // input is still written to the JSONL, which is the only thing we assert on.
    const cmd =
      `cd ${projectDir} && ANTHROPIC_API_KEY=sk-invalid-injection-test ` +
      `claude --bare --permission-mode=bypassPermissions --dangerously-skip-permissions ` +
      `--session-id=${sessionUuid}`;
    tmux(["new", "-d", "-s", tmuxSession, "-x", "200", "-y", "50", cmd]);

    // Workspace trust dialog appears first; press Enter to accept it.
    await sleep(3500);
    tmux(["send-keys", "-t", target, "Enter"]);
    await sleep(2000);
  }, 30_000);

  afterAll(() => {
    tmuxRun(["kill-session", "-t", tmuxSession]);
    // Keep the project dir + JSONL when the test fails so the artifact is
    // available for debugging. Only clean it up on success path.
    if (process.env.KEEP_INJECT_TEST_ARTIFACTS !== "1") {
      if (fs.existsSync(projectDir)) fs.rmSync(projectDir, { recursive: true });
      // Remove the shared scratch root too, but only if no concurrent run still
      // has a session dir under it.
      if (fs.existsSync(scratchRoot) && fs.readdirSync(scratchRoot).length === 0) {
        fs.rmdirSync(scratchRoot);
      }
      const projectsDir = path.dirname(jsonlPath);
      if (fs.existsSync(projectsDir) && fs.readdirSync(projectsDir).length === 0) {
        fs.rmdirSync(projectsDir);
      }
    }
  });

  test("recalled prompt is fully cleared; second injection lands clean", async () => {
    // 1. Inject a first prompt. After Claude Code records it, the input box is
    //    empty (Claude Code clears the input on submit).
    await injectViaTmux(target, "first prompt that will be recalled");
    await sleep(3000);

    let userMessages = getUserMessages(jsonlPath);
    expect(userMessages).toEqual(["first prompt that will be recalled"]);

    // 2. Simulate the user (or any path that puts stale text in the box):
    //    press Up arrow. Claude Code recalls the previous prompt into the
    //    input box — this is the state the bug report observed.
    tmux(["send-keys", "-t", target, "Up"]);
    await sleep(500);

    // 3. Inject a second message. With the buggy clear (Escape + single C-u),
    //    the recalled "first prompt..." stays in the box and the injected
    //    paste-buffer content concatenates with it. With a correct clear,
    //    only "follow-up content" lands.
    await injectViaTmux(target, "follow-up content");
    await sleep(3000);

    userMessages = getUserMessages(jsonlPath);
    expect(userMessages.length).toBeGreaterThanOrEqual(2);
    const second = userMessages[1];

    // The assertion that proves the fix: the second message must be exactly
    // the injected content, with no fragment of the recalled stale prompt.
    // Under the bug, `second` is something like
    //   "follow-up contentfirst prompt that will be recalled"
    // (when cursor was at start after Up) or
    //   "first prompt that will be recallefollow-up content"
    // (when the bad clear deleted one trailing word). Either way it contains
    // the stale prompt text, which the strict-equality assertion will catch.
    expect(second).toBe("follow-up content");
  }, 60_000);
});
