import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

describe("history jumps are one-shot fetches", () => {
  const src = readFileSync(join(import.meta.dir, "../useConversationMessages.ts"), "utf8");

  it("jumpToStart calls fetchMessagesAround instead of subscribing", () => {
    const at = src.indexOf("const jumpToStart = useCallback");
    expect(at).toBeGreaterThan(-1);
    const fn = src.slice(at, src.indexOf("const jumpToEnd = useCallback", at));
    expect(fn).toContain("fetchMessagesAround");
    expect(fn).not.toContain("useQuery");
  });

  it("the around useQuery is bookmark/deeplink only, not jumpTimestamp", () => {
    const at = src.indexOf("const aroundData = useQuery(");
    expect(at).toBeGreaterThan(-1);
    const args = src.slice(at, src.indexOf(");", at) + 2);
    expect(args).toContain("jumpMode === null");
    expect(args).not.toContain("jumpTimestamp !== null");
  });
});
