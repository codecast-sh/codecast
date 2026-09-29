import { afterEach, describe, expect, it } from "bun:test";
import { redrivePendingMessagesFor, useInboxStore } from "../inboxStore";

// An Escape paints "[Request interrupted by user]" as a local pending row so
// the line shows at once. It is display only: a redrive of the conversation's
// pending sends must never dispatch it, or the agent receives it as a prompt
// (a Cursor Cloud agent opened on it, 2026-09-29).
const CONV = "jx7fr30ftyeyr7bbab3htsgsxd8fbje9";

describe("redrive of pending sends", () => {
  const original = useInboxStore.getState().sendMessage;
  afterEach(() => useInboxStore.setState({ sendMessage: original }));

  it("resends real messages and skips the interruption line", () => {
    const sent: string[] = [];
    useInboxStore.setState({
      sendMessage: ((_conv: string, content: string) => { sent.push(content); }) as any,
      pendingMessages: {
        [CONV]: [
          { _id: "optimistic_1", role: "user", content: "[Request interrupted by user]", timestamp: 1, _isOptimistic: true },
          { _id: "optimistic_2", role: "user", content: "<turn_aborted>", timestamp: 2, _isOptimistic: true },
          { _id: "optimistic_3", role: "user", content: "name the top-level folders", timestamp: 3, _isOptimistic: true, _clientId: "optimistic_3" },
        ] as any,
      },
    });
    redrivePendingMessagesFor(CONV);
    expect(sent).toEqual(["name the top-level folders"]);
  });
});
