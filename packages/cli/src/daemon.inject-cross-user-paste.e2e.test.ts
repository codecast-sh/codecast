// Red list #8 (ct-55711, pl-810): a teammate's paste over 2KB, sent into a
// LIVE pane on a real Claude Code client while the machine is loaded, lands
// exactly once, is acknowledged once, and leaves a verified receipt.
//
// Each step runs the production function for it; only the network between
// them is left out:
//   send     Bo types into Ada's session from the dashboard (performSessionSend,
//            direct: true), so the row carries Bo's <user-message> wrapper,
//            from_user_id Bo and owner Ada.
//   claim    Ada's daemon claims the row and marks it injected, as
//            deliverMessage does before the paste.
//   deliver  injectViaTmux with the row's delivery identity and a receipt
//            journal, retried on the same identity the way the delivery loop
//            retries AGENT_STDIN_NOT_READY / INJECT_UNVERIFIED.
//   ack      every user turn the real client wrote to its transcript is
//            redacted and acked the way addMessages acks it: pendingRowsForEcho,
//            findEchoedPendingMessage, then settleEchoedPending.
// `yes` processes load every core for the whole delivery. The client talks to
// a fake model endpoint (no model call is made): "idle" ends every turn at
// once, "busy" holds a turn open so the paste lands mid-turn and Claude queues
// it. Both renderers run: the classic one, and the fullscreen TUI this
// machine's own sessions use. The pane starts with the machine's cached remote
// flags, so the paste is wrapped in <pasted_content> as on a real client.
//
// It loads every core for minutes, so it runs only when asked for
// (CODECAST_PASTE_E2E=1), and it also skips without tmux or a claude binary,
// like the other real-client suites (daemon.inject-double-paste.test.ts).
import { killIsolatedTmuxServer } from "./test-helpers/isolatedTmuxServer.js";
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { injectViaTmux, setSyncServiceForTests } from "./daemon.js";
import { TmuxDeliveryJournal } from "./tmuxDeliveryJournal.js";
import { cpuLoad } from "./test-helpers/cpuLoad.js";
import { machinePasteWrapperOn } from "./test-helpers/claudeFeatureCache.js";
import { loadScaledMs } from "./test-helpers/machineLoad.js";
import {
  hasBinary,
  MATRIX_TMUX_PREFIX,
  spawnClientPane,
  startFakeModelEndpoint,
  sweepStaleSessions,
  waitFor,
} from "./test-helpers/messagingHarness.js";
import type { SyncService } from "./syncService.js";
import { makeFakeDb } from "../../convex/convex/testDb";
import {
  claimPendingMessageForDaemon,
  performSessionSend,
  updatePendingMessageStatusForDaemon,
} from "../../convex/convex/pendingMessages";
import { findEchoedPendingMessage, pendingRowsForEcho, settleEchoedPending } from "../../convex/convex/messages";
import { redactSecrets } from "../../convex/convex/redact";

const CAN_RUN = process.env.CODECAST_PASTE_E2E === "1" && hasBinary("tmux") && hasBinary("claude");
const WRAPPED = machinePasteWrapperOn();
const TEST_TIMEOUT_MS = loadScaledMs(300_000, 3);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Ada owns the session and its device; Bo is her teammate on team T.
function world(sessionId: string) {
  const now = Date.now();
  const db = makeFakeDb({
    users: [{ _id: "uAda", name: "Ada" }, { _id: "uBo", name: "Bo" }],
    teams: [{ _id: "tA" }],
    team_memberships: [
      { _id: "mAda", user_id: "uAda", team_id: "tA", visibility: "summary" },
      { _id: "mBo", user_id: "uBo", team_id: "tA", visibility: "summary" },
    ],
    conversations: [{
      _id: "convAda", user_id: "uAda", team_id: "tA", short_id: "jxada01", session_id: sessionId,
      is_private: false, status: "active", owner_device_id: "devAda", updated_at: now,
    }],
    managed_sessions: [{
      _id: "msAda", user_id: "uAda", conversation_id: "convAda", session_id: sessionId, last_heartbeat: now, agent_status: "idle",
    }],
    devices: [{ _id: "dAda", user_id: "uAda", device_id: "devAda", last_seen: now }],
    pending_messages: [],
  });
  return { db, ctx: { db } as any };
}

// A teammate's review notes: many lines, well past 2KB, one marker on the
// first line so a split or doubled submit is countable.
function teammateNotes(marker: string): string {
  const lines = [`${marker}: notes from the release review, please work through them in order.`];
  for (let i = 1; lines.join("\n").length < 3_000; i++) {
    lines.push(`${i}. Check the migration step ${i} against the staging snapshot, compare row counts, and write down any table whose count moved.`);
  }
  return lines.join("\n");
}

// The content-matched ack in addMessages, one transcript turn at a time, on
// the same redacted text and through the same steps.
async function ackEcho(ctx: any, content: string, echoId: string): Promise<string | null> {
  const rows = await pendingRowsForEcho(ctx, "convAda" as any);
  const row = findEchoedPendingMessage(rows, redactSecrets(content), Date.now());
  if (!row) return null;
  await settleEchoedPending(ctx, row, echoId as any);
  return row._id;
}

const RETRYABLE = /^(AGENT_STDIN_NOT_READY|INJECT_UNVERIFIED|AGENT_NOT_READY|AGENT_UNKNOWN_STATE)/;

describe.skipIf(!CAN_RUN)("a teammate's long paste into a live claude pane under load", () => {
  afterAll(() => {
    setSyncServiceForTests(null);
    sweepStaleSessions(MATRIX_TMUX_PREFIX);
    killIsolatedTmuxServer();
  });

  test.each([
    ["idle", "classic"], ["busy", "classic"], ["idle", "fullscreen"], ["busy", "fullscreen"],
  ] as const)("lands once, acks once, leaves a verified receipt (%s pane, %s renderer)", async (mode, renderer) => {
    const endpoint = await startFakeModelEndpoint();
    if (mode === "idle") endpoint.reject();
    const pane = spawnClientPane("claude", {
      endpointUrl: endpoint.url, machineFeatures: true, tui: renderer === "fullscreen" ? "fullscreen" : undefined,
    });
    const scratch = mkdtempSync(join(os.tmpdir(), "codecast-xuser-paste-"));
    const journal = new TmuxDeliveryJournal(join(scratch, "delivery.sqlite"));
    const load = cpuLoad();
    const marker = `xuser-${randomUUID().slice(0, 8)}`;
    const body = teammateNotes(marker);
    const chips = new Set<string>();
    let watching = true;
    try {
      await waitFor(() => pane.capture().includes("shift+tab"), { timeoutMs: loadScaledMs(90_000, 3), label: "claude prompt" });
      if (mode === "busy") {
        await injectViaTmux(pane.target, "Start the release checklist.", "claude");
        await waitFor(() => endpoint.inFlight() > 0, { timeoutMs: loadScaledMs(30_000, 3), label: "turn in flight" });
      }

      // Bo's send, then Ada's daemon claims it and marks it injected.
      const { db, ctx } = world(pane.sessionId()!);
      const sent = await performSessionSend(ctx, "uBo" as any, { to: "jxada01", body, direct: true });
      expect(sent.cross_user).toBe(true);
      const row = db._tables.pending_messages[0];
      expect(row.content.length).toBeGreaterThan(2_048);
      expect({ from: row.from_user_id, owner: row.owner_user_id }).toEqual({ from: "uBo", owner: "uAda" });
      expect((await claimPendingMessageForDaemon(ctx, row._id, "uAda" as any, "devAda"))?._id).toBe(row._id);
      await updatePendingMessageStatusForDaemon(ctx, row._id, "uAda" as any, "devAda", { status: "injected" });
      setSyncServiceForTests({
        getPendingMessageStatus: async (id: string) => (await db.get(id))?.status ?? "missing",
      } as unknown as SyncService);

      // Every chip the composer ever shows while the paste is in flight.
      const watcher = (async () => {
        while (watching) {
          for (const m of pane.capture().matchAll(/\[Pasted text #(\d+)/g)) chips.add(m[1]!);
          await sleep(150);
        }
      })();

      load.on(os.cpus().length);
      const delivery = { messageId: row._id, conversationId: "convAda" };
      const errors: string[] = [];
      const started = Date.now();
      for (;;) {
        try {
          await injectViaTmux(pane.target, row.content, "claude", { delivery, journal });
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(msg.split(":")[0]!);
          if (!RETRYABLE.test(msg) || Date.now() - started > loadScaledMs(90_000, 3)) throw new Error(`delivery failed after ${errors.length} attempts: ${msg}\npane:\n${pane.capture()}`);
          await sleep(2_000);
        }
      }
      if (mode === "busy") endpoint.reject();

      const withMarker = () => pane.userMessages().filter((m) => m.includes(marker));
      await waitFor(() => withMarker().length > 0, { timeoutMs: loadScaledMs(60_000, 3), label: "teammate paste in the transcript" });
      await sleep(3_000);
      load.off();

      const turns = pane.userMessages();
      let acks = 0;
      for (const [i, turn] of turns.entries()) if (await ackEcho(ctx, turn, `echo-${i}`) === row._id) acks++;
      const receipt = journal.get(row._id);
      const wrappers = (withMarker()[0]?.match(/<pasted_content/g) ?? []).length;
      console.log(`[xuser-paste] mode=${mode} renderer=${renderer} attempts=${errors.length + 1} errors=${JSON.stringify(errors)} chips=${JSON.stringify([...chips])} turns=${turns.length} withMarker=${withMarker().length} wrappers=${wrappers} acks=${acks} receipt=${receipt?.phase}`);

      expect(withMarker()).toHaveLength(1);
      // One wrapper when this machine's flags turn it on (a split paste shows
      // as more than one in the turn, a lost wrapper as none), none otherwise.
      if (!WRAPPED) console.log("[xuser-paste] this machine's cached flags leave the paste wrapper off; expecting no <pasted_content>");
      expect(wrappers).toBe(WRAPPED ? 1 : 0);
      expect(acks).toBe(1);
      expect((await db.get(row._id)).status).toBe("delivered");
      expect(receipt?.phase).toBe("verified");

      // A retry of the same delivery (the 120s cron re-pending, a timeout the
      // daemon read as a failure) finds the receipt and the ack and writes
      // nothing; the server refuses a second claim. A second paste would show
      // as a second chip, a second submit as a second transcript turn.
      await injectViaTmux(pane.target, row.content, "claude", { delivery, journal, receiptSettleMs: 0 });
      expect(await claimPendingMessageForDaemon(ctx, row._id, "uAda" as any, "devAda")).toBeNull();
      await sleep(3_000);
      watching = false;
      await watcher;
      expect(withMarker()).toHaveLength(1);
      // A paste over 2KB always shows a chip; exactly one means it neither
      // split nor went unseen.
      expect(chips.size).toBe(1);
    } finally {
      watching = false;
      load.off();
      setSyncServiceForTests(null);
      journal.close();
      try { pane.tearDown(); } catch {}
      endpoint.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT_MS);
});
