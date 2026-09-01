import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  computeInboxSessions,
  computeSessionsLiveness,
  INBOX_LIVENESS_FIELDS,
  INBOX_FAST_FIELDS,
} from "./conversations";
import { INBOX_FACT_FIELDS, INBOX_WINDOW_CAPS, inboxEpoch, selectWorkingSet } from "@codecast/shared/contracts";
import { makeFakeDb } from "./testDb";

// FROZEN CONTRACTS for deployed binaries (sync-convergence C9). Mobile builds
// live for months and read these payloads with the OLD classifiers; every
// guarantee pinned here stays while they exist. Deleting any of them is tied to
// a minimum supported mobile version of 1.3.0 (the first build whose store
// classifies from the shared projection) — not an open-ended watch. A cleanup
// cannot pass CI ahead of that floor.

const ME = "users_me";
const MIN = 60 * 1000;
const H = 60 * MIN;
const NOW = 1_800_000_000_000 + 25_000;
const EPOCH = inboxEpoch(NOW);

function conv(id: string, overrides: Record<string, any> = {}) {
  return {
    _id: `conversations_${id}`,
    user_id: ME,
    status: "active",
    updated_at: EPOCH - 2 * H,
    started_at: EPOCH - 3 * H,
    message_count: 4,
    last_message_role: "assistant",
    title: `Session ${id}`,
    ...overrides,
  };
}

function db(tables: Record<string, any[]> = {}) {
  return makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@example.com" }],
    session_owners: [],
    managed_sessions: [
      { _id: "ms_a", user_id: ME, conversation_id: "conversations_a", last_heartbeat: EPOCH - 1000, agent_status: "working", agent_status_updated_at: EPOCH - MIN, tmux_session: "cc-1", permission_mode: "default" },
    ],
    messages: [],
    session_decisions: [],
    conversations: [conv("a", { updated_at: EPOCH - MIN, has_pending_messages: false })],
    ...tables,
  });
}

let nowSpy: ReturnType<typeof spyOn>;
beforeEach(() => { nowSpy = spyOn(Date, "now").mockReturnValue(NOW); });
afterEach(() => { nowSpy.mockRestore(); });

// The fields the OLD mobile/web classifiers read, per channel that carries
// them today. `has_pending` rides the enriched row channels; the overlay
// carries the fact set instead.
const OLD_CLASSIFIER_ROW_FIELDS = ["agent_status", "is_idle", "awaiting_input", "has_pending", "message_count"] as const;

describe("frozen payload contracts (minimum supported mobile 1.3.0)", () => {
  test("listInboxSessions: include_liveness DEFAULTS TO TRUE — an un-flagged call still carries every classifier field", async () => {
    const { sessions } = await computeInboxSessions({ db: db() }, ME as any, {});
    const row = sessions.find((s: any) => s._id === "conversations_a");
    expect(row).toBeDefined();
    for (const f of OLD_CLASSIFIER_ROW_FIELDS) expect(row[f]).not.toBeUndefined();
    expect(row.agent_status).toBe("working");
    // …and the arg is declared optional on the public query.
    const src = readFileSync(join(import.meta.dir, "conversations.ts"), "utf8");
    expect(src).toContain("include_liveness: v.optional(v.boolean())");
    expect(src).toContain("const includeLiveness = opts.includeLiveness !== false;");
  });

  test("sessionsLiveness: the payload keeps its `liveness` key with the classifier facts on every row", async () => {
    const { liveness } = await computeSessionsLiveness({ db: db() }, ME as any);
    const row = (liveness as any).conversations_a;
    expect(row).toBeDefined();
    for (const f of ["agent_status", "is_idle", "awaiting_input", "message_count", "updated_at", "is_connected"]) {
      expect(row[f]).not.toBeUndefined();
    }
    // The no-auth arm returns the same shape, never a bare {}.
    const src = readFileSync(join(import.meta.dir, "conversations.ts"), "utf8");
    expect(src.match(/return \{ liveness: \{\} \};/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test("the enriched channels (crawl, byIds) keep has_pending and message_count on their rows", async () => {
    const { sessions } = await computeInboxSessions({ db: db() }, ME as any, { includeLiveness: true });
    for (const s of sessions) {
      expect(s.has_pending).not.toBeUndefined();
      expect(s.message_count).not.toBeUndefined();
    }
  });
});

describe("un-flagged listInboxSessions payload — golden shape", () => {
  // The base list is byte compatible for deployed bundles: the fold cut stays
  // a TRANSPORT omission (show_all:false omits below-fold row bodies), and no
  // projection stamp ever rides a row. This pins the exact key set of an
  // un-flagged row so an accidental field move fails CI instead of shipping a
  // torn channel.
  test("row key set is pinned", async () => {
    const { sessions, hidden_count, truncated } = await computeInboxSessions({ db: db() }, ME as any, {});
    expect(hidden_count).toBe(0);
    expect(truncated).toEqual([]);
    const row = sessions.find((s: any) => s._id === "conversations_a");
    expect(Object.keys(row).sort()).toEqual([
      "_id", "acting_user_id", "active_plan", "active_task", "agent_name", "agent_started_at",
      "agent_status", "agent_task_id", "agent_team_name", "agent_type", "anchor_id",
      "armed_trigger_kind", "author_avatar", "author_name", "awaiting_input", "effort",
      "forked_from", "git_branch", "git_root", "has_pending", "icon", "icon_color",
      "idle_summary", "image_preview_url", "implementation_session", "inbox_dismissed_at",
      "inbox_dormant_at", "inbox_killed_at", "inbox_pinned_at", "inbox_stash_hidden", "inbox_stashed_at", "is_anchor",
      "is_connected", "is_deferred", "is_dormant", "is_favorite", "is_idle", "is_pinned",
      "is_private", "is_subagent", "is_unresponsive", "is_workflow_primary", "last_comment_at",
      "last_comment_author", "last_comment_author_id", "last_comment_excerpt", "last_user_message",
      "loop_state", "message_count", "model", "open_comment_threads", "open_tasks", "open_tasks_at",
      "owned_by_me", "owner_device_id", "owner_user_id", "parent_conversation_id",
      "parent_message_uuid", "pending_api_error", "pending_api_error_at", "pending_api_error_kind",
      "permission_mode", "project_path", "session_error", "session_id", "settle_verdict",
      "spawned_by_conversation_id", "started_at", "subtitle", "team_id", "thread_state",
      "thread_state_at", "thread_state_msg_count", "thread_state_status", "title", "tmux_session",
      "transcript_revision", "updated_at", "user_id", "workflow_run_activity",
      "workflow_run_agents_done", "workflow_run_agents_total", "workflow_run_id",
      "workflow_run_name", "workflow_run_started_at", "workflow_run_status", "worktree_branch",
      "worktree_name",
    ]);
  });

  test("show_all:false keeps omitting below-fold rows from transport (membership is unchanged)", async () => {
    const tables = {
      conversations: [
        conv("a", { updated_at: EPOCH - MIN }),
        // The row AT the gap is the cut and never folds itself; the one below
        // it does.
        conv("edge", { updated_at: EPOCH - 20 * H }),
        conv("older", { updated_at: EPOCH - 21 * H }),
      ],
    };
    const dflt = await computeInboxSessions({ db: db(tables) }, ME as any, {});
    expect(dflt.sessions.map((s: any) => s._id)).toContain("conversations_edge");
    expect(dflt.sessions.map((s: any) => s._id)).not.toContain("conversations_older");
    expect(dflt.hidden_count).toBe(1);
  });
});

describe("fact-field signature (sync-convergence C1)", () => {
  test("the server strip list derives exactly from the shared INBOX_FACT_FIELDS", () => {
    expect([...INBOX_LIVENESS_FIELDS, ...INBOX_FAST_FIELDS].sort()).toEqual([...INBOX_FACT_FIELDS].sort());
    // The fast split is pinned: exactly the two per-message churn fields.
    expect([...INBOX_FAST_FIELDS]).toEqual(["message_count", "updated_at"]);
  });

  test("an un-flagged (liveness-on) row and an overlay row cover every fact field between them", async () => {
    const { liveness } = await computeSessionsLiveness({ db: db() }, ME as any);
    const overlayRow = (liveness as any).conversations_a;
    for (const f of INBOX_FACT_FIELDS) expect(overlayRow[f]).not.toBeUndefined();
  });
});

describe("one visibility rule, one selection (sync-convergence C4)", () => {
  test("inboxFilters re-exports the shared shouldShowInInbox — no local implementation survives", () => {
    const src = readFileSync(join(import.meta.dir, "inboxFilters.ts"), "utf8");
    expect(src).not.toContain("export function shouldShowInInbox");
    expect(src).toMatch(/export \{[^}]*shouldShowInInbox[^}]*\} from "@codecast\/shared\/contracts"/);
    const conversations = readFileSync(join(import.meta.dir, "conversations.ts"), "utf8");
    expect(conversations).toContain("INBOX_WINDOW_CAPS.recent");
    const projection = readFileSync(join(import.meta.dir, "inboxProjection.ts"), "utf8");
    expect(projection).toContain("INBOX_WINDOW_CAPS.pinned");
  });

  test("the scan's candidate set equals selectWorkingSet over one fixture set", async () => {
    // One fixture with every window represented plus rows each side must drop.
    const rows = [
      conv("recent1", { updated_at: EPOCH - MIN }),
      conv("recent2", { updated_at: EPOCH - 2 * H }),
      conv("pin_old", { updated_at: EPOCH - 40 * 24 * H, inbox_pinned_at: EPOCH - H }),
      conv("dismissed1", { inbox_dismissed_at: EPOCH - H }),
      conv("stashed1", { inbox_stashed_at: EPOCH - H }),
      conv("too_old", { updated_at: EPOCH - 40 * 24 * H }),
      conv("killed", { inbox_killed_at: EPOCH - H, inbox_dismissed_at: EPOCH - H }),
      conv("sub", { is_subagent: true, updated_at: EPOCH - MIN }),
      conv("noise", { title: "[Using: claude]", updated_at: EPOCH - MIN }),
      conv("blank_done", { status: "completed", message_count: 0, updated_at: EPOCH - MIN }),
    ];
    const { liveness } = await computeSessionsLiveness({ db: db({ conversations: rows }) }, ME as any);
    const stamped = Object.entries(liveness)
      .filter(([, r]) => (r as any).bucket !== undefined)
      .map(([id]) => id)
      .sort();
    const { members, truncated } = selectWorkingSet(rows as any, EPOCH);
    expect(truncated).toEqual([]);
    // conversations_a from the base fixture is not in this table; both sides
    // see exactly the same members.
    expect(stamped).toEqual([...members.keys()].sort());
    expect(stamped).toEqual([
      "conversations_dismissed1", "conversations_pin_old", "conversations_recent1",
      "conversations_recent2", "conversations_stashed1",
    ]);
  });

  test("the window caps re-derive from the shared single source", () => {
    expect(INBOX_WINDOW_CAPS.recent).toBe(200);
    expect(INBOX_WINDOW_CAPS.pinned).toBe(100);
  });
});
