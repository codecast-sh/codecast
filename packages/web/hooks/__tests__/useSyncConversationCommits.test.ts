// A commit the server unlinked from a conversation must leave that
// conversation's timeline on a client that cached the link, and stay cached
// for every other surface that shows it.
import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../../store/inboxStore";
import { detachUnlinkedCommits } from "../useSyncTimeline";

const CONV = "conv_1";
const row = (id: string, conversation_id?: string) => ({ _id: id, sha: id.repeat(8), message: id, timestamp: 1, repository: "o/r", ...(conversation_id ? { conversation_id } : {}) });

describe("detachUnlinkedCommits", () => {
  beforeEach(() => {
    useInboxStore.setState({ commits: {}, pending: {} } as any);
    useInboxStore.getState().syncTable("commits", [row("own", CONV), row("merged", CONV), row("other", "conv_2")], { isDelta: true });
  });

  it("drops the link from a cached row the answer no longer names, and keeps the row", () => {
    const answer = [row("own", CONV)];
    const rows = detachUnlinkedCommits(answer, useInboxStore.getState().commits, CONV);
    useInboxStore.getState().syncTable("commits", rows, { isDelta: true });
    const commits = useInboxStore.getState().commits as Record<string, any>;
    expect(commits.own.conversation_id).toBe(CONV);
    expect(commits.merged).toBeDefined();
    expect(commits.merged.conversation_id).toBeUndefined();
    expect(commits.other.conversation_id).toBe("conv_2");
  });

  it("hands back the answer untouched when nothing was unlinked", () => {
    const answer = [row("own", CONV), row("merged", CONV)];
    expect(detachUnlinkedCommits(answer, useInboxStore.getState().commits, CONV)).toBe(answer);
  });
});
