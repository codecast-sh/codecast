// ct-102115: pressing an agent's face that wears a new-reply count must put
// the reply on screen. On main the press clears the count and opens the
// agent's card, which never draws the messages section (FaceCard gates it on
// `!member.is_bot`). The same setup with a person's face passes, so the miss
// is the agent's.
// Either fix passes: the card shows the counted line, or the press takes the
// reader to where the line lives.
import { describe, expect, test } from "bun:test";
import { FIXTURE_TEAM } from "../../../test-helpers/teamRoster";
import { stampRoster } from "../../../lib/activeTeam";
import { FaceRow, ME, bar, entry, faceChat, mount, openedChat, rowOf, useInboxStore } from "./faceRowHarness";

const AGENT = "u-esc";
const TEAM = "chatchannels:team";
const REPLY = "Escalation #3876 is merged and deployed";

function seedAgentReply() {
  const now = Date.now();
  useInboxStore.setState({
    teamMembers: [
      ...useInboxStore.getState().teamMembers,
      ...stampRoster([{ _id: AGENT, name: "Escalations lead", is_bot: true, bot_kind: "anchor" }], FIXTURE_TEAM),
    ],
    chatChannels: { [TEAM]: { _id: TEAM, kind: "channel", name: "team" } },
    chatMessages: { e1: { _id: "e1", channel_id: TEAM, user_id: AGENT, content: REPLY, created_at: now - 30_000 } },
    chatReads: {},
  } as any);
  const off = faceChat.registerFaceChatLayer({ canShow: () => true } as any);
  // The reply lands while another card is open, so it waits on the agent's
  // face as a count (no bubble), the state the recording shows.
  faceChat.openFacePanel("u-ann", false);
  faceChat.deliverChatToFace(
    AGENT,
    { messageId: "e1", channelId: TEAM, channelName: "team", isDm: false, preview: REPLY, at: now - 30_000, loud: false, count: 1 },
    () => {},
  );
  faceChat.closeFacePanel();
  return off;
}

describe("an agent's face with a new-reply count (ct-102115)", () => {
  test("one press clears the count only by putting the reply on screen", async () => {
    const off = seedAgentReply();
    try {
      openedChat.length = 0;
      const h = await mount(bar(rowOf([entry(AGENT, "Escalations lead", { bot: true })])));
      expect(h.q(".face-unread")?.textContent).toBe("1");
      const replyReached = () => (h.q("[data-member-card]")?.textContent ?? "").includes(REPLY) || openedChat.some((p) => p.includes(TEAM));

      await h.click(h.circle(AGENT));
      expect({ countCleared: h.q(".face-unread") === null, replyReached: replyReached() }).toEqual({ countCleared: true, replyReached: true });
    } finally {
      off();
      faceChat.__resetFaceChat();
    }
  });

  test("off the header, the count badge opens the chat line it counted, not the agent's DM", async () => {
    const off = seedAgentReply();
    try {
      openedChat.length = 0;
      const h = await mount(<FaceRow row={rowOf([entry(AGENT, "Escalations lead", { bot: true })])} density="float" viewerId={ME} />);
      await h.click(h.q(".face-unread")!);
      expect(openedChat).toEqual([`/chat/${TEAM}?m=e1`]);
      expect(h.q(".face-unread")).toBeNull();
    } finally {
      off();
      faceChat.__resetFaceChat();
    }
  });
});
