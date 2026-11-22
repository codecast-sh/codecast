import { describe, expect, test } from "bun:test";
import { pressFromSig, pressSig, runThroughMessage, addToFlowsMessage } from "../flowMessages";

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
    // Asked something before it answered the press: no reply to the press yet.
    expect(read([press(10), later, said("a2", "Renamed the button to Save.", 14)])?.reply).toBeNull();
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
