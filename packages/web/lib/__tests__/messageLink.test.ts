import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../../store/inboxStore";
import { messageLink } from "../conversationFormat";
import { setShareTokenScope } from "../shareTokenScope";

// A copied message link must open for whoever the conversation is shared with:
// a bare /conversation/<id> grants anonymous viewers nothing (issue #27).
describe("messageLink", () => {
  beforeEach(() => {
    useInboxStore.setState({ conversations: {} } as any);
  });

  it("carries the token when the owner has link access on", () => {
    useInboxStore.setState({ conversations: { c1: { _id: "c1", is_own: true, share_token: "tok 1" } } } as any);
    expect(messageLink("c1", "m1")).toEndWith("/conversation/c1?share=tok%201#msg-m1");
  });

  it("stays bare when the conversation has no public link", () => {
    useInboxStore.setState({ conversations: { c2: { _id: "c2", is_own: true } } } as any);
    expect(messageLink("c2", "m1", 1)).toEndWith("/conversation/c2#msg-m1.p2");
  });

  it("does not hand out the token from a teammate's view", () => {
    useInboxStore.setState({ conversations: { c3: { _id: "c3", is_own: false, share_token: "tok" } } } as any);
    expect(messageLink("c3", "m1")).toEndWith("/conversation/c3#msg-m1");
  });

  it("passes on the token a guest arrived with", () => {
    setShareTokenScope("c4", "guest-tok");
    expect(messageLink("c4", "m1")).toEndWith("/conversation/c4?share=guest-tok#msg-m1");
  });
});
