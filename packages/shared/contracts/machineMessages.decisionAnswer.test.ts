import { describe, expect, it } from "bun:test";
import { formatDecisionAnswer, parseDecisionAnswer, isMachineDeliveredMessage } from "./machineMessages";

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

  it("ignores messages without the tag and harness reminders around it", () => {
    expect(parseDecisionAnswer("Decision: Hold")).toBeNull();
    expect(parseDecisionAnswer(null)).toBeNull();
    const wrapped = `<system-reminder>x</system-reminder>${formatDecisionAnswer({ id: "d1", question: "Q", answer: "Hold" })}`;
    expect(parseDecisionAnswer(wrapped)?.id).toBe("d1");
  });

  it("counts as the human's own send, not machine-delivered", () => {
    expect(isMachineDeliveredMessage(formatDecisionAnswer({ id: "d1", question: "Q", answer: "Hold" }))).toBe(false);
  });
});
