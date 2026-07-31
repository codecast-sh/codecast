import { describe, expect, it } from "bun:test";
import { messagePageSyncKey } from "../useConversationMessages";

const message = (content: string) => ({
  _id: "message-1",
  message_uuid: "stream-1",
  role: "assistant",
  content,
  timestamp: 1,
});

describe("messagePageSyncKey", () => {
  it("changes as a same-id streaming message grows and finalizes", () => {
    const partial = messagePageSyncKey("conversation-1", [message("Half a reply")]);
    const grown = messagePageSyncKey("conversation-1", [message("Half a reply, now complete.")]);

    expect(grown).not.toBe(partial);
  });

  it("stays stable for an unchanged page", () => {
    const first = messagePageSyncKey("conversation-1", [message("Complete reply")]);
    const cloned = messagePageSyncKey("conversation-1", [{ ...message("Complete reply") }]);

    expect(cloned).toBe(first);
  });

  it("changes when a revisioned message in the middle of the page changes", () => {
    const rows = [
      { ...message("first"), _id: "message-1", transcript_revision: 1 },
      { ...message("partial"), _id: "message-2", transcript_revision: 2 },
      { ...message("last"), _id: "message-3", transcript_revision: 3 },
    ];
    const before = messagePageSyncKey("conversation-1", rows);
    const after = messagePageSyncKey("conversation-1", [
      rows[0],
      { ...rows[1], content: "complete", transcript_revision: 4 },
      rows[2],
    ]);

    expect(after).not.toBe(before);
  });
});
