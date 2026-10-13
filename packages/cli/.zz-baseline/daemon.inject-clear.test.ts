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
// Reproduction strategy: spawn a real Claude Code TUI under tmux pointed at a
// fake model endpoint, drive it the way the daemon does, and assert on what the
// client recorded.
//
// Test is skipped automatically when `tmux` or `claude` isn't on PATH so
// vanilla `bun test` runs without the integration dependency.

// FIRST import, and it must stay first: this file spawns real client TUIs, and
// they belong on a private tmux server rather than beside the panes the daemon
// is driving for real work. The daemon reads the environment that selects the
// server at module load. See isolatedTmuxServer.ts.
import { killIsolatedTmuxServer } from "./test-helpers/isolatedTmuxServer.js";
import { describe, expect, test, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmuxRun } from "./tmux.js";
import {
  hasBinary,
  waitFor,
  waitForRecorded,
  sweepStaleSessions,
  assertRealClaudeHomeUntouched,
  MATRIX_CLIENTS,
  MATRIX_TMUX_PREFIX,
  matrixClientAvailable,
  spawnClientPane,
  startFakeModelEndpoint,
  deliverToPane,
  logMatrix,
  type ClientPane,
} from "./test-helpers/messagingHarness.js";

const CAN_RUN = hasBinary("tmux") && hasBinary("claude");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** What the composer currently holds: the text after the last `❯` on screen. */
function composerText(pane: ClientPane): string {
  const line = pane.capture().split("\n").reverse().find((l) => l.includes("❯")) ?? "";
  return line.slice(line.indexOf("❯") + 1).trim();
}

describe.skipIf(!CAN_RUN)("injectViaTmux clears stale draft before pasting", () => {
  afterAll(() => {
    sweepStaleSessions(MATRIX_TMUX_PREFIX);
  });

  test("recalled prompt is fully cleared; second injection lands clean", async () => {
    // A fake endpoint that rejects, rather than a bad ANTHROPIC_API_KEY: an
    // unrecognized key parks current builds on a "Do you want to use this API
    // key?" dialog, which this test used to answer with a blind Enter — the
    // pane's fate then rode on which row that build highlighted. Rejecting from
    // the endpoint ends each turn at once instead, so the pane is idle and
    // classifiable for the next injection, and nothing leaves the machine.
    const endpoint = await startFakeModelEndpoint();
    endpoint.reject();
    const pane = spawnClientPane("claude", { endpointUrl: endpoint.url });
    try {
      // 1. Inject a first prompt. After Claude Code records it, the input box
      //    is empty (Claude Code clears the input on submit).
      const first = `first prompt that will be recalled ${randomUUID().slice(0, 8)}`;
      await deliverToPane(pane, first);
      await waitForRecorded(pane, first, { timeoutMs: 40_000 });

      // 2. Put stale text in the box the way the person at the keyboard does:
      //    press Up, which recalls the previous prompt (claude 2.1.263 paints
      //    "History 1/1" over the composer). This is the state the 2026-05-19
      //    bug report observed.
      tmuxRun(["send-keys", "-t", pane.target, "Up"]);
      // Why: without this the test passes vacuously the day Up stops recalling
      // — an injection over an EMPTY composer proves nothing about clearing,
      // and that is how this test came to be read as broken (ct-49619). Fail
      // here, with the pane, rather than assert a guarantee never exercised.
      try {
        await waitFor(() => composerText(pane).includes(first), { timeoutMs: 10_000 });
      } catch {
        throw new Error(
          `Up did not recall the previous prompt into the composer, so the stale ` +
          `draft this test needs never existed. Find the gesture that recalls one ` +
          `today and use it here.\ncomposer: ${JSON.stringify(composerText(pane))}\n` +
          `pane:\n${pane.capture()}`,
        );
      }

      // 3. Inject a second message. With the buggy clear (Escape + single C-u),
      //    the recalled prompt stays in the box and the injected paste-buffer
      //    content concatenates with it. With a correct clear, only the payload
      //    lands.
      const second = `follow-up content ${randomUUID().slice(0, 8)}`;
      const delivery = await deliverToPane(pane, second);
      logMatrix("claude", "recalled_draft", delivery);
      await waitForRecorded(pane, second, { timeoutMs: 40_000 });

      // The assertion that proves the fix: two separate messages, the second
      // exactly the injected payload with no fragment of the recalled prompt.
      // Under the bug the second is something like
      //   "follow-up contentfirst prompt that will be recalled"
      // (cursor at start after Up) or
      //   "first prompt that will be recallefollow-up content"
      // (a bad clear that ate one trailing word) — and either way there is one
      // message on disk, not two.
      expect(pane.userMessages().map((m) => m.trimEnd())).toEqual([first, second]);
    } finally {
      try { pane.tearDown(); } catch {}
      endpoint.close();
    }
  }, 240_000);
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
