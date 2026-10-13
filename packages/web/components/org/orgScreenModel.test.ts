// The message a proposal's card sits in. Run: bun test components/org/orgScreenModel.test.ts
import { describe, expect, test } from "bun:test";
import { findProposalCardMessage } from "./orgScreenModel";

describe("findProposalCardMessage", () => {
  const messages = [
    { _id: "m0", role: "user", content: "op-57" },
    { _id: "m1", role: "assistant", content: "Here it is, op-57, and then op-57#3 came up." },
    { _id: "m2", role: "assistant", content: "The proposal:\n\n  OP-57  \n\nTell me what you think." },
    { _id: "m3", role: "assistant", content: "op-57" },
    { _id: "m4", role: "assistant", content: "op-57#3\nI changed my mind." },
    { _id: "m5", role: "assistant", content: "op-5" },
  ];
  test("the oldest agent message with the bare line, case-insensitive, N fixed", () => {
    expect(findProposalCardMessage(messages, "op-57")).toBe("m2");
    expect(findProposalCardMessage(messages, "op-5")).toBe("m5");
    expect(findProposalCardMessage(messages, "op-570")).toBeNull();
  });
  test("a sentence, a #seq line and a person's message never match", () => {
    expect(findProposalCardMessage([messages[0], messages[1], messages[4]], "op-57")).toBeNull();
    expect(findProposalCardMessage(undefined, "op-57")).toBeNull();
    expect(findProposalCardMessage([], "op-57")).toBeNull();
  });
});
