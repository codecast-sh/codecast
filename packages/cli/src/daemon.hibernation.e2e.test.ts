import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  clearHibernationPark,
  hibernateSessionNow,
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

  test("an enabled cap and manual commands leave every healthy pane live", async () => {
    const idleOf = new Map(harnesses.map((h, i) => [h.sessionId, i * 60_000]));
    const before = harnesses.map((h) => sessionParkStateForTests(h.sessionId));
    expect(await runHibernationPass(passIo(idleOf))).toBe(0);
    for (const [i, h] of harnesses.entries()) {
      expect(await hibernateSessionNow(h.sessionId, convOf(h.sessionId), passIo(idleOf))).toMatchObject({
        result: "skipped_parking-safety-unavailable",
      });
      expect(paneAlive(h.tmuxSession)).toBe(true);
      expect(sessionParkStateForTests(h.sessionId)).toEqual(before[i]);
    }
    expect(writes).toEqual([]);
  }, TIMEOUT);

  test("repeated enabled passes keep the fleet over its cap without parking", async () => {
    expect(await runHibernationPass(passIo())).toBe(0);
    for (const h of harnesses) expect(paneAlive(h.tmuxSession)).toBe(true);
    expect(writes).toEqual([]);
  }, TIMEOUT);

  test("a wake clears a pre-existing park without requiring a new park", async () => {
    const woken = harnesses.at(-1)!;
    trackSessionPaneForTests(woken.sessionId, woken.tmuxSession, { parked: true, status: "hibernated" });
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
