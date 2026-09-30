// The views split out of the inbox, the rail and the search bar render from
// props alone: no Convex client, no store writes. The homepage hero mounts them
// straight from fixtures, so a view that starts reading a query or writing the
// store fails here before it leaks into the marketing page.

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { useInboxStore, type InboxSession } from "../../store/inboxStore";
import { SessionCardView, type SessionCardViewProps } from "./SessionCardView";
import { SectionHeader } from "./SectionHeader";
import { InboxNavRow, NavCount, NavSection, NeedsInputCount, RailHeading, SectionRow } from "../sidebar/navPrimitives";
import { SearchField } from "../search/SearchField";
import { SearchResultRow } from "../search/SearchResultRow";

const NOW = Date.UTC(2026, 8, 30, 18, 0);
const noop = () => {};

const session = {
  _id: "c-hero-1",
  session_id: "s1",
  agent_type: "codex",
  title: "Webhook API half",
  message_count: 24,
  updated_at: NOW - 2 * 60_000,
  is_idle: false,
  has_pending: false,
  project_path: "/Users/me/src/codecast",
  git_root: "/Users/me/src/codecast",
  user_id: "me",
  thread_state: "Retry budget per delivery\nBlocked: needs the signing secret",
  thread_state_status: "blocked",
  thread_state_at: NOW - 60_000,
  thread_state_msg_count: 24,
} as InboxSession;

const cardProps: SessionCardViewProps = {
  session,
  isActive: false,
  isFavorite: true,
  sessionLabel: "Payments",
  now: NOW,
  chrome: { showModelBadge: false, showAgentIcon: true, showBranchPill: true, personifyAll: false },
  liveness: { isLive: true, pendingSend: false, restarting: false, draft: "" },
  viewerId: "me",
  author: null,
  viewers: [],
  spawnedByTitle: null,
  anchorIdentity: null,
  onSelect: noop,
  onPin: noop,
  onDismiss: noop,
  onStash: noop,
};

const render = (el: React.ReactElement) => renderToStaticMarkup(<MemoryRouter>{el}</MemoryRouter>);

test("the views render from props alone and leave the store untouched", () => {
  const before = useInboxStore.getState();
  const keys = Object.keys(before);

  const card = render(<SessionCardView {...cardProps} />);
  expect(card).toContain('data-session-id="c-hero-1"');
  expect(card).toContain("Webhook API half");
  expect(card).toContain("Needs input");
  expect(card).toContain("Payments");
  expect(card).toContain('title="Working"');

  const sub = render(<SessionCardView {...cardProps} session={{ ...session, is_subagent: true, parent_conversation_id: "p" } as InboxSession} />);
  expect(sub).toContain('aria-label="Subagent"');

  expect(render(<SectionHeader label="Needs input" count={3} color="text-sol-yellow" sectionKey="needs_input" collapsed={false} />))
    .toContain('data-inbox-section-count="3"');

  const rail = render(
    <>
      <RailHeading label="Conversations" isNarrow={false} />
      <InboxNavRow active isNarrow={false} badge={<NeedsInputCount n={4} />} />
      <NavSection label="Tasks" href="/tasks" isActive={false} isNarrow={false} icon={null} badge={<NavCount n={7} tone="bg-sol-cyan text-sol-bg" />}
        expanded items={[{ id: "v1", name: "Ready to ship", onSelect: noop }]} />
      <SectionRow row={{ id: "v2", name: "#eng", active: true, onSelect: noop }} />
    </>,
  );
  expect(rail).toContain(">Inbox<");
  expect(rail).toContain(">4<");
  expect(rail).toContain("Ready to ship");

  const search = render(
    <>
      <SearchField value="webhook retry" expanded onChange={noop} />
      <SearchResultRow
        query="retry"
        selected
        session={{ conversationId: "c-hero-1", title: "Webhook API half", isOwn: true, authorName: "Me", messageCount: 24, updatedAt: NOW, matchCount: 1, matches: [{ messageId: "m1", role: "user", content: "make the retry idempotent", timestamp: NOW }] }}
      />
    </>,
  );
  expect(search).toContain('value="webhook retry"');
  expect(search).toContain("<mark");

  const after = useInboxStore.getState();
  expect(Object.keys(after)).toEqual(keys);
  for (const k of keys) expect((after as any)[k]).toBe((before as any)[k]);
});
