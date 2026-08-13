import { describe, expect, it } from "bun:test";
import { resolveRecentVisits } from "../recentVisits";
import { chatTabTitle } from "../../components/TabBar";

// A channel is named by its name. pathLabel can only say "Chat", which turns
// three open channels into three identical tabs and fills the recently-visited
// rail with identical rows — while the name sits in the store the whole time.

const CHANNEL = "chan1234567890123456789012345678";

const state = {
  chatChannels: { [CHANNEL]: { _id: CHANNEL, name: "design", created_at: 1, updated_at: 1 } },
  recentVisits: [
    { kind: "page", key: `page:/chat/${CHANNEL}`, path: `/chat/${CHANNEL}`, label: "Chat", ts: 5 },
  ],
};

describe("chat page titles", () => {
  it("names a recently visited channel, not the surface", () => {
    const [visit] = resolveRecentVisits(state, 10);
    expect(visit.title).toBe("#design");
  });

  it("falls back to the stored label for a channel the store has not loaded", () => {
    const [visit] = resolveRecentVisits({ ...state, chatChannels: {} }, 10);
    expect(visit.title).toBe("Chat");
  });

  it("names a channel tab", () => {
    expect(chatTabTitle(`/chat/${CHANNEL}`, state.chatChannels)).toBe("#design");
    expect(chatTabTitle(`/chat/${CHANNEL}?m=abc`, state.chatChannels)).toBe("#design");
    expect(chatTabTitle("/chat", state.chatChannels)).toBeNull();
    expect(chatTabTitle("/inbox", state.chatChannels)).toBeNull();
  });
});
