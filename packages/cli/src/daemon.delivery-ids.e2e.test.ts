// End to end through a real Claude Code in a tmux pane: the daemon types two
// deliveries (one while the agent is idle, one into its running turn), a
// person types a third line at the terminal, and the agent's own transcript
// is uploaded through SyncService into the Convex write. Each delivery's echo
// carries its pending row's id and settles that row. The line typed by hand
// was handed over by nobody, so it settles nothing, even though a pending row
// that was never delivered holds the same words: the server pairs nothing by text.
import { killIsolatedTmuxServer } from "./test-helpers/isolatedTmuxServer.js";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectViaTmux } from "./daemon.js";
import { DeliveryEchoLedger, echoCandidatesOf } from "./deliveryEchoLedger.js";
import { TmuxDeliveryJournal } from "./tmuxDeliveryJournal.js";
import { SyncService } from "./syncService.js";
import { tmuxRun } from "./tmux.js";
import { hasBinary, spawnClientPane, startFakeModelEndpoint, waitFor } from "./test-helpers/messagingHarness.js";
import { addMessages } from "../../convex/convex/messages";
import { makeFakeDb } from "../../convex/convex/testDb";

describe.skipIf(!hasBinary("tmux") || !hasBinary("claude"))("delivery ids through a real Claude pane", () => {
  afterAll(killIsolatedTmuxServer);

  test("each delivery's echo settles its own row, and a line typed at the terminal settles none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-ids-"));
    const echoes = new DeliveryEchoLedger(join(dir, "echoes.sqlite"));
    const journal = new TmuxDeliveryJournal(join(dir, "journal.sqlite"));
    const endpoint = await startFakeModelEndpoint();
    const pane = spawnClientPane("claude", { endpointUrl: endpoint.url });
    const conversationId = "conversation";
    try {
      await waitFor(() => /❯/.test(pane.capture()), { timeoutMs: 60_000, label: "claude prompt" });
      tmuxRun(["set-option", "-t", pane.target, "@codecast_session_id", pane.sessionId()!]);

      // Idle: the first delivery starts a turn, which the endpoint holds open.
      const step = (s: string) => console.log(`[e2e] ${s} ${new Date().toISOString()}`);
      await injectViaTmux(pane.target, "read the plan; then report;", "claude", { delivery: { messageId: "pm1", conversationId }, journal, echoes });
      step("pm1 typed");
      await waitFor(() => endpoint.inFlight() > 0, { timeoutMs: 30_000, label: "turn running" });
      step("turn running");
      // Mid-turn: the second delivery steers the running turn.
      await injectViaTmux(pane.target, "also check the tests", "claude", { delivery: { messageId: "pm2", conversationId }, journal, echoes });
      step("pm2 typed");
      // A person at the terminal types words a pending row also holds.
      tmuxRun(["send-keys", "-t", pane.target, "-l", "continue"]);
      tmuxRun(["send-keys", "-t", pane.target, "Enter"]);
      await new Promise((r) => setTimeout(r, 1500));
      step("typed by hand");
      // The turn ends; Claude takes what was queued behind it.
      endpoint.reject();
      await waitFor(() => pane.userMessages().length >= 3, { timeoutMs: 60_000, label: "three user turns" });
      step(`turns: ${JSON.stringify(pane.userMessages())}`);

      const stamped = echoes.stamp(conversationId, echoCandidatesOf(pane.turns()));
      const users = stamped.filter((m) => m.role === "user");
      expect(users.map((m) => [m.content.trim(), m.deliveryIds ?? null])).toEqual([
        ["read the plan; then report;", ["pm1"]],
        ["also check the tests", ["pm2"]],
        ["continue", null],
      ]);

      // The upload: SyncService stamps the same turns, and the Convex write settles by id.
      const db = makeFakeDb({
        users: [{ _id: "owner" }],
        conversations: [{ _id: conversationId, user_id: "owner", is_private: true, agent_type: "claude", message_count: 0, updated_at: 1, status: "active", skip_title_generation: true }],
        pending_messages: ["pm1", "pm2", "pm3"].map((id, i) => ({
          _id: id, conversation_id: conversationId, from_user_id: "owner", owner_user_id: "owner", status: "injected",
          content: ["read the plan; then report;", "also check the tests", "continue"][i], created_at: 1 + i, retry_count: 0, client_id: `client-${id}`,
        })),
      });
      const ctx = { db, auth: { getUserIdentity: async () => ({ subject: "owner|session" }) }, scheduler: { runAfter: async () => "scheduled" }, storage: { getUrl: async () => null } };
      const sync = new SyncService({ convexUrl: "http://localhost:0", userId: "owner", authToken: "token" });
      (sync as any).client = { mutation: async (_name: string, args: any) => (addMessages as any)._handler(ctx, args) };
      sync.setDeliveryEchoes(echoes);
      const upload = () => sync.addMessages({ conversationId, messages: pane.turns().map((m) => ({
        messageUuid: m.uuid, role: m.role === "user" ? "human" as const : m.role, content: m.content, timestamp: m.timestamp,
      })) });
      await upload();
      await upload();
      const status = (id: string) => db._tables.pending_messages.find((r: any) => r._id === id).status;
      expect([status("pm1"), status("pm2"), status("pm3")]).toEqual(["delivered", "delivered", "injected"]);
      const userRows = db._tables.messages.filter((m: any) => m.role === "user");
      expect(userRows.map((m: any) => m.client_id ?? null)).toEqual(["client-pm1", "client-pm2", null]);
    } finally {
      pane.tearDown();
      endpoint.close();
      echoes.close();
      journal.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
