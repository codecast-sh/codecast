// ct-96995: a session whose first message has not been delivered yet is named
// by that message, not "Untitled" on its card and its raw id on its tab. The
// message sits in the store's pendingMessages (appendOptimisticMessage puts it
// there at send); the row itself has no title, first_prompt or
// last_user_message until the agent receives it. Three such sessions must be
// told apart by what the person wrote in each.
// Run: cd packages/web && bun test components/inbox/pendingFirstMessageTitle.test.tsx

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConvexProvider } from "convex/react";
import { MemoryRouter } from "react-router";
import { mockInboxStore } from "../__tests__/mockInboxStore";
import type { AppTab, InboxSession } from "../../store/inboxStore";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";
import { IdentityPrefsOverride } from "../../hooks/useIdentityPrefs";
import { identityPrefsOf } from "../../lib/sessionIdentity";
import { tabTitle } from "../../lib/tabTitle";

const NOW = Date.UTC(2026, 10, 22, 18, 0);
const UI = { show_model_badge: true, show_agent_icon: true } as Record<string, unknown>;

// Real Convex-shaped ids (32 chars), the kind that shows as "jx71a8n" on a tab.
const ASKS: Array<[string, string]> = [
  ["jx71a8nrpw4pcma0fvjyn17xx18jfeb5", "Why does the deploy script skip the lockfile check?"],
  ["jx72b9oqsx5qdnb1gwkzo28yy29kgfc6", "Rename the billing tables to match the new schema"],
  ["jx73c0prty6reoc2hxl0p39zz30lhgd7", "Add a retry budget to the webhook sender"],
];

const row = (id: string): InboxSession => ({
  _id: id,
  session_id: `s-${id}`,
  agent_type: "claude_code",
  message_count: 0,
  updated_at: NOW - 7 * 60_000,
  started_at: NOW - 7 * 60_000,
  is_idle: true,
  has_pending: true,
  project_path: "/Users/me/src/codecast",
  git_root: "/Users/me/src/codecast",
  user_id: "me",
} as InboxSession);

const sessions = Object.fromEntries(ASKS.map(([id]) => [id, row(id)]));
const pendingMessages = Object.fromEntries(ASKS.map(([id, text], i) => [id, [{
  _id: `optimistic_${i}`,
  _clientId: `optimistic_${i}`,
  role: "user",
  content: text,
  timestamp: NOW - 7 * 60_000,
  _isOptimistic: true,
}]]));

const readState = mockInboxStore(() => ({
  currentUser: { _id: "me" },
  clientState: { ui: UI },
  drafts: {},
  pendingMessages,
  sessions,
  conversations: {},
  sessionCommands: {},
  blockedReviveRequestedAt: {},
}), { useTrackedStore: () => readState() });

const { SessionCard } = await import("./SessionCard");
const convex = offlineConvexClient("https://example.convex.cloud");
const noop = () => {};

const cardText = (id: string) => renderToStaticMarkup(
  <MemoryRouter>
    <ConvexProvider client={convex}>
      <IdentityPrefsOverride.Provider value={identityPrefsOf(UI)}>
        <SessionCard session={sessions[id]} isActive={false} globalIndex={0} onSelect={noop} onDismiss={noop} onStash={noop} onPin={noop} sessionLabel={null} isFavorite={false} />
      </IdentityPrefsOverride.Provider>
    </ConvexProvider>
  </MemoryRouter>,
).replace(/<[^>]+>/g, " ");

// The exact call TabBar and WindowTitle make: the whole state rides as records.
const tabText = (id: string) => {
  const s = readState() as any;
  const tab = { id: `t-${id}`, path: `/inbox?s=${id}`, sessionId: id, title: "", createdAt: 0 } as AppTab;
  return tabTitle(tab, s.sessions, s.chatChannels ?? {}, [], "me", s.initiatives, null, s);
};

describe("an untitled session with an undelivered first message", () => {
  for (const [id, text] of ASKS) {
    test(`card is named by its pending message (${id.slice(0, 7)})`, () => {
      const html = cardText(id);
      expect(html).not.toContain("Untitled");
      expect(html).toContain(text.slice(0, 30));
    });

    test(`tab is named by its pending message, not its id (${id.slice(0, 7)})`, () => {
      const title = tabText(id);
      expect(title).not.toBe(id.slice(0, 7));
      expect(title).toContain(text.slice(0, 30));
    });
  }

  test("the three tabs read three different names", () => {
    expect(new Set(ASKS.map(([id]) => tabText(id))).size).toBe(3);
  });
});
