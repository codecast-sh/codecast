// Hibernation against real tmux and real fake-claude panes.
//
// The wiring test proves the pass picks the right sessions; this proves the
// picks actually lose their panes, that the ones under the cap keep theirs, and
// that a parked session keeps beating. That last one is load bearing: the
// server deletes any managed_sessions row that stops beating for an hour, so a
// park that also stopped the heartbeat would throw away the park stamp and the
// status within the hour.
//
// Awake idle is injected rather than measured. The real clock only advances on
// macOS (collectResourceSnapshot returns immediately on any other platform) and
// CI is ubuntu, so relying on it would make the ordering assertion untestable
// there.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runHibernationPass, sessionParkStateForTests, trackSessionPaneForTests } from "./daemon.js";
import { spawnHarness, sweepStaleSessions, waitFor, type Harness } from "./test-helpers/messagingHarness.js";
import { hasTmux, tmuxRun } from "./tmux.js";

const MAX_LIVE = 4;
const EXTRA = 3;
const FLEET = MAX_LIVE + EXTRA;
const TIMEOUT = 120_000;

const paneAlive = (tmux: string): boolean => tmuxRun(["has-session", "-t", tmux]).status === 0;

describe.skipIf(!hasTmux())("hibernation with real panes", () => {
  const harnesses: Harness[] = [];

  beforeAll(async () => {
    sweepStaleSessions();
    for (let i = 0; i < FLEET; i++) harnesses.push(spawnHarness());
    // The teardown re-checks the pane is idle in the instant before the kill,
    // so every pane must have reached its prompt before the pass runs.
    for (const h of harnesses) {
      await waitFor(() => h.paneHasPrompt(), { timeoutMs: 30_000, label: `prompt for ${h.tmuxSession}` });
    }
    for (const h of harnesses) trackSessionPaneForTests(h.sessionId, h.tmuxSession);
  }, TIMEOUT);

  afterAll(() => {
    for (const h of harnesses) {
      trackSessionPaneForTests(h.sessionId, null);
      try { h.tearDown(); } catch {}
    }
    sweepStaleSessions();
  });

  test("parks exactly the overage, longest idle first, and leaves the rest alone", async () => {
    // Ascending idle, so the last EXTRA sessions are the oldest.
    const idleOf = new Map(harnesses.map((h, i) => [h.sessionId, i * 60_000]));
    const expected = harnesses.slice(-EXTRA).reverse();

    const hibernated = await runHibernationPass({
      policy: () => ({ maxLive: MAX_LIVE, idleMs: 0, maxPerPass: 5 }),
      awakeIdleMs: (id) => idleOf.get(id) ?? 0,
      // The fleet is synthetic, so it has no conversations: this keeps the pass
      // off the real backend.
      conversationIds: () => ({}),
    });
    expect(hibernated).toBe(EXTRA);

    for (const h of expected) {
      await waitFor(() => !paneAlive(h.tmuxSession), { timeoutMs: 15_000, label: `pane gone for ${h.tmuxSession}` });
      const state = sessionParkStateForTests(h.sessionId);
      expect(state.parked).toBe(true);
      // Still beating (or the server collects the row), and no longer tracked
      // as having a pane (or the health check would reconstitute it).
      expect(state.beating).toBe(true);
      expect(state.paneTracked).toBe(false);
    }

    for (const h of harnesses.slice(0, MAX_LIVE)) {
      expect(paneAlive(h.tmuxSession)).toBe(true);
      expect(sessionParkStateForTests(h.sessionId).parked).toBe(false);
    }
  }, TIMEOUT);

  test("a second pass parks nothing more: the fleet is back under its cap", async () => {
    const hibernated = await runHibernationPass({
      policy: () => ({ maxLive: MAX_LIVE, idleMs: 0, maxPerPass: 5 }),
      awakeIdleMs: () => 0,
      conversationIds: () => ({}),
    });
    expect(hibernated).toBe(0);
  }, TIMEOUT);
});
