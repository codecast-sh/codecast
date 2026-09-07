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

// FIRST import, and it must stay first: this file spawns real client TUIs, and
// they belong on a private tmux server rather than beside the panes the daemon
// is driving for real work. The daemon reads the environment that selects the
// server at module load. See isolatedTmuxServer.ts.
import { killIsolatedTmuxServer } from "./test-helpers/isolatedTmuxServer.js";
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { injectViaTmux, TEST_SCRATCH_DIRNAME } from "./daemon.js";
import { tmuxRun } from "./tmux.js";
import { claudeProjectDirName } from "./projectPathResolver.js";
import {
  hasBinary,
  seedClaudeHome,
  waitForRecorded,
  sweepStaleSessions,
  assertRealClaudeHomeUntouched,
  MATRIX_CLIENTS,
  MATRIX_TMUX_PREFIX,
  matrixClientAvailable,
  spawnClientPane,
  startFakeModelEndpoint,
  deliverToPane,
} from "./test-helpers/messagingHarness.js";

const CAN_RUN = hasBinary("tmux") && hasBinary("claude");

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

function jsonlPathFor(homeDir: string, projectDir: string, sessionUuid: string): string {
  const real = fs.realpathSync(projectDir);
  const encoded = claudeProjectDirName(real);
  return path.join(homeDir, ".claude", "projects", encoded, `${sessionUuid}.jsonl`);
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
  // claude runs under a HOME of its own, so its transcript lands here and the
  // human's ~/.claude/projects is neither written to nor deleted from. The
  // scratch marker in the project path still keeps the daemon from syncing it.
  const claudeHome = path.join(scratchRoot, `inject_clear_home-${process.pid}-${Date.now()}`);
  const target = `${tmuxSession}:0.0`;
  let jsonlPath = "";

  beforeAll(async () => {
    tmuxRun(["kill-session", "-t", tmuxSession]);
    if (fs.existsSync(projectDir)) fs.rmSync(projectDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    seedClaudeHome(claudeHome, projectDir);
    jsonlPath = jsonlPathFor(claudeHome, projectDir, sessionUuid);

    // --bare skips hooks/plugins/auto-memory. Invalid API key keeps the test
    // hermetic — the model call will fail with "Not logged in", but the user
    // input is still written to the JSONL, which is the only thing we assert on.
    const cmd =
      `cd ${projectDir} && HOME=${claudeHome} ANTHROPIC_API_KEY=sk-invalid-injection-test ` +
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
      const dismissed = new Set<string>();
      while (Date.now() < until) {
        const pane = tmuxRun(["capture-pane", "-p", "-J", "-t", target, "-S", "-40"]).stdout;
        const dialog = pane.match(/trust (the )?(contents|files)|Do you trust|Do you want to use this API key/i)?.[0];
        if (dialog && !dismissed.has(dialog)) {
          dismissed.add(dialog);
          tmux(["send-keys", "-t", target, "Enter"]);
          await sleep(250);
          continue;
        }
        if (pattern.test(pane)) return true;
        await sleep(250);
      }
      return false;
    };
    // An unrecognized ANTHROPIC_API_KEY makes current builds ask for approval
    // before showing the composer; decline it (the highlighted row) and carry on
    // — the test only needs the input box, never a model call.
    // Wait for the input box's own ❯ — NOT the footer's ⏵⏵ mode indicator, which
    // paints while the TUI is still drawing and left this wait passing on a pane
    // the daemon can't classify yet.
    if (!(await paneReady(/❯/, 45_000))) {
      throw new Error(`Claude Code never rendered an input prompt: ${tmuxRun(["capture-pane", "-p", "-J", "-t", target, "-S", "-40"]).stdout}`);
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
  }, 90_000);

  afterAll(async () => {
    tmuxRun(["kill-session", "-t", tmuxSession]);
    // Let the dying Claude Code flush before deleting: it rewrites its transcript
    // on exit, which recreated the directory right after we removed it.
    await sleep(1500);
    // Keep the project dir + JSONL when the test fails so the artifact is
    // available for debugging. Only clean it up on success path.
    if (process.env.KEEP_INJECT_TEST_ARTIFACTS !== "1") {
      if (fs.existsSync(projectDir)) fs.rmSync(projectDir, { recursive: true });
      // The transcript, and the second one Claude Code writes under a session
      // id of its own choosing, both live inside this run's temp home, so one
      // removal takes everything. (Before the home was sandboxed, missing that
      // second transcript left a directory under the real ~/.claude/projects on
      // every run — 157 had piled up by 2026-07-30.)
      if (fs.existsSync(claudeHome)) fs.rmSync(claudeHome, { recursive: true });
      // Remove the shared scratch root too, but only if no concurrent run still
      // has a session dir under it.
      if (fs.existsSync(scratchRoot) && fs.readdirSync(scratchRoot).length === 0) {
        fs.rmdirSync(scratchRoot);
      }
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

    tmux(["send-keys", "-t", target, "Escape"]);
    const idleDeadline = Date.now() + 10_000;
    while (true) {
      const pane = tmuxRun(["capture-pane", "-p", "-J", "-t", target, "-S", "-40"]).stdout;
      if (!/esc to interrupt|Retrying in/i.test(pane)) break;
      if (Date.now() >= idleDeadline) throw new Error(`Claude did not stop its invalid-key retry: ${pane}`);
      await sleep(250);
    }

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
    expect(userMessages.length, tmuxRun(["capture-pane", "-p", "-J", "-t", target, "-S", "-50"]).stdout).toBeGreaterThanOrEqual(2);
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

// ---------------------------------------------------------------------------
// The same guarantee, once per installed client (the D0 matrix, ct-49536)
//
// A composer holding a draft is not a claude-only situation: the person at the
// keyboard types into any of these TUIs while a message is in flight, and the
// pre-paste drain is a blind C-a/C-k that each client's line editor answers its
// own way. So this runs the same shape — foreign text at the prompt, then an
// injection over it — against every client whose binary is installed, and
// self-skips the rest. The endpoint rejects from the first request so each turn
// ends immediately and the pane is idle for the next case; the busy pane is the
// matrix's own mid-turn scenario, not this one.
// ---------------------------------------------------------------------------

describe("stale composer draft is cleared for every installed client", () => {
  afterAll(() => {
    sweepStaleSessions(MATRIX_TMUX_PREFIX);
    // Takes the whole private server with it, so a pane orphaned by a thrown
    // test cannot outlive the run.
    killIsolatedTmuxServer();
    assertRealClaudeHomeUntouched();
  });

  for (const client of MATRIX_CLIENTS) {
    test.skipIf(!matrixClientAvailable(client))(
      `${client}: an injection over a typed draft records only the payload`,
      async () => {
        const endpoint = await startFakeModelEndpoint();
        endpoint.reject();
        const pane = spawnClientPane(client, { endpointUrl: endpoint.url });
        try {
          // Deliver once the ordinary way, so the pane is provably up and
          // consuming input before the draft goes in.
          const primer = `matrix-primer-${randomUUID().slice(0, 8)}`;
          await deliverToPane(pane, primer);
          await waitForRecorded(pane, primer, { timeoutMs: 30_000 });

          // The stale draft: typed at the prompt, never submitted.
          const draft = "STALE-DRAFT-";
          tmuxRun(["send-keys", "-t", pane.target, "-l", draft]);
          await sleep(1_000);

          const payload = `matrix-clean-${randomUUID().slice(0, 8)}: follow-up content`;
          await deliverToPane(pane, payload);
          await waitForRecorded(pane, payload, { timeoutMs: 30_000 });

          // Nothing the client recorded may carry the draft: a missed drain
          // submits "STALE-DRAFT-<payload>" as one message.
          expect(pane.userMessages().filter((m) => m.includes(draft))).toEqual([]);
        } finally {
          try { pane.tearDown(); } catch {}
          endpoint.close();
        }
      },
      240_000,
    );
  }
});
