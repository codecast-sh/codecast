import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

// A push that carries a room this client tombstoned (a left room, a refused
// read) lifts the tombstone and lands the row (liftExcludesForIncoming). The
// lift rebuilt the collection by spreading the DRAFT, which copied a draft
// proxy for every other row into a frozen object finalize could not clean, so
// every sibling row reached committed state as a proxy revoked at commit:
// "Cannot perform 'get' on a proxy that has been revoked" on the next read.

const serverId = (seed: string) => seed.padEnd(32, "0").slice(0, 32);
const ME = serverId("userme");
const LEFT = serverId("chanleft");
const KEPT = serverId("chankept");
const channel = (id: string, name: string) => ({ _id: id, name, team_id: "t1", created_at: 1, updated_at: 1 });

describe("a push that lifts a tombstone", () => {
  beforeEach(() => {
    useInboxStore.setState({
      chatChannels: {},
      chatReads: {},
      chatRail: [],
      pending: {},
      currentUser: { _id: ME },
    } as any);
  });

  it("leaves every other chat channel a plain, readable row", () => {
    useInboxStore.getState().syncTable("chatChannels", [channel(LEFT, "left"), channel(KEPT, "kept")]);
    useInboxStore.getState().retireChatChannel(LEFT);
    expect(useInboxStore.getState().pending[`chatChannels:${LEFT}`]?.type).toBe("exclude");

    useInboxStore.getState().syncTable("chatChannels", [channel(LEFT, "left again")]);

    const after = useInboxStore.getState();
    expect(after.pending[`chatChannels:${LEFT}`]).toBeUndefined();
    expect(after.chatChannels[LEFT]?.name).toBe("left again");
    expect(after.chatChannels[KEPT]?.name).toBe("kept");
    expect(() => structuredClone(after.chatChannels)).not.toThrow();
  });
});
