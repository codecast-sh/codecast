import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { DEFAULT_CAPS } from "./orgEvents";
import { buildFrame, performFlush, stampWakeId, type FrameInput } from "./orgWakes";
import type { BriefFacts } from "./org";

// What the web wake card reads off a frame (docs/architecture/org-roles-standing.md
// T3): the counts on the opening tag, the "(held)" mark on a backlog group, and
// the wake short id stamped in at delivery.

const ME = "u".repeat(31) + "m";
const TEAM = "teams_acme" as any;
const NOW = 1_800_000_000_000;

const facts: BriefFacts = {
  scope: { projects: [], plans: [], whole_workspace: true },
  tasks: { total: 0, open: 0, by_status: {}, by_priority: {} },
  plans: [],
  hands: [],
  changed: [],
  decisions: { open: 0, answered_today: 0 },
  usage: { day: "2027-01-01", wakes: 0, hands: 0, tokens: 0, caps: { ...DEFAULT_CAPS }, uncounted_sessions: 0 },
  generated_at: NOW,
};

const base = (rows: any[]): FrameInput => ({
  role: { _id: "role1", short_id: "or-1", name: "Infra lead", handle: "infra-lead", trust: "direct", last_frame_seq: NOW - 1 },
  anchor: null, rows, facts, charter: { content: "# Charter" }, brief: null,
  channelLines: [], parentName: "Me", restart: false, now: NOW,
});

describe("orgWakes frame for the wake card", () => {
  test("the opening tag carries the cause and held counts; held groups are marked", () => {
    const f = buildFrame(base([
      { kind: "immediate", cause: "a person wrote: go", created_at: NOW },
      { kind: "fold", cause: "task ct-5 is done", ref: { table: "tasks", id: "t5" }, created_at: NOW - 5, held_at: NOW - 4 },
      { kind: "fold", cause: "task ct-5 is in_review", ref: { table: "tasks", id: "t5" }, created_at: NOW - 3 },
      { kind: "passive", cause: "decision sd-1 answered", ref: { table: "decisions", id: "d1" }, created_at: NOW - 2 },
    ]));
    expect(f.text.startsWith(`<role-wake or-1 at="${new Date(NOW).toISOString()}" causes="3" held="1">`)).toBe(true);
    const why = f.text.split("## Why you are awake\n")[1].split("\n\n")[0].split("\n");
    expect(why).toEqual([
      "- a person wrote: go",
      "- (passive) decision sd-1 answered",
      "- (held) task ct-5 is in_review (changed 2 times)",
    ]);
  });

  test("stampWakeId names the wake on the tag and leaves the rest alone", () => {
    const text = `<role-wake or-1 at="x" causes="1" held="0">\n## You\nme\n</role-wake>`;
    expect(stampWakeId(text, "rw-7")).toBe(`<role-wake or-1 wake="rw-7" at="x" causes="1" held="0">\n## You\nme\n</role-wake>`);
    // A frame that already names a wake is renamed, not stamped twice.
    expect(stampWakeId(stampWakeId(text, "rw-7"), "rw-8")).toBe(`<role-wake or-1 wake="rw-8" at="x" causes="1" held="0">\n## You\nme\n</role-wake>`);
  });

  test("a paused hold marks the rows; the frame after resume carries them as held", async () => {
    const tables: Record<string, any[]> = {
      users: [{ _id: ME, name: "Me" }, { _id: "bot1", name: "Infra lead", is_bot: true, bot_kind: "role" }],
      team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 }],
      teams: [{ _id: TEAM, name: "Acme" }],
      counters: [],
      org_roles: [{
        _id: "role1", short_id: "or-1", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Infra lead", handle: "infra-lead",
        scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "paused", anchor_id: "anchor1",
        created_by: ME, created_at: 1, updated_at: 1,
      }],
      anchors: [{ _id: "anchor1", scope_type: "team", team_id: TEAM, bot_user_id: "bot1", host_user_id: ME, conversation_id: "standing", org_role_id: "role1", status: "active", name: "Infra lead", created_at: 1 }],
      conversations: [
        { _id: "standing", user_id: ME, acting_user_id: "bot1", anchor_id: "anchor1", standing_role_id: "role1", session_id: "s-standing", short_id: "jxstand", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 3, persistent: true, team_id: TEAM },
      ],
      role_wake_outbox: [
        { _id: "row1", role_id: "role1", kind: "immediate", cause: "a person wrote: go", created_at: 1_700_000_000_000, due_at: 1_700_000_000_000 },
      ],
      role_wakes: [], pending_messages: [], managed_sessions: [], session_owners: [], tasks: [], plans: [], projects: [], docs: [], session_decisions: [], chat_messages: [], chat_channels: [], chat_members: [],
    };
    const ctx: any = { db: makeFakeDb(tables), scheduler: { runAfter: async () => {} } };
    expect(await performFlush(ctx, "role1" as any)).toEqual({ outcome: "held", reason: "paused" });
    expect(tables.role_wake_outbox[0].held_at).toBeGreaterThan(0);

    tables.org_roles[0].status = "active";
    tables.role_wake_outbox.push({ _id: "row2", role_id: "role1", kind: "immediate", cause: "a person wrote: now", created_at: 1_700_000_000_100, due_at: 1_700_000_000_100 });
    const out = await performFlush(ctx, "role1" as any);
    expect(out.outcome).toBe("delivered");
    const frame = tables.pending_messages[0].content as string;
    expect(frame).toMatch(/^<role-wake or-1 wake="rw-\d+" at="[^"]+" causes="2" held="1">/);
    expect(frame).toContain("- (held) a person wrote: go");
    expect(frame).toContain("- a person wrote: now");
  });
});
