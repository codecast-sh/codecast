// clearDisownedClaims and owner_ids: membership counts owner_ids too, so a
// disowned row that still listed me there stayed "mine" for good (the jx78xak
// bug, back through owner_ids). The claim fields themselves are covered in
// inboxStore.test.ts.
import { describe, expect, it } from "bun:test";
import { claimsViewer, isForeignRow, useInboxStore } from "../inboxStore";

const ME = "kd77bg600000000000000000000000me";
const BOT = "kd7e0g100000000000000000000000bt";
const MATE = "kd74rxrw000000000000000000000mat";
const DISOWNED = "jx78xak0000000000000000000000aaa";

describe("clearDisownedClaims takes the viewer out of owner_ids", () => {
  it("on both twins, so the row is no longer mine", () => {
    useInboxStore.setState({
      currentUser: { _id: ME } as any,
      sessions: { [DISOWNED]: { _id: DISOWNED, session_id: "s-dis", updated_at: 1, user_id: MATE, owned_by_me: true, owner_user_id: MATE, owner_ids: [MATE, ME] } },
      conversations: { [DISOWNED]: { _id: DISOWNED, user_id: MATE, owner_ids: [MATE, ME] } },
    } as any);
    useInboxStore.getState().clearDisownedClaims([DISOWNED]);
    const s = useInboxStore.getState() as any;
    expect(s.sessions[DISOWNED].owner_ids).toEqual([MATE]);
    expect(s.conversations[DISOWNED].owner_ids).toEqual([MATE]);
    expect(isForeignRow(s.sessions[DISOWNED], ME)).toBe(true);
  });

  it("sees a claim that rests on owner_ids alone", () => {
    expect(claimsViewer({ user_id: BOT, owner_ids: [BOT, ME] }, ME)).toBe(true);
  });
});
