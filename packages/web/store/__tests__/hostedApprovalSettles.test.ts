// A hosted approval, answered, with its turn finished: nothing still waits on
// the person. The approval is the conversation's decision row alone, so a
// work state that lags the answer (permission_blocked left on the row) never
// brings it back as a terminal "permission prompt", and the conversation
// files under Done. An unsent new conversation is a draft, not work.
import { describe, expect, it } from "bun:test";
import { HOSTED_AGENT_TYPE } from "@codecast/shared/contracts/assistant";
import { awaitingOkIds, sessionHasOpenQuestion } from "../../lib/decisionQueue";
import { buildDecisionQueue } from "../../hooks/useDecisionQueue";
import { hostedStatusSections, isUnsentConversation, pendingSendIdsOf, type InboxSession, type SessionDecisionItem } from "../inboxStore";

const ME = "user1";
const CONV = "conv_hosted_routine_0000000000000";

const hosted = (extra: Partial<InboxSession> = {}): InboxSession => ({
  _id: CONV,
  session_id: "s-hosted",
  user_id: ME,
  updated_at: 2_000,
  agent_type: HOSTED_AGENT_TYPE,
  message_count: 6,
  is_idle: true,
  has_pending: false,
  last_user_message: "Remind me of my to-dos each weekday morning",
  title: "Morning to-do review",
  ...extra,
} as InboxSession);

const answered: SessionDecisionItem = {
  _id: "d1",
  conversation_id: CONV,
  session_id: "s-hosted",
  question: 'Set up a routine: "Morning to-do review"?',
  options: [{ label: "Approve" }, { label: "Decline" }],
  blocking: true,
  status: "answered",
  answer_index: 0,
  created_at: 1_000,
  resolved_at: 1_500,
} as SessionDecisionItem;

describe("an answered hosted approval settles", () => {
  it("leaves the queue empty even while the row still says permission_blocked", () => {
    const stale = hosted({ agent_status: "permission_blocked" });
    expect(sessionHasOpenQuestion(stale)).toBe(false);
    const queue = buildDecisionQueue({ d1: answered }, { [CONV]: stale }, {}, ME);
    expect(queue).toHaveLength(0);
    expect(awaitingOkIds({ d1: answered }).has(CONV)).toBe(false);
  });

  it("still lists the approval while its decision row is pending, as an approval", () => {
    const pending = { ...answered, status: "pending", answer_index: undefined, resolved_at: undefined } as SessionDecisionItem;
    const queue = buildDecisionQueue({ d1: pending }, { [CONV]: hosted({ agent_status: "permission_blocked" }) }, {}, ME);
    expect(queue.map((i) => i.source)).toEqual(["decide"]);
  });

  it("files the finished conversation under Done, and a draft under Drafts", () => {
    const done = hosted({ agent_status: "done" });
    const draft = hosted({ _id: "conv_draft", message_count: 0, last_user_message: undefined, title: undefined });
    expect(isUnsentConversation(draft)).toBe(true);
    const sections = hostedStatusSections(
      { pinned: [], questions: [], needsInput: [], newSessions: [draft], working: [], done: [done], dormant: [] },
      (id) => awaitingOkIds({ d1: answered }).has(id),
    );
    const of = (key: string) => sections.find(([, k]) => k === key)?.[0].map((s) => s._id);
    expect(of("needs_input")).toEqual([]);
    expect(of("working")).toEqual([]);
    expect(of("done")).toEqual([CONV]);
    expect(of("drafts")).toEqual(["conv_draft"]);
  });

  it("has no Scheduled for later: a parked row reads as Done, newest first", () => {
    const parked = hosted({ _id: "conv_parked", agent_status: "done", updated_at: 9_000 });
    const done = hosted({ agent_status: "done", updated_at: 1_000 });
    const sections = hostedStatusSections(
      { pinned: [], questions: [], needsInput: [], newSessions: [], working: [], done: [done], dormant: [parked] },
    );
    expect(sections.map(([, k]) => k)).not.toContain("dormant");
    expect(sections.find(([, k]) => k === "done")?.[0].map((s) => s._id)).toEqual(["conv_parked", CONV]);
  });

  it("files a just-sent stub under Working on it from the first frame", () => {
    // The optimistic stub has no message_count or last_user_message until the
    // server echoes, but its first message is already on the way.
    const stub = hosted({ _id: "conv_stub", message_count: 0, last_user_message: undefined, title: undefined });
    const pending = pendingSendIdsOf({
      sessionsWithQueuedMessages: new Set<string>(),
      pendingMessages: { conv_stub: [{ content: "Every weekday at 7am remind me" } as any] },
    });
    expect(isUnsentConversation(stub, pending.has("conv_stub"))).toBe(false);
    const sections = hostedStatusSections(
      { pinned: [], questions: [], needsInput: [], newSessions: [stub], working: [], done: [], dormant: [] },
      () => false,
      (id) => pending.has(id),
    );
    const of = (key: string) => sections.find(([, k]) => k === key)?.[0].map((s) => s._id);
    expect(of("working")).toEqual(["conv_stub"]);
    expect(of("drafts")).toEqual([]);
  });
});
