// Hibernation against real tmux and real fake-claude panes.
//
// The wiring test proves the pass picks the right sessions; this proves the
// picks actually lose their panes, that the ones under the cap keep theirs, that
// a parked session keeps beating, and that the park it publishes is undone when
// the session comes back. Two of those are load bearing. The server deletes any
// managed_sessions row that stops beating for an hour, so a park that also
// stopped the heartbeat would throw away the park stamp and the status within
// the hour. And the wake has to move the status off "hibernated": the heartbeat
// re-sends whatever the daemon last sent, so a park that survived its own wake
// would paint a live pane as parked with nothing able to correct it.
//
// Awake idle is injected rather than measured. The real clock only advances on
// macOS (collectResourceSnapshot returns immediately on any other platform) and
// CI is ubuntu, so relying on it would make the ordering assertion untestable
// there.
//
// The park half is a real teardown of real panes. The wake half is not a real
// resume: the resume ladder reads a conversation out of Convex, spawns the
// agent and waits for its prompt, and no harness supplies a conversation. So it
// drives clearHibernationPark, the one function every resume path funnels
// through, and a source assertion in daemon.hibernation.test.ts holds
// autoResumeSession to calling it. The full path was verified by hand against
// the live daemon (reaper.log WOKE lines on both wake routes).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  clearHibernationPark,
  runHibernationPass,
  sessionParkStateForTests,
  setSyncServiceForTests,
  trackSessionPaneForTests,
} from "./daemon.js";
import { spawnHarness, sweepStaleSessions, waitFor, type Harness } from "./test-helpers/messagingHarness.js";
import type { SyncService } from "./syncService.js";
import { hasTmux, tmuxRun } from "./tmux.js";

const MAX_LIVE = 4;
const EXTRA = 3;
const FLEET = MAX_LIVE + EXTRA;
const TIMEOUT = 120_000;

const paneAlive = (tmux: string): boolean => tmuxRun(["has-session", "-t", tmux]).status === 0;

// Every agent-status write the daemon made, in order. Enough of a SyncService
// for the park and the wake: the pass asks for a lifecycle (null proceeds, the
// documented behaviour of an unreachable backend) and the teardown publishes a
// status.
type StatusWrite = { conversationId: string; status: string; hibernatedAt?: number | null };

function recordingSyncService(writes: StatusWrite[]): SyncService {
  return {
    updateSessionAgentStatus: async (
      conversationId: string,
      status: string,
      _clientTs?: number,
      _mode?: unknown,
      _tasks?: unknown,
      _presumed?: boolean,
      hibernatedAt?: number | null,
    ) => { writes.push({ conversationId, status, hibernatedAt }); },
    getConversationLifecycle: async () => null,
  } as unknown as SyncService;
}

describe.skipIf(!hasTmux())("hibernation with real panes", () => {
  const harnesses: Harness[] = [];
  const writes: StatusWrite[] = [];
  const convOf = (sessionId: string) => `conv-${sessionId}`;

  beforeAll(async () => {
    sweepStaleSessions();
    setSyncServiceForTests(recordingSyncService(writes));
    for (let i = 0; i < FLEET; i++) harnesses.push(spawnHarness());
    // The teardown re-checks the pane is idle in the instant before the kill,
    // so every pane must have reached its prompt before the pass runs.
    for (const h of harnesses) {
      await waitFor(() => h.paneHasPrompt(), { timeoutMs: 30_000, label: `prompt for ${h.tmuxSession}` });
    }
    for (const h of harnesses) trackSessionPaneForTests(h.sessionId, h.tmuxSession);
  }, TIMEOUT);

  afterAll(() => {
    setSyncServiceForTests(null);
    for (const h of harnesses) {
      trackSessionPaneForTests(h.sessionId, null);
      try { h.tearDown(); } catch {}
    }
    sweepStaleSessions();
  });

  const passIo = (idleOf?: Map<string, number>) => ({
    policy: () => ({ maxLive: MAX_LIVE, idleMs: 0, maxPerPass: 5 }),
    awakeIdleMs: (id: string) => idleOf?.get(id) ?? 0,
    // Synthetic ids: the fleet has no real conversations, and the recording
    // sync service above is what receives the writes they address.
    conversationIds: () => Object.fromEntries(harnesses.map((h) => [h.sessionId, convOf(h.sessionId)])),
  });

  test("parks exactly the overage, longest idle first, and leaves the rest alone", async () => {
    // Ascending idle, so the last EXTRA sessions are the oldest.
    const idleOf = new Map(harnesses.map((h, i) => [h.sessionId, i * 60_000]));
    const expected = harnesses.slice(-EXTRA).reverse();

    const hibernated = await runHibernationPass(passIo(idleOf));
    expect(hibernated).toBe(EXTRA);

    for (const h of expected) {
      await waitFor(() => !paneAlive(h.tmuxSession), { timeoutMs: 15_000, label: `pane gone for ${h.tmuxSession}` });
      const state = sessionParkStateForTests(h.sessionId);
      expect(state.parked).toBe(true);
      // The status half of the park: the row reads "hibernated" and carries the
      // stamp, so the inbox can tell a parked session from a crashed one.
      expect(state.status).toBe("hibernated");
      const write = writes.filter((w) => w.conversationId === convOf(h.sessionId)).at(-1);
      expect(write?.status).toBe("hibernated");
      expect(typeof write?.hibernatedAt).toBe("number");
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
    expect(await runHibernationPass(passIo())).toBe(0);
  }, TIMEOUT);

  test("the wake clears the park instead of re-asserting it", async () => {
    // Not a resume: the chokepoint every resume path funnels through, for the
    // reason in the file comment above.
    const woken = harnesses.at(-1)!;
    expect(sessionParkStateForTests(woken.sessionId).parked).toBe(true);

    clearHibernationPark(woken.sessionId, convOf(woken.sessionId));

    const state = sessionParkStateForTests(woken.sessionId);
    expect(state.parked).toBe(false);
    // Not "hibernated": the heartbeat re-sends this value every 30s.
    expect(state.status).toBe("connected");
    const write = writes.filter((w) => w.conversationId === convOf(woken.sessionId)).at(-1);
    expect(write?.status).toBe("connected");
    expect(write?.hibernatedAt).toBeNull();
  }, TIMEOUT);
});
