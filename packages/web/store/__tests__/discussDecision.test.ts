import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { sendDiscussion } from "../../lib/decisionDiscussion";

// A Discuss send the server refuses (decisionDiscussion.discussCore returns
// { error }: too long, no owner any more, no longer readable) must not sit
// under the question as "Sending…" forever (ct-58330).
const s = () => useInboxStore.getState() as any;
const D = "d".repeat(32);
let reply: unknown = null;
const owner = {};
beforeAll(() => s()._setDispatch(async () => reply, { owner }));
afterAll(() => s()._clearDispatch(owner));
beforeEach(() => useInboxStore.setState({ discussionSends: {}, pending: {} } as any));

describe("sendDiscussion", () => {
  it("paints the words at once and keeps them while the server takes them", async () => {
    reply = { ok: true, conversation_id: "c" };
    const sent = sendDiscussion(D, "Why a new table?", "cid-1");
    expect(s().discussionSends[D]?.map((x: any) => x.text)).toEqual(["Why a new table?"]);
    expect(await sent).toBeNull();
    expect(s().discussionSends[D]?.length).toBe(1);
  });

  it("a refusal takes the echo back and says why", async () => {
    reply = { error: "sd-9 has no session to discuss it with" };
    const refused = await sendDiscussion(D, "Anyone there?", "cid-2");
    expect(refused).toBe("sd-9 has no session to discuss it with");
    expect(s().discussionSends[D] ?? []).toEqual([]);
  });
});
