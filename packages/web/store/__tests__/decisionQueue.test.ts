import { describe, expect, it, beforeEach } from "bun:test";
import {
  decisionQueueItems,
  queueTier,
  sessionHasOpenQuestion,
  sortQueue,
  type QueueItem,
} from "../../lib/decisionQueue";
import { buildSingleAnswerPayload, pollKeyForOption } from "../../lib/pollPayload";
import { useInboxStore, type InboxSession, type SessionDecisionItem } from "../inboxStore";

const convexId = (seed: string) => seed.padEnd(32, "0").slice(0, 32);

const session = (id: string, extra: Partial<InboxSession> = {}): InboxSession => ({
  _id: id,
  session_id: `session-${id}`,
  updated_at: 1,
  agent_type: "claude_code",
  message_count: 3,
  is_idle: false,
  has_pending: false,
  last_user_message: "hi",
  title: `Session ${id}`,
  ...extra,
});

const decision = (id: string, extra: Partial<SessionDecisionItem> = {}): SessionDecisionItem => ({
  _id: id,
  conversation_id: convexId(`conv${id}`),
  session_id: `sess-${id}`,
  question: `Question ${id}?`,
  options: [{ label: "Yes" }, { label: "No" }],
  blocking: true,
  status: "pending",
  created_at: 1000,
  ...extra,
});

const item = (extra: Partial<QueueItem> = {}): QueueItem => ({
  key: "k",
  source: "decide",
  conversationId: "c",
  question: "q?",
  options: [],
  blocking: true,
  createdAt: 0,
  ...extra,
});

describe("decision queue ranking", () => {
  it("puts a live blocked agent ahead of a dead one and of advisory asks", () => {
    const live = item({
      key: "live",
      createdAt: 5000, // newest, but tier wins
      session: session("a", { agent_status: "permission_blocked", is_unresponsive: false }),
    });
    const dead = item({
      key: "dead",
      createdAt: 2000,
      session: session("b", { agent_status: "stopped" }),
    });
    const advisory = item({
      key: "advisory",
      blocking: false,
      createdAt: 1, // oldest of all, but advisory sorts last
      session: session("c", { agent_status: "permission_blocked" }),
    });

    expect(queueTier(live)).toBe(1);
    expect(queueTier(dead)).toBe(2);
    expect(queueTier(advisory)).toBe(3);
    expect(sortQueue([advisory, dead, live]).map((i) => i.key)).toEqual([
      "live",
      "dead",
      "advisory",
    ]);
  });

  it("orders oldest first within a tier, so an answer never gets pushed down by a newer ask", () => {
    const running = { agent_status: "permission_blocked" as const, is_unresponsive: false };
    const older = item({ key: "older", createdAt: 100, session: session("a", running) });
    const newer = item({ key: "newer", createdAt: 900, session: session("b", running) });
    expect(sortQueue([newer, older]).map((i) => i.key)).toEqual(["older", "newer"]);
  });

  it("treats an unresponsive session as tier 2 even while its status looks blocked", () => {
    const stale = item({
      session: session("a", { agent_status: "permission_blocked", is_unresponsive: true }),
    });
    expect(queueTier(stale)).toBe(2);
  });

  it("only surfaces pending decisions", () => {
    const decisions = {
      a: decision("a"),
      b: decision("b", { status: "answered" }),
      c: decision("c", { status: "dismissed" }),
    };
    const items = decisionQueueItems(decisions, {});
    expect(items.map((i) => i.decisionId)).toEqual(["a"]);
  });
});

describe("open-question predicate", () => {
  it("accepts both the awaiting_input flag and a permission-blocked status", () => {
    expect(sessionHasOpenQuestion(session("a", { awaiting_input: true }))).toBe(true);
    // The buffered-AUQ trap: a poll left open long enough for the row to settle
    // reports awaiting_input false, but the status still says blocked.
    expect(
      sessionHasOpenQuestion(session("b", { awaiting_input: false, agent_status: "permission_blocked" }))
    ).toBe(true);
    expect(sessionHasOpenQuestion(session("c"))).toBe(false);
  });

  it("never surfaces a killed session", () => {
    expect(
      sessionHasOpenQuestion(session("a", { awaiting_input: true, inbox_killed_at: 5 }))
    ).toBe(false);
  });
});

describe("poll answer payload", () => {
  it("maps option index to a 1-based digit, and a confirmation to Enter/Escape", () => {
    expect(pollKeyForOption(0)).toBe("1");
    expect(pollKeyForOption(2)).toBe("3");
    expect(pollKeyForOption(0, true)).toBe("Enter");
    expect(pollKeyForOption(1, true)).toBe("Escape");
  });

  it("builds the control message the daemon parses", () => {
    const q = {
      question: "Which schema wins?",
      options: [{ label: "Frontmatter" }, { label: "Path" }],
    };
    const payload = JSON.parse(buildSingleAnswerPayload(q, 1));
    expect(payload.__cc_poll).toBe(true);
    expect(payload.keys).toEqual(["2"]);
    expect(payload.display).toBe("Path");
    // A single-select single question must NOT append a submit Enter.
    expect(payload.keys).not.toContain("Enter");
  });
});

describe("answering a decision", () => {
  beforeEach(() => {
    useInboxStore.setState({ sessionDecisions: {}, pendingMessages: {} } as any);
  });

  it("flips the row locally and queues the chosen option as a message", async () => {
    const convId = convexId("conv1");
    const row = decision("d1", { conversation_id: convId, options: [{ label: "Approve" }, { label: "Hold" }] });
    useInboxStore.setState({ sessionDecisions: { d1: row } } as any);

    useInboxStore.getState().answerDecision("d1", { index: 0 });

    // Local-first: the status is already answered, no await involved.
    const after = useInboxStore.getState().sessionDecisions.d1;
    expect(after.status).toBe("answered");
    expect(after.answer_index).toBe(0);
    expect(after.resolved_at).toBeGreaterThan(0);

    // The send is deferred one microtask so the draft commits first.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const pending = useInboxStore.getState().pendingMessages[convId] ?? [];
    expect(pending.some((m: any) => m.content === "Decision: Approve")).toBe(true);
  });

  it("is idempotent — answering twice does not double-send", async () => {
    const convId = convexId("conv2");
    useInboxStore.setState({
      sessionDecisions: { d2: decision("d2", { conversation_id: convId }) },
    } as any);

    useInboxStore.getState().answerDecision("d2", { index: 0 });
    useInboxStore.getState().answerDecision("d2", { index: 1 });
    await new Promise((r) => setTimeout(r, 0));

    const after = useInboxStore.getState().sessionDecisions.d2;
    expect(after.answer_index).toBe(0);
    const pending = useInboxStore.getState().pendingMessages[convId] ?? [];
    expect(pending.length).toBe(1);
  });

  it("dismissing resolves the row without messaging the session", async () => {
    const convId = convexId("conv3");
    useInboxStore.setState({
      sessionDecisions: { d3: decision("d3", { conversation_id: convId }) },
    } as any);

    useInboxStore.getState().answerDecision("d3", { dismiss: true });
    await new Promise((r) => setTimeout(r, 0));

    expect(useInboxStore.getState().sessionDecisions.d3.status).toBe("dismissed");
    expect(useInboxStore.getState().pendingMessages[convId] ?? []).toHaveLength(0);
  });
});

// The local-first question resolution overlay: answering or dismissing an
// AskUserQuestion/permission ask marks the session in questionResolutions,
// and EVERY question surface reads that mark through sessionHasOpenQuestion —
// so the queue and the rail's QUESTIONS section can never disagree while the
// server's awaiting_input truth round-trips.
describe("local question resolutions", () => {
  beforeEach(() => {
    useInboxStore.setState({ sessions: {}, questionResolutions: {}, pendingMessages: {} } as any);
  });

  it("a poll answer hides the question in the same commit, and its own echo does not resurface it", () => {
    const convId = convexId("conv4");
    const row = session(convId, { awaiting_input: true, message_count: 6 });
    useInboxStore.setState({ sessions: { [convId]: row } } as any);

    const payload = buildSingleAnswerPayload(
      { question: "Deploy?", options: [{ label: "Yes" }, { label: "No" }] } as any,
      0,
    );
    useInboxStore.getState().sendMessage(convId, payload);

    const resolutions = useInboxStore.getState().questionResolutions;
    expect(sessionHasOpenQuestion(row, resolutions)).toBe(false);

    // The answer message itself lands (+1) — still resolved.
    expect(sessionHasOpenQuestion({ ...row, message_count: 7 }, resolutions)).toBe(false);
    // The AGENT speaks after that — the mark expires and server truth rules.
    expect(sessionHasOpenQuestion({ ...row, message_count: 8 }, resolutions)).toBe(true);
  });

  it("free text answers an awaiting_input session; a plain message to a permission-blocked one does not", () => {
    const asking = convexId("conv5");
    const blocked = convexId("conv6");
    useInboxStore.setState({
      sessions: {
        [asking]: session(asking, { awaiting_input: true }),
        [blocked]: session(blocked, { agent_status: "permission_blocked" }),
      },
    } as any);

    useInboxStore.getState().sendMessage(asking, "use the second option but rename it");
    useInboxStore.getState().sendMessage(blocked, "how is it going?");

    const resolutions = useInboxStore.getState().questionResolutions;
    expect(resolutions[asking]).toBeDefined();
    // A chat message does not approve a permission prompt.
    expect(resolutions[blocked]).toBeUndefined();
  });

  it("dismissal (sends: 0) hides the ask but any new agent message resurfaces it", () => {
    const convId = convexId("conv7");
    const row = session(convId, { awaiting_input: true, message_count: 4 });
    useInboxStore.setState({ sessions: { [convId]: row } } as any);

    useInboxStore.getState().resolveSessionQuestion(convId);

    const resolutions = useInboxStore.getState().questionResolutions;
    expect(sessionHasOpenQuestion(row, resolutions)).toBe(false);
    expect(sessionHasOpenQuestion({ ...row, message_count: 5 }, resolutions)).toBe(true);
  });

  it("a session with no resolution mark is untouched", () => {
    const row = session(convexId("conv8"), { awaiting_input: true });
    expect(sessionHasOpenQuestion(row, {})).toBe(true);
    expect(sessionHasOpenQuestion(row, undefined)).toBe(true);
  });
});
