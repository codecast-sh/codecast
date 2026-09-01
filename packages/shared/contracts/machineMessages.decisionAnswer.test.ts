import { describe, expect, it } from "bun:test";
import { formatDecisionAnswer, parseDecisionAnswer, pickAnsweredDecision, isMachineDeliveredMessage } from "./machineMessages";

// The answer to a `cast decide` question is one user message that both the
// agent and every rendering surface read. The first line stays the plain
// "Decision: <answer>" the agent acts on; the tag carries what the bubble
// needs to render the answer against its ask.
describe("decision answer wire format", () => {
  it("round-trips id, question and a chosen option", () => {
    const wire = formatDecisionAnswer({ id: "k97abc", question: "Keep the engine vendored?", answer: "Keep vendored (current)" });
    expect(wire.startsWith("Decision: Keep vendored (current)\n")).toBe(true);
    expect(parseDecisionAnswer(wire)).toEqual({ id: "k97abc", question: "Keep the engine vendored?", answer: "Keep vendored (current)" });
  });

  it("escapes quotes, angle brackets and newlines inside the question", () => {
    const question = 'Rename "foo" to <bar>?\nIt breaks & fixes things';
    const parsed = parseDecisionAnswer(formatDecisionAnswer({ id: "d1", question, answer: "Yes" }));
    expect(parsed?.question).toBe('Rename "foo" to <bar>? It breaks & fixes things');
  });

  it("keeps a multi-line free-text answer intact", () => {
    const answer = "Do both.\nVendor now, package later.";
    expect(parseDecisionAnswer(formatDecisionAnswer({ id: "d1", question: "Q", answer }))?.answer).toBe(answer);
  });

  it("survives the tmux inject collapsing the newline to a space", () => {
    const wire = formatDecisionAnswer({ id: "d1", question: "Q?", answer: "Hold" }).replace(/\n/g, " ");
    expect(parseDecisionAnswer(wire)).toEqual({ id: "d1", question: "Q?", answer: "Hold" });
  });

  it("recognizes the legacy bare answer, id unknown", () => {
    // Before the tag shipped the whole message was "Decision: <label>".
    expect(parseDecisionAnswer("Decision: Hold")).toEqual({ id: "", answer: "Hold" });
    // Single-line only: a typed message that merely opens with the word
    // stays a normal message.
    expect(parseDecisionAnswer("Decision: Hold\nAnd also do X")).toBeNull();
    expect(parseDecisionAnswer("Decision:")).toBeNull();
  });

  it("ignores non-answers and strips harness reminders around the tag", () => {
    expect(parseDecisionAnswer(null)).toBeNull();
    expect(parseDecisionAnswer("Ship it")).toBeNull();
    const wrapped = `<system-reminder>x</system-reminder>${formatDecisionAnswer({ id: "d1", question: "Q", answer: "Hold" })}`;
    expect(parseDecisionAnswer(wrapped)?.id).toBe("d1");
  });

  it("counts as the human's own send, not machine-delivered", () => {
    expect(isMachineDeliveredMessage(formatDecisionAnswer({ id: "d1", question: "Q", answer: "Hold" }))).toBe(false);
  });
});

// Resolving a legacy answer to its decision row: match the recorded answer
// (chosen label or free text), break ties by resolution time nearest the
// message. Shared by sessionDecisions.findByAnswer and the web store scan.
describe("pickAnsweredDecision", () => {
  const row = (id: string, label: string, resolved_at: number) => ({
    _id: id,
    options: [{ label: "Other" }, { label }],
    answer_index: 1,
    created_at: resolved_at - 10,
    resolved_at,
  });

  it("matches the chosen option's label", () => {
    const rows = [row("a", "Hold", 100), row("b", "Ship", 200)];
    expect(pickAnsweredDecision(rows, "Ship")?._id).toBe("b");
    expect(pickAnsweredDecision(rows, "Revert")).toBeNull();
  });

  it("matches a free-text answer when no option was chosen", () => {
    const rows = [{ _id: "t", options: [{ label: "A" }], answer_text: "Do both", created_at: 50, resolved_at: 60 }];
    expect(pickAnsweredDecision(rows, "Do both")?._id).toBe("t");
  });

  it("breaks a label tie by resolution time nearest the message", () => {
    const rows = [row("early", "Hold", 100), row("late", "Hold", 900)];
    expect(pickAnsweredDecision(rows, "Hold", 150)?._id).toBe("early");
    expect(pickAnsweredDecision(rows, "Hold", 850)?._id).toBe("late");
    // No timestamp: the newest match.
    expect(pickAnsweredDecision(rows, "Hold")?._id).toBe("late");
  });
});
