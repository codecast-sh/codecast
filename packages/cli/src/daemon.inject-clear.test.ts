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
import { claudeProjectDirName } from "./projectPathResolver.js";

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

function jsonlPathFor(projectDir: string, sessionUuid: string): string {
  const real = fs.realpathSync(projectDir);
  const encoded = claudeProjectDirName(real);
  return path.join(os.homedir(), ".claude", "projects", encoded, `${sessionUuid}.jsonl`);
}

describe.skipIf(!CAN_RUN)("injectViaTmux clears stale draft before pasting", () => {
  const sessionUuid = randomUUID();
  const tmuxSession = `cc-inject-clear-test-${process.pid}`;
  // Run under the shared scratch marker dir so the daemon's isProjectAllowedToSync
  // refuses to sync this real claude session — otherwise its transcript lands in
  // ~/.claude/projects like any other and leaks into the inbox as a phantom
  // conversation.
  const scratchRoot = path.join(os.tmpdir(), TEST_SCRATCH_DIRNAME);
  const projectDir = path.join(scratchRoot, `inject_clear-${process.pid}-${Date.now()}`);
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

    // Wait for the TUI to actually render, rather than sleeping a fixed 3.5s:
    // on a loaded machine Claude Code can take longer than that to paint, and
    // injecting into a blank pane makes the daemon (correctly) defer with
    // AGENT_UNKNOWN_STATE — which failed this test for reasons that had nothing
    // to do with the clearing behavior it exercises. Dismiss the workspace-trust
    // dialog if the build shows one, then wait for the input prompt.
    const paneReady = async (pattern: RegExp, budgetMs: number): Promise<boolean> => {
      const until = Date.now() + budgetMs;
      while (Date.now() < until) {
        const pane = tmuxRun(["capture-pane", "-p", "-J", "-t", target, "-S", "-40"]).stdout;
        if (pattern.test(pane)) return true;
        await sleep(250);
      }
      return false;
    };
    if (await paneReady(/trust (the )?(contents|files)|Do you trust/i, 8_000)) {
      tmux(["send-keys", "-t", target, "Enter"]);
    }
    // An unrecognized ANTHROPIC_API_KEY makes current builds ask for approval
    // before showing the composer; decline it (the highlighted row) and carry on
    // — the test only needs the input box, never a model call.
    if (await paneReady(/Do you want to use this API key/i, 8_000)) {
      tmux(["send-keys", "-t", target, "Enter"]);
    }
    // Wait for the input box's own ❯ — NOT the footer's ⏵⏵ mode indicator, which
    // paints while the TUI is still drawing and left this wait passing on a pane
    // the daemon can't classify yet.
    if (!(await paneReady(/❯/, 25_000))) {
      throw new Error(`Claude Code never rendered an input prompt in ${target}`);
    }

    // Painting the input box does NOT mean stdin is being read: Claude Code
    // starts consuming keys seconds later, and keys sent into that window get
    // recorded as literal text instead of acted on — the daemon's own C-a/C-k
    // clearing keys then show up inside the submitted message as \x01/\x0b.
    // That boot race is a separate defect from the draft-clearing behavior under
    // test here, so prove consumption first: type a character, wait for it to
    // appear at the prompt, then remove it.
    const consuming = async (): Promise<boolean> => {
      const until = Date.now() + 25_000;
      while (Date.now() < until) {
        tmux(["send-keys", "-t", target, "-l", "Z"]);
        for (let i = 0; i < 8; i++) {
          await sleep(250);
          const pane = tmuxRun(["capture-pane", "-p", "-J", "-t", target, "-S", "-40"]).stdout;
          const promptLine = pane.split("\n").reverse().find((l) => l.includes("❯")) ?? "";
          if (promptLine.slice(promptLine.indexOf("❯") + 1).includes("Z")) return true;
        }
      }
      return false;
    };
    if (!(await consuming())) {
      throw new Error(`Claude Code never started consuming keys in ${target}`);
    }
    tmux(["send-keys", "-t", target, "BSpace"]);
    await sleep(300);
  }, 60_000);

  afterAll(async () => {
    tmuxRun(["kill-session", "-t", tmuxSession]);
    // Let the dying Claude Code flush before deleting: it rewrites its transcript
    // on exit, which recreated the directory right after we removed it.
    await sleep(1500);
    // Keep the project dir + JSONL when the test fails so the artifact is
    // available for debugging. Only clean it up on success path.
    if (process.env.KEEP_INJECT_TEST_ARTIFACTS !== "1") {
      if (fs.existsSync(projectDir)) fs.rmSync(projectDir, { recursive: true });
      // Remove the shared scratch root too, but only if no concurrent run still
      // has a session dir under it.
      if (fs.existsSync(scratchRoot) && fs.readdirSync(scratchRoot).length === 0) {
        fs.rmdirSync(scratchRoot);
      }
      // Remove the whole transcript directory, not just jsonlPath: Claude Code
      // also writes a second transcript under a session id of its own choosing,
      // so the old "delete nothing, rmdir if empty" never fired and every run
      // left another directory under ~/.claude/projects behind (157 had piled up
      // by 2026-07-30). Safe to remove wholesale — the directory name encodes
      // this run's unique project path, so nothing else writes there.
      const projectsDir = path.dirname(jsonlPath);
      if (fs.existsSync(projectsDir)) fs.rmSync(projectsDir, { recursive: true });
    }
  });

  // Claude Code appends to the JSONL on submit, but how soon depends on machine
  // load, so wait for the count rather than sleeping a fixed interval and hoping.
  const waitForMessages = async (count: number, budgetMs = 20_000): Promise<string[]> => {
    const until = Date.now() + budgetMs;
    let msgs = getUserMessages(jsonlPath);
    while (msgs.length < count && Date.now() < until) {
      await sleep(300);
      msgs = getUserMessages(jsonlPath);
    }
    return msgs;
  };

  test("recalled prompt is fully cleared; second injection lands clean", async () => {
    // 1. Inject a first prompt. After Claude Code records it, the input box is
    //    empty (Claude Code clears the input on submit).
    await injectViaTmux(target, "first prompt that will be recalled");

    let userMessages = await waitForMessages(1);
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

    userMessages = await waitForMessages(2);
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
