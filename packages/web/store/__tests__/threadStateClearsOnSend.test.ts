import { describe, expect, it, beforeEach } from "bun:test";
import { useInboxStore } from "../inboxStore";

// The pinned thread state (`cast state`) is the agent's declaration of who acts
// next. A message the human sends IS the human acting, so the send action takes
// the pin down on its draft — before the server's enqueue (which clears the same
// four fields) round-trips. Both rows the conversation view can read from drop
// it, and a row with no pin is left untouched.

const CONV = "jx70000000000000000000000000pin1";
const PIN = {
  thread_state: "Eval suite cleanup\nStatus: report is in the thread",
  thread_state_at: 1_000,
  thread_state_msg_count: 40,
  thread_state_status: "done",
};

function seed(extra: Record<string, unknown>) {
  useInboxStore.setState({
    sessions: {
      [CONV]: {
        _id: CONV, session_id: "s1", title: "Eval suite", agent_type: "claude_code",
        message_count: 51, is_idle: true, has_pending: false, updated_at: Date.now(),
        ...extra,
      } as any,
    },
    conversations: { [CONV]: { _id: CONV, session_id: "s1", ...extra } as any },
    pendingMessages: {},
    questionResolutions: {},
  } as any);
}

describe("sendMessage takes the pinned thread state down", () => {
  beforeEach(() => {
    (useInboxStore.getState() as any)._setDispatch(() => Promise.resolve(undefined));
  });

  it("clears all four fields on the session row and the conversation row", () => {
    seed(PIN);
    useInboxStore.getState().sendMessage(CONV, "one more thing", undefined, "client-1");
    const s = useInboxStore.getState();
    for (const row of [s.sessions[CONV], s.conversations[CONV]] as any[]) {
      expect(row.thread_state).toBeUndefined();
      expect(row.thread_state_at).toBeUndefined();
      expect(row.thread_state_msg_count).toBeUndefined();
      expect(row.thread_state_status).toBeUndefined();
    }
  });

  it("leaves a row with no pin alone", () => {
    seed({});
    useInboxStore.getState().sendMessage(CONV, "hi", undefined, "client-2");
    const s = useInboxStore.getState();
    expect("thread_state" in (s.sessions[CONV] as any)).toBe(false);
  });
});
