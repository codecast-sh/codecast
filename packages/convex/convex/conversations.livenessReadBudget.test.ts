import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { computeSessionsLiveness, _resetChildAuqProbeCacheForTests } from "./conversations";
import { ME, MIN, H, NOW, EPOCH, conv, db, countingCtx } from "./conversations.projection.testkit";

// sessionsLiveness timed out on heavy accounts: "Your request timed out
// performing too many system operations" (eg-2780, ct-87828). The windows are
// capped, but two reads still grow with the account: the live-pool hydration
// gets every heartbeating conversation outside the windows one by one, and the
// pending-decide set gets every pending decision_inbox row one by one (and its
// conversation again through the pool). Doubling the account must not raise
// an execution's db calls, and no execution may pass the ceiling.
const READ_CEILING = 1500;

const FILINGS = [{}, { inbox_dismissed_at: EPOCH - H }, { inbox_stashed_at: EPOCH - H }, { inbox_snoozed_until: EPOCH + H }];

type Shape = { live?: boolean; pendingDecisions?: boolean };

function account(n: number, shape: Shape) {
  const conversations: any[] = [];
  const managed_sessions: any[] = [];
  const messages: any[] = [];
  const session_decisions: any[] = [];
  const decision_inbox: any[] = [];
  for (let i = 0; i < n; i++) {
    conversations.push(conv(`c${i}`, { updated_at: EPOCH - (i + 1) * MIN, ...FILINGS[i % FILINGS.length] }));
    messages.push({ _id: `messages_${i}`, conversation_id: `conversations_c${i}`, role: "assistant", timestamp: EPOCH - i * MIN, content: "x", usage: {} });
    managed_sessions.push({
      _id: `managed_sessions_${i}`, user_id: ME, conversation_id: `conversations_c${i}`,
      last_heartbeat: shape.live ? EPOCH - 5_000 : EPOCH - 10 * H,
      agent_status: "working", agent_status_updated_at: EPOCH - MIN,
    });
    if (shape.pendingDecisions) {
      session_decisions.push({ _id: `session_decisions_${i}`, user_id: ME, conversation_id: `conversations_c${i}`, status: "pending", asked_user_ids: [ME], blocking: true });
      decision_inbox.push({ _id: `decision_inbox_${i}`, user_id: ME, decision_id: `session_decisions_${i}`, status: "pending" });
    }
  }
  return { conversations, managed_sessions, messages, session_decisions, decision_inbox };
}

async function readsFor(n: number, shape: Shape) {
  _resetChildAuqProbeCacheForTests();
  const { ctx, ops } = countingCtx(db(account(n, shape)));
  await computeSessionsLiveness(ctx, ME as any);
  return ops.length;
}

let nowSpy: ReturnType<typeof spyOn>;
beforeEach(() => { nowSpy = spyOn(Date, "now").mockReturnValue(NOW); });
afterEach(() => { nowSpy.mockRestore(); });

describe("sessionsLiveness reads stay bounded as the account grows", () => {
  test("many live sessions outside the windows", async () => {
    const small = await readsFor(1000, { live: true });
    const large = await readsFor(2000, { live: true });
    expect(large).toBeLessThanOrEqual(small);
    expect(large).toBeLessThanOrEqual(READ_CEILING);
  }, 60_000);

  test("many pending decisions", async () => {
    const small = await readsFor(1000, { pendingDecisions: true });
    const large = await readsFor(2000, { pendingDecisions: true });
    expect(large).toBeLessThanOrEqual(small);
    expect(large).toBeLessThanOrEqual(READ_CEILING);
  }, 60_000);
});
