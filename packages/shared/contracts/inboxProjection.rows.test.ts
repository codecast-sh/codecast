import { describe, expect, test } from "bun:test";
import {
  FNV1A32_OFFSET,
  INBOX_CREATE_GRACE_MS,
  fnv1a32,
  fnv1a32Update,
  inboxEpoch,
  inboxSortTimeOfRow,
  isBelowFoldAt,
  isFoldExempt,
  isWorkingSetWindow,
  projectInbox,
  type WorkingSetRow,
} from "./inboxProjection";

const EPOCH = inboxEpoch(1_800_000_000_000);
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

function row(id: string, overrides: Record<string, any> = {}): WorkingSetRow & Record<string, any> {
  return {
    _id: id,
    status: "active",
    updated_at: EPOCH - 2 * HOUR,
    message_count: 4,
    title: `Session ${id}`,
    ...overrides,
  };
}

describe("isBelowFoldAt — the per-row fold rule computeFold's loop reads", () => {
  const base: WorkingSetRow = { _id: "x", status: "active", updated_at: 100, message_count: 3 };
  test("no cut, exempt rows and queued work never fold; otherwise under the cut folds", () => {
    expect(isBelowFoldAt(base, 0)).toBe(false);
    expect(isBelowFoldAt(base, 200)).toBe(true);
    expect(isBelowFoldAt({ ...base, updated_at: 200 }, 200)).toBe(true);
    expect(isBelowFoldAt({ ...base, updated_at: 201 }, 200)).toBe(false);
    expect(isBelowFoldAt({ ...base, has_pending_messages: true }, 200)).toBe(false);
    for (const exempt of [{ inbox_pinned_at: 1 }, { inbox_dismissed_at: 1 }, { inbox_stashed_at: 1 }, { owned_by_me: true }]) {
      expect(isFoldExempt({ ...base, ...exempt })).toBe(true);
      expect(isBelowFoldAt({ ...base, ...exempt }, 200)).toBe(false);
    }
  });
});

describe("fnv1a32Update — the incremental form of the digest hash", () => {
  test("folding a string in pieces equals hashing it whole", () => {
    const whole = fnv1a32("abc:working:0");
    expect(fnv1a32Update(fnv1a32Update(FNV1A32_OFFSET, "abc:"), "working:0")).toBe(whole);
  });
  test("isWorkingSetWindow names exactly the five windows", () => {
    for (const w of ["recent", "pinned", "dismissed", "stashed", "owned"] as const) expect(isWorkingSetWindow(w)).toBe(true);
    for (const t of ["members", "member_rows", "foreign_scan"] as const) expect(isWorkingSetWindow(t)).toBe(false);
  });
});

describe("inboxSortTimeOfRow — the replicated fields the sort reads", () => {
  test("the stamps come off the row exactly once, for web, mobile and the server alike", () => {
    const r = row("s", {
      updated_at: EPOCH - 3 * HOUR,
      started_at: EPOCH - 3 * DAY,
      agent_status_updated_at: EPOCH - 2 * HOUR,
      turn_completed_at: EPOCH - HOUR,
    });
    expect(inboxSortTimeOfRow(r, "needs_input", EPOCH).at).toBe(EPOCH - 2 * HOUR);
    expect(inboxSortTimeOfRow(r, "done", EPOCH).at).toBe(EPOCH - HOUR);
    expect(inboxSortTimeOfRow(r, "idle", EPOCH).at).toBe(EPOCH - 3 * HOUR);
  });

  test("a dormant row orders by when it parked, whatever wake it names", () => {
    const base = { updated_at: EPOCH - 2 * HOUR, agent_status_updated_at: EPOCH - HOUR };
    expect(inboxSortTimeOfRow(row("z", { ...base, inbox_snoozed_until: EPOCH + HOUR }), "dormant", EPOCH)).toEqual({ at: EPOCH - HOUR, key: EPOCH - HOUR });
    expect(inboxSortTimeOfRow(row("l", { ...base, loop_state: { status: "armed", wakeup_at: EPOCH + 2 * HOUR, event_at: EPOCH - HOUR } }), "dormant", EPOCH).at).toBe(EPOCH - HOUR);
  });

  test("a brand new row floors its key on started_at", () => {
    const r = row("n", { updated_at: EPOCH - 2 * DAY, started_at: EPOCH - 60_000 });
    expect(inboxSortTimeOfRow(r, "idle", EPOCH).key).toBe(-(EPOCH - 60_000 + INBOX_CREATE_GRACE_MS));
  });
});

// A role is one of a session's owners (org-roles-run-work.md R1): nothing
// rides the role's standing session. Each row files by its own facts, and one
// its role drives files what it waits on as working (With <role>).
describe("a role's sessions file by their own facts", () => {
  const E = inboxEpoch(1_800_000_000_000);
  const base = (id: string, over: Record<string, unknown> = {}) => ({ _id: id, status: "active", updated_at: E - 120_000, message_count: 12, is_idle: true, ...over }) as any;
  const top = (over: Record<string, unknown> = {}) => base("top", { anchor_id: "a_top", standing_role_id: "role_top", agent_status: "dormant", thread_state_status: "dormant", ...over });
  const sub = (over: Record<string, unknown> = {}) => base("sub", { anchor_id: "a_sub", standing_role_id: "role_sub", org_role_id: "role_top", agent_status: "idle", thread_state_status: "blocked", ...over });
  const hand = (over: Record<string, unknown> = {}) => base("hand", { org_role_id: "role_top", agent_status: "idle", ...over });
  const bucket = (p: ReturnType<typeof projectInbox>, id: string) => p.placements.get(id)?.bucket;

  test("the standing session stays hidden on its own facts; nothing under it lifts it", () => {
    const p = projectInbox([top(), sub(), hand()], E);
    expect(bucket(p, "top")).toBe("hidden");
    // A blocked sub-lead and a settled hand wait on the role that drives them.
    expect(bucket(p, "sub")).toBe("working");
    expect(bucket(p, "hand")).toBe("working");
    expect(p.placements.get("hand")?.work_state).toBe("needs_input");
  });

  test("a hand's own verdict stands, and a person driving files it like any session", () => {
    expect(bucket(projectInbox([top(), hand({ agent_status: "done" })], E), "hand")).toBe("done");
    expect(bucket(projectInbox([top(), hand({ driver_user_id: "users_me" })], E), "hand")).toBe("needs_input");
    expect(bucket(projectInbox([top(), sub({ driver_user_id: "users_me" })], E), "sub")).toBe("needs_input");
  });

  test("a top lead reaches the person on its own", () => {
    const alone = projectInbox([top({ thread_state_status: "blocked", agent_status: "idle" })], E);
    expect(bucket(alone, "top")).toBe("needs_input");
  });
});
