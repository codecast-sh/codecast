import { describe, expect, test } from "bun:test";
import { discussionThread, waitingWords } from "../decisionDiscussion";
import type { DecisionDiscussionItem } from "../../store/inboxStore";

const row = (turns: Partial<DecisionDiscussionItem["turns"][number]>[]): DecisionDiscussionItem => ({
  _id: "d1",
  decision_short_id: "sd-9",
  owner: { conversation_id: "c_lead", short_id: "jxlead1", name: "Agent Quality lead", via: "lead" },
  turns: turns.map((t, i) => ({ client_id: `c${i}`, text: "q", at: i, user_id: "u", by: "Ashot", conversation_id: "c_lead", delivered: false, reply: null, ...t })),
});

describe("discussionThread", () => {
  test("a local echo paints until the server row carries its client id, then shows once", () => {
    const sends = [{ client_id: "c0", text: "q", at: 0 }, { client_id: "c9", text: "and this?", at: 5 }];
    const thread = discussionThread(row([{ delivered: true }]), sends);
    expect(thread.map((t) => [t.client_id, t.state])).toEqual([["c0", "waiting"], ["c9", "sending"]]);
  });

  test("states follow the server: on its way, being answered, answered", () => {
    const thread = discussionThread(row([{}, { delivered: true }, { delivered: true, reply: { text: "Because.", at: 3 } }]), undefined);
    expect(thread.map((t) => t.state)).toEqual(["delivering", "waiting", "answered"]);
    expect(waitingWords("delivering", "the lead")).toBe("On its way to the lead");
    expect(waitingWords("answered", "the lead")).toBeNull();
  });

  test("no row and no sends is an empty thread", () => {
    expect(discussionThread(undefined, undefined)).toEqual([]);
  });
});
