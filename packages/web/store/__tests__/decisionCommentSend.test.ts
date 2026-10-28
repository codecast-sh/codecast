import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { sendDecisionComment } from "../../lib/decisionThread";
import { decisionCommentStubId } from "../decisionThreadTypes";

// A comment the server refuses (decisionThread.commentCore returns { error }:
// too long, no longer readable) must not sit in the thread as sent forever
// (ct-58330, first written for Discuss, which the thread replaced).
const s = () => useInboxStore.getState() as any;
const D = "d".repeat(32);
let reply: unknown = null;
const owner = {};
beforeAll(() => s()._setDispatch(async () => reply, { owner }));
afterAll(() => s()._clearDispatch(owner));
beforeEach(() => useInboxStore.setState({ decisionComments: {}, pending: {} } as any));

describe("sendDecisionComment", () => {
  it("paints the words at once and keeps them while the server takes them", async () => {
    reply = { ok: true };
    const sent = sendDecisionComment(D, "Why a new table?", "cid-1");
    expect(s().decisionComments[decisionCommentStubId("cid-1")]?.content).toBe("Why a new table?");
    expect(await sent).toBeNull();
    expect(s().decisionComments[decisionCommentStubId("cid-1")]).toBeDefined();
  });

  it("a refusal takes the comment back and says why", async () => {
    reply = { error: "sd-9 is no longer readable" };
    const refused = await sendDecisionComment(D, "Anyone there?", "cid-2");
    expect(refused).toBe("sd-9 is no longer readable");
    expect(s().decisionComments[decisionCommentStubId("cid-2")]).toBeUndefined();
  });
});
