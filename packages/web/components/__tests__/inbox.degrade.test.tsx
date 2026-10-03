// THE INBOX SURVIVES A BACKEND THAT HAS NONE OF ITS FUNCTIONS.
//
// The inbox page mounted where the app mounts it (the dashboard shell, the
// sidebar, the top bar and every global feeder), over the real store, with a
// convex transport that answers every query "Could not find public function"
// (test-helpers/missingBackend.tsx). That is the live site in the gap between
// a web push and the convex deploy it needed. Every query here only feeds or
// enriches a store the inbox already paints from, so the cached session must
// still be a card and no part of the page may fall into an ErrorBoundary.
// Run: cd packages/web && bun test --isolate components/__tests__/inbox.degrade.test.tsx
import { expect, test } from "bun:test";
import { describeFailures, fixtureId, installDom, installMissingBackend, seedViewer, VIEWER_ID } from "../../test-helpers/missingBackend";

const { mountPage } = installDom("https://app.test/inbox");
const backend = await installMissingBackend();
await seedViewer();

const { useInboxStore } = await import("../../store/inboxStore");
const { default: InboxPage } = await import("../../app/inbox/page");

const SESSION = fixtureId("inboxcached");
const now = Date.now();
useInboxStore.getState().syncTable("sessions", [{
  _id: SESSION,
  session_id: "s-inbox-cached",
  user_id: VIEWER_ID,
  owned_by_me: true,
  title: "Port the importer to bun",
  status: "active",
  started_at: now - 3_600_000,
  updated_at: now - 60_000,
  message_count: 4,
  is_idle: true,
  agent_type: "claude_code",
  project_path: "/src/importer",
}] as any);

test("the inbox paints its cached session with every query missing", async () => {
  const page = await mountPage("/inbox", { inbox: <InboxPage /> });
  try {
    expect(describeFailures(page)).toBe("");
    expect(page.container.querySelector(`[data-session-id="${SESSION}"]`)).not.toBeNull();
    expect(page.text()).toContain("Port the importer to bun");
    // The shell's own enrichment ran and was refused, so the page above was
    // rendered through those failures and not around them.
    for (const fn of [
      "conversations:listInboxSessions",
      "teams:getUserTeams",
      "notifications:list",
      "conversations:listFavorites",
      "tasks:webActiveSessions",
      "docs:webMentionList",
      "conversations:listConversations",
    ]) {
      expect(backend.refused).toContain(fn);
    }
  } finally {
    await page.unmount();
  }
}, 120_000);
