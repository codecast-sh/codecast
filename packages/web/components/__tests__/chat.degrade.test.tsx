// A TEAM CHAT CHANNEL PAINTS ITS CACHED LINES WHEN ITS BACKEND IS MISSING.
//
// /chat/<channel> mounted in the dashboard shell over a convex transport that
// answers every query "Could not find public function" (test-helpers/
// missingBackend.tsx), the live site between a web push and its convex
// deploy. The channel paints the chat collections; the channel list, the
// Slack people, the roles, who is typing and the message pages only refresh or annotate
// them, so the cached channel and its line stay on screen and no part of the
// page falls into an ErrorBoundary.
// Run: cd packages/web && bun test --isolate components/__tests__/chat.degrade.test.tsx
import { expect, test } from "bun:test";
import { describeFailures, fixtureId, installDom, installMissingBackend, seedViewer, TEAM_ID, VIEWER_ID } from "../../test-helpers/missingBackend";

const CHANNEL = fixtureId("chatgeneral");

const { mountPage } = installDom(`https://app.test/chat/${CHANNEL}`);
const backend = await installMissingBackend();
await seedViewer();

const { useInboxStore } = await import("../../store/inboxStore");
const { default: ChatPage } = await import("../../app/chat/page");

const now = Date.now();
const store = useInboxStore.getState();
store.syncTable("chatChannels", [{ _id: CHANNEL, team_id: TEAM_ID, workspace: `team:${TEAM_ID}`, name: "release-room", is_default: true, created_at: now - 86_400_000, updated_at: now - 60_000 }] as any);
store.syncTable("chatMessages", [{ _id: fixtureId("chatline"), team_id: TEAM_ID, channel_id: CHANNEL, user_id: VIEWER_ID, content: "Cutting the 1.1.168 release after lunch", created_at: now - 60_000, updated_at: now - 60_000 }] as any);

test("a chat channel paints its cached line with every query missing", async () => {
  const page = await mountPage(`/chat/${CHANNEL}`, { "chat/:channelId": <ChatPage /> });
  try {
    expect(describeFailures(page)).toBe("");
    const text = page.text();
    expect(text).toContain("release-room");
    expect(text).toContain("Cutting the 1.1.168 release after lunch");
    for (const fn of ["chat:listChannels", "chat:listMessages", "chatTyping:list", "slackSync:listSlackPeople", "org:roles"]) {
      expect(backend.refused).toContain(fn);
    }
  } finally {
    await page.unmount();
  }
}, 120_000);
