// Tables for the Slack integration: the workspaces installed through "Add to
// Slack", people's own Slack tokens, inbound event idempotency, and the
// channel mirroring between Slack and codecast chat (slackSync).

import { defineTable } from "convex/server";
import { v } from "convex/values";

export const slackTables = {
  // A Slack workspace connected via the "Add to Slack" OAuth flow. Holds the
  // per-workspace bot token (replaces the single app-level SLACK_BOT_TOKEN env
  // var) so many workspaces can install the one codecast Slack app. Bound to the
  // codecast scope (team or user) that authorized it, which is how link/post
  // authorize and how inbound events resolve the right token.
  slack_installations: defineTable({
    workspace_id: v.string(), // Slack team.id
    workspace_name: v.optional(v.string()),
    bot_user_id: v.string(), // Slack bot user id (self-loop detection)
    bot_token: v.string(), // xoxb- per-workspace OAuth token
    scopes: v.optional(v.string()),
    app_id: v.optional(v.string()),
    // The codecast scope that owns this install (exactly one set).
    team_id: v.optional(v.id("teams")),
    scope_user_id: v.optional(v.id("users")),
    installed_by_user_id: v.id("users"),
    // The synthetic identity (users.is_bot, bot_kind "slack") that Slack people
    // without a codecast account speak through in mirrored channels. Minted on
    // first need by slackSync.ensureBridgeUser.
    bridge_user_id: v.optional(v.id("users")),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_workspace", ["workspace_id"])
    .index("by_team", ["team_id"])
    .index("by_scope_user", ["scope_user_id"]),

  // A person's own Slack token (xoxp) for a workspace the team installed. Used
  // for exactly one thing: seeing the private channels THEY are in and inviting
  // the bot into one they pick, so a private channel comes over without a
  // manual /invite. Never used to read or post messages.
  slack_user_tokens: defineTable({
    installation_id: v.id("slack_installations"),
    workspace_id: v.string(),
    user_id: v.id("users"), // the codecast person
    slack_user_id: v.string(), // who they are in Slack
    token: v.string(),
    scopes: v.optional(v.string()),
    // The person's direct messages, when they switched them on: every DM of
    // theirs becomes a codecast DM (see slackSync.scanDms). `status` follows
    // the scan that lists and links them; each DM's own import is on its link.
    dm_sync: v.optional(v.object({
      enabled: v.boolean(),
      window: v.string(),
      enabled_at: v.number(),
      status: v.optional(v.union(v.literal("scanning"), v.literal("done"), v.literal("failed"))),
      conversations: v.optional(v.number()),
      error: v.optional(v.string()),
    })),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_installation_user", ["installation_id", "user_id"])
    .index("by_user", ["user_id"]),

  // Idempotency for inbound Slack events: Slack retries on slow/failed acks, and
  // a double-wake would make the anchor answer the same mention twice (Aivery's
  // triple-send bug). We record each event_id and drop repeats.
  slack_events: defineTable({
    event_id: v.string(),
    created_at: v.number(),
  })
    .index("by_event_id", ["event_id"])
    .index("by_created_at", ["created_at"]),

  // ── Slack ↔ chat channel mirroring (slackSync) ─────────────────────────────
  // One row per mirrored pair. A Slack channel mirrors into at most one chat
  // channel and a chat channel into at most one Slack channel; both uniqueness
  // rules are enforced on write, not by index shape. `team_id` ROUTES (which
  // team's chat this belongs to); access to the row follows access to the chat
  // channel, checked through chatAccess.canAccessChannel on every read.
  slack_channel_links: defineTable({
    team_id: v.id("teams"),
    installation_id: v.id("slack_installations"),
    workspace_id: v.string(), // Slack team id, so inbound events resolve strictly inside their workspace
    slack_channel_id: v.string(),
    slack_channel_name: v.optional(v.string()),
    slack_channel_private: v.optional(v.boolean()),
    chat_channel_id: v.id("chat_channels"),
    // A channel mirror, or a person's direct message. A DM is read and written
    // through the OWNER's own token (the connected person whose DM it is); the
    // chat side is the codecast DM between the same people.
    kind: v.optional(v.union(v.literal("channel"), v.literal("dm"))),
    owner_user_id: v.optional(v.id("users")),
    // Which way lines flow. Every other flag narrows inside this.
    direction: v.union(
      v.literal("both"),
      v.literal("slack_to_codecast"),
      v.literal("codecast_to_slack"),
    ),
    // Content controls. Absent means the default named in slackSync.LINK_DEFAULTS.
    options: v.object({
      threads: v.boolean(), // thread replies (else roots only)
      reactions: v.boolean(),
      edits: v.boolean(), // edits and deletes
      files: v.boolean(), // attachments both ways
      bot_messages: v.boolean(), // lines other Slack apps and bots post
      system_messages: v.boolean(), // joins, leaves, topic and pin notices
      agent_lines: v.boolean(), // codecast agent and session lines out to Slack
      match_people_by_email: v.boolean(), // a Slack person with a teammate's email IS that teammate
    }),
    paused: v.optional(v.boolean()),
    // Slack ts floor: events older than this are not mirrored (set at link time,
    // moved back by a backfill).
    since_ts: v.string(),
    // Status, for the settings surface. Counters are best effort.
    last_inbound_at: v.optional(v.number()),
    last_outbound_at: v.optional(v.number()),
    inbound_count: v.optional(v.number()),
    outbound_count: v.optional(v.number()),
    last_error: v.optional(v.string()),
    last_error_at: v.optional(v.number()),
    // The history import, when one was asked for. Runs page by page in
    // scheduled actions; the settings surface reads `fetched` as it grows.
    backfill: v.optional(v.object({
      window: v.string(), // "1d" | "7d" | "30d" | "90d" | "all"
      status: v.union(v.literal("running"), v.literal("done"), v.literal("failed")),
      fetched: v.number(), // lines brought over so far (roots and replies)
      skipped: v.optional(v.number()), // lines that failed to convert; the import went on without them
      started_at: v.number(),
      heartbeat_at: v.optional(v.number()), // last run that reported in; the stall sweep reads this, not updated_at
      finished_at: v.optional(v.number()),
      capped: v.optional(v.boolean()), // stopped at the per import ceiling
      error: v.optional(v.string()),
    })),
    // Who is in the Slack channel (Slack user ids), for the room's member
    // panel. Read whole by slackSync.refreshSlackMembers, kept live by the
    // member_joined/left events, edited by slackSync.setSlackMember. Absent
    // means never read. Capped at SLACK_MEMBERS_CAP.
    slack_member_ids: v.optional(v.array(v.string())),
    slack_members_at: v.optional(v.number()),
    // The last invite or remove Slack refused, undone on the roster and shown
    // in the panel. null (not absent) once a later change clears it.
    member_error: v.optional(v.union(
      v.object({ message: v.string(), slack_user_id: v.string(), at: v.number() }),
      v.null(),
    )),
    created_by: v.id("users"),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_chat_channel", ["chat_channel_id"])
    .index("by_workspace_channel", ["workspace_id", "slack_channel_id"])
    .index("by_team", ["team_id"])
    .index("by_installation", ["installation_id"]),

  // Profile cache for Slack people, one row per (workspace, user). Filled by
  // users.info on first sight and refreshed when stale or on user_change. The
  // mapped codecast user is recomputed on refresh so a teammate who joins
  // codecast later is recognised on their next Slack line.
  slack_users: defineTable({
    workspace_id: v.string(),
    slack_user_id: v.string(),
    name: v.string(), // best display label: display_name || real_name || name
    handle: v.optional(v.string()), // Slack @name
    real_name: v.optional(v.string()),
    avatar_url: v.optional(v.string()),
    email: v.optional(v.string()),
    is_bot: v.optional(v.boolean()),
    deleted: v.optional(v.boolean()),
    codecast_user_id: v.optional(v.id("users")),
    // How codecast_user_id was decided. "email": the addresses matched, and a
    // profile refresh may recompute it. "manual": a teammate chose it (or chose
    // "nobody", with codecast_user_id unset); a refresh leaves it alone.
    mapped_by: v.optional(v.union(v.literal("email"), v.literal("manual"))),
    // A Slack person with no codecast account speaks in a DM through their own
    // shadow identity (users.is_bot, bot_kind "slack", their Slack name and
    // face), so two such people never share a room. Minted on first DM.
    shadow_user_id: v.optional(v.id("users")),
    fetched_at: v.number(),
  })
    .index("by_workspace_user", ["workspace_id", "slack_user_id"])
    .index("by_workspace_handle", ["workspace_id", "handle"])
    .index("by_codecast_user", ["codecast_user_id"]),

  // Inbound Slack events queued for processing. The webhook must ack inside
  // three seconds and the work (profile fetch, file download, several writes)
  // runs in an action, so the route stores the event and schedules it. Rows are
  // the retry ledger and are swept once processed.
  slack_sync_events: defineTable({
    event_id: v.string(),
    link_id: v.id("slack_channel_links"),
    kind: v.string(), // event type + subtype, for the ledger
    payload: v.any(),
    status: v.union(v.literal("queued"), v.literal("done"), v.literal("failed"), v.literal("skipped")),
    attempts: v.number(),
    error: v.optional(v.string()),
    created_at: v.number(),
    processed_at: v.optional(v.number()),
  })
    .index("by_status_created", ["status", "created_at"])
    .index("by_link_created", ["link_id", "created_at"]),
};
