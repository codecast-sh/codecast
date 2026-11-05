import { describe, expect, test } from "bun:test";
import { buildCleanThread } from "./cleanThread";
import type { Message, TimelineItem, UserMessageKind } from "../components/conversation/types";

let n = 0;
const bash = (command: string) => ({ id: `tc${++n}`, name: "Bash", input: JSON.stringify({ command }) });
const row = (m: Partial<Message> & { _id: string; role: Message["role"] }): TimelineItem => ({ type: "message", data: { timestamp: ++n, ...m } as Message } as TimelineItem);

function build(items: TimelineItem[], kinds: Record<string, UserMessageKind["kind"]> = {}) {
  const turnKeyOf = new Map<string, string>();
  const lastTextOf = new Map<string, string>();
  let key: string | null = null;
  for (const it of items) {
    const m = it.data as Message;
    if (m.role === "user") { if ((kinds[m._id] ?? "normal") !== "tool_results_only") key = null; continue; }
    key ??= m._id;
    turnKeyOf.set(m._id, key);
    if (m.content) lastTextOf.set(key, m._id);
  }
  return buildCleanThread({ timeline: items, userKindOf: (id) => kinds[id], turnKeyOf, lastTextOf, resultOf: () => undefined });
}

describe("buildCleanThread", () => {
  test("a turn that said something shows only what it said", () => {
    const rows = build([
      row({ _id: "u1", role: "user", content: "what is your focus?" }),
      row({ _id: "a1", role: "assistant", content: "Let me check the funnel.", tool_calls: [bash("cast brief")] }),
      row({ _id: "a2", role: "assistant", content: "", tool_calls: [bash(`cast say "One funnel: introductions per week."`)] }),
      row({ _id: "a3", role: "assistant", content: "Said it." }),
    ]);
    expect([...rows.keys()]).toEqual(["a2"]);
    expect(rows.get("a2")).toMatchObject({ text: "One funnel: introductions per week.", header: true, tools: [] });
  });

  test("a person's turn that said nothing shows its last reply, so the question never reads unanswered", () => {
    const rows = build([
      row({ _id: "u1", role: "user", content: "status?" }),
      row({ _id: "a1", role: "assistant", content: "Checking.", tool_calls: [bash("cast brief")] }),
      row({ _id: "a2", role: "assistant", content: "Everything is green." }),
    ]);
    expect([...rows.keys()]).toEqual(["a2"]);
    expect(rows.get("a2")!.text).toBe("Everything is green.");
  });

  test("a machine's wake that said nothing draws nothing", () => {
    const rows = build([
      row({ _id: "u1", role: "user", content: "routine fired" }),
      row({ _id: "a1", role: "assistant", content: "Nothing new.", tool_calls: [bash("cast brief")] }),
    ], { u1: "scheduled_task" });
    expect(rows.size).toBe(0);
  });

  test("a decision card stays, and only the first agent row after a person's message carries the name", () => {
    const rows = build([
      row({ _id: "u1", role: "user", content: "pick one" }),
      row({ _id: "a1", role: "assistant", content: "", tool_calls: [bash(`cast say "Two options."`)] }),
      row({ _id: "a2", role: "assistant", content: "", tool_calls: [bash(`cast decide "Which?" -o "A :: a" -o "B :: b"`)] }),
    ]);
    expect(rows.get("a1")!.header).toBe(true);
    expect(rows.get("a2")).toMatchObject({ text: "", header: false });
    expect(rows.get("a2")!.tools).toHaveLength(1);
  });
});
