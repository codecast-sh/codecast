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
});
