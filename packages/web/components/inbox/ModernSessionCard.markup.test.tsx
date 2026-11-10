// The session card in the Modern style: SessionCard (the container) chooses
// ModernSessionCardView when the theme says Modern, and the view draws three
// lines whose second says the state in the status vocabulary
// (lib/sessionStatus). The markup is checked by what it must carry (the
// attributes other code selects on, the state's word for the section the
// card sits in, one toolbar row, the chips) rather than frozen whole, since
// the primitives it is built from (components/ui) keep their own looks.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConvexProvider } from "convex/react";
import { MemoryRouter } from "react-router";
import { mockInboxStore } from "../__tests__/mockInboxStore";
import type { InboxSession } from "../../store/inboxStore";
import { offlineConvexClient } from "../../test-helpers/offlineConvex";
import { IdentityPrefsOverride } from "../../hooks/useIdentityPrefs";
import { identityPrefsOf } from "../../lib/sessionIdentity";
import { ThemeContext } from "../ThemeProvider";

process.env.TZ = "UTC";
const NOW = Date.UTC(2026, 8, 30, 18, 0);
Date.now = () => NOW;
const MIN = 60_000;

const UI = { show_model_badge: true, show_agent_icon: true, show_branch_pill: true, personify_sessions: false, show_characters: true, inbox_image_thumbs: false } as Record<string, unknown>;

const readState = mockInboxStore(() => ({
  machineRoster: [
    { device_id: "cloud-linux", is_remote: true, platform: "linux", online: false, last_seen: 1, label: "Cloud Linux" },
    { device_id: "laptop-here", is_remote: false, platform: "darwin", online: true, last_seen: 1, label: "This laptop" },
  ],
  machineRosterLive: true,
  localDevice: { viewer: "me", deviceId: "laptop-here" },
  currentUser: { _id: "me" },
  teamMembers: [
    { _id: "me", name: "Ashot Petrosian", email: "a@x.org" },
    { _id: "u-ann", name: "Ann Lee", email: "ann@x.org", avatar_url: null, presence_state: "active", viewing_conversation_id: "c-viewed" },
  ],
  clientState: { ui: UI },
  drafts: { "c-draft": { draft_message: "try the retry budget again" } },
  pendingMessages: {},
  sessionCommands: {},
  sessionDecisions: { d1: { _id: "d1", conversation_id: "c-decide", status: "pending", blocking: true, in_queue: true } },
  blockedReviveRequestedAt: {},
  conversations: {},
  sessions: { "c-lead": { _id: "c-lead", title: "Webhook retry rewrite" } },
}), {
  useTrackedStore: () => readState(),
});

const { SessionCard } = await import("./SessionCard");

const convex = offlineConvexClient("https://example.convex.cloud");
const MODERN = { theme: "light", toggleTheme: () => {}, visualStyle: "modern", setVisualStyle: () => {} } as const;

// Settled five minutes ago: past the idle grace, inside the status trust TTL.
const base: InboxSession = {
  _id: "c1",
  session_id: "s1",
  agent_type: "claude_code",
  title: "Fix the auth race",
  message_count: 12,
  updated_at: NOW - 5.5 * MIN,
  agent_status_updated_at: NOW - 5.5 * MIN,
  started_at: NOW - 90 * MIN,
  last_heartbeat: NOW - 0.1 * MIN,
  is_idle: true,
  agent_status: "idle",
  has_pending: false,
  is_connected: true,
  project_path: "/Users/me/src/codecast",
  git_root: "/Users/me/src/codecast",
  user_id: "me",
  model: "claude-opus-4-1",
  idle_summary: "Made the retry idempotent behind a lock",
  last_user_message: "make the retry idempotent",
} as InboxSession;

type Props = Record<string, unknown>;
const noop = () => {};

function render(overrides: Partial<InboxSession> & Record<string, unknown>, props: Props = {}) {
  return renderToStaticMarkup(
    <ThemeContext.Provider value={MODERN as never}>
      <MemoryRouter>
        <ConvexProvider client={convex}>
          <IdentityPrefsOverride.Provider value={identityPrefsOf(UI)}>
            <SessionCard
              session={{ ...base, ...overrides } as InboxSession}
              isActive={false}
              globalIndex={0}
              onSelect={noop}
              onDismiss={noop}
              onStash={noop}
              onPin={noop}
              sessionLabel={null}
              isFavorite={false}
              {...props}
            />
          </IdentityPrefsOverride.Provider>
        </ConvexProvider>
      </MemoryRouter>
    </ThemeContext.Provider>,
  );
}

const attr = (html: string, name: string) => html.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;
const word = (html: string) => html.match(/data-status-word="[^"]*"[^>]*>([^<]*)</)?.[1] ?? null;

describe("the Modern session card", () => {
  test("is the Modern view, keeping the attributes other code selects on", () => {
    const html = render({ _id: "c-plain" });
    expect(attr(html, "data-session-id")).toBe("c-plain");
    expect(html).toContain("data-sv-title");
    expect(html).toContain('data-mc="card"');
    expect(html).toContain('role="button"');
    // Not the Classic card's anatomy.
    expect(html).not.toContain("data-sv-meta");
    expect(html).not.toContain("data-sv-body");
    // The title, the time and the line about the work.
    expect(html).toContain("Fix the auth race");
    expect(html).toContain("data-mc-time");
    expect(html).toContain("Made the retry idempotent behind a lock");
    // The prompt the line left out, and the facts the Classic card drew as
    // chips and counts, are in tooltips.
    expect(html).toContain("&gt; make the retry idempotent");
    expect(html).toMatch(/title="Updated [^"]*\n12 messages\nClaude Code · /);
  });

  test("the section the card sits in decides its word", () => {
    expect(word(render({ _id: "c-w", is_idle: false, agent_status: "working" }, { variant: "working" }))).toBe("Working");
    expect(word(render({ _id: "c-n" }, { sectionStatus: "blocked" }))).toBe("Needs you");
    expect(word(render({ _id: "c-d" }, { sectionStatus: "done" }))).toBe("Done");
    expect(word(render({ _id: "c-p" }, { sectionStatus: "dormant" }))).toBe("Dormant");
    expect(word(render({ _id: "c-s" }, { variant: "stashed", onRestore: noop, onKill: noop, onDismiss: undefined, onStash: undefined, onPin: undefined }))).toBe("Stashed");
    expect(word(render({ _id: "c-k" }, { variant: "dismissed", onRestore: noop, onKill: noop, onDismiss: undefined, onStash: undefined, onPin: undefined }))).toBe("Killed");
    expect(word(render({ _id: "c-z", inbox_snoozed_until: NOW + 60 * MIN }, { variant: "snoozed", onRestore: noop }))).toBe("Dormant");
  });

  test("a failure in Needs You says Error and what failed", () => {
    const html = render({ _id: "c-limit", pending_api_error: true, pending_api_error_kind: "limit" }, { sectionStatus: "blocked" });
    expect(word(html)).toBe("Error");
    expect(attr(html, "data-mc-status")).toBe("error");
    expect(html).toContain("Limit");
  });

  test("with no section (Pinned, the flat views) the row's own placement decides", () => {
    expect(word(render({ _id: "c-own-work", is_idle: false, agent_status: "working" }))).toBe("Working");
    expect(word(render({ _id: "c-own-done", settle_verdict: "done" }))).toBe("Done");
    expect(word(render({ _id: "c-own-ask", settle_verdict: "needs_input" }))).toBe("Needs you");
    // A pending `cast decide` (the Decisions section) is an ask.
    expect(word(render({ _id: "c-decide", is_idle: false, agent_status: "working" }))).toBe("Needs you");
    // A blank session coming up.
    expect(word(render({ _id: "c-new", message_count: 0, is_connected: false, started_at: NOW - 5_000, updated_at: NOW - 5_000, idle_summary: undefined, last_user_message: undefined }))).toBe("Starting");
  });

  test("unread is a bar on the left edge and a heavier title; open is the active attribute", () => {
    const unread = render({ _id: "c-unread" }, { isUnread: true });
    expect(unread).toContain("data-mc-unread-bar");
    expect(unread).toContain('data-mc-unread="true"');
    expect(unread).toMatch(/font-semibold text-sol-text/);
    const read = render({ _id: "c-read" });
    expect(read).not.toContain("data-mc-unread-bar");
    const active = render({ _id: "c-open" }, { isActive: true, isUnread: true });
    expect(attr(active, "data-active")).toBe("true");
    // The open card is read: no bar. Its line may run to two lines.
    expect(active).not.toContain("data-mc-unread-bar");
    expect(active).toContain("line-clamp-2");
  });

  test("the toolbar is one row: Pin, Kill, Label, Stash; a set-aside card offers Restore and Kill", () => {
    const html = render({ _id: "c-tools" });
    const tools = html.slice(html.indexOf("data-mc-tools"));
    expect(tools.match(/aria-label="(Pin|Kill Session|Label session|Stash)"/g)).toEqual(['aria-label="Pin"', 'aria-label="Kill Session"', 'aria-label="Label session"', 'aria-label="Stash"']);
    expect(html.match(/data-mc-tools/g)).toHaveLength(1);
    expect(html).toMatch(/data-mc-tools[^>]*class="[^"]*flex items-center/);
    const stashed = render({ _id: "c-aside" }, { variant: "stashed", onRestore: noop, onKill: noop, onDismiss: undefined, onStash: undefined, onPin: undefined });
    expect(stashed.match(/aria-label="(Restore|Kill Session)"/g)).toEqual(['aria-label="Restore"', 'aria-label="Kill Session"']);
  });

  test("the third line: project, branch or PR, task, links, author, comments; none when there is nothing", () => {
    const html = render({
      _id: "c-chips",
      git_branch: "fix/auth-race",
      git_remote_url: "https://github.com/codecast-sh/codecast",
      active_task: { _id: "t1", title: "Dashboard retry UI", short_id: "ct-4102" },
      spawned_by_conversation_id: "c-lead",
      open_comment_threads: 2,
      last_comment_author_id: "u-ann",
      last_comment_author: "Ann Lee",
      user_id: "u-ann",
      author_name: "Ann Lee",
    } as never);
    const chips = [...html.matchAll(/data-mc-chip="([a-z]+)"/g)].map((m) => m[1]);
    expect(chips).toEqual(["project", "branch", "parent", "author", "comments"]);
    expect(html).toContain("data-session-task");
    expect(html).toContain("Webhook retry rewrite");
    expect(html).toContain("fix/auth-race");
    // A row with nothing for the line still renders the empty line, which the
    // stylesheet collapses (:empty).
    const bare = render({ _id: "c-bare", project_path: undefined, git_root: undefined });
    expect(bare).toMatch(/<div data-mc-line3[^>]*><\/div>/);
  });

  test("a nested row (a subagent) reads its own state and keeps to its own facts", () => {
    const html = render({ _id: "c-sub", is_subagent: true, parent_conversation_id: "c-lead", is_idle: false, agent_status: "working" } as never, { variant: "working" });
    expect(html).toContain('data-mc="nested"');
    expect(html).toContain('aria-label="Subagent"');
    expect(word(html)).toBe("Working");
    expect(html).not.toContain('data-mc-chip="project"');
  });

  test("text stays on the type scale", () => {
    const html = render({ _id: "c-scale" }, { isUnread: true, sectionStatus: "blocked" });
    expect(html).not.toMatch(/text-\[(\d|1[01])px\]/);
    expect(html).toContain("text-body");
    expect(html).toContain("text-ui");
    expect(html).toContain("text-meta");
  });
});
