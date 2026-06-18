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

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import { injectViaTmux } from "./daemon.js";
import {
  spawnHarness,
  waitFor,
  sweepStaleSessions,
  readJsonlMessages,
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
    const h = track(spawnHarness({ fatal: "fake-claude: simulated startup failure" }));
    // The pane should NOT show a normal ❯ prompt within the budget.
    let sawPrompt = false;
    try {
      await waitFor(() => h.paneHasPrompt(), { timeoutMs: 2_000, label: "no prompt expected" });
      sawPrompt = true;
    } catch {}
    expect(sawPrompt).toBe(false);
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
