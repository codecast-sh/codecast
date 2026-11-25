import { describe, expect, test } from "bun:test";
import { pressFromSig, pressSig, pressWaiting, runThroughMessage, addToFlowsMessage } from "../flowMessages";
import { formatDecisionAnswer } from "@codecast/shared/contracts";

// A Ship press is a message to the session; whether its run started, is still to come, or will not come is read from
// the session's messages after it (RunThroughFlow's chip and panel).

const press = (at: number) => ({ _id: `p${at}`, role: "user", content: runThroughMessage({ slug: "change", label: "Change" }), timestamp: at });
const said = (id: string, content: string, at: number) => ({ _id: id, role: "assistant", content, timestamp: at });
const read = (msgs: any[], newestRunAt = 0) => pressFromSig(pressSig(msgs, newestRunAt));

describe("a Ship press", () => {
  test("with nothing said since, it is waiting; the session's last words after it are its reply, first paragraph only", () => {
    expect(read([press(10)])).toEqual({ at: 10, id: "p10", reply: null });
    const long = "I didn't run the **Change** flow: it had nothing to take.\n\nThat branch went through the landing flow.";
    expect(read([said("a0", "before", 5), press(10), said("a1", "Checking.", 11), said("a2", long, 12)])).toEqual({
      at: 10, id: "p10", reply: { id: "a2", text: "I didn't run the Change flow: it had nothing to take." },
    });
  });

  test("a run started after it answers it; an Add-to-flows press is not a Ship press", () => {
    expect(read([press(10)], 11)).toBeNull();
    expect(read([{ _id: "x", role: "user", content: addToFlowsMessage("land", "run_1"), timestamp: 10 }])).toBeNull();
  });

  test("its reply is the session's last words before the person's next message, not what it said to that message", () => {
    const later = { _id: "u2", role: "user", content: "Rename the button to Save", timestamp: 13 };
    const result = { _id: "tr", role: "user", content: "", tool_results: [{ tool_use_id: "x" }], timestamp: 12 };
    const msgs = [press(10), said("a1", "I didn't run Change: nothing to take.", 11), result, later, said("a2", "Renamed the button to Save.", 14)];
    expect(read(msgs)?.reply).toEqual({ id: "a1", text: "I didn't run Change: nothing to take." });
  });

  test("a person who speaks after the session answered starts the next exchange, however their words arrived", () => {
    const answered = [press(10), said("a1", "I didn't run Change: nothing to take.", 11)];
    const next = (content: string) => read([...answered, { _id: "u", role: "user", content, timestamp: 12 }, said("a2", "Renamed it.", 13)])?.reply?.id;
    expect(next("Rename the button")).toBe("a1");
    expect(next('<user-message from="Jason Benn">\nRename the button\n</user-message>')).toBe("a1");
    expect(next(formatDecisionAnswer({ id: "sd-1", question: "Keep the name?", answer: "Rename it" }))).toBe("a1");
  });

  const comment = { _id: "c", role: "user", content: '<task-comment task="ct-1" from="Ana">\nAbout ct-1\n</task-comment>', timestamp: 12 };
  const report = { _id: "s", role: "user", content: '<session-message from="jx7005k">\nThe Built change passed.\n</session-message>', timestamp: 13 };
  const toolCall = (id: string, at: number) => ({ _id: id, role: "assistant", content: "", tool_calls: [{ id: `${id}-call` }], timestamp: at });
  const toolResult = (id: string, at: number) => ({ _id: id, role: "user", content: "", tool_results: [{ tool_use_id: `${id}-call` }], timestamp: at });

  test("what lands mid-turn, between a tool call and its result, folds into the turn that answers the press", () => {
    // jx7dhj9, Nov 21: a task comment and another session's report arrived while it checked, then it answered the press.
    const msgs = [press(10), toolCall("t1", 11), toolResult("r1", 11), comment, report, toolCall("t2", 14), toolResult("r2", 14), said("a", "I didn't run the Change flow: it had nothing to take.", 15)];
    expect(read(msgs)?.reply).toEqual({ id: "a", text: "I didn't run the Change flow: it had nothing to take." });
  });

  test("any message after the session's answer ends the turn, whoever sent it", () => {
    const answered = [press(10), said("a1", "Not run: nothing to take.", 11)];
    expect(read([...answered, report, said("a2", "Thanks, noted.", 14)])?.reply?.id).toBe("a1");
    expect(read([...answered, comment, said("a2", "Done.", 14)])?.reply?.id).toBe("a1");
  });

  test("a message sent before the session answered the press is answered in the same turn", () => {
    const later = { _id: "u2", role: "user", content: "Also rename the button", timestamp: 11 };
    expect(read([press(10), later, said("a", "Not run, and renamed it.", 12)])?.reply?.id).toBe("a");
  });

  test("a long stretch of tool work after it does not lose it", () => {
    const tools = Array.from({ length: 150 }, (_, i) => ({ _id: `t${i}`, role: "assistant", content: "", timestamp: 11 + i }));
    expect(read([press(10), ...tools])?.id).toBe("p10");
  });

  test("an answer runs to a glance, cut at a word", () => {
    const text = read([press(1), said("a", "word ".repeat(80), 2)])!.reply!.text;
    expect(text.length).toBeLessThanOrEqual(221);
    expect(text.endsWith("word…")).toBe(true);
  });
});

describe("Ship again waiting on its press", () => {
  const declined = { at: 10, id: "p10", reply: { id: "a1", text: "Not run." } };
  const pending = { at: 20, id: "p20", reply: null };
  const sent = { run: "run_1", press: "p10" };
  test("a press just sent holds it until its message comes back, then until a run answers it", () => {
    expect(pressWaiting({ sent, newestRun: "run_1", press: declined, settled: true })).toBe(true);
    expect(pressWaiting({ sent, newestRun: "run_1", press: pending, settled: true })).toBe(true);
    expect(pressWaiting({ sent, newestRun: "run_2", press: null, settled: false })).toBe(false);
  });
  test("a press the session answered and settled without a run frees it for another try", () => {
    expect(pressWaiting({ sent, newestRun: "run_1", press: { ...pending, reply: { id: "a2", text: "Nothing to take." } }, settled: true })).toBe(false);
    expect(pressWaiting({ sent, newestRun: "run_1", press: { ...pending, reply: { id: "a2", text: "Checking." } }, settled: false })).toBe(true);
  });
  test("with no press of this viewer's, it follows any press the session has open, and nothing holds it otherwise", () => {
    expect(pressWaiting({ sent: null, newestRun: "run_1", press: pending, settled: false })).toBe(true);
    expect(pressWaiting({ sent: null, newestRun: "run_1", press: declined, settled: true })).toBe(false);
    expect(pressWaiting({ sent: null, newestRun: "run_1", press: null, settled: false })).toBe(false);
  });
});
