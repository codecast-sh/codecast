import { describe, expect, it, beforeEach } from "bun:test";
import {
  useInboxStore,
  isSessionHidden,
  sessionRowFromSummary,
  type ForkChild,
} from "../inboxStore";
import { placeSections } from "./placeTestHarness";

// Regression coverage for ct-42666 — "forks flash in the inbox on reload".
// preloadForkSessions seeds branch rows into the sessions cache so branch-chip
// clicks are instant, and those rows persist to IDB. The seeded row used to
// omit the per-user triage stamps (inbox_stashed_at / inbox_dismissed_at /
// inbox_killed_at / inbox_pinned_at), so a stashed branch seeded as an ACTIVE
// idle row and rendered as a needs-input card on every boot until the live
// inbox payload re-delivered the stamps. A seeded row must never claim more
// liveness than the server row it came from.

const FORK_ID = "jx7fork00000000000000000000000aa"; // 32-char => isConvexId
const PARENT_ID = "jx7parent000000000000000000000aa";

const child = (extra: Partial<ForkChild> = {}): ForkChild => ({
  _id: FORK_ID,
  title: "Fork: Some branch",
  message_count: 7,
  updated_at: Date.now() - 24 * 60 * 60 * 1000,
  started_at: Date.now() - 25 * 60 * 60 * 1000,
  ...extra,
});

const preload = (forks: ForkChild[], from?: string) =>
  (useInboxStore.getState() as any).preloadForkSessions(forks, from);

// The one constructor every cache-seeding surface goes through (fork preload,
// deep-link inject, palette inject, linked-session open). Its soundness rule:
// a key the payload doesn't carry stays ABSENT — the categorizer can't tell
// missing from false, so fabricated "not stashed" nulls would un-hide triaged
// sessions; keys the payload carries are copied even when null.
describe("sessionRowFromSummary", () => {
  it("keeps absent triage keys absent, copies present ones (null included)", () => {
    const bare = sessionRowFromSummary({ _id: FORK_ID, title: "t" });
    expect("inbox_stashed_at" in bare).toBe(false);
    expect("inbox_dismissed_at" in bare).toBe(false);
    expect("is_pinned" in bare).toBe(false);

    const stamped = sessionRowFromSummary({ _id: FORK_ID, inbox_stashed_at: 123, inbox_dismissed_at: null });
    expect(stamped.inbox_stashed_at).toBe(123);
    expect(stamped.inbox_dismissed_at).toBe(null);
    expect("inbox_killed_at" in stamped).toBe(false);
  });

  it("derives is_pinned only when the pin stamp was delivered", () => {
    expect(sessionRowFromSummary({ _id: FORK_ID, inbox_pinned_at: 5 }).is_pinned).toBe(true);
    expect(sessionRowFromSummary({ _id: FORK_ID, inbox_pinned_at: null }).is_pinned).toBe(false);
    expect("is_pinned" in sessionRowFromSummary({ _id: FORK_ID })).toBe(false);
  });

  it("fills identity/liveness defaults and drops unknown keys (whitelist)", () => {
    const row = sessionRowFromSummary({
      _id: FORK_ID,
      started_at: 1000,
      // Unknown extras a fat server object might carry must not leak onto the row.
      username: "alice", fork_copied: 7, share_token: "tok",
    } as any);
    expect(row.session_id).toBe(FORK_ID);
    expect(row.updated_at).toBe(1000); // falls back to started_at
    expect(row.agent_type).toBe("claude_code");
    expect(row.message_count).toBe(0);
    expect(row.is_idle).toBe(true);
    expect(row.has_pending).toBe(false);
    expect("username" in row).toBe(false);
    expect("fork_copied" in row).toBe(false);
    expect("share_token" in row).toBe(false);
  });

  it("passes through parent linkage so a workflow-agent stub nests as a subagent", () => {
    const row = sessionRowFromSummary({ _id: FORK_ID, parent_conversation_id: PARENT_ID, is_idle: false });
    expect(row.parent_conversation_id).toBe(PARENT_ID);
    expect(row.is_idle).toBe(false);
  });
});

describe("preloadForkSessions triage state", () => {
  beforeEach(() => {
    useInboxStore.setState({
      sessions: {},
      conversations: {},
      pending: {},
    } as any);
  });

  it("seeds a stashed fork as hidden, never as an active needs-input card", () => {
    const stashedAt = Date.now() - 60 * 60 * 1000;
    preload([child({ inbox_stashed_at: stashedAt, inbox_dismissed_at: null })], PARENT_ID);
    const row = useInboxStore.getState().sessions[FORK_ID];
    expect(row).toBeTruthy();
    expect(row.inbox_stashed_at).toBe(stashedAt);
    expect(isSessionHidden(row)).toBe(true);

    const cat = placeSections(useInboxStore.getState().sessions, new Set());
    expect(cat.needsInput.map((s) => s._id)).not.toContain(FORK_ID);
    expect(cat.stashed.map((s) => s._id)).toContain(FORK_ID);
  });

  it("seeds a dismissed fork into the dismissed bucket", () => {
    const dismissedAt = Date.now() - 60 * 60 * 1000;
    preload([child({ inbox_dismissed_at: dismissedAt, inbox_stashed_at: null })], PARENT_ID);
    const cat = placeSections(useInboxStore.getState().sessions, new Set());
    expect(cat.needsInput.map((s) => s._id)).not.toContain(FORK_ID);
    expect(cat.dismissed.map((s) => s._id)).toContain(FORK_ID);
  });

  it("derives is_pinned from inbox_pinned_at", () => {
    preload([child({ inbox_pinned_at: 123, inbox_stashed_at: null, inbox_dismissed_at: null })], PARENT_ID);
    expect(useInboxStore.getState().sessions[FORK_ID].is_pinned).toBe(true);
  });

  it("a thin payload (no triage fields) seeds without fabricating nulls", () => {
    preload([child()], PARENT_ID);
    const row = useInboxStore.getState().sessions[FORK_ID];
    expect(row).toBeTruthy();
    // undefined = "never delivered", so a later triage-carrying payload can heal.
    expect(row.inbox_stashed_at).toBeUndefined();
    expect(row.inbox_dismissed_at).toBeUndefined();
  });

  it("heals an existing stampless stub when a triage-carrying payload arrives", () => {
    preload([child()], PARENT_ID); // legacy-shaped stub, no triage fields
    const stashedAt = Date.now() - 60 * 60 * 1000;
    preload([child({ inbox_stashed_at: stashedAt, inbox_dismissed_at: null })], PARENT_ID);
    const row = useInboxStore.getState().sessions[FORK_ID];
    expect(row.inbox_stashed_at).toBe(stashedAt);
    expect(isSessionHidden(row)).toBe(true);
  });

  it("never downgrades an existing row's data or overwrites explicit triage values", () => {
    useInboxStore.setState({
      sessions: {
        [FORK_ID]: {
          _id: FORK_ID,
          session_id: FORK_ID,
          title: "Renamed branch",
          message_count: 95,
          // Explicit null = a real "not stashed" (e.g. a local un-stash tombstone).
          inbox_stashed_at: null,
          updated_at: Date.now(),
          agent_type: "claude_code",
          is_idle: true,
          has_pending: false,
        } as any,
      },
    } as any);
    preload([child({ title: "Fork: old title", message_count: 7, inbox_stashed_at: 999, inbox_dismissed_at: null })], PARENT_ID);
    const row = useInboxStore.getState().sessions[FORK_ID];
    expect(row.title).toBe("Renamed branch");
    expect(row.message_count).toBe(95);
    expect(row.inbox_stashed_at).toBe(null); // explicit local value wins
  });
});
