import { describe, expect, it, beforeEach } from "bun:test";
import { useInboxStore } from "./inboxStore";
import { feedCoverMetaKey } from "../lib/feedCatchup";

// The team feed cache only grows: every page the server returns is merged in
// and nothing is dropped, so a removal has to reach it from the sync log.
// Regression for Littlebird (2026-09-23): an admin removed a member, the server
// stopped serving their rows, and the member kept a pill with thirty sessions
// in every remaining member's feed.

const TEAM = "teams_little";
const OTHER = "teams_other";
const GONE = "users_jonathan";
const STAYS = "users_alex";

function row(id: string, userId: string, extra: Record<string, unknown> = {}) {
  return { _id: id, user_id: userId, updated_at: 1, ...extra };
}

beforeEach(() => {
  useInboxStore.setState({
    feedConversations: {
      [`${TEAM}|`]: [row("a", GONE), row("b", STAYS), row("seat", GONE, { acting_user_id: "users_chief" })],
      [`${TEAM}|repo`]: [row("c", GONE)],
      [`${OTHER}|`]: [row("d", GONE)],
    },
    feedHasMore: { [`${TEAM}|`]: true, [`${OTHER}|`]: true },
    feedCursors: { [`${TEAM}|`]: "5", [`${OTHER}|`]: "7" },
    syncMeta: { [feedCoverMetaKey(`${TEAM}|`)]: { cursor: 9 }, [feedCoverMetaKey(`${OTHER}|`)]: { cursor: 9 } },
  } as any);
});

describe("purgeMemberTeamRows", () => {
  it("drops the departed member's rows from every key of that team and no other", () => {
    useInboxStore.getState().purgeMemberTeamRows(TEAM, GONE);
    const s = useInboxStore.getState();
    expect(s.feedConversations[`${TEAM}|`].map((c: any) => c._id)).toEqual(["b"]);
    expect(s.feedConversations[`${TEAM}|repo`]).toEqual([]);
    expect(s.feedConversations[`${OTHER}|`].map((c: any) => c._id)).toEqual(["d"]);
  });

  it("keys on the runner, so a seat row leaves with its host", () => {
    useInboxStore.getState().purgeMemberTeamRows(TEAM, GONE);
    expect(useInboxStore.getState().feedConversations[`${TEAM}|`].some((c: any) => c._id === "seat")).toBe(false);
  });

  it("leaves a key untouched when the member has no rows in it", () => {
    const before = useInboxStore.getState().feedConversations[`${OTHER}|`];
    useInboxStore.getState().purgeMemberTeamRows(OTHER, STAYS);
    expect(useInboxStore.getState().feedConversations[`${OTHER}|`]).toBe(before);
  });
});

describe("dropTeamFeedCache", () => {
  it("forgets the team's rows, paging state and covered watermark, and nothing of another team", () => {
    useInboxStore.getState().dropTeamFeedCache(TEAM);
    const s = useInboxStore.getState();
    expect(Object.keys(s.feedConversations)).toEqual([`${OTHER}|`]);
    expect(Object.keys(s.feedHasMore)).toEqual([`${OTHER}|`]);
    expect(Object.keys(s.feedCursors)).toEqual([`${OTHER}|`]);
    expect(s.syncMeta[feedCoverMetaKey(`${TEAM}|`)]).toBeUndefined();
    expect(s.syncMeta[feedCoverMetaKey(`${OTHER}|`)]).toEqual({ cursor: 9 });
  });

  it("rides the viewer's own revocation of the team scope", () => {
    useInboxStore.getState().purgeTeamScopeRows(TEAM);
    expect(Object.keys(useInboxStore.getState().feedConversations)).toEqual([`${OTHER}|`]);
  });
});
