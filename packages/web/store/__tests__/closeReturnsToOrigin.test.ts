import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _resetUndoStacks } from "@platform/engine";
import { useInboxStore, type InboxSession } from "../inboxStore";
import { _resetTrailForTests, recordTrail } from "../../lib/navTrail";

// ct-102190: a session opened from another surface (a Priorities row) is shown
// through the inbox (/conversation/<id> redirects to /inbox?s=<id>). Closing it
// must land back on the surface it was opened from, not on a bare /inbox.
const OPENED = "a".repeat(32);
const OTHER = "b".repeat(32);
const NOW = Date.now();
const TAB = "tab-1";
const owner = Symbol("close-returns-to-origin");

const row = (id: string, extra: Record<string, unknown> = {}) =>
  ({ _id: id, session_id: `s-${id}`, title: `Row ${id[0]}`, agent_type: "claude_code", message_count: 8, agent_status: "idle", updated_at: NOW - 3_600_000, last_heartbeat: NOW - 1000, ...extra }) as InboxSession;

const initialUser = (useInboxStore.getState() as any).currentUser;

// The tab's walk, as the trail recorder (lib/navTrailRecorder) writes it: each
// place the tab showed, then the tab's path left on the last one with the
// session current.
function walk(paths: string[], current: string, rows: InboxSession[]) {
  for (const p of paths) recordTrail(TAB, p, "push", undefined, [TAB]);
  useInboxStore.setState({
    sessions: Object.fromEntries(rows.map((r) => [r._id, r])),
    conversations: Object.fromEntries(rows.map((r) => [r._id, { ...r }])),
    pending: {},
    clientState: {},
    currentUser: initialUser,
    showMySessions: false,
    tabs: [{ id: TAB, title: "Tab", path: paths[paths.length - 1]!, createdAt: NOW }],
    activeTabId: TAB,
  } as any);
  // The /conversation route's own open (ConversationPageClient).
  useInboxStore.getState().navigateToSession(current);
}

const tabPath = () => useInboxStore.getState().tabs.find((t) => t.id === TAB)?.path;

describe("Close returns to the surface the session was opened from", () => {
  beforeEach(() => {
    try { sessionStorage.clear(); } catch {}
    _resetTrailForTests();
    _resetUndoStacks();
    useInboxStore.getState()._setDispatch(async () => null, { owner });
  });
  afterEach(() => useInboxStore.getState()._clearDispatch(owner));

  test("a Done session opened from a Priorities row closes back to /priorities", () => {
    walk(["/priorities", `/conversation/${OPENED}`, `/inbox?s=${OPENED}`], OPENED, [row(OPENED, { user_rest: "done" })]);
    useInboxStore.getState().closeSession(OPENED);
    expect(useInboxStore.getState().sessions[OPENED]?.inbox_dismissed_at).toBeGreaterThan(0);
    expect(tabPath()).toBe("/priorities");
  });

  test("the exact page is restored, query included", () => {
    walk(["/priorities/pri-60?milestone=s1", `/conversation/${OPENED}`, `/inbox?s=${OPENED}`], OPENED, [row(OPENED, { user_rest: "done" })]);
    useInboxStore.getState().closeSession(OPENED);
    expect(tabPath()).toBe("/priorities/pri-60?milestone=s1");
  });

  // Guard (passes today): a session opened inside the inbox still advances.
  test("a session opened from the inbox advances to the next session as before", () => {
    walk([`/inbox?s=${OTHER}`, `/inbox?s=${OPENED}`], OPENED, [row(OPENED), row(OTHER)]);
    useInboxStore.getState().closeSession(OPENED);
    expect(tabPath()).toBe(`/inbox?s=${OTHER}`);
  });
});
