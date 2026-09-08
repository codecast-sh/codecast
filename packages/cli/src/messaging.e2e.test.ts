// E2E messaging-pipeline tests.
//
// These tests exercise the daemon's tmux injection primitives against real
// tmux + a fake-claude shim. They cover the risk surface of the startup-
// latency speedup PR (the changes in `injectViaTmux` and `tryStartedTmux`).
//
// What this DOES test:
//   - injectViaTmux's full state machine (clear input → paste → confirm →
//     Enter → verify) against a real tmux pane running the shim.
//   - JSONL appearance under ~/.claude/projects/<encoded-cwd>/.
//   - Prompt-detection timing for the "is the agent ready to receive input?"
//     question on a fresh tmux session.
//   - Latency budgets — every scenario asserts an upper bound; the PR that
//     speeds up startup must tighten these without breaking them.
//
// What this does NOT test (intentionally — needs Convex test backend):
//   - The daemon's full subscription pipeline (Convex websocket → daemon).
//   - Pending-message retry behavior driven by the 120s cron.
//   - Cross-process restart/recovery.
//
// All scenarios run real tmux and a real shim binary. CI must have `tmux`
// and `bash` installed (true on every Ubuntu/macOS GH runner).

// FIRST import, and it must stay first: every tmux session this file creates —
// shim panes and real client TUIs alike — belongs on a private tmux server, and
// the daemon reads the environment that selects it at module load. See
// isolatedTmuxServer.ts.
import { killIsolatedTmuxServer } from "./test-helpers/isolatedTmuxServer.js";
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { injectViaTmux } from "./daemon.js";
import { tmuxRun } from "./tmux.js";
import {
  spawnHarness,
  waitFor,
  sweepStaleSessions,
  assertRealClaudeHomeUntouched,
  readJsonlMessages,
  MATRIX_CLIENTS,
  MATRIX_TMUX_PREFIX,
  matrixClientAvailable,
  spawnClientPane,
  startFakeModelEndpoint,
  deliverToPane,
  waitForRecorded,
  logMatrix,
  type ClientPane,
  type FakeModelEndpoint,
  type Harness,
} from "./test-helpers/messagingHarness.js";

// Latency budgets — these are CORRECTNESS upper bounds (test fails if
// exceeded), not perf targets. The speedup PR's job is to drive the
// observed numbers (printed by each test as `[perf]` lines) down; tighten
// these in a follow-up commit once the new floor is established.
//
// Set generous to absorb CI variance: macOS tmux process spawn can take
// 1–3 seconds under load, and we run 10+ panes back-to-back in this file.
const BUDGET_PROMPT_READY_MS = 15_000;
const BUDGET_INJECT_FRESH_MS = 20_000;
const BUDGET_JSONL_SYNC_MS = 8_000;

function logPerf(scenario: string, label: string, elapsedMs: number): void {
  // Single greppable line — used to track the speedup PR's before/after.
  console.log(`[perf] ${scenario} ${label}=${elapsedMs}ms`);
}

// All harnesses created in a test, so afterEach can tear them all down.
let activeHarnesses: Harness[] = [];

function track(h: Harness): Harness {
  activeHarnesses.push(h);
  return h;
}

beforeAll(() => {
  sweepStaleSessions();
});

afterAll(() => {
  sweepStaleSessions();
  // Takes the whole private server with it, so a pane orphaned by a thrown
  // test cannot outlive the run.
  killIsolatedTmuxServer();
  assertRealClaudeHomeUntouched();
});

beforeEach(() => {
  // Don't sweep here — the broad `cc-claude-test*` prefix would kill the
  // session of any concurrently-running scenario. Per-test cleanup happens
  // in afterEach via tracked harnesses; suite-wide cleanup is in before/afterAll.
  activeHarnesses = [];
});

afterEach(async () => {
  for (const h of activeHarnesses) {
    try { h.tearDown(); } catch {}
  }
  // Brief settle so the next test's setup sees a clean tmux state.
  // Without this, fast back-to-back runs can race the kill-session syscall.
  await new Promise(r => setTimeout(r, 200));
});

describe("messaging e2e — fresh session", () => {
  test("Scenario 1: new session, single message lands in pane and JSONL", async () => {
    const h = track(spawnHarness());

    // Step 1: agent prompt becomes visible.
    const promptElapsed = await waitFor(() => h.paneHasPrompt(), {
      timeoutMs: BUDGET_PROMPT_READY_MS,
      label: "prompt visible",
    });
    expect(promptElapsed).toBeLessThan(BUDGET_PROMPT_READY_MS);

    logPerf("S1", "prompt_visible", promptElapsed);

    // Step 2: inject a user message.
    const target = `${h.tmuxSession}:0.0`;
    const content = "hello from test scenario 1";
    const injectStart = Date.now();
    try {
      await injectViaTmux(target, content);
    } catch (err) {
      const dbg = [
        `[s1 inject threw] ${err instanceof Error ? err.message : String(err)}`,
        `pane: ${JSON.stringify(h.capturePane())}`,
        `jsonl exists: ${fs.existsSync(h.jsonlPath)}`,
      ];
      fs.writeFileSync("/tmp/codecast-s1-debug.log", dbg.join("\n\n"));
      throw err;
    }
    const injectElapsed = Date.now() - injectStart;
    logPerf("S1", "inject_fresh", injectElapsed);
    expect(injectElapsed).toBeLessThan(BUDGET_INJECT_FRESH_MS);

    // Step 3: shim writes the user message to JSONL.
    try {
      await waitFor(() => {
        const msgs = readJsonlMessages(h.jsonlPath);
        return msgs.some(m => m.type === "user" && m.text === content);
      }, { timeoutMs: BUDGET_JSONL_SYNC_MS, label: "user msg in JSONL" });
    } catch (err) {
      const raw = fs.existsSync(h.jsonlPath) ? fs.readFileSync(h.jsonlPath, "utf-8") : "(no jsonl)";
      const dbg = [
        `[s1 jsonl wait] ${err instanceof Error ? err.message : String(err)}`,
        `pane: ${JSON.stringify(h.capturePane())}`,
        `jsonl: ${raw}`,
      ];
      fs.writeFileSync("/tmp/codecast-s1-debug.log", dbg.join("\n\n"));
      throw err;
    }

    // Step 4: shim emits an assistant reply (proves bidirectional flow).
    await waitFor(() => {
      const msgs = readJsonlMessages(h.jsonlPath);
      return msgs.some(m => m.type === "assistant" && m.text?.includes("got it"));
    }, { timeoutMs: BUDGET_JSONL_SYNC_MS, label: "assistant reply in JSONL" });

    // Step 5: pane content shows the injected message landed.
    const pane = h.capturePane();
    expect(pane).toContain(content.slice(0, 20));
  }, 30_000);

  test("Scenario 2: fast startup (200ms) — inject latency is dominated by injectViaTmux", async () => {
    const h = track(spawnHarness({ startupMs: 200 }));
    await waitFor(() => h.paneHasPrompt(), { timeoutMs: BUDGET_PROMPT_READY_MS });

    const target = `${h.tmuxSession}:0.0`;
    const start = Date.now();
    await injectViaTmux(target, "fast startup test");
    const elapsed = Date.now() - start;
    logPerf("S2", "inject_after_fast_start", elapsed);

    // After speedup PR: this should be < 4s. Today: < 20s (CI-generous).
    expect(elapsed).toBeLessThan(BUDGET_INJECT_FRESH_MS);
    expect(elapsed).toBeGreaterThan(0);
  }, 30_000);

  test("Scenario 3: slow startup (3s sleep) — prompt-poll waits past the sleep", async () => {
    // The shim sleeps 3s before printing the prompt. The test asserts:
    //   (a) we don't return prematurely (the prompt-poll handles slow agents)
    //   (b) we do eventually find the prompt (no infinite hang)
    // The exact upper bound is sensitive to macOS process-spawn jitter — on a
    // busy CI box, `tmux new-session ... bash -c '...exec claude'` can take
    // 1–3 seconds before the inner process even runs.
    const h = track(spawnHarness({ startupMs: 3_000 }));
    const elapsed = await waitFor(() => h.paneHasPrompt(), {
      timeoutMs: 20_000,
      label: "slow prompt visible",
    });
    expect(elapsed).toBeGreaterThanOrEqual(2_500);
    logPerf("S3", "slow_prompt_visible", elapsed);
  }, 30_000);
});

describe("messaging e2e — content edge cases", () => {
  test("Scenario 4: long message (~500 chars) reaches the tmux pane intact", async () => {
    // We assert pane bytes (not JSONL) because the bash shim's `read -r`
    // is line-length-limited — real claude has its own pty handling and is
    // not affected. Goal here: prove injectViaTmux delivers the full
    // payload through paste-buffer + send-keys without truncation.
    const h = track(spawnHarness());
    await waitFor(() => h.paneHasPrompt(), { timeoutMs: BUDGET_PROMPT_READY_MS });

    const target = `${h.tmuxSession}:0.0`;
    const startMarker = "long-marker-START";
    const endMarker = "END-marker";
    const content = startMarker + "x".repeat(500) + endMarker;
    await injectViaTmux(target, content);

    // Allow the pane to settle, then verify both bookends survived the paste.
    await new Promise(r => setTimeout(r, 500));
    const pane = h.capturePane();
    expect(pane).toContain(startMarker);
    expect(pane).toContain(endMarker);
  }, 30_000);

  test("Scenario 4b: multi-line message arrives as ONE message with newlines intact", async () => {
    // The regression this guards: injection used to flatten every newline to a
    // space, because an unbracketed linefeed reaches a TUI as the Enter key and
    // would submit one message per line. `paste-buffer -p` brackets the payload
    // instead, so the newlines are delivered as composer newlines. The shim
    // requests bracketed paste exactly like a real agent TUI and reassembles a
    // bracketed burst into a single message.
    const h = track(spawnHarness());
    await waitFor(() => h.paneHasPrompt(), { timeoutMs: BUDGET_PROMPT_READY_MS });

    const target = `${h.tmuxSession}:0.0`;
    const content = "multiline-marker: first line\nsecond line\n\nfourth after blank";
    await injectViaTmux(target, content);

    await waitFor(() => {
      const msgs = readJsonlMessages(h.jsonlPath);
      return msgs.some(m => m.type === "user" && m.text?.startsWith("multiline-marker:"));
    }, { timeoutMs: BUDGET_JSONL_SYNC_MS, label: "multi-line content in JSONL" });

    const userMsgs = readJsonlMessages(h.jsonlPath).filter(
      m => m.type === "user" && m.text?.includes("marker"),
    );
    // One message, not four: a per-line submit would leave "second line" and
    // "fourth after blank" as separate user turns.
    expect(userMsgs.length).toBe(1);
    expect(userMsgs[0].text).toBe(content);
  }, 30_000);

  test("Scenario 5: message with shell-special characters does not break paste", async () => {
    const h = track(spawnHarness());
    await waitFor(() => h.paneHasPrompt(), { timeoutMs: BUDGET_PROMPT_READY_MS });

    const target = `${h.tmuxSession}:0.0`;
    const content = `marker-special: $HOME ${"`whoami`"} && echo 'hi' | grep "x" \\n end`;
    await injectViaTmux(target, content);

    await waitFor(() => {
      const msgs = readJsonlMessages(h.jsonlPath);
      return msgs.some(m => m.type === "user" && m.text?.includes("marker-special:"));
    }, { timeoutMs: BUDGET_JSONL_SYNC_MS, label: "special-char content in JSONL" });
  }, 30_000);
});

describe("messaging e2e — concurrent / sequential injects", () => {
  test("Scenario 6: 3 sequential messages to same session — order preserved in JSONL", async () => {
    const h = track(spawnHarness());
    await waitFor(() => h.paneHasPrompt(), { timeoutMs: BUDGET_PROMPT_READY_MS });

    const target = `${h.tmuxSession}:0.0`;
    const messages = ["seq-msg-1", "seq-msg-2", "seq-msg-3"];

    for (const msg of messages) {
      await injectViaTmux(target, msg);
      // Wait for the shim to print its prompt again before the next inject.
      // Mimics the daemon's natural backpressure (waiting for the assistant
      // to finish before delivering the next pending message).
      await waitFor(() => {
        const msgs = readJsonlMessages(h.jsonlPath);
        return msgs.filter(m => m.type === "user").length >= messages.indexOf(msg) + 1;
      }, { timeoutMs: BUDGET_JSONL_SYNC_MS, label: `${msg} in JSONL` });
    }

    const msgs = readJsonlMessages(h.jsonlPath);
    const userMsgs = msgs.filter(m => m.type === "user").map(m => m.text);
    expect(userMsgs).toEqual(messages);
  }, 60_000);

  test("Scenario 7: parallel sessions — no cross-talk between two harnesses", async () => {
    const a = track(spawnHarness({ tmuxPrefix: "cc-claude-test-A" }));
    const b = track(spawnHarness({ tmuxPrefix: "cc-claude-test-B" }));

    await Promise.all([
      waitFor(() => a.paneHasPrompt(), { timeoutMs: BUDGET_PROMPT_READY_MS, label: "A prompt" }),
      waitFor(() => b.paneHasPrompt(), { timeoutMs: BUDGET_PROMPT_READY_MS, label: "B prompt" }),
    ]);

    await Promise.all([
      injectViaTmux(`${a.tmuxSession}:0.0`, "alpha-message"),
      injectViaTmux(`${b.tmuxSession}:0.0`, "bravo-message"),
    ]);

    await Promise.all([
      waitFor(() => readJsonlMessages(a.jsonlPath).some(m => m.text === "alpha-message"), { timeoutMs: BUDGET_JSONL_SYNC_MS, label: "A jsonl" }),
      waitFor(() => readJsonlMessages(b.jsonlPath).some(m => m.text === "bravo-message"), { timeoutMs: BUDGET_JSONL_SYNC_MS, label: "B jsonl" }),
    ]);

    // Critical: B's JSONL must NOT contain alpha-message and vice versa.
    const aMsgs = readJsonlMessages(a.jsonlPath).filter(m => m.type === "user").map(m => m.text);
    const bMsgs = readJsonlMessages(b.jsonlPath).filter(m => m.type === "user").map(m => m.text);
    expect(aMsgs).toContain("alpha-message");
    expect(aMsgs).not.toContain("bravo-message");
    expect(bMsgs).toContain("bravo-message");
    expect(bMsgs).not.toContain("alpha-message");
  }, 30_000);
});

describe("messaging e2e — failure modes", () => {
  test("Scenario 8: stuck shim (HANG=1) — inject errors out within bounded time, doesn't hang forever", async () => {
    // The shim never prints a prompt, so ensureTmuxReady can never confirm
    // a clean paste target. This SHOULD error out — silently injecting into
    // an unknown pane state is exactly the bug the readiness checks prevent.
    // What matters is: the failure is bounded (no infinite hang) so the
    // daemon's outer retry can take over.
    const h = track(spawnHarness({ hang: true }));
    const target = `${h.tmuxSession}:0.0`;

    const start = Date.now();
    let err: unknown = null;
    try {
      await injectViaTmux(target, "stuck-shim-test");
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - start;

    // An unknown/no-prompt pane throws AGENT_UNKNOWN_STATE within
    // ensureTmuxReady's STUCK_BUDGET_MS (8s), so inject gives up by ~10s rather
    // than hanging. (A genuinely busy pane no longer waits at all — it injects
    // into the type-ahead queue — but the HANG shim prints no prompt, so it
    // classifies "unknown", not "busy".)
    expect(elapsed).toBeLessThan(15_000);
    expect(err).not.toBeNull();
  }, 30_000);

  test("Scenario 9: shim exits immediately (FATAL) — JSONL never appears", async () => {
    const fatalMessage = "fake-claude: simulated startup failure";
    const h = track(spawnHarness({ fatal: fatalMessage }));
    await waitFor(() => h.paneExitCode() !== null, {
      timeoutMs: 5_000,
      label: "fatal shim exit",
    }).catch((error) => {
      const state = tmuxRun(["list-panes", "-t", h.tmuxSession, "-F", "#{pane_id}:#{pane_index}:#{pane_dead}:#{pane_dead_status}"]);
      throw new Error(`${error.message}; pane: ${JSON.stringify(h.capturePane())}; state: ${JSON.stringify(state)}`);
    });
    // The retained dead pane proves the intended shim ran. An unrelated
    // tmux/bash startup failure cannot satisfy these negative assertions.
    expect(h.paneExitCode()).toBe(1);
    expect(tmuxRun(["move-window", "-s", h.tmuxSession, "-t", `${h.tmuxSession}:7`]).status).toBe(0);
    expect(h.paneExitCode()).toBe(1);
    expect(h.capturePane()).toContain(fatalMessage);
    expect(h.paneHasPrompt()).toBe(false);
    expect(fs.existsSync(h.jsonlPath)).toBe(false);
  }, 10_000);
});

describe("messaging e2e — resume / large JSONL", () => {
  test("Scenario 10: shim with pre-existing large JSONL — discovery still finds it", async () => {
    // Pre-populate a large JSONL before starting the shim. The shim's
    // sessionId must match the one in the file path so the daemon's
    // JSONL discovery would link it. (We don't run discovery here, but
    // we assert the file is parseable + grows correctly when we inject.)
    const h = track(spawnHarness());
    await waitFor(() => h.paneHasPrompt(), { timeoutMs: BUDGET_PROMPT_READY_MS });

    // Append 5,000 dummy rows to simulate a long resume.
    const dummyLines: string[] = [];
    for (let i = 0; i < 5_000; i++) {
      dummyLines.push(JSON.stringify({
        type: "user",
        sessionId: h.sessionId,
        uuid: `dummy-${i}`,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: `historical message ${i}` },
      }));
    }
    fs.appendFileSync(h.jsonlPath, dummyLines.join("\n") + "\n");

    const target = `${h.tmuxSession}:0.0`;
    const start = Date.now();
    await injectViaTmux(target, "post-resume-marker");
    const elapsed = Date.now() - start;

    // Inject latency on a "resumed" pane (prompt already up) should be
    // similar to fresh — the shim doesn't actually load the history.
    expect(elapsed).toBeLessThan(BUDGET_INJECT_FRESH_MS);

    await waitFor(() => {
      const msgs = readJsonlMessages(h.jsonlPath);
      return msgs.some(m => m.type === "user" && m.text === "post-resume-marker");
    }, { timeoutMs: 5_000, label: "post-resume msg in JSONL" });

    const all = readJsonlMessages(h.jsonlPath);
    // 5000 historical + 1 new + 1 assistant reply.
    expect(all.length).toBeGreaterThan(5_000);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// D0 cold-boot injection matrix (ct-49536)
//
// The scenarios above drive a shim we wrote. These drive the REAL client TUIs
// — claude, codex, grok, opencode — each spawned cold in its own tmux pane and
// injected through the same `injectViaTmux` the daemon calls, then asserted on
// the client's own transcript. Every cell self-skips when the client's binary
// is absent, so a runner with no agents installed (every CI runner today) stays
// green while a developer machine runs the whole grid.
//
// The three cases are the injection failure classes the memories record:
//   cold boot   — a TUI paints its composer seconds before it reads stdin, so a
//                 payload can vanish, arrive with the drain's C-a/C-k bytes
//                 glued to it, or sit in the composer forever
//                 (inject_cold_boot_enter_swallowed, cold_boot_clearing_keys_
//                 land_as_text). Multi-line, because an unbracketed newline is
//                 the Enter key (injection_newlines_need_bracketed_paste).
//   mid-turn    — delivery into a running turn must ride the type-ahead queue
//                 and never send the interrupting Escape.
//   resume      — the pane a resume rebuilds is a cold boot with a warm
//                 transcript (resume_readiness_poll_outran_inflight_guard).
//
// Every measurement prints a `[matrix]` line; the per-client pass rate and
// latency baseline on the task comes from running this file repeatedly.
// ---------------------------------------------------------------------------

const CONTROL_BYTE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

function multilinePayload(marker: string): string {
  return `${marker}: first line\nsecond line\n\nfourth after a blank line`;
}

/** A TUI may pad the composer, so compare on trailing whitespace only —
 *  anything glued to the FRONT of the payload still fails the match. */
function recorded(pane: ClientPane): string[] {
  return pane.userMessages().map((m) => m.trimEnd());
}

describe("cold-boot injection matrix (real clients)", () => {
  afterAll(() => {
    sweepStaleSessions(MATRIX_TMUX_PREFIX);
  });

  for (const client of MATRIX_CLIENTS) {
    describe.skipIf(!matrixClientAvailable(client))(client, () => {
      let endpoint: FakeModelEndpoint;
      let pane: ClientPane | null = null;

      beforeEach(async () => {
        endpoint = await startFakeModelEndpoint();
      });

      // The budget is for the DELETE, not for anything the test is waiting on.
      // Measured on the codex cell (ct-49852): the tmux kill takes 4-59ms, the
      // endpoint closes in under 1ms, and `fs.rmSync` of the pane's directories
      // takes 0.7-5.4s — 25s once with the disk contended. A fresh CODEX_HOME is
      // why: codex bootstraps ~730MB into it that the tests never use — three
      // 220MB copies of its own binary under `tmp/arg0/` so it can re-exec under
      // another argv[0], and a git clone of the plugin marketplace (~2.6k files)
      // under `.tmp/`. bun's default 5s hook budget sits inside that spread, so
      // two runs in four failed a delivery that had already passed, on "a
      // beforeEach/afterEach hook timed out for this test". 60s is an order of
      // magnitude over the median removal and 2.4x the worst one measured.
      afterEach(() => {
        try { pane?.tearDown(); } catch {}
        pane = null;
        endpoint.close();
      }, 60_000);

      test("cold boot: a multi-line message starts a turn and lands verbatim", async () => {
        pane = spawnClientPane(client, { endpointUrl: endpoint.url });
        const payload = multilinePayload(`matrix-cold-${randomUUID().slice(0, 8)}`);

        const delivery = await deliverToPane(pane, payload);
        const landedMs = await waitForRecorded(pane, payload);
        logMatrix(client, "cold_boot", {
          delivered_ms: delivery.elapsedMs,
          attempts: delivery.attempts,
          transcript_ms: landedMs,
          pane_age_ms: pane.ageMs(),
        });

        // One message, not four: an unbracketed multi-line payload submits per
        // line, so the blank line and the tail would be separate turns.
        expect(recorded(pane).filter((m) => m.startsWith(payload.split("\n")[0]))).toEqual([payload]);
        // The turn actually started — the client called the model. Clients take
        // their time getting there (opencode fires ~10s after the submit), so
        // this waits rather than sampling once.
        await waitFor(() => endpoint.requests() > 0, {
          timeoutMs: 60_000,
          label: `${client} started a turn for the injected message`,
        });
        // No clearing-key residue: the pre-paste C-a/C-k bytes must never be
        // recorded as message text (cold_boot_clearing_keys_land_as_text).
        for (const message of recorded(pane)) expect(CONTROL_BYTE.test(message)).toBe(false);
      }, 180_000);

      test("mid-turn: a type-ahead message queues and lands when the turn ends", async () => {
        pane = spawnClientPane(client, { endpointUrl: endpoint.url });
        const first = `matrix-turn-${randomUUID().slice(0, 8)}: hold this turn open`;
        await deliverToPane(pane, first);
        // Ground truth for "a turn is running": the client's model request is
        // open on the fake endpoint, which never answers. Pane text is the
        // daemon's own guess at the same question and is what this case exists
        // to test, so it cannot also be the precondition.
        await waitFor(() => endpoint.inFlight() > 0, {
          timeoutMs: 60_000,
          label: `${client} turn is in flight against the stalling endpoint`,
        });
        logMatrix(client, "mid_turn", { pane_state_while_busy: pane.liveState() });

        const second = multilinePayload(`matrix-typeahead-${randomUUID().slice(0, 8)}`);
        const delivery = await deliverToPane(pane, second, { budgetMs: 45_000 });
        // The running turn survived. An interrupt aborts the model request, so
        // a still-held request proves the injection rode the type-ahead queue
        // instead of sending the Escape that cancels the turn.
        expect(endpoint.inFlight()).toBeGreaterThan(0);

        // Ending the turn flushes the client's own queue.
        endpoint.reject();
        const landedMs = await waitForRecorded(pane, second, { timeoutMs: 90_000 });
        logMatrix(client, "mid_turn", {
          delivered_ms: delivery.elapsedMs,
          attempts: delivery.attempts,
          transcript_ms: landedMs,
        });

        const messages = recorded(pane);
        if (!messages.includes(first)) {
          throw new Error(
            `${client} lost the message the turn was started with\n` +
            `recorded: ${JSON.stringify(messages)}\npane:\n${pane.capture()}`,
          );
        }
        expect(messages.indexOf(first)).toBeLessThan(messages.indexOf(second));
      }, 240_000);

      test("resume: a rebuilt pane takes an injection into the same session", async () => {
        pane = spawnClientPane(client, { endpointUrl: endpoint.url });
        const before = `matrix-preresume-${randomUUID().slice(0, 8)}: first turn`;
        await deliverToPane(pane, before);
        await waitForRecorded(pane, before);
        // Let the turn end, so the resumed pane starts from a settled session.
        endpoint.reject();

        pane.resume();
        const after = multilinePayload(`matrix-postresume-${randomUUID().slice(0, 8)}`);
        const delivery = await deliverToPane(pane, after, { budgetMs: 90_000 });
        const landedMs = await waitForRecorded(pane, after);
        logMatrix(client, "resume", {
          delivered_ms: delivery.elapsedMs,
          attempts: delivery.attempts,
          transcript_ms: landedMs,
          pane_age_ms: pane.ageMs(),
        });

        const messages = recorded(pane);
        expect(messages).toContain(before);
        for (const message of messages) expect(CONTROL_BYTE.test(message)).toBe(false);
      }, 240_000);
    });
  }
});
