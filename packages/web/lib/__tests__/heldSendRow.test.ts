import { describe, expect, test } from "bun:test";
import { placeInboxRows, pendingSendIdsOf, useInboxStore, type InboxSession } from "../../store/inboxStore";
import { sessionCardLine } from "../sessionCardLine";

// ct-97017: a send the daemon holds waits on the person. The row says Held and
// files where the session itself stands (an idle agent: Needs You), not under
// Working as "Sending" until the ten-minute placement bound runs out.

const NOW = 1_700_000_000_000;
const SENT_AT = NOW - 60_000;
const CONV = "jx7" + "h".repeat(29);
const REASON = "terminal input not confirmed: composer never showed the pasted payload";

const row = {
  _id: CONV, session_id: "s1", agent_type: "claude_code", title: "t", message_count: 6,
  updated_at: NOW - 5 * 60_000, agent_status_updated_at: NOW - 5 * 60_000, started_at: NOW - 30 * 60_000,
  last_heartbeat: NOW - 5_000, is_idle: true, has_pending: false, is_connected: true, agent_status: "idle",
} as unknown as InboxSession;

const serverRow = (hold?: string) => ({
  _id: CONV, conversation_id: CONV, message_id: "m".repeat(32), client_id: "client-1",
  created_at: SENT_AT, status: "pending", content: "do this", ...(hold ? { hold_reason: hold } : {}),
});

const state = (hold?: string) => ({
  sessions: { [CONV]: row },
  sessionsWithQueuedMessages: new Set<string>(),
  pendingMessages: { [CONV]: [{ _id: "client-1", _clientId: "client-1", role: "user", content: "do this", timestamp: SENT_AT, _isOptimistic: true }] },
  pendingMessageStatus: { [CONV]: serverRow(hold) },
  clientState: { ui: { inbox_show_old: true } },
  currentUser: { _id: "me" },
  teamInboxIds: new Set<string>(),
  currentSessionId: null,
});

const bucketOf = (s: ReturnType<typeof state>) => {
  const placed = placeInboxRows(s as never, { now: NOW });
  if (placed.working.some((r) => r._id === CONV)) return "working";
  if (placed.needsInput.some((r) => r._id === CONV)) return "needs_input";
  return null;
};

describe("a held send on the sidebar row", () => {
  test("files under Needs You at once and reads Held, with the reason in its title", () => {
    expect(bucketOf(state(REASON))).toBe("needs_input");
    const line = sessionCardLine({ row: row as never, status: "needs_you", now: NOW, live: { pendingSend: false, held: REASON } });
    expect(line.reason).toBe("Held");
    expect(line.reasonTitle).toBe(`Held: ${REASON}`);
  });

  test("an ordinary unconfirmed send still reads Sending under Working", () => {
    expect(bucketOf(state())).toBe("working");
    expect(sessionCardLine({ row: row as never, status: "working", now: NOW, live: { pendingSend: true } }).reason).toBe("Sending");
  });

  test("Send anyway ends the hold in the store draft, and Cancel drops the send", async () => {
    useInboxStore.setState(state(REASON) as never);
    expect(pendingSendIdsOf(useInboxStore.getState() as never, NOW).has(CONV)).toBe(false);
    void useInboxStore.getState().retryPendingMessage(CONV, { messageId: "m".repeat(32), clientId: "client-1", force: true }).catch(() => {});
    expect(pendingSendIdsOf(useInboxStore.getState() as never, NOW).has(CONV)).toBe(true);

    useInboxStore.setState(state(REASON) as never);
    void useInboxStore.getState().cancelPendingMessage(CONV, { messageId: "m".repeat(32), clientId: "client-1" }).catch(() => {});
    const after = useInboxStore.getState() as any;
    expect(after.pendingMessageStatus[CONV]).toBeUndefined();
    expect(pendingSendIdsOf(after, NOW).has(CONV)).toBe(false);
  });
});
