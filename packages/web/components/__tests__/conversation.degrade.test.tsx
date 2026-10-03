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
//               deleted or withheld) and keeps a way out
//   cached      a session this browser already holds opens into the inbox's
//               conversation view: its header, its title and its messages,
//               with the resolve, the message tail, the watermark, the user
//               message index, comments and the collab requests all
//               refused
// Run: cd packages/web && bun test --isolate components/__tests__/conversation.degrade.test.tsx
import { expect, test } from "bun:test";
import { describeFailures, fixtureId, installDom, installMissingBackend, seedCachedSession, seedViewer } from "../../test-helpers/missingBackend";

const CACHED = fixtureId("convcached");
const UNKNOWN = fixtureId("convunknown");

const { mountPage } = installDom(`https://app.test/conversation/${CACHED}`);
const backend = await installMissingBackend();
await seedViewer();

const { default: ConversationRoute } = await import("../../app/conversation/[id]/page");
const { default: InboxPage } = await import("../../app/inbox/page");

await seedCachedSession(CACHED, "Rename the store slice", [
  { role: "user", content: "Rename the store slice to sessions" },
  { role: "assistant", content: "Renamed it in four files and the tests pass." },
]);

const routes = { "conversation/:id": <ConversationRoute />, inbox: <InboxPage /> };

// The unknown id goes first: opening the cached one moves the inbox onto
// it, and that selection is store state a later mount would inherit.
test("a conversation the cache never held says the server did not answer, not that it was deleted", async () => {
  const page = await mountPage(`/conversation/${UNKNOWN}`, routes);
  try {
    expect(describeFailures(page)).toBe("");
    const text = page.text();
    expect(text).toContain("This conversation couldn't be loaded");
    expect(text).not.toContain("It was deleted");
    // The note keeps a way out: the inbox's own note goes back to the inbox,
    // the bare route's note asks again.
    const actions = [...page.container.querySelectorAll("button")].map((b) => b.textContent);
    expect(actions.some((a) => a === "Back to inbox" || a === "Try again")).toBe(true);
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
