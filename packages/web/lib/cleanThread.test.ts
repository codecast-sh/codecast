import { describe, expect, test } from "bun:test";
import { buildCleanThread, cleanKeepsSystemRow } from "./cleanThread";
import { formatDeliveryFailedNotice } from "@codecast/shared/contracts/deliveryFailed";
import type { Message, TimelineItem, UserMessageKind } from "../components/conversation/types";

let n = 0;
const bash = (command: string) => ({ id: `tc${++n}`, name: "Bash", input: JSON.stringify({ command }) });
const row = (m: Partial<Message> & { _id: string; role: Message["role"] }): TimelineItem => ({ type: "message", data: { timestamp: ++n, ...m } as Message } as TimelineItem);

function build(items: TimelineItem[], kinds: Record<string, UserMessageKind["kind"]> = {}) {
  return buildCleanThread({ timeline: items, userKindOf: (id) => kinds[id], resultOf: () => undefined }).rows;
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

  test("a trigger that lands after the person's answer starts its own exchange, so their answer still shows", () => {
    const items = [
      row({ _id: "d1", role: "user", content: "Decision: Yes, both" }),
      row({ _id: "a1", role: "assistant", content: "The App Store page is live." }),
      row({ _id: "u1", role: "user", content: "think about natural upsells to the app" }),
      row({ _id: "a2", role: "assistant", content: "The backend already has the setting.", tool_calls: [bash("cast spawn --subagent -- x")] }),
      row({ _id: "a3", role: "assistant", content: "The member web app already had install prompts; three workers are on it." }),
      row({ _id: "t1", role: "user", content: "<scheduled-task title=\"A session under you needs input\"></scheduled-task>" }),
      row({ _id: "a4", role: "assistant", content: "The worker had stopped on a permission prompt; it is running again." }),
    ];
    const rows = build(items, { d1: "decision_answer", t1: "scheduled_task" });
    expect([...rows.keys()]).toEqual(["a1", "a3"]);
  });

  test("while the person's request is being worked on, the newest reply shows, and before any the message is marked as taken", () => {
    const kinds = {} as Record<string, UserMessageKind["kind"]>;
    const asked = [row({ _id: "u1", role: "user", content: "build it" })];
    expect(buildCleanThread({ timeline: asked, userKindOf: (id) => kinds[id], resultOf: () => undefined }).awaitingReplyTo).toBe("u1");
    const working = [...asked, row({ _id: "a1", role: "assistant", content: "", tool_calls: [bash("cast brief")] })];
    expect(buildCleanThread({ timeline: working, userKindOf: (id) => kinds[id], resultOf: () => undefined }).awaitingReplyTo).toBe("u1");
    const acked = [...working, row({ _id: "a2", role: "assistant", content: "On it: briefing two workers.", tool_calls: [bash("cast spawn --subagent -- x")] })];
    const t = buildCleanThread({ timeline: acked, userKindOf: (id) => kinds[id], resultOf: () => undefined });
    expect(t.awaitingReplyTo).toBeNull();
    expect([...t.rows.keys()]).toEqual(["a2"]);
  });

  test("a machine's exchange never waits on a reply, and a colleague's message is a machine's", () => {
    const t = buildCleanThread({ timeline: [row({ _id: "m1", role: "user", content: "<session-message from=\"jx7\">done</session-message>" })], userKindOf: () => "session_message", resultOf: () => undefined });
    expect(t.awaitingReplyTo).toBeNull();
  });
});

describe("cleanKeepsSystemRow", () => {
  test("a trigger's failed delivery and the trigger machinery draw nothing", () => {
    expect(cleanKeepsSystemRow(formatDeliveryFailedNotice({ writes: 3, submitted: false, message: "<scheduled-task title=\"x\"></scheduled-task>" }), "delivery_failed")).toBe(false);
    expect(cleanKeepsSystemRow("fired", "scheduled_task_fire")).toBe(false);
  });
  test("the person's own message that never arrived stays, as does anything else that explains silence", () => {
    expect(cleanKeepsSystemRow(formatDeliveryFailedNotice({ writes: 3, submitted: false, message: "ship it" }), "delivery_failed")).toBe(true);
    expect(cleanKeepsSystemRow("You've hit your limit", undefined)).toBe(true);
  });
});
