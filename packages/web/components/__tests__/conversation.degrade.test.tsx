// A CONVERSATION OPENS FROM THE CACHE WHEN ITS BACKEND IS MISSING.
//
// The conversation route mounted in the dashboard shell over a convex
// transport that answers every query "Could not find public function"
// (test-helpers/missingBackend.tsx), the live site between a web push and
// its convex deploy. On 2026-08-11 that gap took out the whole conversation
// header through one pill's plain useQuery.
//
//   uncached    a session the cache has never seen cannot be opened, and the
//               page says the server did not answer (not that the session was
//               deleted) and offers to try again
//   cached      a session this browser already holds opens into the inbox's
//               conversation view: its header, its title and its messages,
//               with the resolve, the message tail, the watermark, the user
//               message index, comments, bookmarks and the collab grants all
//               refused
// Run: cd packages/web && bun test --isolate components/__tests__/conversation.degrade.test.tsx
import { expect, test } from "bun:test";
import { describeFailures, fixtureId, installDom, installMissingBackend, seedViewer, VIEWER_ID } from "../../test-helpers/missingBackend";

const CACHED = fixtureId("convcached");
const UNKNOWN = fixtureId("convunknown");

const { mountPage } = installDom(`https://app.test/conversation/${CACHED}`);
const backend = await installMissingBackend();
await seedViewer();

const { useInboxStore } = await import("../../store/inboxStore");
const { default: ConversationRoute } = await import("../../app/conversation/[id]/page");
const { default: InboxPage } = await import("../../app/inbox/page");

const now = Date.now();
const store = useInboxStore.getState();
store.syncTable("sessions", [{
  _id: CACHED,
  session_id: "s-conv-cached",
  user_id: VIEWER_ID,
  owned_by_me: true,
  title: "Rename the store slice",
  status: "active",
  started_at: now - 3_600_000,
  updated_at: now - 60_000,
  message_count: 2,
  is_idle: true,
  agent_type: "claude_code",
  project_path: "/src/app",
}] as any);
store.syncRecord("conversations", CACHED, { _id: CACHED, title: "Rename the store slice", user_id: VIEWER_ID, is_own: true, message_count: 2, updated_at: now - 60_000 } as any);
store.setMessages(CACHED, [
  { _id: fixtureId("msgask"), role: "user", content: "Rename the store slice to sessions", timestamp: now - 120_000 },
  { _id: fixtureId("msgdone"), role: "assistant", content: "Renamed it in four files and the tests pass.", timestamp: now - 60_000 },
] as any);

const routes = { "conversation/:id": <ConversationRoute />, inbox: <InboxPage /> };

// The unknown id goes first: opening the cached one moves the inbox onto
// it, and that selection is store state a later mount would inherit.
test("a conversation the cache never held says the server did not answer, and offers a retry", async () => {
  const page = await mountPage(`/conversation/${UNKNOWN}`, routes);
  try {
    expect(describeFailures(page)).toBe("");
    const text = page.text();
    expect(text).toContain("This conversation couldn't be loaded");
    expect(text).not.toContain("It was deleted");
    expect([...page.container.querySelectorAll("button")].some((b) => b.textContent === "Try again")).toBe(true);
  } finally {
    await page.unmount();
  }
}, 120_000);

test("a cached conversation opens with its header and messages while every query is missing", async () => {
  const page = await mountPage(`/conversation/${CACHED}`, routes);
  try {
    expect(describeFailures(page)).toBe("");
    const text = page.text();
    expect(text).toContain("Rename the store slice");
    expect(text).toContain("Renamed it in four files and the tests pass.");
    for (const fn of [
      "conversations:resolveConversation",
      "conversations:listMessagesTail",
      "conversations:getTranscriptWatermark",
      "conversations:getUserMessages",
      "comments:getConversationCommentSummary",
      "collab:collabRequests",
    ]) {
      expect(backend.refused).toContain(fn);
    }
  } finally {
    await page.unmount();
  }
}, 120_000);
