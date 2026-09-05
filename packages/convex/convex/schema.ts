import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { AGENT_STATUSES, DAEMON_COMMANDS } from "@codecast/shared/contracts";
import { openTaskValidator } from "./lib/openTasksValidator";
import { TASK_STATUS_CATEGORIES, TASK_STATUS_COLORS } from "@codecast/shared/tasks";
import { ccAccountsValidator, ccAutoSwitchStateValidator, ccLoginFlowValidator, ccMintFlowValidator } from "./ccAccountsShared";
import { deviceSettingsValidator, modelInventoryValidator } from "./deviceSettingsShared";
import { capabilityTables } from "./capabilitiesSchema";
import { googleOAuthTables } from "./googleOAuthSchema";
import { oauthConnectorTables } from "./oauthConnectorsSchema";
import { issueSyncTables, taskExternalValidator, taskCommentExternalValidator } from "./issueSyncSchema";

// Derived from the single source of truth in @codecast/shared/contracts so the
// schema, validators, the CLI daemon, and the browser store can never drift.
// Each accepts exactly the same set as the old hand-written unions.
const agentStatusFieldValidator = v.union(
  ...AGENT_STATUSES.map((s) => v.literal(s)),
);
const daemonCommandValidator = v.union(
  ...DAEMON_COMMANDS.map((c) => v.literal(c)),
);
const taskStatusCategoryValidator = v.union(
  ...TASK_STATUS_CATEGORIES.map((s) => v.literal(s)),
);
// A team's editable task statuses (Linear-style): named statuses within the
// six fixed categories, in display order. Absent = the shared defaults, one
// per category. See @codecast/shared/tasks/statuses.ts for the contract.
const teamTaskStatusesValidator = v.array(v.object({
  id: v.string(),
  name: v.string(),
  category: taskStatusCategoryValidator,
  color: v.optional(v.union(...TASK_STATUS_COLORS.map((c) => v.literal(c)))),
}));
// Per-team opt-in features (chat, calls). Only flags that were ever set are
// stored; an absent flag reads as OFF (teamFeatureEnabled in shared
// contracts). Every key optional so a new feature needs no migration.
const teamFeaturesValidator = v.object({
  chat: v.optional(v.boolean()),
  calls: v.optional(v.boolean()),
});

// The entity kinds that can participate in entity-conversation links.
const linkableEntityTypeValidator = v.union(
  v.literal("task"),
  v.literal("plan"),
);

export default defineSchema({
  // Capability library tables (fleet mirror + catalog cache). Defined in their
  // own module so the capability functions and their tests share one source;
  // spread here because a deploy only ships what this file names.
  ...capabilityTables,
  ...googleOAuthTables,
  ...oauthConnectorTables,
  ...authTables,
  users: defineTable({
    email: v.optional(v.string()),
    // Extra known addresses for assignee/name resolution only — never auth.
    // Auth identity and cross-provider dedupe key on `email` alone (auth.ts).
    alternate_emails: v.optional(v.array(v.string())),
    emailVerificationTime: v.optional(v.number()),
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    isAnonymous: v.optional(v.boolean()),
    created_at: v.optional(v.number()),
    team_id: v.optional(v.id("teams")),
    role: v.optional(v.union(v.literal("member"), v.literal("admin"))),
    // Agent (non-human) account. Two flavors: a synthetic anchor identity (no
    // login; gives a standing agent member its own name/avatar in author chips
    // while a human host runs and bills the session — see anchors), or a full
    // agent member account like Mr Bot (own login + daemon). Either way no
    // human reads this account's inbox, so bots can never HOLD session
    // ownership: performSessionSend skips auto-own for bot senders and
    // performSetSessionOwner refuses a bot as the owner value (bots may still
    // CALL it to park sessions on humans).
    is_bot: v.optional(v.boolean()),
    bot_kind: v.optional(v.union(v.literal("anchor"))),
    active_team_id: v.optional(v.id("teams")),
    daemon_last_seen: v.optional(v.number()),
    last_message_sent_at: v.optional(v.number()),
    prev_message_sent_at: v.optional(v.number()),
    work_cluster_started_at: v.optional(v.number()),
    theme: v.optional(v.union(v.literal("dark"), v.literal("light"))),
    github_id: v.optional(v.string()),
    github_username: v.optional(v.string()),
    github_avatar_url: v.optional(v.string()),
    github_access_token: v.optional(v.string()),
    push_token: v.optional(v.string()),
    // PushKit VoIP token (hex device token, iOS only). Rings the phone through
    // CallKit even when the app is killed; sent DIRECTLY to APNs (the Expo push
    // service has no VoIP channel). Cleared when APNs reports it unregistered.
    voip_push_token: v.optional(v.string()),
    notifications_enabled: v.optional(v.boolean()),
    // Opt-in: widen push presence from "active in Codecast" to "active anywhere
    // on this Mac". Off, only the web/Electron client reports presence, so
    // working in an editor with no Codecast window reads as away and the phone
    // buzzes. On, the daemon's machine-wide input idle also counts as present
    // (devices.last_input_at), so pushes hold until you leave the computer.
    // Read in pushRouter.readPresence.
    machine_wide_presence: v.optional(v.boolean()),
    // Codecast-owned default model per agent client (client id → shared-contract
    // option key, e.g. { claude: "fable" }). enqueueStartSession applies it when
    // a launch carries no explicit per-session model, so every managed session
    // launches with an explicit model flag and the agent's own saved default —
    // a file any /model one-shot can rewrite — never decides. Set from the
    // model picker's "Set as default"; validated against findModelOption.
    default_models: v.optional(v.record(v.string(), v.string())),
    notification_preferences: v.optional(v.object({
      team_session_start: v.boolean(),
      mention: v.boolean(),
      permission_request: v.boolean(),
      session_idle: v.optional(v.boolean()),
      session_error: v.optional(v.boolean()),
      // Routed by notificationRouter's PREFERENCE_MAP, so it has to be storable
      // here — a preference key the row cannot hold is a mute that silently
      // never applies.
      session_assigned: v.optional(v.boolean()),
      task_activity: v.optional(v.boolean()),
      doc_activity: v.optional(v.boolean()),
      plan_activity: v.optional(v.boolean()),
      artifact_activity: v.optional(v.boolean()),
      // Team chat that is not a direct mention: a thread reply, an @here. A
      // direct @you rides the existing `mention` key. Absent reads as ON, so the
      // key must exist here or the settings toggle has nowhere to persist and the
      // mute silently does nothing.
      chat_activity: v.optional(v.boolean()),
      // Master switch for the "while you were away" email digest
      // (emails/digest.ts). Absent reads as ON; the unsubscribe link and the
      // settings toggle both write false here.
      email_notifications: v.optional(v.boolean()),
    })),
    // Cooldown stamp for the email digest — at most one digest per cooldown
    // window, and items created before this stamp are never re-emailed.
    email_digest_last_sent_at: v.optional(v.number()),
    // Bearer for the one-click unsubscribe link. Minted lazily on first digest.
    email_unsub_token: v.optional(v.string()),
    pr_auto_comment_enabled: v.optional(v.boolean()),
    // Dedupe/cooldown state for the aggregated "sessions blocked" notification
    // (accountSwitch.blockedNotifyCheck). One write per incident, not per park.
    blocked_notify_state: v.optional(v.object({
      last_notified_at: v.number(),
      // Newest pending_api_error park covered by that notification; a park
      // newer than this is a fresh casualty worth announcing again.
      last_park_ts: v.number(),
    })),
    bio: v.optional(v.string()),
    title: v.optional(v.string()),
    status: v.optional(v.union(v.literal("available"), v.literal("busy"), v.literal("away"))),
    // Walkie talkie door. Absent means "team" — the open door, the default the
    // product argues for: a teammate's push-to-talk burst plays live on this
    // person's client. "off" closes it; the burst still LANDS as a chat voice
    // message, it just never plays itself. The door gates live playback only,
    // never delivery, so nobody can be silenced by someone else's setting.
    walkie_pref: v.optional(v.union(v.literal("team"), v.literal("off"))),
    // The shutter, as opposed to the door above. "Leave me alone for an hour":
    // the pref stays on, and until this moment passes no burst plays itself
    // here. It lives on the user rather than in the client prefs bag because
    // snoozing is a statement about the PERSON, not about the browser they
    // happened to press it in — it has to hold on the laptop and the phone at
    // once. Delivery is untouched, exactly like the pref: the burst still
    // lands as a voice message with its unread and its push.
    walkie_snoozed_until: v.optional(v.number()),
    timezone: v.optional(v.string()),
    hide_activity: v.optional(v.boolean()),
    // Public-profile opt-in. A claimed, unique handle (lowercase alnum+dash) that
    // forms the anonymous URL /u/<username>; github_username only pre-fills the
    // suggestion. `public_profile_enabled` is the master switch — until it's true
    // the public page 404s for everyone. See privacy.ts (public visibility tier).
    username: v.optional(v.string()),
    public_profile_enabled: v.optional(v.boolean()),
    share_session_metadata: v.optional(v.boolean()),
    activity_visibility: v.optional(v.union(
      v.literal("detailed"),
      v.literal("summary"),
      v.literal("minimal"),
      v.literal("hidden")
    )),
    encryption_enabled: v.optional(v.boolean()),
    encryption_master_key: v.optional(v.string()),
    sync_mode: v.optional(v.union(v.literal("all"), v.literal("selected"))),
    sync_projects: v.optional(v.array(v.string())),
    team_share_paths: v.optional(v.array(v.string())),
    muted_members: v.optional(v.array(v.id("users"))),
    team_conversations_last_seen: v.optional(v.number()),
    cli_version: v.optional(v.string()),
    cli_platform: v.optional(v.string()),
    autostart_enabled: v.optional(v.boolean()),
    has_tmux: v.optional(v.boolean()),
    daemon_pid: v.optional(v.number()),
    // Which device's daemon currently owns the per-machine fields above
    // (cli_version, cli_platform, daemon_pid, autostart_enabled, has_tmux,
    // local_project_roots). With two machines online, each daemon used to
    // overwrite the other's values on every beat, and every reader of the user
    // doc re-rendered on each flip. The owner keeps them until it goes offline.
    daemon_fields_device_id: v.optional(v.string()),
    last_heartbeat: v.optional(v.number()),
    // Sync backlog reported on each heartbeat. Lets the web show a "sync
    // stalled" warning while the daemon is alive but data isn't flowing.
    // count = logical ops (per-conversation), messages/conversations = honest
    // backlog depth, oldest_pending_ms = how far behind the oldest queued item.
    daemon_pending_sync_count: v.optional(v.number()),
    daemon_oldest_pending_ms: v.optional(v.number()),
    daemon_pending_sync_messages: v.optional(v.number()),
    daemon_pending_sync_conversations: v.optional(v.number()),
    // Daemon boot time and ms its event loop was blocked in the last minute —
    // last-writer across machines, like daemon_last_seen. The web reads the
    // per-device twins on `devices` first and falls back to these only when a
    // daemon predates device rows.
    daemon_started_at: v.optional(v.number()),
    daemon_loop_freeze_ms: v.optional(v.number()),
    // Capability convergence: monotonic revision (bumped by any binding write)
    // and the reconciler mode kill switch ("off" | "dry" | "on").
    capability_revision: v.optional(v.number()),
    capabilities_mode: v.optional(v.string()),
    agent_permission_modes: v.optional(v.object({
      claude: v.optional(v.union(v.literal("default"), v.literal("bypass"))),
      codex: v.optional(v.union(v.literal("default"), v.literal("full_auto"), v.literal("bypass"))),
      gemini: v.optional(v.union(v.literal("default"), v.literal("bypass"))),
    })),
    agent_default_params: v.optional(v.object({
      claude: v.optional(v.record(v.string(), v.string())),
      codex: v.optional(v.record(v.string(), v.string())),
      gemini: v.optional(v.record(v.string(), v.string())),
      cursor: v.optional(v.record(v.string(), v.string())),
    })),
    available_agents: v.optional(v.array(v.object({
      name: v.string(),
      description: v.optional(v.string()),
    }))),
    available_skills: v.optional(v.string()),
    // Paths the running daemon can see on this user's machine. Published on
    // every heartbeat. Used by the project switcher to hide "ghost" folders
    // that exist on another device the user owns but not on this one.
    local_project_roots: v.optional(v.array(v.string())),
    local_project_roots_updated_at: v.optional(v.number()),
  })
    .index("email", ["email"])
    .index("by_email_unsub_token", ["email_unsub_token"])
    .index("by_github_username", ["github_username"])
    .index("by_github_id", ["github_id"])
    .index("by_username", ["username"])
    .index("by_team_id", ["team_id"])
    .index("by_last_heartbeat", ["last_heartbeat"]),

  // Per-user skills blob, split out of the users doc. The users doc is patched
  // on every heartbeat, and Convex versions the WHOLE doc per patch — carrying
  // a 30-100KB skills map on it cost ~20GB of version churn per retention
  // window. Skills live here (written only when they actually change);
  // getCurrentUser overlays them back so clients still read
  // currentUser.available_skills. users.available_skills is legacy: shed on the
  // next setAvailableSkills write per user, kept in schema for dormant users.
  user_skills: defineTable({
    user_id: v.id("users"),
    skills_json: v.string(),
    updated_at: v.number(),
  }).index("by_user", ["user_id"]),

  daemon_commands: defineTable({
    user_id: v.id("users"),
    command: daemonCommandValidator,
    args: v.optional(v.string()),
    created_at: v.number(),
    executed_at: v.optional(v.number()),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    // Device this command is routed to. When set, only the daemon whose
    // deviceId() matches executes it — the poll filters the rest out, so
    // session commands (start/resume) go to the one machine that owns the
    // checkout instead of being raced by every daemon. Undefined = broadcast
    // (device-agnostic commands like status/restart, or sessions whose owner
    // can't be resolved yet).
    target_device_id: v.optional(v.string()),
    // Exclusive lease, held by one daemon PROCESS on one DEVICE. Two daemons
    // can share a device (a launchd instance and a self spawned one, or both
    // sides of an upgrade) and both poll this queue, so without a claim both
    // execute every command. The first writer wins and holds for CLAIM_GRACE_MS
    // (lib/daemonCommandClaim.ts); a claimer that died holding one releases it
    // when the lease lapses.
    //
    // claimed_device is what keeps a broadcast a broadcast: an untargeted row
    // (kill_session, an admin restart) is meant for every machine, so a hold
    // from another device is not a hold at all.
    claimed_by: v.optional(v.string()),
    claimed_at: v.optional(v.number()),
    claimed_device: v.optional(v.string()),
  }).index("by_user_pending", ["user_id", "executed_at"]),

  teams: defineTable({
    name: v.string(),
    icon: v.optional(v.string()),
    icon_color: v.optional(v.string()),
    task_statuses: v.optional(teamTaskStatusesValidator),
    // Opt-in features; default off. Enforced server-side at each feature's
    // access chokepoint (teamFeatures.requireTeamFeature), hidden client-side.
    features: v.optional(teamFeaturesValidator),
    created_at: v.number(),
    invite_code: v.string(),
    invite_code_expires_at: v.optional(v.number()),
    // Idempotency key from the client's optimistic stub. A retried create
    // (replayed dispatch, timeout after commit) finds the team it already
    // made instead of minting a duplicate.
    client_key: v.optional(v.string()),
  })
    .index("by_invite_code", ["invite_code"])
    .index("by_client_key", ["client_key"]),

  team_memberships: defineTable({
    user_id: v.id("users"),
    team_id: v.id("teams"),
    role: v.union(v.literal("member"), v.literal("admin")),
    joined_at: v.number(),
    visibility: v.optional(v.union(
      v.literal("hidden"),
      v.literal("activity"),
      v.literal("summary"),
      v.literal("full")
    )),
  })
    .index("by_user_id", ["user_id"])
    .index("by_team_id", ["team_id"])
    .index("by_user_team", ["user_id", "team_id"]),

  directory_team_mappings: defineTable({
    user_id: v.id("users"),
    path_prefix: v.string(),
    team_id: v.id("teams"),
    auto_share: v.boolean(),
    created_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_team", ["user_id", "team_id"])
    .index("by_team_id", ["team_id"]),

  // The SET of team members who OWN a session — the humans whose inboxes it
  // appears in and who receive its notifications. A session has zero or more
  // owners, each an independent, separately-removable assignment. This is one of
  // a session's three independent ownership axes and is deliberately distinct
  // from the other two: conversations.user_id (the account that RUNS + bills it)
  // and conversations.owner_device_id (the machine it runs ON). Reassigning
  // owners never moves the device, and vice versa.
  //
  // This table is the canonical owner store. conversations.owner_user_id is a
  // denormalized cache of the PRIMARY (first-added, still-present) owner, kept in
  // lockstep by the owner mutations for back-compat while readers migrate off it.
  // Seeded from owner_user_id by sessionOwnership.backfillSessionOwners.
  session_owners: defineTable({
    conversation_id: v.id("conversations"),
    user_id: v.id("users"), // the human owner (bots may never be owners)
    added_by: v.id("users"), // who assigned them — provenance + "X assigned you" notif
    added_at: v.number(),
    note: v.optional(v.string()), // assigner's optional handoff message
    seen_at: v.optional(v.number()), // when the assignee acknowledged the handoff
  })
    // Powers the owner's inbox merge: newest-first owner rows for a user, then
    // hydrate the conversations and filter by the activity window in JS.
    // Deliberately NOT keyed on the conversation's updated_at — denormalizing
    // that here would make every conversation heartbeat fan out and patch all of
    // its owner rows (write amplification). The owned set per user is small.
    .index("by_user", ["user_id", "added_at"])
    // List the owners of one session (owner chips, notification fan-out).
    .index("by_conversation", ["conversation_id"])
    // Membership check / dedupe — is this user already an owner of this session?
    .index("by_conversation_user", ["conversation_id", "user_id"]),

  conversations: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    agent_type: v.union(
      v.literal("claude_code"),
      v.literal("codex"),
      v.literal("cursor"),
      v.literal("gemini"),
      v.literal("cowork"),
      // Widened ahead of their clients (plan phases 1-2) so rows can store them
      // before descriptors exist; see shared ConvexAgentType.
      v.literal("opencode"),
      v.literal("pi"),
      v.literal("grok")
    ),
    session_id: v.string(),
    slug: v.optional(v.string()),
    title: v.optional(v.string()),
    subtitle: v.optional(v.string()),
    title_embedding: v.optional(v.array(v.float64())),
    project_hash: v.optional(v.string()),
    project_path: v.optional(v.string()),
    model: v.optional(v.string()),
    // Last-known effort level (low|medium|high|max), same lifecycle as `model`:
    // stamped optimistically by the web picker / at create, confirmed by the
    // rollup parsing "Set effort level to X" / "with X effort" switch echoes.
    effort: v.optional(v.string()),
    // Saved Claude account profile this session launches on (its setup-token
    // is sourced into the launch env, see cli/ccAccounts.ts). Stamped at
    // create; the daemon re-reads it on every resume so a restart never
    // silently falls back to the machine's keychain login.
    cc_account: v.optional(v.string()),
    started_at: v.number(),
    updated_at: v.number(),
    message_count: v.number(),
    // Monotonic server watermark for material transcript changes. Unlike
    // message_count it advances for inserts AND same-UUID patches, so clients
    // can recover a streaming message that finalized while their subscription
    // was stalled.
    transcript_revision: v.optional(v.number()),
    is_private: v.boolean(),
    team_visibility: v.optional(v.union(v.literal("summary"), v.literal("full"), v.literal("private"))),
    status: v.union(v.literal("active"), v.literal("completed")),
    share_token: v.optional(v.string()),
    parent_message_uuid: v.optional(v.string()),
    parent_conversation_id: v.optional(v.id("conversations")),
    git_commit_hash: v.optional(v.string()),
    git_branch: v.optional(v.string()),
    git_remote_url: v.optional(v.string()),
    // LEGACY: now written to conversation_git_diffs.git_status (off the hot
    // doc). Still declared so pre-diet rows validate; unread everywhere.
    git_status: v.optional(v.string()),
    git_root: v.optional(v.string()),
    fork_count: v.optional(v.number()),
    forked_from: v.optional(v.id("conversations")),
    // Fork-copy progress (set on the fork target, not the source). The fork
    // mutation chain reads/writes these to copy >8192-message conversations
    // across multiple transactions without hitting Convex's per-mutation write
    // limit. Absence means "not a fork in progress".
    //   - fork_status: "copying" while batches are being copied; "complete"
    //     once finalized; "failed" if a watchdog marks it.
    //   - fork_copy_total: messages we expect to copy.
    //   - fork_copied: messages copied so far (kept in sync with message_count).
    //   - fork_copy_cursor: timestamp of the last message copied; the next
    //     batch reads messages where timestamp > this cursor.
    //   - fork_cutoff_timestamp: upper bound for partial forks (forked at a
    //     specific message). Absent = full copy.
    //   - fork_daemon_args: JSON args for the daemon_commands row to insert
    //     once copy completes; kept here so the daemon can't race a half-copied
    //     fork.
    fork_status: v.optional(v.union(v.literal("copying"), v.literal("complete"), v.literal("failed"))),
    fork_copy_total: v.optional(v.number()),
    fork_copied: v.optional(v.number()),
    fork_copy_cursor: v.optional(v.number()),
    fork_cutoff_timestamp: v.optional(v.number()),
    fork_daemon_args: v.optional(v.string()),
    // Comment-thread agent reply: this conversation is a hidden fork spawned to
    // answer in a teammate comment thread. It points back at the parent
    // conversation, the anchored message (if any), and the placeholder comment to
    // mirror the reply into; comment_fork_prompt_at separates the agent's new
    // reply from the copied parent history (any assistant message newer than it
    // is the reply). Hidden from the feed via is_subagent.
    comment_fork_parent: v.optional(v.id("conversations")),
    comment_fork_message_id: v.optional(v.string()),
    comment_fork_comment_id: v.optional(v.id("comments")),
    comment_fork_prompt_at: v.optional(v.number()),
    // Denormalized comment signal for the inbox card, recomputed by
    // comments.refreshCommentSignal on every comment create/resolve/delete.
    // Count of OPEN threads plus who spoke last in them and what they said —
    // enough for the session row to show "Alice: typo in step 2" with no extra
    // query on the list render path. author_id is a users id string, or
    // "agent" for agent replies, so the client can mute the chip when the
    // viewer themselves commented last.
    unresolved_comment_count: v.optional(v.number()),
    last_comment_at: v.optional(v.number()),
    last_comment_author: v.optional(v.string()),
    last_comment_author_id: v.optional(v.string()),
    last_comment_excerpt: v.optional(v.string()),
    // Visible-child pointer: the session that spawned this one (agent-team
    // teammate → its lead, `cast spawn` → its caller). Unlike
    // parent_conversation_id — whose mere presence marks a row as a subagent
    // and nests/hides it from the inbox — this field only labels and links:
    // the child stays a first-class inbox card with a click-through to its
    // parent. Set by conversations.linkSpawnedBy (daemon-resolved).
    spawned_by_conversation_id: v.optional(v.id("conversations")),
    // Agent-team identity, from the teamName/agentName stamps Claude Code
    // writes on every teammate JSONL line (the lead's transcript is never
    // stamped; linkSpawnedBy stamps the lead as "team-lead" when it links a
    // worker). Lets the client resolve a teammate name in a transcript to the
    // sibling session that carries it.
    agent_team_name: v.optional(v.string()),
    agent_name: v.optional(v.string()),
    is_favorite: v.optional(v.boolean()),
    short_id: v.optional(v.string()),
    auto_shared: v.optional(v.boolean()),
    skip_title_generation: v.optional(v.boolean()),
    // Last time generateTitle was scheduled for this conversation — floors the
    // re-scheduling rate (see titleGeneration.maybeScheduleTitleGeneration).
    title_gen_scheduled_at: v.optional(v.number()),
    title_is_custom: v.optional(v.boolean()),
    idle_summary: v.optional(v.string()),
    // The pinned thread state: a short standing answer to "where does this
    // thread stand right now?", written and kept current by the agent itself
    // (`cast state "…"`, cleared with `cast state clear`). Unlike idle_summary —
    // an AI-generated blurb about what the session was about — this is a live
    // status the agent owns and revises as the work moves, so the human can open
    // a noisy thread and know the situation without reading the backscroll.
    // Rendered pinned above the composer and truncated on the inbox card.
    thread_state: v.optional(v.string()),
    thread_state_at: v.optional(v.number()),
    // message_count when the state was written. The gap against the live count
    // is the honest staleness signal the UI shows ("12 messages since"), and the
    // only defence against a stale state reading as current.
    thread_state_msg_count: v.optional(v.number()),
    // Declared tri-state of the work ("working" | "blocked" | "done"), written
    // with the text. Drives the status chip on the panel and the row tint on
    // the inbox card; absent on rows written before it existed.
    thread_state_status: v.optional(v.string()),
    // Dedupe for the needs-input push: "<message_count>:<kind>" of the last
    // waiting episode already notified (see notifications.checkNeedsInput).
    // Mirrors the web idle-sound's notified-keys map so one episode pushes
    // once but each new turn can push again.
    needs_input_notified_key: v.optional(v.string()),
    // Absolute flag: a truthy value means dismissed until a user action clears
    // it. Never compare against `updated_at` — dozens of mutations bump that
    // field and a relative check re-opens the session. Set by:
    // dismissFromInbox, linkSessions*, linkPlanHandoff (auto-dismiss parent),
    // killSession-adjacent paths. Cleared only by: dispatch.sendMessage,
    // pendingMessages.create, inboxStore.restoreSession, adminUnlinkSession.
    // The list predicates live in inboxFilters.ts. Dismiss also KILLS the
    // agent (dispatch.applyPatches enqueues kill_session on the transition).
    inbox_dismissed_at: v.optional(v.number()),
    // Stash = set aside WITHOUT killing: hides the session from the active inbox
    // buckets into the "Stashed" group (above Dismissed) while the agent keeps
    // running. Same absolute-flag semantics as inbox_dismissed_at (cleared by
    // any send — human or a trigger wake — or an explicit restore, see
    // enqueuePendingMessage); unlike dismiss it never triggers a kill. A
    // dismiss clears it (the row moves to Dismissed).
    inbox_stashed_at: v.optional(v.number()),
    // "Stash and hide": the stash survives machine wakes. A trigger firing into
    // a plain stash pulls the row back into the inbox ("something happened,
    // show me"); into a hidden stash it keeps working out of sight. Asks still
    // surface both (blocked declaration, --needs-attention, a stall). Honored
    // only while inbox_stashed_at is set — every stash write sets it (true or
    // cleared), so a clear of the stamp needs no companion clear here.
    inbox_stash_hidden: v.optional(v.boolean()),
    inbox_killed_at: v.optional(v.number()),
    inbox_deferred_at: v.optional(v.number()),
    // The user's "dormant" gesture: "a machine owns this, wake me when something
    // happens". A stamp that any later activity silently expires — honored only
    // while >= updated_at (see inboxFilters.isUserDormant), the same contract as
    // inbox_deferred_at. Never cleared by hand; a wake, a message, or a new turn
    // bumps updated_at past it and the row moves on.
    inbox_dormant_at: v.optional(v.number()),
    inbox_pinned_at: v.optional(v.number()),
    // The settle classifier's verdict for the settle it last inspected: "done"
    // (delivered, no ask present) or "needs_input" — never "dormant", which
    // needs a wake the system can verify. Written by idleSummary alongside idle_summary, from the
    // same model call over the same transcript tail, so the two can never
    // describe different turns. Honored only while settle_verdict_at >=
    // updated_at (inboxFilters.isSettleVerdictCurrent) and only when the agent
    // made no declaration of its own — a declaration (agent_status dormant /
    // done) always outranks the classifier.
    settle_verdict: v.optional(v.string()),
    settle_verdict_at: v.optional(v.number()),
    // Distinct from inbox_pinned_at: this is the PUBLIC-profile pin. Setting it
    // is the consent act that makes a session world-visible (the mutation also
    // guarantees a share_token, so the card deep-links to the existing /share
    // guest viewer). Timestamp = curation order, GitHub-pinned-repos style.
    profile_pinned_at: v.optional(v.number()),
    draft_message: v.optional(v.string()),
    last_user_message_at: v.optional(v.number()),
    is_subagent: v.optional(v.boolean()),
    cli_flags: v.optional(v.string()),
    // LEGACY: now written to conversation_context.stable_context (off the hot
    // doc). Still declared so pre-diet rows validate; readers fall back to it
    // until the doc diet sweep moves it.
    stable_context: v.optional(v.string()),
    last_message_role: v.optional(v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system"),
      v.literal("tool")
    )),
    last_message_preview: v.optional(v.string()),
    // Files this session recently edited (absolute paths, newest first, capped).
    // Denormalized at message-write time from Edit/Write/NotebookEdit tool
    // calls (see mergeRecentFiles in messages.ts). Feed/search cards render it
    // so agents and humans can see WHERE a session actually works — including
    // a worktree path that project_path alone would hide.
    recent_files: v.optional(v.array(v.string())),
    // Serving URL of the newest image in this conversation (attachment,
    // screenshot, or a trusted markdown image in prose) — the inbox row
    // thumbnail. Denormalized at message-write time (latestImagePreviewUrl);
    // never cleared, so presence also means "this session has images".
    image_preview_url: v.optional(v.string()),
    // When the conversation's whole history was swept into conversation_images
    // (backfillConversationImages). Live ingest materializes every new image, so
    // this only marks that the pre-feature history was caught up. Set = never
    // sweep this conversation again.
    images_backfilled_at: v.optional(v.number()),
    has_pending_messages: v.optional(v.boolean()),
    // True while the conversation's newest message is a transient Claude Code
    // API/auth-error banner (see isApiErrorBanner). Cleared when a real turn
    // supersedes it. Gates the banner-cleanup scan in addMessages so the common
    // (no-error) write path never pays for the extra read.
    pending_api_error: v.optional(v.boolean()),
    // Which banner family parked the session ("auth" | "limit" | "error" |
    // "connection" | "fatal", see classifyApiErrorBanner) — drives the
    // session-card pill label. Set/cleared in lockstep with pending_api_error.
    pending_api_error_kind: v.optional(v.string()),
    // When the block landed — the newest banner message's timestamp. Set and
    // cleared in lockstep with pending_api_error; the web blocked-sessions
    // banner and session rows render "Xm ago" from it.
    pending_api_error_at: v.optional(v.number()),
    session_error: v.optional(v.string()),
    active_plan_id: v.optional(v.id("plans")),
    active_task_id: v.optional(v.id("tasks")),
    plan_ids: v.optional(v.array(v.id("plans"))),
    worktree_name: v.optional(v.string()),
    worktree_branch: v.optional(v.string()),
    // Set on a row the web created for the cloud host BEFORE a local daemon has
    // prepared the host and acquired its worktree (cloud_spawn). While pending
    // no daemon may deliver into the row: the host would resume a session with
    // no checkout, and a laptop would claim it for itself. Cleared by
    // cloud.placeConversation together with the real start.
    cloud_placement: v.optional(v.literal("pending")),
    worktree_path: v.optional(v.string()),
    worktree_status: v.optional(v.union(
      v.literal("active"),
      v.literal("merged"),
      v.literal("archived")
    )),
    workflow_run_id: v.optional(v.id("workflow_runs")),
    is_workflow_sub: v.optional(v.boolean()),
    is_workflow_primary: v.optional(v.boolean()),
    // The schedule (agent_tasks row) that spawned this conversation as a run.
    // Stamped by the daemon shortly after spawn (agentTasks.linkRunConversation)
    // and backfilled on run completion/failure, so EVERY run — not just the
    // latest — stays attributable to its schedule (panel, badges, provenance).
    agent_task_id: v.optional(v.id("agent_tasks")),
    // Denormalized: is this conversation the home of an armed inject trigger,
    // and of which strength (dormancy.ts ArmedTriggerHomes)? Written by the
    // agent_tasks lifecycle (agentTasks.refreshArmedTriggerKind) so the inbox
    // projection classifies dormancy off the row alone, with no agent_tasks
    // read per execution. Absent = "none". Semantic (not churn), so it rides
    // the sync log.
    armed_trigger_kind: v.optional(v.union(v.literal("none"), v.literal("standing"), v.literal("once"))),
    // The pull request this session shepherds, folded for the inbox card and
    // the thread state panel. Single writer: prShepherd.refreshConversationPrStatus.
    // state mirrors pull_requests.shepherd_state.
    pr_status: v.optional(v.object({
      pr_id: v.id("pull_requests"),
      repository: v.string(),
      number: v.number(),
      title: v.optional(v.string()),
      state: v.string(),
      at: v.number(),
    })),
    // Harness /loop state, folded from the message stream at ingest (see
    // loopState.ts): the agent scheduled its own wakeup (ScheduleWakeup) or is
    // mid-wakeup-turn. Lets the inbox trigger set treat a self-pacing loop
    // like an armed trigger without reading messages. "stopped" is kept as a
    // tombstone so replayed history can't re-arm a finished loop.
    loop_state: v.optional(
      v.object({
        status: v.union(v.literal("armed"), v.literal("waking"), v.literal("stopped")),
        wakeup_at: v.number(),
        armed_at: v.number(),
        fired_at: v.optional(v.number()),
        event_at: v.number(),
        reason: v.optional(v.string()),
        prompt: v.optional(v.string()),
      })
    ),
    // LEGACY: never read (skills live in user_skills; getConversationWithMeta
    // strips this). Declared only so pre-diet rows validate; setAvailableSkills
    // no longer writes it and the doc diet sweep sheds it.
    available_skills: v.optional(v.string()),
    subagent_description: v.optional(v.string()),
    icon: v.optional(v.string()),
    icon_color: v.optional(v.string()),
    // Which device currently OWNS (runs) this session. Set by the managing
    // daemon. Absent = legacy/unowned. The single-owner invariant: a daemon
    // only manages sessions whose owner_device_id matches its own device id.
    // "Move to remote" flips this from the local device to the Mac's device.
    owner_device_id: v.optional(v.string()),
    // DENORMALIZED CACHE of the PRIMARY (first-added, still-present) owner. The
    // canonical owner store is the session_owners join table — a session may have
    // SEVERAL owners and this single field cannot express that, so never branch
    // inbox/feed membership on it (use session_owners; see scanInboxConversations).
    // Kept because the row-level UI shows one owner chip and it's a cheap fast
    // path in checkConversationAccess. Maintained in lockstep by the owner
    // mutations. Absent = unowned.
    //
    // An owner is the team member RESPONSIBLE for a session — whose inbox it
    // appears in and who may reply into it — distinct from user_id (the account
    // that RUNS + bills it) and owner_device_id (the DEVICE its daemon runs on).
    // These three axes move independently: reassigning owners never moves the
    // device, and reparenting the device never changes the owners.
    owner_user_id: v.optional(v.id("users")),
    // Tombstone forwarding: the id of a DELETED conversation this row replaced
    // when a kill/restart restored its session (resolveRestartTarget). Lets
    // resolveConversation heal stale links/cards that still point at the dead
    // id. A plain string — the referenced row no longer exists.
    restored_from_conversation_id: v.optional(v.string()),
    // ── Anchor / persistent-session support ──────────────────────────────────
    // `persistent` exempts a conversation from auto-completion so a standing
    // agent member can sit dormant indefinitely and be re-woken by an event. The
    // guard lives in markSessionCompleted (covers the watchdog, SessionEnd hook,
    // daemon kill teardown) plus matching checks in the direct-patch kill paths
    // (killSession + dispatch dismiss→kill). It is flipped to "completed" only by
    // decommissionAnchor, which clears `persistent` first.
    persistent: v.optional(v.boolean()),
    // The IDENTITY a session renders as. When set (to a synthetic is_bot user),
    // the author chip / feed show the bot, while `user_id` stays the human host
    // that actually runs and bills the session. Absent = render as user_id.
    acting_user_id: v.optional(v.id("users")),
    // The ORIGINAL human author, pinned the first time a session is reparented
    // ACROSS accounts (reparentSessionToDevice). Author is immutable, but
    // account-follows-device rewrites user_id when a session moves to another
    // user's machine — so before that overwrite we stamp the pre-move user_id
    // here, and resolveInitiatorRef prefers it. Absent = author is still user_id
    // (never reparented across accounts). Distinct from acting_user_id (rendered
    // identity) and owner_user_id (inbox responsibility).
    author_user_id: v.optional(v.id("users")),
    // Back-link to the owning anchors row when this conversation IS an anchor's
    // standing session (vs an ephemeral hand it spawned).
    anchor_id: v.optional(v.id("anchors")),
    // Durable execution fencing is opt-in during the mixed-version rollout.
    // Absence means the conversation is still served by the legacy daemon rail.
    // `legacy-quiescing` closes every legacy claim/status endpoint while the
    // owning supervisor proves the exact old daemon boot has stopped. `fenced`
    // means execution_bindings + delivery_attempts are the only authority.
    execution_protocol_state: v.optional(v.union(
      v.literal("legacy-quiescing"),
      v.literal("fenced"),
    )),
    execution_protocol_version: v.optional(v.number()),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_updated", ["user_id", "updated_at"])
    // Sparse in practice (only banner-parked conversations are true) — lets the
    // stale-flag sweep find expired pending_api_error rows without a table scan.
    .index("by_pending_api_error", ["pending_api_error", "updated_at"])
    .index("by_user_git_root", ["user_id", "git_root"])
    .index("by_user_git_remote_url", ["user_id", "git_remote_url"])
    .index("by_user_project_path", ["user_id", "project_path"])
    .index("by_user_favorite", ["user_id", "is_favorite"])
    .index("by_user_private", ["user_id", "is_private"])
    .index("by_team_id", ["team_id"])
    .index("by_team_user_updated", ["team_id", "user_id", "updated_at"])
    // (Removed: by_owner_updated. The owner's inbox merge and feed --mine now
    // read the canonical owner SET from session_owners — a single owner_user_id
    // can't express multiple owners. It was also not free: Convex indexes every
    // document (a missing optional field indexes as undefined), so with
    // updated_at as the second key EVERY conversation heartbeat rewrote an entry
    // in it. Nothing reads it anymore.)
    .index("by_share_token", ["share_token"])
    .index("by_session_id", ["session_id"])
    .index("by_short_id", ["short_id"])
    .index("by_forked_from", ["forked_from"])
    .index("by_git_branch", ["git_branch"])
    .index("by_parent_conversation_id", ["parent_conversation_id"])
    // Sparse and STATIC key (spawned_by never changes after creation, so no
    // write amplification — the cost that killed by_user_updated_at above).
    // Powers the hide cascade: killing/stashing a team lead must find its
    // teammates (spawned_by + agent_team_name), which by_parent_conversation_id
    // can't see. See cascadeHideToNestedChildren (cleanup.ts).
    .index("by_spawned_by", ["spawned_by_conversation_id"])
    .index("by_user_pinned", ["user_id", "inbox_pinned_at"])
    .index("by_user_stashed", ["user_id", "inbox_stashed_at"])
    // Inbox scan indexes (scanInboxConversations): exclude subagent / killed
    // rows at the index so the scan never reads docs the inbox filter drops.
    .index("by_user_subagent_updated", ["user_id", "is_subagent", "updated_at"])
    .index("by_user_live_dismissed", ["user_id", "is_subagent", "inbox_killed_at", "inbox_dismissed_at"])
    .index("by_user_live_stashed", ["user_id", "is_subagent", "inbox_killed_at", "inbox_stashed_at"])
    .index("by_user_profile_pinned", ["user_id", "profile_pinned_at"])
    .index("by_user_dismissed", ["user_id", "inbox_dismissed_at"])
    .index("by_owner_device", ["user_id", "owner_device_id"])
    .index("by_restored_from", ["restored_from_conversation_id"])
    // `persistent` and `anchor_id` are plain fields with no index: anchors
    // resolve their conversation via anchors.conversation_id, and no query
    // scans conversations by either field. Indexes on written-to tables are
    // not free (each one adds rows to the backing `indexes` table and
    // tombstone cost on every delete) — don't add indexes speculatively.
    // Sparse: only spawned schedule runs carry agent_task_id. Powers the run
    // history strip (agentTasks.webListRuns) — every run of one schedule.
    .index("by_agent_task", ["agent_task_id"])
    .searchIndex("search_title_v2", {
      searchField: "title",
      filterFields: ["user_id"],
    })
    // Summaries are searched alongside titles (searchConversations): subtitle is
    // the generated multi-line session summary, idle_summary the one-line blurb.
    .searchIndex("search_subtitle", {
      searchField: "subtitle",
      filterFields: ["user_id"],
    })
    .searchIndex("search_idle_summary", {
      searchField: "idle_summary",
      filterFields: ["user_id"],
    }),

  // Stable-context records that arrived before their conversation existed. The
  // SessionStart hook fires at agent boot and reports by agent session id; a
  // terminal-started session's conversation row is only created when the daemon
  // first syncs the transcript, seconds later. recordStableContext parks the
  // record here and createConversation / updateSessionId consume it (patching
  // conversations.stable_context, deleting the row). Rows are transient — any
  // consumer also lazily prunes leftovers older than a day for its user.
  stable_context_spool: defineTable({
    user_id: v.id("users"),
    session_id: v.string(),
    data: v.string(),
    created_at: v.number(),
  })
    .index("by_session_id", ["session_id"])
    .index("by_user_created", ["user_id", "created_at"]),

  // ── Anchors ─────────────────────────────────────────────────────────────────
  // A standing agent member: one per team (shared) and one per user (personal).
  // The anchor owns a long-lived `conversation_id` (persistent, pinned, rendered
  // under `bot_user_id`'s identity) that is woken by events and delegates code
  // work to ephemeral `cast spawn` hands. `host_user_id` is the human whose
  // daemon actually runs and bills the session; `bot_user_id` is identity only.
  anchors: defineTable({
    scope_type: v.union(v.literal("team"), v.literal("user")),
    // Exactly one of these is set, matching scope_type.
    team_id: v.optional(v.id("teams")),
    scope_user_id: v.optional(v.id("users")), // the human a personal anchor belongs to
    bot_user_id: v.id("users"), // the synthetic is_bot identity it renders as
    host_user_id: v.id("users"), // the human whose daemon runs + bills the session
    conversation_id: v.optional(v.id("conversations")), // the persistent session (once started)
    name: v.string(), // display name (default "Anchor", or custom)
    persona: v.optional(v.string()), // skill name or inline persona reference
    project_path: v.optional(v.string()), // cwd for the anchor and its hands
    model: v.optional(v.string()),
    status: v.union(
      v.literal("provisioning"),
      v.literal("active"),
      v.literal("paused"),
      v.literal("decommissioned"),
    ),
    // Per-anchor governance: cap daily spawned-hand/session count; absent = default.
    daily_session_cap: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.optional(v.number()),
  })
    .index("by_team", ["team_id"])
    .index("by_scope_user", ["scope_user_id"])
    .index("by_bot_user", ["bot_user_id"])
    .index("by_host_user", ["host_user_id"])
    .index("by_conversation", ["conversation_id"]),

  // Maps an external comms channel (e.g. a Slack channel) to the anchor that
  // answers there, plus the credentials/config to post back as the bot. Kept
  // separate from `anchors` so one anchor can own several channels and so the
  // Slack adapter can resolve channel → anchor with a single indexed lookup.
  anchor_channels: defineTable({
    anchor_id: v.id("anchors"),
    // "codecast" binds an anchor to a chat channel INSIDE codecast. These rows are
    // an override, not the wiring: a chat channel with no row resolves to its
    // team's anchor through `anchors.by_team`, so mentioning the anchor works with
    // no setup step and no row written per channel that could drift.
    surface: v.union(v.literal("slack"), v.literal("codecast")),
    // Slack: the channel id (e.g. "C0123"). codecast: the chat_channels _id.
    // Unique per surface.
    channel_key: v.string(),
    // Slack workspace/team id, for multi-workspace installs.
    workspace_key: v.optional(v.string()),
    project_path: v.optional(v.string()), // override the anchor's cwd for this channel
    created_at: v.number(),
  })
    .index("by_anchor", ["anchor_id"])
    .index("by_surface_channel", ["surface", "channel_key"])
    // Channel ids are only unique WITHIN a workspace, so multi-workspace routing
    // resolves on (surface, workspace, channel).
    .index("by_workspace_channel", ["surface", "workspace_key", "channel_key"]),

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
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_workspace", ["workspace_id"])
    .index("by_team", ["team_id"])
    .index("by_scope_user", ["scope_user_id"]),

  // Idempotency for inbound Slack events: Slack retries on slow/failed acks, and
  // a double-wake would make the anchor answer the same mention twice (Aivery's
  // triple-send bug). We record each event_id and drop repeats.
  slack_events: defineTable({
    event_id: v.string(),
    created_at: v.number(),
  })
    .index("by_event_id", ["event_id"])
    .index("by_created_at", ["created_at"]),

  // Large git-diff blobs split off the conversations hot doc. The conversations
  // row is read+patched on every message sync (addMessages) and returned by list
  // queries; keeping multi-MB diffs there inflated every read/write and worsened
  // OCC contention. These are written once at session creation (and on fork) and
  // read only on-demand by getConversationGitDiff.
  // Large per-conversation blobs that no LIST ever renders, keyed off the hot
  // doc so the inbox scan (which reads every candidate doc in full, on every
  // recompute) never pays for them. Same rationale as conversation_git_diffs.
  conversation_context: defineTable({
    conversation_id: v.id("conversations"),
    // StableContextData JSON snapshot — see conversations.stable_context
    // (legacy location) and recordStableContext.
    stable_context: v.optional(v.string()),
    updated_at: v.number(),
  }).index("by_conversation_id", ["conversation_id"]),

  conversation_git_diffs: defineTable({
    conversation_id: v.id("conversations"),
    git_diff: v.optional(v.string()),
    git_diff_staged: v.optional(v.string()),
    // `git status` text captured at session start. Lives here, not on the
    // conversation doc, for the same reason as the diffs: the inbox scan reads
    // every candidate doc in full and never renders this.
    git_status: v.optional(v.string()),
    updated_at: v.number(),
  }).index("by_conversation_id", ["conversation_id"]),

  public_conversations: defineTable({
    conversation_id: v.id("conversations"),
    user_id: v.id("users"),
    title: v.string(),
    description: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    preview_text: v.string(),
    agent_type: v.string(),
    message_count: v.number(),
    created_at: v.number(),
    view_count: v.number(),
  })
    .index("by_created_at", ["created_at"]),

  messages: defineTable({
    conversation_id: v.id("conversations"),
    from_user_id: v.optional(v.id("users")),
    message_uuid: v.optional(v.string()),
    // Source ordering prevents an older durable retry from overwriting a newer
    // projection of the same logical message. Legacy clients omit both fields.
    source_device_id: v.optional(v.string()),
    source_revision: v.optional(v.number()),
    // Conversation-scoped server watermark at which this row last changed.
    transcript_revision: v.optional(v.number()),
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system"),
      v.literal("tool")
    ),
    content: v.optional(v.string()),
    encrypted_content: v.optional(v.string()),
    is_encrypted: v.optional(v.boolean()),
    thinking: v.optional(v.string()),
    tool_calls: v.optional(v.array(v.object({
      id: v.string(),
      name: v.string(),
      input: v.string(),
    }))),
    tool_results: v.optional(v.array(v.object({
      tool_use_id: v.string(),
      content: v.string(),
      is_error: v.optional(v.boolean()),
    }))),
    images: v.optional(v.array(v.object({
      media_type: v.string(),
      data: v.optional(v.string()),
      storage_id: v.optional(v.id("_storage")),
      tool_use_id: v.optional(v.string()),
    }))),
    subtype: v.optional(v.string()),
    client_id: v.optional(v.string()),
    // Model that generated this assistant turn (from the agent transcript),
    // e.g. "claude-opus-4-8". Conversations can switch models mid-stream, so
    // this is per-message; conversations.model is only the last-known value.
    model: v.optional(v.string()),
    timestamp: v.number(),
    tokens_used: v.optional(v.number()),
    usage: v.optional(v.object({
      input_tokens: v.number(),
      output_tokens: v.number(),
      cache_creation_input_tokens: v.optional(v.number()),
      cache_read_input_tokens: v.optional(v.number()),
    })),
    embedding: v.optional(v.array(v.float64())),
  })
    .index("by_conversation_id", ["conversation_id"])
    .index("by_conversation_timestamp", ["conversation_id", "timestamp"])
    .index("by_conversation_transcript_revision", ["conversation_id", "transcript_revision"])
    .index("by_conversation_uuid", ["conversation_id", "message_uuid"])
    .index("by_conversation_client_id", ["conversation_id", "client_id"])
    .index("by_message_uuid", ["message_uuid"])
    .index("by_timestamp", ["timestamp"])
    .index("by_conversation_role_timestamp", ["conversation_id", "role", "timestamp"])
    .searchIndex("search_content_v2", {
      searchField: "content",
      filterFields: ["conversation_id"],
    }),

  // Recent-window mirror of message text for content search (see
  // searchMirror.ts). search_content_v2 above scans its whole posting list per
  // term across every message ever written, so common tokens exceed the query
  // budget; this table holds only the trailing window, making the scan small
  // by construction. Rows are written solely by the searchMirror cron walker.
  message_search_recent: defineTable({
    message_id: v.id("messages"),
    conversation_id: v.id("conversations"),
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system"),
      v.literal("tool")
    ),
    content: v.string(),
    timestamp: v.number(),
    tool_calls_count: v.optional(v.number()),
    tool_results_count: v.optional(v.number()),
    // _creationTime of the SOURCE message — the window/GC axis. Distinct from
    // `timestamp` (client event time): imported old transcripts get fresh
    // creation times and should be searchable, not instantly GC'd.
    source_created_at: v.number(),
    // Owner/team of the conversation at mirror time, for SCOPED search
    // lookups (fetchMessageSearchPool): the global BM25 pool truncates at 512
    // rows BEFORE visibility filtering, so one user's term-heavy private
    // sessions can starve everyone else's hits out of the pool entirely.
    // Scoped lookups make the caller's own (and their teams') rows immune to
    // that flood. Stamps are snapshots — visibility is still enforced
    // post-pool against the live conversation doc, so a stale team_id costs
    // recall only, never leaks.
    user_id: v.optional(v.id("users")),
    team_id: v.optional(v.id("teams")),
  })
    .index("by_message_id", ["message_id"])
    .index("by_source_created_at", ["source_created_at"])
    // "_r2" because renaming a search index is convex's drop-and-rebuild: the
    // original "search_content" segment set was damaged beyond compaction
    // (2026-08-10 mass-patch incident — a segment blob went missing and the
    // TextCompactor crash-looped on it). Prod no longer carries the original
    // index — do NOT re-declare it (that re-creates it and forces a ~636k-doc
    // backfill).
    .searchIndex("search_content_r2", {
      searchField: "content",
      filterFields: ["conversation_id", "team_id", "user_id"],
    }),

  // Single row: the searchMirror walker's watermark. `cursor` = _creationTime
  // of the last mirrored message. Patched EVERY cron tick — nothing that a
  // subscribed query reads may live here (reactivity: reading this row would
  // re-run every open search each tick).
  search_mirror_state: defineTable({
    cursor: v.number(),
    updated_at: v.number(),
  }),

  // Singleton: _creationTime position of the daemon_logs retention sweep
  // (advanceLogPrune). Same pattern and same reactivity warning as
  // search_mirror_state above — patched on every prune tick, so no subscribed
  // query may read it.
  log_prune_state: defineTable({
    cursor: v.number(),
    updated_at: v.number(),
  }),

  // Single row, read by fetchMessageSearchPool: is the mirror serveable? The
  // walker writes it ONLY when liveness transitions (with hysteresis), so open
  // search subscriptions stay stable across cron ticks.
  search_mirror_live: defineTable({
    live: v.boolean(),
  }),

  // Story & Summary densities. Both are chunked first-person retellings cached
  // as JSON. `story` is an array of beats (each spans several turns); `summary`
  // is a coarser array of phases built by grouping the beats. Each level tracks
  // the message_count it was built at so the client knows when to regenerate.
  // Kept out of the conversations table so list queries don't carry the markdown.
  conversation_summaries: defineTable({
    conversation_id: v.id("conversations"),
    story: v.optional(v.string()),
    summary: v.optional(v.string()),
    story_message_count: v.optional(v.number()),
    summary_message_count: v.optional(v.number()),
    // Legacy field from the first (per-conversation single-summary) design.
    // Tolerated so old rows validate; superseded by the per-level counts above.
    message_count: v.optional(v.number()),
    generated_at: v.number(),
    model: v.optional(v.string()),
  }).index("by_conversation_id", ["conversation_id"]),

  bookmarks: defineTable({
    user_id: v.id("users"),
    conversation_id: v.id("conversations"),
    message_id: v.id("messages"),
    name: v.optional(v.string()),
    note: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_conversation", ["user_id", "conversation_id"])
    .index("by_message_id", ["message_id"])
    .index("by_user_name", ["user_id", "name"]),

  // Manual session buckets: personal, lightweight named groups for organizing
  // inbox sessions by workstream. Purely attention-organization for the human —
  // orthogonal to plans (which carry agent-facing context). Archive = archived_at
  // set; rows are never hard-deleted so the delta sync cache converges.
  inbox_buckets: defineTable({
    user_id: v.id("users"),
    name: v.string(),
    color: v.optional(v.string()),
    sort_order: v.optional(v.number()),
    archived_at: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_user_id", ["user_id"]),

  // One row per (user, conversation): exclusive bucket membership. Unassign sets
  // bucket_id null (delta-friendly tombstone) rather than deleting the row, so
  // every change reaches clients as an upsert. Kept off the conversation row on
  // purpose: conversations are hot, shared docs; filing is per-user and cold.
  bucket_assignments: defineTable({
    user_id: v.id("users"),
    conversation_id: v.id("conversations"),
    bucket_id: v.optional(v.id("inbox_buckets")),
    updated_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_conversation", ["user_id", "conversation_id"]),

  decisions: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    // ACCESS axis — see tasks.workspace.
    workspace: v.optional(v.string()),
    project_path: v.optional(v.string()),
    title: v.string(),
    rationale: v.string(),
    alternatives: v.optional(v.array(v.string())),
    session_id: v.optional(v.string()),
    conversation_id: v.optional(v.id("conversations")),
    message_index: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_project", ["user_id", "project_path"])
    .index("by_team_id", ["team_id"])
    .index("by_workspace", ["workspace"])
    .searchIndex("search_decisions_v2", {
      searchField: "title",
      filterFields: ["user_id", "project_path"],
    }),

  patterns: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    // ACCESS axis — see tasks.workspace.
    workspace: v.optional(v.string()),
    name: v.string(),
    description: v.string(),
    content: v.string(),
    source_session_id: v.optional(v.string()),
    source_conversation_id: v.optional(v.id("conversations")),
    source_range: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    usage_count: v.number(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_name", ["user_id", "name"])
    .index("by_team_id", ["team_id"])
    .index("by_workspace", ["workspace"])
    .searchIndex("search_patterns_v2", {
      searchField: "name",
      filterFields: ["user_id"],
    }),

  file_touches: defineTable({
    conversation_id: v.id("conversations"),
    user_id: v.id("users"),
    file_path: v.string(),
    operation: v.union(
      v.literal("read"),
      v.literal("edit"),
      v.literal("write"),
      v.literal("delete"),
      v.literal("glob"),
      v.literal("grep")
    ),
    line_range: v.optional(v.string()),
    message_index: v.number(),
    timestamp: v.number(),
  })
    .index("by_conversation", ["conversation_id"])
    .index("by_user_file", ["user_id", "file_path"])
    .index("by_timestamp", ["timestamp"]),

  comments: defineTable({
    conversation_id: v.id("conversations"),
    message_id: v.optional(v.id("messages")),
    user_id: v.id("users"),
    content: v.string(),
    parent_comment_id: v.optional(v.id("comments")),
    created_at: v.number(),
    github_comment_id: v.optional(v.number()),
    pr_id: v.optional(v.id("pull_requests")),
    file_path: v.optional(v.string()),
    line_number: v.optional(v.number()),
    // Agent-reply comments: an opt-in "ask the agent to reply" spawns a hidden
    // fork whose answer is mirrored back into this comment. author_kind="agent"
    // renders it as the agent; agent_status tracks the reply lifecycle; the fork
    // it came from is recorded for traceability.
    author_kind: v.optional(v.union(v.literal("user"), v.literal("agent"))),
    agent_status: v.optional(v.union(
      v.literal("thinking"),
      v.literal("streaming"),
      v.literal("done"),
      v.literal("error"),
    )),
    fork_conversation_id: v.optional(v.id("conversations")),
    // Thread resolution (GitHub-style). Stamped on EVERY comment of a thread
    // when resolved, so "open" is simply "has an unstamped comment" — a reply
    // posted after resolution reopens the thread with no root bookkeeping.
    resolved_at: v.optional(v.number()),
    resolved_by: v.optional(v.id("users")),
    // Client-generated id for the optimistic store flow: the inboxStore stub
    // carries it as altKey so the synced server row supersedes the stub, and the
    // server dedups on it so a dispatch-outbox retry can't double-insert.
    client_id: v.optional(v.string()),
  })
    .index("by_conversation_id", ["conversation_id"])
    .index("by_conversation_client_id", ["conversation_id", "client_id"])
    .index("by_message_id", ["message_id"])
    .index("by_user_id", ["user_id"])
    .index("by_parent_comment_id", ["parent_comment_id"])
    .index("by_pr_id", ["pr_id"])
    .index("by_github_comment_id", ["github_comment_id"])
    // Cross-conversation recency scan for the review queue (open threads across
    // every conversation the viewer can access).
    .index("by_created_at", ["created_at"]),

  public_comments: defineTable({
    conversation_id: v.id("conversations"),
    user_id: v.id("users"),
    content: v.string(),
    parent_comment_id: v.optional(v.id("public_comments")),
    created_at: v.number(),
  })
    .index("by_conversation_id", ["conversation_id"]),

  sync_cursors: defineTable({
    user_id: v.id("users"),
    file_path_hash: v.string(),
    last_position: v.number(),
    last_synced_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_file_path_hash", ["file_path_hash"]),

  rate_limits: defineTable({
    user_id: v.id("users"),
    endpoint: v.string(),
    window_start: v.number(),
    request_count: v.number(),
  })
    .index("by_user_endpoint", ["user_id", "endpoint"]),

  api_tokens: defineTable({
    user_id: v.id("users"),
    token_hash: v.string(),
    name: v.string(),
    created_at: v.number(),
    last_used_at: v.number(),
    expires_at: v.optional(v.number()),
    // The machine this token was minted for. OPTIONAL, and the optionality is
    // the migration: every token already in the wild carries none and keeps
    // authenticating from anywhere, exactly as before. Only a token that names a
    // device is checked against the device presenting it, so a token lifted off
    // one machine stops working on another WITHOUT a backfill and without
    // logging anybody out.
    //
    // Enforced in verifyApiToken, which stays a pure read — see the comment
    // there. Binding is a comparison, not a write.
    device_id: v.optional(v.string()),
  })
    .index("by_user_id", ["user_id"])
    .index("by_token_hash", ["token_hash"]),

  // Server-relayed `cast auth` handoffs for CLIs the browser can't reach over
  // 127.0.0.1 (SSH / remote machines). The web page deposits the minted token
  // keyed by a hash of the CLI's one-time nonce; the CLI polls /cli/claim-auth
  // and the row is deleted on first claim. Rows are transient: claimed within
  // minutes or swept (token revoked) by the cleanup cron.
  cli_auth_requests: defineTable({
    nonce_hash: v.string(),
    user_id: v.id("users"),
    token: v.string(),
    device_name: v.string(),
    created_at: v.number(),
  })
    .index("by_nonce_hash", ["nonce_hash"])
    .index("by_created_at", ["created_at"]),

  pending_messages: defineTable({
    conversation_id: v.id("conversations"),
    from_user_id: v.id("users"),
    // The user who OWNS the target conversation — i.e. whose daemon delivers this message.
    // For a self-send (the common case) this equals from_user_id; for a team send (one user
    // messaging a teammate's session) it's the teammate. Delivery, claiming, and status writes
    // route on owner; cancel/retry/status-read and failure notifications route on the sender.
    // Optional only for backward compat with rows created before this field existed (backfilled
    // to from_user_id, which they're equal to); enqueuePendingMessage always sets it on new rows.
    owner_user_id: v.optional(v.id("users")),
    // The sender's own conversation, captured so the cron can tell the sending session when a
    // cross-user message can't be delivered (the "remote not responding" feedback path).
    from_conversation_id: v.optional(v.id("conversations")),
    // Set once when the sender has been told this cross-user message is stuck — keeps the cron
    // from notifying repeatedly.
    sender_notified_at: v.optional(v.number()),
    content: v.string(),
    image_storage_id: v.optional(v.id("_storage")),
    image_storage_ids: v.optional(v.array(v.id("_storage"))),
    client_id: v.optional(v.string()),
    // Who initiated the send. Absent = a person (web composer, cast send, team
    // send) — those clear dismissed/stashed/killed so the session resurfaces.
    // "scheduler" = the daemon's task scheduler firing a `cast trigger`
    // injection: a machine wake must not override the user's stash (stash =
    // "keep working out of my sight"), so enqueue skips the stash-clear.
    origin: v.optional(v.literal("scheduler")),
    status: v.union(
      v.literal("pending"),
      v.literal("injected"),
      v.literal("delivered"),
      v.literal("failed"),
      v.literal("undeliverable"),
      // User-initiated terminal state. The only way to stop the always-on retry loop short of
      // delivery — the daemon's getPendingMessages never returns it and the healer never revives it.
      v.literal("cancelled")
    ),
    created_at: v.number(),
    delivered_at: v.optional(v.number()),
    // The transcript message this row's echo produced. Stamped when the echo
    // adopts the row (content rewrite, client_id, images, from_user_id). Lets a
    // row terminalized early by the status ack still be adopted by its late
    // echo, while guaranteeing each row is adopted at most once — an identical
    // later send can never re-match an already-echoed row.
    echo_message_id: v.optional(v.id("messages")),
    retry_count: v.number(),
    // Present only after a conversation crosses the fenced-execution gate.
    // Legacy columns remain as a UI/backward-compatible projection, but legacy
    // daemon endpoints reject these rows. Convex assigns all four values in the
    // enqueue transaction; clients never mint ordering or delivery authority.
    delivery_protocol_version: v.optional(v.number()),
    delivery_id: v.optional(v.string()),
    conversation_sequence: v.optional(v.number()),
    execution_epoch: v.optional(v.number()),
    delivery_status: v.optional(v.union(
      v.literal("pending"),
      v.literal("claimed"),
      v.literal("delivery-started"),
      v.literal("delivered"),
      v.literal("rejected"),
      v.literal("cancelled-by-supersession"),
      v.literal("correlated-delivered"),
      v.literal("ambiguous"),
      v.literal("abandoned-ambiguous"),
    )),
    active_delivery_attempt_id: v.optional(v.id("delivery_attempts")),
    delivery_disposition_reason: v.optional(v.string()),
    // Explicit risk-bearing resend provenance. The original delivery remains
    // terminal abandoned-ambiguous; content is copied into a new logical
    // delivery with a new client/delivery id and sequence.
    resend_of_delivery_id: v.optional(v.string()),
  })
    .index("by_conversation_id", ["conversation_id"])
    .index("by_conversation_status", ["conversation_id", "status"])
    .index("by_user_status", ["from_user_id", "status"])
    // The daemon polls by the TARGET owner (owner_user_id), not the sender, so a teammate's
    // message lands in the right daemon's queue. Replaces by_user_status for delivery routing.
    .index("by_owner_status", ["owner_user_id", "status"])
    // Lets the global retryStuckMessages cron read ONLY the handful of non-terminal
    // rows instead of `.filter()`-scanning the entire table (which read-conflicts
    // with every addMessages pending-write → OCC stampede → 60s sync timeouts).
    .index("by_status", ["status"])
    .index("by_conversation_sequence", ["conversation_id", "conversation_sequence"])
    .index("by_conversation_client_id", ["conversation_id", "client_id"])
    .index("by_delivery_id", ["delivery_id"])
    .index("by_owner_delivery_status", ["owner_user_id", "delivery_protocol_version", "delivery_status"]),

  // One authoritative ordering/fencing row per conversation. Convex OCC on
  // this row serializes enqueue, delivery-slot acquisition, terminal-prefix
  // advancement, and epoch activation. There is deliberately one slot for the
  // whole conversation rather than one slot per epoch.
  conversation_execution_heads: defineTable({
    conversation_id: v.id("conversations"),
    owner_user_id: v.id("users"),
    protocol_state: v.union(v.literal("legacy-quiescing"), v.literal("fenced")),
    protocol_version: v.number(),
    current_epoch: v.optional(v.number()),
    pending_epoch: v.optional(v.number()),
    admission_epoch: v.optional(v.number()),
    next_conversation_sequence: v.number(),
    next_nonterminal_sequence: v.number(),
    pending_policy: v.optional(v.union(
      v.literal("drain-current"),
      v.literal("cancel-unstarted"),
    )),
    pending_requested_at_sequence: v.optional(v.number()),
    cancelled_through_sequence: v.optional(v.number()),
    // Browser/session-authenticated product intent. The browser can request a
    // restart or a model/effort reconfiguration, but it never names effect
    // authority (device/boot/runtime/operation/capabilities). Those fields are
    // derived here from the current binding and consumed by the daemon's
    // separate API-token-only successor proposal.
    successor_intent: v.optional(v.object({
      intent_id: v.string(),
      requested_by_user_id: v.id("users"),
      expected_current_epoch: v.number(),
      kind: v.union(v.literal("restart"), v.literal("reconfigure")),
      policy: v.union(v.literal("drain-current"), v.literal("cancel-unstarted")),
      requested_model_option: v.optional(v.string()),
      requested_effort_option: v.optional(v.string()),
      requested_agent: v.union(
        v.literal("claude"),
        v.literal("codex"),
        v.literal("cursor"),
        v.literal("gemini"),
        v.literal("opencode"),
        v.literal("pi"),
        v.literal("grok"),
      ),
      transport: v.union(v.literal("tmux"), v.literal("app-server"), v.literal("external")),
      project_path: v.string(),
      isolation: v.optional(v.object({
        sandbox: v.optional(v.union(
          v.literal("read-only"),
          v.literal("workspace-write"),
          v.literal("danger-full-access"),
        )),
        approval_policy: v.optional(v.union(
          v.literal("untrusted"),
          v.literal("on-failure"),
          v.literal("on-request"),
          v.literal("never"),
        )),
        isolated: v.optional(v.boolean()),
        worktree_name: v.optional(v.string()),
      })),
      configuration_revision: v.number(),
      model: v.optional(v.string()),
      effort: v.optional(v.string()),
      owner_device_id: v.string(),
      protocol_version: v.number(),
      required_capabilities: v.array(v.union(
        v.literal("single-flight-binding"),
        v.literal("delivery-permit-v1"),
        v.literal("strict-agent-routing"),
        v.literal("runtime-inspection-v1"),
      )),
      status: v.union(v.literal("pending"), v.literal("consumed"), v.literal("activated")),
      successor_epoch: v.optional(v.number()),
      consumed_daemon_boot_id: v.optional(v.string()),
      created_at: v.number(),
      consumed_at: v.optional(v.number()),
      activated_at: v.optional(v.number()),
    })),
    active_delivery_attempt_id: v.optional(v.id("delivery_attempts")),
    active_delivery_state: v.optional(v.union(
      v.literal("claimed"),
      v.literal("delivery-started"),
      v.literal("ambiguous"),
    )),
    // The migration proof is exact to one device and one daemon incarnation;
    // device identity alone is not a worker fence.
    legacy_owner_device_id: v.optional(v.string()),
    legacy_daemon_boot_id: v.optional(v.string()),
    terminated_legacy_daemon_boot_id: v.optional(v.string()),
    replacement_daemon_boot_id: v.optional(v.string()),
    legacy_runtime_disposition: v.optional(v.union(
      v.literal("stopped"),
      v.literal("adopted"),
      v.literal("quarantined"),
    )),
    termination_evidence: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_conversation", ["conversation_id"])
    .index("by_owner_state", ["owner_user_id", "protocol_state"]),

  // Immutable target/configuration per epoch plus the durable startup CAS.
  // The device's CURRENT fenced-execution daemon boot, upserted at rail
  // startup. Cross-boot binding recovery is authorized only for this exact
  // boot: a claim from any other boot id (a dead boot's late-arriving request,
  // or a boot that never registered) stays rejected, so a restart can adopt
  // stranded bindings without a stale claimant ever stealing one back.
  execution_daemon_boots: defineTable({
    user_id: v.id("users"),
    owner_device_id: v.string(),
    daemon_boot_id: v.string(),
    registered_at: v.number(),
  }).index("by_user_device", ["user_id", "owner_device_id"]),

  // Ready-only fields are optional in storage and validated as a complete set
  // by executionBindings.publishReadyBinding before state becomes `ready`.
  execution_bindings: defineTable({
    conversation_id: v.id("conversations"),
    epoch: v.number(),
    owner_user_id: v.id("users"),
    owner_device_id: v.string(),
    daemon_boot_id: v.string(),
    requested_agent: v.union(
      v.literal("claude"),
      v.literal("codex"),
      v.literal("cursor"),
      v.literal("gemini"),
      v.literal("opencode"),
      v.literal("pi"),
      v.literal("grok"),
    ),
    transport: v.union(v.literal("tmux"), v.literal("app-server"), v.literal("external")),
    project_path: v.string(),
    isolation: v.optional(v.object({
      sandbox: v.optional(v.union(
        v.literal("read-only"),
        v.literal("workspace-write"),
        v.literal("danger-full-access"),
      )),
      approval_policy: v.optional(v.union(
        v.literal("untrusted"),
        v.literal("on-failure"),
        v.literal("on-request"),
        v.literal("never"),
      )),
      isolated: v.optional(v.boolean()),
      worktree_name: v.optional(v.string()),
    })),
    configuration_revision: v.number(),
    model: v.optional(v.string()),
    effort: v.optional(v.string()),
    protocol_version: v.number(),
    required_capabilities: v.array(v.union(
      v.literal("single-flight-binding"),
      v.literal("delivery-permit-v1"),
      v.literal("strict-agent-routing"),
      v.literal("runtime-inspection-v1"),
    )),
    state: v.union(
      v.literal("requested"),
      v.literal("starting"),
      v.literal("ready"),
      v.literal("start-failed-before-effect"),
      v.literal("start-ambiguous"),
      v.literal("stopped"),
      v.literal("quarantined"),
    ),
    operation_id: v.optional(v.string()),
    actual_agent: v.optional(v.union(
      v.literal("claude"),
      v.literal("codex"),
      v.literal("cursor"),
      v.literal("gemini"),
      v.literal("opencode"),
      v.literal("pi"),
      v.literal("grok"),
    )),
    runtime_id: v.optional(v.string()),
    handle: v.optional(v.string()),
    applied_configuration_revision: v.optional(v.number()),
    capabilities: v.optional(v.array(v.union(
      v.literal("single-flight-binding"),
      v.literal("delivery-permit-v1"),
      v.literal("strict-agent-routing"),
      v.literal("runtime-inspection-v1"),
    ))),
    failure_code: v.optional(v.string()),
    failure_message: v.optional(v.string()),
    failure_retryable: v.optional(v.boolean()),
    suspected_runtime_id: v.optional(v.string()),
    stopped_reason: v.optional(v.string()),
    // Evidence-bearing retirement of an epoch that never reached `ready`.
    // `no-runtime-proven` is safe only after inspection proves no external
    // runtime exists; `runtime-quarantined` retains the suspected runtime id.
    pre_ready_disposition: v.optional(v.union(
      v.literal("no-runtime-proven"),
      v.literal("runtime-quarantined"),
    )),
    disposition_evidence: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_conversation_epoch", ["conversation_id", "epoch"])
    .index("by_owner_device_state", ["owner_user_id", "owner_device_id", "state"]),

  // Every retry gets a fresh attempt row; delivery_id and sequence stay stable.
  // An ambiguous attempt remains the conversation-global slot owner until an
  // explicit proof/recovery decision resolves it.
  delivery_attempts: defineTable({
    conversation_id: v.id("conversations"),
    message_id: v.id("pending_messages"),
    delivery_id: v.string(),
    conversation_sequence: v.number(),
    execution_epoch: v.number(),
    configuration_revision: v.number(),
    owner_user_id: v.id("users"),
    owner_device_id: v.string(),
    daemon_boot_id: v.string(),
    runtime_id: v.string(),
    state: v.union(
      v.literal("claimed"),
      v.literal("delivery-started"),
      v.literal("delivered"),
      v.literal("failed-before-effect"),
      v.literal("ambiguous"),
      v.literal("correlated-delivered"),
      v.literal("cancelled-by-supersession"),
      v.literal("abandoned-ambiguous"),
    ),
    failure_code: v.optional(v.string()),
    failure_message: v.optional(v.string()),
    external_delivery_id: v.optional(v.string()),
    resolution_evidence: v.optional(v.string()),
    claimed_at: v.number(),
    delivery_started_at: v.optional(v.number()),
    completed_at: v.optional(v.number()),
  })
    .index("by_message", ["message_id"])
    .index("by_conversation_sequence", ["conversation_id", "conversation_sequence"])
    .index("by_conversation_state", ["conversation_id", "state"]),

  // One row per machine the user runs a codecast daemon on. The remote Mac is
  // just another device. device_id is a stable hash of ~/.codecast/.machine_key,
  // bound to the machine's hardware UUID so a disk-copied ~/.codecast (Migration
  // Assistant) mints a fresh id instead of impersonating the source machine
  // (see remote/device.ts). Per-device fields (local_project_roots) live here
  // rather than on the user doc, so multiple machines don't clobber each other.
  devices: defineTable({
    user_id: v.id("users"),
    device_id: v.string(),
    label: v.string(),
    platform: v.string(),
    // The machine's own hostname, heartbeat-reported. Distinct from `label`,
    // which is a display name a human can override to anything ("Cloud Mac").
    // Only ever a SUGGESTION for ssh_host — never interpolated into a command
    // on its own, because a hostname is not necessarily a reachable ssh target.
    hostname: v.optional(v.string()),
    // How to reach this machine over SSH from elsewhere, e.g. "nose" or
    // "m1@1.2.3.4". User-set in Settings → Devices (never heartbeat-written):
    // an ssh alias resolves against the VIEWER's ~/.ssh/config, which no daemon
    // can know. Absent = no target, and the UI then refuses to hand out an
    // attach command it can't stand behind. Shell-safe by construction — see
    // sanitizeSshHost in devices.ts, which is what makes it safe to paste.
    ssh_host: v.optional(v.string()),
    last_seen: v.number(),
    // When a human last touched THIS machine's keyboard/mouse — computed
    // server-side as (heartbeat arrival − the daemon's reported input idle), so
    // daemon clock skew can't fake it. macOS-only (cli/inputIdle.ts); absent on
    // Linux/headless boxes, which therefore never read as "the user is here".
    // Consumed by pushRouter unless the user opted out of machine_wide_presence.
    last_input_at: v.optional(v.number()),
    status: v.optional(v.union(v.literal("online"), v.literal("offline"))),
    // Per-device daemon health, written on every beat: boot time, ms the event
    // loop was blocked in the last minute, and the sync backlog. The web derives
    // "restarted, catching up" / "under load" / "syncing N" PER MACHINE from
    // these — the user-doc twins are last-writer across machines, so with two
    // daemons alive one machine's trouble is masked by the other's beats.
    daemon_started_at: v.optional(v.number()),
    loop_freeze_ms: v.optional(v.number()),
    // The same measure over the trailing hour, plus the worst single freeze and
    // the stacks it was in. This is the loop freeze budget the daemonLogs cron
    // alerts on and the devices settings page shows. Rounded by the daemon (1h
    // to 5s, max to 1s) so a beat that changed nothing else does not rewrite
    // the row and churn the roster.
    loop_freeze_1h_ms: v.optional(v.number()),
    loop_freeze_max_ms: v.optional(v.number()),
    loop_freeze_top: v.optional(v.string()),
    // Debounce state for the aggregated "daemon overloaded" notification
    // (daemonLogs.checkDeviceLoopFreeze). One write per incident, not per tick.
    // Dropped once the hour total has stayed under the bar past
    // FREEZE_NOTIFY_COOLDOWN_MS, which is what lets the next real incident on
    // this machine announce itself. Not on the first dip: a machine hovering at
    // the bar crosses it every other tick, and clearing on the dip would let it
    // reset its own debounce and alert every ten minutes.
    freeze_notify_state: v.optional(v.object({
      last_notified_at: v.number(),
      // Hour total covered by that notification; only a HIGHER total is a fresh
      // incident worth announcing again.
      last_hour_ms: v.number(),
    })),
    pending_sync_count: v.optional(v.number()),
    oldest_pending_ms: v.optional(v.number()),
    pending_sync_messages: v.optional(v.number()),
    pending_sync_conversations: v.optional(v.number()),
    is_remote: v.optional(v.boolean()),
    // Set when work was queued for a REMOTE device that is offline (a cloud
    // host that put itself to sleep). The configured server waker or a local
    // daemon boots the host; a heartbeat from the device itself clears it.
    // Never set for a local device — nothing can wake
    // a closed laptop.
    wake_requested_at: v.optional(v.number()),
    cloud_wake: v.optional(v.object({
      request_at: v.number(),
      attempt: v.number(),
      next_attempt_at: v.number(),
      status: v.union(v.literal("pending"), v.literal("starting"), v.literal("awake"), v.literal("failed")),
      lease_token: v.optional(v.string()),
      lease_until: v.optional(v.number()),
      last_error: v.optional(v.string()),
      aws_request_id: v.optional(v.string()),
    })),
    local_project_roots: v.optional(v.array(v.string())),
    // Git-plane health per repo with live sessions on this device (gitPlane.ts),
    // heartbeat-reported: is origin a real rendezvous URL, does fetch succeed,
    // how far HEAD sits from upstream. Metadata only — never file content or
    // credentials. Surfaces silent drift (a dead bundle origin, a repo weeks
    // behind) in the UI instead of during an incident.
    git_plane: v.optional(v.array(v.object({
      root: v.string(),
      origin: v.optional(v.string()),
      origin_ok: v.boolean(),
      fetch_ok: v.optional(v.boolean()),
      ahead: v.optional(v.number()),
      behind: v.optional(v.number()),
      branch: v.optional(v.string()),
      fetched_at: v.optional(v.number()),
      repaired_from: v.optional(v.string()),
      // Fetch fails with an auth error even via the device key: the machine
      // needs to be granted repo access (the devices page renders the grant card).
      needs_access: v.optional(v.boolean()),
      // "device" when the per-device fallback git key is the identity in use.
      identity: v.optional(v.string()),
      error: v.optional(v.string()),
    }))),
    // The device's PUBLIC git key (ed25519), heartbeat-reported. Not a secret —
    // it exists precisely to be pasted into GitHub/GitLab to grant this machine
    // repo access. The private half never leaves the device.
    git_pubkey: v.optional(v.string()),
    // Saved CC account profiles on this machine (names/emails/tiers only,
    // never tokens) — heartbeat-reported, drives the web account switcher.
    cc_accounts: v.optional(ccAccountsValidator),
    // DEPRECATED (2026-08-01): superseded by codex_accounts. Kept as v.any()
    // because prod rows still hold data and old daemons still send it; drop
    // once the field is cleared everywhere.
    codex_usage: v.optional(v.any()),
    // Saved Codex (ChatGPT) account profiles on this machine (names/emails/
    // plans/usage percentages, never tokens) — heartbeat-reported, same shape
    // as cc_accounts so the web renders both with one component set.
    codex_accounts: v.optional(ccAccountsValidator),
    // Managed-provider-key metadata (pl-207), heartbeat-reported. The public half
    // of the device's ECDH keypair — NOT a secret; the web encrypts a key to it so
    // Convex never sees plaintext. `managed_provider_ids` is which providers have a
    // key set here (ids only, never the keys) — drives the web's managed/unmanaged
    // status, mirroring how cc_accounts reports names-not-tokens.
    provider_key_pubkey: v.optional(v.string()),
    managed_provider_ids: v.optional(v.array(v.string())),
    // Auto-switch on usage limits: when on, limit-parked sessions trigger a
    // server-side check that switches this machine to the best saved profile
    // and revives them, retrying until unblocked or every account is spent.
    // Web-set (setAutoSwitchAccounts); the heartbeat never writes these.
    cc_auto_switch: v.optional(v.boolean()),
    // Same-account resume once the limit window resets (no switch). Unset
    // means ON — see isAutoContinueEnabled; false is the explicit opt-out.
    // Web-set (setAutoContinueAccounts). Shares cc_auto_switch_state.
    cc_auto_continue: v.optional(v.boolean()),
    cc_auto_switch_state: v.optional(ccAutoSwitchStateValidator),
    // The in-flight browser sign-in round trip (web CTA → daemon `claude auth
    // login` → outcome). Web-set to pending; daemon-set to confirmed/rejected.
    cc_login_flow: v.optional(ccLoginFlowValidator),
    // Deprecated rollout field. Per-session account tokens are always enabled;
    // retained while existing device rows and older clients still carry it.
    cc_session_tokens: v.optional(v.boolean()),
    // The in-flight mint round trip (web/daemon → `claude setup-token` →
    // outcome). Web-set or daemon-set to pending; daemon-set to the outcome.
    cc_mint_flow: v.optional(ccMintFlowValidator),
    // Installed agent-feature snippets (by slug) + stable mode on this machine
    // — heartbeat-reported, drives the web Settings page (per-device toggles).
    settings: v.optional(deviceSettingsValidator),
    // Launchable `provider/model` ids per dynamic client (opencode/pi) on this
    // machine — heartbeat-reported (hash-gated), drives the web model pickers.
    model_inventory: v.optional(modelInventoryValidator),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_device", ["user_id", "device_id"]),

  managed_sessions: defineTable({
    session_id: v.string(),
    conversation_id: v.optional(v.id("conversations")),
    user_id: v.id("users"),
    pid: v.number(),
    tmux_session: v.optional(v.string()),
    started_at: v.number(),
    last_heartbeat: v.number(),
    agent_status: v.optional(agentStatusFieldValidator),
    agent_status_updated_at: v.optional(v.number()),
    // When the daemon parked this session's pane to stay under the fleet cap.
    // Cleared when the session resumes. Separate from agent_status_updated_at
    // so a later status write does not lose when the park started.
    hibernated_at: v.optional(v.number()),
    permission_mode: v.optional(v.union(v.literal("default"), v.literal("plan"), v.literal("acceptEdits"), v.literal("bypassPermissions"), v.literal("dontAsk"), v.literal("auto"))),
    current_cpu: v.optional(v.number()),
    current_memory: v.optional(v.number()),
    current_pid_count: v.optional(v.number()),
    // Real PID of the agent's process tree root (distinct from the daemon's PID
    // historically stored in `pid`). Set by the resource collector.
    agent_pid: v.optional(v.number()),
    // When that agent process started (ps etime, resolved to wall clock by the
    // resource collector). The session id survives a restart but this does not,
    // so it names the process GENERATION: the web fences background watches
    // armed by an earlier one, which died with it and are never notified.
    agent_started_at: v.optional(v.number()),
    // The background work the harness still holds for this session, as the
    // daemon last verified it (shared/contracts/openTasks). Reported with every
    // settle verdict and refreshed by the heartbeat reconcile while the session
    // is parked; `open_tasks_at` is when. Drives the inbox's "↳ Background …"
    // row without the conversation's messages, and vouches for a "waiting"
    // status past the quiet-time decay.
    open_tasks: v.optional(v.array(openTaskValidator)),
    open_tasks_at: v.optional(v.number()),
    // Accumulated time the session has been idle while the machine was AWAKE
    // (sleep gaps excluded). Reset to 0 whenever the session shows activity.
    awake_idle_ms: v.optional(v.number()),
    // When the daemon last reported live metrics for this session. Freshness
    // here is the liveness signal: a live process tree is what produces a report.
    last_metrics_at: v.optional(v.number()),
  })
    .index("by_session_id", ["session_id"])
    .index("by_conversation_id", ["conversation_id"])
    .index("by_user_id", ["user_id"])
    .index("by_user_heartbeat", ["user_id", "last_heartbeat"])
    .index("by_heartbeat", ["last_heartbeat"]),

  session_metrics: defineTable({
    session_id: v.string(),
    user_id: v.id("users"),
    cpu: v.number(),
    memory: v.number(),
    pid_count: v.number(),
    collected_at: v.number(),
  })
    .index("by_session_collected", ["session_id", "collected_at"])
    .index("by_user_collected", ["user_id", "collected_at"]),

  commits: defineTable({
    conversation_id: v.optional(v.id("conversations")),
    sha: v.string(),
    message: v.string(),
    author_name: v.string(),
    author_email: v.string(),
    timestamp: v.number(),
    files_changed: v.number(),
    insertions: v.number(),
    deletions: v.number(),
    repository: v.optional(v.string()),
    pr_number: v.optional(v.number()),
    // GitHub provenance for commits that arrive by webhook or backfill (the
    // transcript path sets conversation_id instead). team_id is the access
    // fallback for a commit with no session: members of the installing team
    // may read it. branch is the ref the push landed on; task_ids are the
    // ct- ids parsed from the message and branch (lib/gitRefs).
    team_id: v.optional(v.id("teams")),
    branch: v.optional(v.string()),
    author_login: v.optional(v.string()),
    author_avatar_url: v.optional(v.string()),
    pr_id: v.optional(v.id("pull_requests")),
    task_ids: v.optional(v.array(v.id("tasks"))),
    files: v.optional(v.array(v.object({
      filename: v.string(),
      status: v.string(),
      additions: v.number(),
      deletions: v.number(),
      changes: v.number(),
      patch: v.optional(v.string()),
    }))),
  })
    .index("by_conversation_id", ["conversation_id"])
    .index("by_timestamp", ["timestamp"])
    .index("by_sha", ["sha"])
    .index("by_repository", ["repository"])
    .index("by_repository_timestamp", ["repository", "timestamp"])
    .index("by_team_timestamp", ["team_id", "timestamp"]),

  // Per-edit file changes materialized at message ingest (materializeFileChanges
  // in messages.ts). Lets the diff viewer show the full session diff without
  // paginating the whole conversation to the top. change_key = the extractor's
  // stable per-edit id (toolCallId, or `${toolCallId}:${section}`) so re-synced
  // messages upsert idempotently instead of duplicating rows.
  file_changes: defineTable({
    conversation_id: v.id("conversations"),
    change_key: v.string(),
    message_id: v.id("messages"),
    tool_call_id: v.optional(v.string()),
    seq: v.number(),
    file_path: v.string(),
    change_type: v.union(v.literal("write"), v.literal("edit"), v.literal("commit")),
    old_content: v.optional(v.string()),
    new_content: v.string(),
    commit_message: v.optional(v.string()),
    commit_hash: v.optional(v.string()),
    timestamp: v.number(),
  })
    .index("by_conversation_id", ["conversation_id"])
    .index("by_conversation_change_key", ["conversation_id", "change_key"])
    // cast blame: resolve a git SHA to the session that committed it. Stored
    // hashes are short (parsed from `[branch abc1234]` output), so lookups
    // range-scan [sha7, fullSha] and prefix-verify.
    .index("by_commit_hash", ["commit_hash"])
    // cast blame fallback: sessions often commit via compound commands whose
    // output carries no `[branch hash]` line, so the row has a message but no
    // hash. Blame then matches commit rows by subject + timestamp proximity.
    .index("by_type_timestamp", ["change_type", "timestamp"])
    // cast blame: attribute uncommitted lines to the newest edit of the file.
    .index("by_file_path", ["file_path"]),

  // Every image in a conversation, materialized at message ingest
  // (materializeConversationImages in messages.ts). The header gallery reads
  // this instead of scanning the loaded message window, so its list covers the
  // whole thread no matter how few pages are loaded. image_key = the storage id
  // or the markdown src — the same identity extractSessionImages dedupes on —
  // so a re-synced message upserts instead of duplicating a row.
  // Inline base64 (data:) images are deliberately NOT materialized: the payload
  // is the identity, and an index table is no place for it. The client window
  // extraction still surfaces those, and the merge folds them in.
  conversation_images: defineTable({
    conversation_id: v.id("conversations"),
    image_key: v.string(),
    storage_id: v.optional(v.id("_storage")),
    src: v.optional(v.string()),
    message_id: v.id("messages"),
    // Position within the message, so two images in one turn keep their order.
    seq: v.number(),
    timestamp: v.number(),
  })
    .index("by_conversation_id", ["conversation_id"])
    .index("by_conversation_image_key", ["conversation_id", "image_key"]),

  pull_requests: defineTable({
    team_id: v.id("teams"),
    github_pr_id: v.number(),
    repository: v.string(),
    number: v.number(),
    title: v.string(),
    body: v.string(),
    state: v.union(
      v.literal("open"),
      v.literal("closed"),
      v.literal("merged")
    ),
    author_github_username: v.string(),
    head_ref: v.optional(v.string()),
    base_ref: v.optional(v.string()),
    linked_session_ids: v.array(v.id("conversations")),
    pr_comment_posted: v.optional(v.boolean()),
    files: v.optional(v.array(v.object({
      filename: v.string(),
      status: v.string(),
      additions: v.number(),
      deletions: v.number(),
      changes: v.number(),
      patch: v.optional(v.string()),
    }))),
    additions: v.optional(v.number()),
    deletions: v.optional(v.number()),
    changed_files: v.optional(v.number()),
    commits_count: v.optional(v.number()),
    files_synced_at: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
    merged_at: v.optional(v.number()),
    closed_at: v.optional(v.number()),
    // Live state mirrored from GitHub by the webhook processors and the merge
    // state refresh (githubWebhooks / prShepherd). Every field is optional so
    // rows that predate it stay valid.
    head_sha: v.optional(v.string()),
    base_sha: v.optional(v.string()),
    draft: v.optional(v.boolean()),
    author_avatar_url: v.optional(v.string()),
    // GitHub's mergeable / mergeable_state ("clean", "behind", "dirty",
    // "blocked", "unstable", "unknown", "draft"). behind_by is the compare
    // API's count of base commits the head lacks.
    mergeable: v.optional(v.union(v.boolean(), v.null())),
    mergeable_state: v.optional(v.string()),
    behind_by: v.optional(v.number()),
    merge_state_checked_at: v.optional(v.number()),
    // "approved" | "changes_requested" | "review_required" | "none"
    review_decision: v.optional(v.string()),
    requested_reviewers: v.optional(v.array(v.string())),
    unresolved_review_count: v.optional(v.number()),
    // One entry per check run or commit status context on head_sha, keyed by
    // name plus the suite's triggering event when known (a job that runs on
    // both push and pull_request is two entries, as on GitHub). checks_state
    // folds them: "none" | "pending" | "success" | "failure".
    checks: v.optional(v.array(v.object({
      name: v.string(),
      status: v.string(),
      conclusion: v.optional(v.string()),
      url: v.optional(v.string()),
      updated_at: v.number(),
      external_id: v.optional(v.string()),
      suite_id: v.optional(v.string()),
      event: v.optional(v.string()),
      app: v.optional(v.string()),
    }))),
    checks_state: v.optional(v.string()),
    // Reasons that piled up since the last wake was DELIVERED. Several events
    // often land while the shepherd is mid-run, and the newest is rarely the
    // most urgent, so they are kept until the prompt is built and the headline
    // is chosen by severity. Cleared once the wake is handed over.
    shepherd_pending_reasons: v.optional(v.array(v.string())),
    // ct- ids parsed from title, body and head_ref.
    task_ids: v.optional(v.array(v.id("tasks"))),
    // Shepherd: the session that owns this PR until it merges. One standing
    // agent_tasks row (shepherd_task_id) is woken with a prompt built from the
    // fields above. shepherd_state is the folded status the inbox card shows:
    // "review_pending" | "changes_requested" | "ci_pending" | "ci_red" |
    // "behind" | "conflicts" | "approved" | "ready" | "merged" | "closed".
    shepherd_conversation_id: v.optional(v.id("conversations")),
    shepherd_enabled: v.optional(v.boolean()),
    shepherd_task_id: v.optional(v.id("agent_tasks")),
    shepherd_state: v.optional(v.string()),
    shepherd_state_at: v.optional(v.number()),
    shepherd_last_wake_at: v.optional(v.number()),
    shepherd_last_wake_reason: v.optional(v.string()),
    shepherd_wake_count: v.optional(v.number()),
  })
    .index("by_team_id", ["team_id"])
    .index("by_github_pr_id", ["github_pr_id"])
    .index("by_repository", ["repository"])
    .index("by_repository_number", ["repository", "number"])
    .index("by_shepherd_conversation", ["shepherd_conversation_id"])
    .index("by_updated_at", ["updated_at"]),

  reviews: defineTable({
    pull_request_id: v.id("pull_requests"),
    // Optional since reviews now also arrive by webhook from reviewers who
    // have no codecast account; those carry author_github_username instead.
    reviewer_user_id: v.optional(v.id("users")),
    author_github_username: v.optional(v.string()),
    github_review_id: v.optional(v.number()),
    commit_sha: v.optional(v.string()),
    html_url: v.optional(v.string()),
    state: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("changes_requested"),
      v.literal("commented")
    ),
    body: v.optional(v.string()),
    submitted_at: v.number(),
  })
    .index("by_pull_request", ["pull_request_id"])
    .index("by_reviewer", ["reviewer_user_id"])
    .index("by_pull_request_state", ["pull_request_id", "state"])
    .index("by_github_review_id", ["github_review_id"]),

  // Code comments: a comment anchored to a file (and optionally a line range)
  // in a repository. Historically PR review comments only; now also comments
  // left on the source browser and on commit pages, with or without a PR.
  // A comment is a codecast object: it records the session, task, plan or doc
  // it was made from, and is mirrored to GitHub (github_comment_id) when the
  // file sits in an open PR.
  review_comments: defineTable({
    review_id: v.optional(v.id("reviews")),
    pull_request_id: v.optional(v.id("pull_requests")),
    repository: v.optional(v.string()),
    // Commit sha or branch the comment was made against.
    ref: v.optional(v.string()),
    file_path: v.optional(v.string()),
    line_number: v.optional(v.number()),
    line_end: v.optional(v.number()),
    // "LEFT" (old side of a diff) | "RIGHT". Absent = the file as it is at ref.
    side: v.optional(v.string()),
    parent_id: v.optional(v.id("review_comments")),
    conversation_id: v.optional(v.id("conversations")),
    task_id: v.optional(v.id("tasks")),
    plan_id: v.optional(v.id("plans")),
    doc_id: v.optional(v.id("docs")),
    author_kind: v.optional(v.union(v.literal("user"), v.literal("agent"), v.literal("github"))),
    author_avatar_url: v.optional(v.string()),
    resolved_at: v.optional(v.number()),
    resolved_by: v.optional(v.id("users")),
    client_id: v.optional(v.string()),
    github_review_id: v.optional(v.number()),
    html_url: v.optional(v.string()),
    content: v.string(),
    resolved: v.boolean(),
    created_at: v.number(),
    updated_at: v.optional(v.number()),
    github_comment_id: v.optional(v.number()),
    // The FIRST comment of the thread this one replies to (GitHub's
    // comment.in_reply_to_id). A review thread is a conversation, and whether it
    // is still outstanding depends on who spoke last in it, not on the comment
    // that opened it. Absent means this comment opened its own thread.
    github_in_reply_to_id: v.optional(v.number()),
    codecast_origin: v.optional(v.boolean()),
    author_github_username: v.optional(v.string()),
    author_user_id: v.optional(v.id("users")),
  })
    .index("by_review", ["review_id"])
    .index("by_review_resolved", ["review_id", "resolved"])
    .index("by_pull_request", ["pull_request_id"])
    .index("by_github_comment_id", ["github_comment_id"])
    .index("by_repository_file", ["repository", "file_path"])
    .index("by_conversation", ["conversation_id"])
    .index("by_task", ["task_id"])
    .index("by_parent", ["parent_id"]),

  // External activity as first class events: one row per commit, push, PR
  // change, review, check result, merge, merge-state change, code comment,
  // or issue change (GitHub issues, Linear). Written only by
  // externalEvents.record (deduped by dedupe_key). Every event names the
  // codecast objects it belongs to so it can be rendered inline in the
  // transcript, the team feed and the task, plan and project timelines by
  // one component. Access follows the PR/commit rule: team membership, or
  // access to the linked conversation.
  external_events: defineTable({
    team_id: v.id("teams"),
    // github | linear | codecast
    source: v.string(),
    // owner/name for git events; absent for issue trackers without a repo.
    repository: v.optional(v.string()),
    // Git kinds: commit | push | pr_opened | pr_synchronize | pr_review
    // | pr_review_comment | pr_check | pr_merged | pr_closed | pr_reopened
    // | pr_behind | pr_conflict | pr_ready | pr_review_requested
    // | pr_ready_for_review | pr_draft | pr_edited | code_comment
    // Issue kinds (issue sync): issue_opened | issue_assigned | issue_closed
    // | issue_reopened | issue_commented | issue_status | issue_edited
    kind: v.string(),
    actor_login: v.optional(v.string()),
    actor_avatar_url: v.optional(v.string()),
    actor_user_id: v.optional(v.id("users")),
    title: v.string(),
    summary: v.optional(v.string()),
    url: v.optional(v.string()),
    sha: v.optional(v.string()),
    branch: v.optional(v.string()),
    pr_id: v.optional(v.id("pull_requests")),
    pr_number: v.optional(v.number()),
    commit_id: v.optional(v.id("commits")),
    comment_id: v.optional(v.id("review_comments")),
    // The external issue this event is about (issue sync).
    issue: v.optional(v.object({
      provider: v.string(),
      key: v.string(),
      url: v.optional(v.string()),
      title: v.optional(v.string()),
    })),
    conversation_id: v.optional(v.id("conversations")),
    // task_id is the first linked task (indexed); task_ids is the full set.
    task_id: v.optional(v.id("tasks")),
    task_ids: v.optional(v.array(v.id("tasks"))),
    plan_ids: v.optional(v.array(v.id("plans"))),
    project_ids: v.optional(v.array(v.id("projects"))),
    meta: v.optional(v.object({
      status: v.optional(v.string()),
      conclusion: v.optional(v.string()),
      check_name: v.optional(v.string()),
      review_state: v.optional(v.string()),
      file_path: v.optional(v.string()),
      line_number: v.optional(v.number()),
      additions: v.optional(v.number()),
      deletions: v.optional(v.number()),
      files_changed: v.optional(v.number()),
      commit_count: v.optional(v.number()),
      behind_by: v.optional(v.number()),
      mergeable_state: v.optional(v.string()),
      base_ref: v.optional(v.string()),
      head_ref: v.optional(v.string()),
      pr_state: v.optional(v.string()),
      shepherd_state: v.optional(v.string()),
    })),
    dedupe_key: v.string(),
    created_at: v.number(),
  })
    .index("by_team_created", ["team_id", "created_at"])
    .index("by_repository_created", ["repository", "created_at"])
    .index("by_pr_created", ["pr_id", "created_at"])
    .index("by_conversation_created", ["conversation_id", "created_at"])
    .index("by_task_created", ["task_id", "created_at"])
    .index("by_issue_key", ["issue.key", "created_at"])
    .index("by_dedupe_key", ["dedupe_key"]),

  // Read-through cache of repository content fetched with the GitHub App
  // token for the source browser and history pages: branch lists, trees,
  // blobs, commit logs and blame. Keyed by (repository, kind, ref, path).
  // Rows are re-fetched when older than their kind's TTL (repos.ts) and never
  // synced to the client store; the pages read them per view.
  repo_cache: defineTable({
    team_id: v.id("teams"),
    repository: v.string(),
    // branches | tree | blob | log | blame | compare
    kind: v.string(),
    ref: v.string(),
    path: v.string(),
    // Resolved commit sha for ref (a branch name resolves to its tip).
    sha: v.optional(v.string()),
    // JSON payload for structured kinds; raw text for blobs.
    content: v.string(),
    size: v.optional(v.number()),
    truncated: v.optional(v.boolean()),
    etag: v.optional(v.string()),
    fetched_at: v.number(),
  })
    .index("by_key", ["repository", "kind", "ref", "path"])
    .index("by_team_fetched", ["team_id", "fetched_at"])
    // Pruning asks one question across every team: what has not been read in a
    // week. by_team_fetched cannot answer it without walking the teams, so the
    // sweep gets an index of its own and reads only rows it is going to delete.
    .index("by_fetched", ["fetched_at"]),

  team_activity_events: defineTable({
    team_id: v.id("teams"),
    actor_user_id: v.id("users"),
    event_type: v.union(
      v.literal("session_started"),
      v.literal("session_completed"),
      v.literal("commit_pushed"),
      v.literal("member_joined"),
      v.literal("member_left"),
      v.literal("pr_created"),
      v.literal("pr_merged")
    ),
    title: v.string(),
    description: v.optional(v.string()),
    timestamp: v.number(),
    related_conversation_id: v.optional(v.id("conversations")),
    related_commit_sha: v.optional(v.string()),
    related_pr_id: v.optional(v.id("pull_requests")),
    metadata: v.optional(v.object({
      duration_ms: v.optional(v.number()),
      message_count: v.optional(v.number()),
      git_branch: v.optional(v.string()),
      files_changed: v.optional(v.number()),
      insertions: v.optional(v.number()),
      deletions: v.optional(v.number()),
    })),
  })
    .index("by_team_id", ["team_id"])
    .index("by_team_timestamp", ["team_id", "timestamp"])
    .index("by_actor", ["actor_user_id"])
    // Time-bounded actor reads: activity charts scan a trailing window, and a
    // long-lived account accumulates far more events than any window shows.
    .index("by_actor_timestamp", ["actor_user_id", "timestamp"]),

  // Per-day human-send counters ("Sends" chart metric). One row per
  // (user, team, UTC day); `hours` holds 24 UTC-hour buckets. Written at
  // message-insert time by messages.ts via lib/userSend.recordUserSend — a
  // send is a user-role message a person actually typed (noise-classified),
  // which is not reconstructable cheaply from `messages` after the fact.
  user_send_daily: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    day_start: v.number(),
    total: v.number(),
    hours: v.array(v.number()),
    updated_at: v.number(),
  })
    .index("by_user_day", ["user_id", "day_start"])
    .index("by_user_team_day", ["user_id", "team_id", "day_start"]),

  session_insights: defineTable({
    conversation_id: v.id("conversations"),
    team_id: v.optional(v.id("teams")),
    actor_user_id: v.id("users"),
    source: v.union(
      v.literal("idle"),
      v.literal("commit"),
      v.literal("manual"),
      v.literal("periodic")
    ),
    generated_at: v.number(),
    summary: v.string(),
    headline: v.optional(v.string()),
    key_changes: v.optional(v.array(v.string())),
    timeline: v.optional(v.array(v.object({
      t: v.string(),
      event: v.string(),
      type: v.string(),
      session_title: v.optional(v.string()),
    }))),
    turns: v.optional(v.array(v.object({
      ask: v.string(),
      did: v.array(v.string()),
    }))),
    goal: v.optional(v.string()),
    what_changed: v.optional(v.string()),
    outcome_type: v.union(
      v.literal("shipped"),
      v.literal("progress"),
      v.literal("blocked"),
      v.literal("unknown")
    ),
    blockers: v.optional(v.array(v.string())),
    next_action: v.optional(v.string()),
    themes: v.array(v.string()),
    confidence: v.optional(v.number()),
    metadata: v.optional(v.object({
      commit_shas: v.optional(v.array(v.string())),
      pr_numbers: v.optional(v.array(v.number())),
      files_touched: v.optional(v.array(v.string())),
    })),
  })
    .index("by_conversation_id", ["conversation_id"])
    .index("by_team_generated_at", ["team_id", "generated_at"])
    .index("by_actor_generated_at", ["actor_user_id", "generated_at"]),

  // One row per conversation: the composer's suggested replies, generated
  // against a specific tail message (anchor). Storing them (rather than
  // returning from the action) makes them reactive and shared across the
  // owner's devices, and the anchor doubles as the dedupe key — same anchor,
  // no regeneration. An empty suggestions array is a valid, stored outcome:
  // "the model looked and found nothing confident", which must also not retry.
  composer_suggestions: defineTable({
    conversation_id: v.id("conversations"),
    user_id: v.id("users"),
    anchor_message_uuid: v.string(),
    suggestions: v.array(v.string()),
    generated_at: v.number(),
  }).index("by_conversation_id", ["conversation_id"]),

  // Append-only record of what happened to each shown suggestion: sent as-is,
  // edited first, or dismissed. This is the ground truth for judging (and
  // later calibrating) the suggester — the model's self-reported confidence
  // is uncalibrated until measured against these.
  suggestion_outcomes: defineTable({
    user_id: v.id("users"),
    conversation_id: v.id("conversations"),
    anchor_message_uuid: v.string(),
    suggestion: v.string(),
    outcome: v.union(v.literal("sent"), v.literal("edited"), v.literal("dismissed")),
    created_at: v.number(),
  }).index("by_user_created", ["user_id", "created_at"]),

  // Per-user mined composer-input corpus: how this user actually talks to
  // their agents. `phrases` are recurring multi-word fragments mined across
  // inputs (each counted once per message); `frequent` is repeated whole
  // multi-word inputs; `recent` preserves the newest inputs in order for
  // style evidence. Refreshed lazily by the suggestions action past its TTL.
  suggestion_profiles: defineTable({
    user_id: v.id("users"),
    frequent: v.array(v.object({ text: v.string(), count: v.number() })),
    phrases: v.optional(v.array(v.object({ text: v.string(), count: v.number() }))),
    // Generalized habits mined by LLM: what the user recurrently asks for,
    // abstracted from topic ("demands e2e verification before accepting
    // work"), with one real quote as voice evidence. The suggester APPLIES
    // these to the current conversation instead of replaying old messages.
    patterns: v.optional(v.array(v.object({
      pattern: v.string(),
      example: v.string(),
      count: v.number(),
    }))),
    // Reusable prompts mined by LLM: full-text directives the user resends
    // across sessions near-verbatim ("you are a world class product
    // engineer… do another 10 rounds"). Unlike pattern examples these are
    // MEANT to be replayed, adapted to the current conversation.
    prompts: v.optional(v.array(v.object({
      text: v.string(),
      count: v.number(),
    }))),
    recent: v.array(v.string()),
    generated_at: v.number(),
  }).index("by_user_id", ["user_id"]),

  day_timelines: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    date: v.string(),
    events: v.array(v.object({
      time: v.number(),
      t: v.string(),
      event: v.string(),
      type: v.string(),
      session_id: v.optional(v.id("conversations")),
      session_title: v.optional(v.string()),
      project: v.optional(v.string()),
    })),
    narrative: v.optional(v.string()),
    generated_at: v.number(),
  })
    .index("by_user_date", ["user_id", "date"])
    .index("by_team_date", ["team_id", "date"]),

  digests: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    scope: v.union(v.literal("day"), v.literal("week"), v.literal("month")),
    date: v.string(),
    narrative: v.string(),
    events: v.array(v.object({
      time: v.number(),
      t: v.string(),
      event: v.string(),
      type: v.string(),
      session_id: v.optional(v.id("conversations")),
      session_title: v.optional(v.string()),
      project: v.optional(v.string()),
    })),
    session_count: v.optional(v.number()),
    generated_at: v.number(),
  })
    .index("by_user_scope_date", ["user_id", "scope", "date"])
    .index("by_team_scope_date", ["team_id", "scope", "date"]),

  notifications: defineTable({
    recipient_user_id: v.id("users"),
    type: v.union(
      v.literal("mention"),
      v.literal("comment_reply"),
      v.literal("conversation_comment"),
      v.literal("team_invite"),
      v.literal("session_idle"),
      v.literal("permission_request"),
      v.literal("session_error"),
      v.literal("session_assigned"),
      v.literal("team_session_start"),
      v.literal("task_completed"),
      v.literal("task_failed"),
      v.literal("task_assigned"),
      v.literal("task_status_changed"),
      v.literal("task_commented"),
      v.literal("doc_updated"),
      v.literal("doc_commented"),
      v.literal("plan_status_changed"),
      v.literal("plan_task_completed"),
      v.literal("artifact_commented"),
      // Team chat. By default ordinary chatter produces unread state only —
      // never a notification row, never a push. A direct message is one
      // exception (addressed to you by construction, it notifies like a
      // mention); chat_post is the other: a plain channel line, written only
      // for members who set that channel's notify level to "all".
      v.literal("chat_mention"),
      v.literal("chat_reply"),
      v.literal("chat_here"),
      v.literal("chat_dm"),
      // Someone added you to a private channel or a group message.
      v.literal("chat_added"),
      v.literal("chat_post"),
      // One machine's daemon event loop froze past the budget in the last hour
      // (daemonLogs.checkDeviceLoopFreeze). Entity is the device, not a session:
      // the whole machine is late, not one conversation.
      v.literal("daemon_overloaded")
    ),
    actor_user_id: v.optional(v.id("users")),
    // Display identity for actors without an account (an anonymous artifact
    // commenter): name + avatar snapshot, used when actor_user_id is absent.
    actor_name: v.optional(v.string()),
    actor_avatar: v.optional(v.string()),
    comment_id: v.optional(v.id("comments")),
    conversation_id: v.optional(v.id("conversations")),
    entity_type: v.optional(v.union(
      v.literal("task"),
      v.literal("doc"),
      v.literal("plan"),
      v.literal("conversation"),
      v.literal("artifact"),
      v.literal("chat_channel"),
      v.literal("device")
    )),
    entity_id: v.optional(v.string()),
    // The exact chat message a chat notification points at. entity_id names the
    // channel; this names the row inside it, so the bell, the toast and the phone
    // all deep-link to the same message instead of "the channel, somewhere".
    // Routing goes through entity_type + these ids, never through `link` — `link`
    // is for pages outside the app and web opens it in a new tab.
    chat_message_id: v.optional(v.id("chat_messages")),
    // Deep link the notification opens (e.g. codecast.sh/a/<slug>?c=<comment>
    // — the artifact page opens that comment thread). Takes precedence over
    // the entity_type route when present.
    link: v.optional(v.string()),
    message: v.string(),
    read: v.boolean(),
    created_at: v.number(),
  })
    .index("by_recipient", ["recipient_user_id"])
    .index("by_recipient_read", ["recipient_user_id", "read"])
    .index("by_recipient_created", ["recipient_user_id", "created_at"])
    // Global recency scan for the email digest sweep (emails/digest.ts): find
    // recently-created unread rows without touching every user.
    .index("by_created", ["created_at"])
    // Session-state notifications (ready / needs permission / error) replace
    // per (recipient, conversation) instead of stacking — this is the lookup
    // for the row(s) being superseded.
    .index("by_recipient_conversation", ["recipient_user_id", "conversation_id"]),

  // "A human is at a desktop surface" — one row per user, heartbeat-written by
  // the web/Electron client while visible (pushRouter.reportPresence). This is
  // presence of the PERSON (input recency), distinct from daemon liveness
  // (users.daemon_last_seen tracks the machine's agent). Read at push time to
  // decide whether the phone needs a copy; goes stale on its own when the tab
  // closes or the machine sleeps.
  user_presence: defineTable({
    user_id: v.id("users"),
    surface: v.string(),
    last_seen: v.number(),
    last_input_at: v.number(),
    focused: v.boolean(),
    updated_at: v.number(),
  }).index("by_user", ["user_id"]),

  // Mobile push staging (pushRouter.ts). Rows wait out a routing delay (short
  // away-debounce, or a longer hold while the desktop is active), then a
  // per-user flush sends everything pending as ONE push — a burst of
  // notifications aggregates instead of buzzing the phone N times. Rows whose
  // notification is read (or superseded away) before the flush are dropped.
  // Rows are deleted on send; the table only ever holds in-flight pushes.
  push_outbox: defineTable({
    user_id: v.id("users"),
    notification_id: v.optional(v.id("notifications")),
    type: v.optional(v.string()),
    title: v.string(),
    // iOS second line ("#team", "thread · #team"). Only a single-row flush
    // shows it — a batch collapses to counts where a subtitle would lie.
    subtitle: v.optional(v.string()),
    body: v.string(),
    data: v.optional(v.any()),
    created_at: v.number(),
    due_at: v.number(),
    deferred: v.boolean(),
  }).index("by_user", ["user_id"]),

  // Fixed-window counters for the IP-keyed rate limiter (ipRateLimit.ts) used on
  // UNAUTHENTICATED endpoints (the auth relay, webhooks) — the existing per-user
  // rate_limits table can't cover them (no userId). Keyed per (endpoint, ip) so
  // counters distribute — no hot doc. Pruned hourly.
  ip_rate_limits: defineTable({
    key: v.string(),
    count: v.number(),
    window_start: v.number(),
  }).index("by_key", ["key"]),

  pending_permissions: defineTable({
    conversation_id: v.id("conversations"),
    session_id: v.string(),
    tool_name: v.string(),
    arguments_preview: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("denied"),
      v.literal("cancelled")
    ),
    created_at: v.number(),
    resolved_at: v.optional(v.number()),
    resolved_by: v.optional(v.id("users")),
    // Denormalized conversation owner so getAllRespondedPermissions can index by
    // (owner, resolved_at) instead of scanning the whole table — the scan made
    // that live per-daemon subscription re-run on every other user's writes.
    owner_user_id: v.optional(v.id("users")),
  })
    .index("by_conversation_status", ["conversation_id", "status"])
    .index("by_session", ["session_id"])
    .index("by_owner_resolved", ["owner_user_id", "resolved_at"]),

  // An explicit decision an agent hands to its human: one question, real
  // options, and enough context to choose without opening the session. Written
  // by `cast decide`; consumed by the web decision queue. Answering happens
  // client-side through the normal message send pipeline — this row only
  // tracks the ask and its resolution, it is never a delivery channel.
  session_decisions: defineTable({
    conversation_id: v.id("conversations"),
    session_id: v.string(),
    // Denormalized owner so the queue subscription indexes by (user, status).
    user_id: v.id("users"),
    question: v.string(),
    // Markdown: the reasoning, the tradeoff, what happens under each choice.
    context_md: v.optional(v.string()),
    options: v.array(
      v.object({
        label: v.string(),
        description: v.optional(v.string()),
      })
    ),
    // Published artifact slug (cast publish) carrying a full HTML report.
    report_slug: v.optional(v.string()),
    // true = the agent ended its turn and is parked on this answer.
    // false = advisory: the agent proceeded with default_option and the
    // human's answer can override it later.
    blocking: v.boolean(),
    default_option: v.optional(v.number()),
    // answered / dismissed are the human's verdicts; withdrawn is the agent
    // taking its own question back (`cast decide cancel`) — the facts changed
    // and there is nothing left to decide.
    status: v.union(
      v.literal("pending"),
      v.literal("answered"),
      v.literal("dismissed"),
      v.literal("withdrawn")
    ),
    answer_index: v.optional(v.number()),
    answer_text: v.optional(v.string()),
    created_at: v.number(),
    // conversation.message_count when the ask landed. The live count minus this
    // is "messages since the ask" — how far the session has run past the
    // question — correct even when the client hasn't loaded that far back.
    asked_message_count: v.optional(v.number()),
    // Last `cast decide edit`. created_at stays the ask time because the queue
    // ranks by age; this is what wakes a card whose text changed underneath it.
    updated_at: v.optional(v.number()),
    resolved_at: v.optional(v.number()),
    resolved_by: v.optional(v.id("users")),
  })
    .index("by_user_status", ["user_id", "status"])
    .index("by_conversation_status", ["conversation_id", "status"])
    // Global recency scan for the email digest sweep: recent pending decisions.
    .index("by_status_created", ["status", "created_at"]),

  // A signed-in link recipient (someone who opened a shared conversation but is
  // neither its owner nor a team member) asking to do more than read: to send
  // messages into the live session — which, since the agent runs whatever it's
  // told, means running commands on the owner's machine. The owner approves once
  // per session; the grant then lets performSessionSend accept that user's sends.
  // Co-writing the draft needs no grant — only firing it into the session does.
  // A signed-in viewer who presented a conversation's share link. Access via a
  // share link requires PRESENTING the token — id knowledge is not a grant
  // (issue #27). Anonymous guests carry the token on every query; signed-in
  // viewers redeem it once here and checkConversationAccess honors the row
  // only while its stored token still matches the conversation's current one,
  // so rotating or revoking the token cuts every past redeemer off.
  share_redemptions: defineTable({
    conversation_id: v.id("conversations"),
    user_id: v.id("users"),
    token: v.string(),
    created_at: v.number(),
  }).index("by_conversation_user", ["conversation_id", "user_id"]),

  collab_grants: defineTable({
    conversation_id: v.id("conversations"),
    grantee_user_id: v.id("users"),
    // The conversation owner whose session is acted on — the one who must approve.
    owner_user_id: v.id("users"),
    status: v.union(
      v.literal("requested"),
      v.literal("granted"),
      v.literal("denied"),
      v.literal("revoked")
    ),
    // Snapshot of the requester so the approve/deny card renders without a join.
    grantee_name: v.optional(v.string()),
    grantee_image: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_conversation", ["conversation_id"])
    .index("by_conversation_grantee", ["conversation_id", "grantee_user_id"])
    .index("by_owner_status", ["owner_user_id", "status"]),

  github_webhook_events: defineTable({
    delivery_id: v.string(),
    event_type: v.string(),
    action: v.optional(v.string()),
    payload: v.string(),
    processed: v.boolean(),
    created_at: v.number(),
  })
    .index("by_delivery_id", ["delivery_id"])
    .index("by_processed", ["processed"]),

  // Which event triggered a GitHub Actions check suite. A check_run names its
  // suite but not the event; the workflow_run delivery for the same suite does.
  github_check_suites: defineTable({
    repository: v.string(),
    suite_id: v.string(),
    event: v.string(),
    workflow_run_id: v.optional(v.string()),
    head_sha: v.optional(v.string()),
    updated_at: v.number(),
  }).index("by_repository_suite", ["repository", "suite_id"]),

  github_app_installations: defineTable({
    team_id: v.id("teams"),
    installation_id: v.number(),
    account_login: v.string(),
    account_type: v.union(v.literal("User"), v.literal("Organization")),
    account_id: v.number(),
    repository_selection: v.union(v.literal("all"), v.literal("selected")),
    repositories: v.optional(v.array(v.object({
      id: v.number(),
      name: v.string(),
      full_name: v.string(),
    }))),
    suspended_at: v.optional(v.number()),
    installed_by_user_id: v.optional(v.id("users")),
    // Health stamps read by the integrations page. issue-sync.md S1.5.
    last_webhook_at: v.optional(v.number()),
    last_sync_at: v.optional(v.number()),
    last_error: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_team_id", ["team_id"])
    .index("by_installation_id", ["installation_id"])
    .index("by_account_login", ["account_login"]),

  github_installation_tokens: defineTable({
    installation_id: v.number(),
    token: v.string(),
    expires_at: v.number(),
    created_at: v.number(),
  }).index("by_installation_id", ["installation_id"]),

  message_shares: defineTable({
    share_token: v.string(),
    message_id: v.id("messages"),
    user_id: v.id("users"),
    context_before: v.optional(v.number()),
    context_after: v.optional(v.number()),
    message_ids: v.optional(v.array(v.id("messages"))),
    note: v.optional(v.string()),
    // When set, the shared page links to the full conversation via its public
    // share_token (minted at share time if the sharer owns the conversation).
    include_conversation_link: v.optional(v.boolean()),
    created_at: v.number(),
  })
    .index("by_share_token", ["share_token"])
    .index("by_message_id", ["message_id"]),

  system_config: defineTable({
    key: v.string(),
    value: v.string(),
    updated_at: v.number(),
    updated_by: v.optional(v.id("users")),
  }).index("by_key", ["key"]),

  agent_tasks: defineTable({
    user_id: v.id("users"),
    // Human-quotable handle ("tr-42"), same counter-allocated shape as tasks
    // (ct-) and plans (pl-). Optional only for rows created before triggers had
    // one; `backfillShortIds` fills those, and every new row gets one at insert.
    // This is what agents quote in prose and what the web renders as a pill —
    // never the 32-char Convex id.
    short_id: v.optional(v.string()),
    title: v.string(),
    prompt: v.string(),
    context_summary: v.optional(v.string()),
    originating_conversation_id: v.optional(v.id("conversations")),
    target_conversation_id: v.optional(v.id("conversations")),
    // Conversation that CREATED this trigger — pure attribution, no routing
    // meaning. originating_conversation_id does double duty (its presence makes
    // runs inject into that session), so a --spawn trigger must leave it empty;
    // this field keeps the parent link anyway, so spawn triggers and their runs
    // still trace back to the session that armed them.
    created_by_conversation_id: v.optional(v.id("conversations")),
    // The creator's raw session uuid, kept when created_by_conversation_id
    // could not be resolved at insert (a trigger armed in the first seconds of
    // a session, before its conversation row synced). Resolved to a
    // conversation at read time by withResolvedRunConversations, exactly like
    // last_run_session_uuid, so the parent link never depends on sync order.
    created_by_session_uuid: v.optional(v.string()),
    project_path: v.optional(v.string()),
    agent_type: v.optional(v.string()),
    // Picker key for the model a SPAWNED run launches on (`opus`, `sonnet`,
    // or a codex model id) — resolved to the client's launch flag by the
    // daemon, same table as `cast spawn --model`. Absent = the agent's saved
    // default. Inline runs ignore it: they inject into a session that already
    // has a model.
    model: v.optional(v.string()),
    // Device that created the task (CLI `cast trigger add`). When set, only
    // that device's scheduler may claim it. Absent on web-created/legacy tasks,
    // which fall back to checkout-existence eligibility.
    created_device_id: v.optional(v.string()),

    schedule_type: v.union(
      v.literal("once"),
      v.literal("recurring"),
      v.literal("event")
    ),
    run_at: v.optional(v.number()),
    interval_ms: v.optional(v.number()),
    event_filter: v.optional(v.object({
      event_type: v.string(),
      action: v.optional(v.string()),
      repository: v.optional(v.string()),
      pr_number: v.optional(v.number()),
    })),

    mode: v.union(v.literal("propose"), v.literal("apply")),
    max_runtime_ms: v.optional(v.number()),

    status: v.union(
      v.literal("scheduled"),
      v.literal("running"),
      v.literal("paused"),
      v.literal("completed"),
      v.literal("failed")
    ),
    lease_holder: v.optional(v.string()),
    lease_expires_at: v.optional(v.number()),
    retry_count: v.number(),
    max_retries: v.optional(v.number()),

    last_run_at: v.optional(v.number()),
    last_run_summary: v.optional(v.string()),
    // True when the last run ended in failTaskRun. Drives the panel's outcome
    // color and gates run auto-fold: a failed previous run must stay visible in
    // the inbox (escalation), only a clean run folds when the next one starts.
    last_run_failed: v.optional(v.boolean()),
    // Agent's explicit escalation from `cast trigger complete --needs-attention`:
    // the run neither auto-folds nor collapses under the schedule's standing row —
    // it stays a real inbox card until the user triages it.
    last_run_needs_attention: v.optional(v.boolean()),
    last_run_conversation_id: v.optional(v.id("conversations")),
    // Claude session UUID of the last spawned run. The daemon assigns it up front
    // via `claude --session-id`; webList resolves it to a conversation at read time
    // (by_session_id), so spawned runs are linkable even if the run's conversation
    // hadn't synced yet at completion. Absent for --context-current runs, which
    // record last_run_conversation_id directly.
    last_run_session_uuid: v.optional(v.string()),
    run_count: v.number(),
    created_at: v.number(),
    // Haiku-generated presentation fields (agentTasks.generateDisplaySummary).
    // Most titles are just prompt.slice(0, 60) — unreadable in rows — so the
    // model distills a short name and a one-sentence gist of what each run
    // does. Regenerated when the prompt changes; display_title yields to an
    // explicit human title.
    display_title: v.optional(v.string()),
    display_summary: v.optional(v.string()),
    // Set when this schedule was canceled as a side effect of killing the
    // session it injects into (cancelTasksBoundToConversation) — distinguishes
    // that from a natural completion, so restoring the session can re-arm
    // exactly the schedules its kill took down. Cleared on reactivation.
    canceled_on_kill_at: v.optional(v.number()),
  })
    .index("by_user_status", ["user_id", "status"])
    .index("by_user_run_at", ["user_id", "run_at"])
    .index("by_status_run_at", ["status", "run_at"])
    .index("by_event_filter", ["status"])
    .index("by_short_id", ["short_id"])
    // Anchor lookups for conversation-scoped visibility (webListForConversation):
    // a trigger armed from a session is findable from that session even when a
    // different account (a remote daemon's bot login) owns the trigger row.
    .index("by_created_by_conversation", ["created_by_conversation_id"])
    .index("by_originating_conversation", ["originating_conversation_id"]),

  // Version history + audit log for trigger edits. One row per edit — both
  // `cast trigger update` and the web edit dialog write through
  // agentTasks.applyTaskUpdate, so neither surface can skip the log. Each row
  // snapshots ALL editable fields as they were BEFORE the edit, making every
  // row a complete prior version (no diff-walking to reconstruct one), and
  // names who changed what from where. The current version is the agent_tasks
  // row itself; `revision` is 1-based and monotonic per task.
  agent_task_revisions: defineTable({
    task_id: v.id("agent_tasks"),
    revision: v.number(),
    // Audit: who made the edit, from which surface.
    actor_user_id: v.id("users"),
    source: v.union(v.literal("cli"), v.literal("web")),
    // Field names the edit actually changed — the log line, without diffing.
    changed_fields: v.array(v.string()),
    // Complete pre-edit snapshot of the editable surface.
    before: v.object({
      title: v.string(),
      prompt: v.string(),
      schedule_type: v.union(v.literal("once"), v.literal("recurring"), v.literal("event")),
      run_at: v.optional(v.number()),
      interval_ms: v.optional(v.number()),
      event_filter: v.optional(v.object({
        event_type: v.string(),
        action: v.optional(v.string()),
        repository: v.optional(v.string()),
        pr_number: v.optional(v.number()),
      })),
      mode: v.union(v.literal("propose"), v.literal("apply")),
      agent_type: v.optional(v.string()),
      model: v.optional(v.string()),
      project_path: v.optional(v.string()),
      max_runtime_ms: v.optional(v.number()),
    }),
    created_at: v.number(),
  }).index("by_task", ["task_id", "revision"]),

  // --- Task Layer: Projects, Tasks, Docs ---

  projects: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    // ACCESS axis — see tasks.workspace.
    workspace: v.optional(v.string()),
    short_id: v.optional(v.string()),
    title: v.string(),
    description: v.optional(v.string()),
    status: v.union(
      v.literal("planning"),
      v.literal("active"),
      v.literal("paused"),
      v.literal("done")
    ),
    color: v.optional(v.string()),
    icon: v.optional(v.string()),
    project_path: v.optional(v.string()),
    target_date: v.optional(v.number()),
    labels: v.optional(v.array(v.string())),

    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_status", ["user_id", "status"])
    .index("by_team_id", ["team_id"])
    .index("by_workspace", ["workspace"])
    .index("by_short_id", ["short_id"]),

  // A post on a project's Updates tab: a human status post or an agent's
  // periodic digest. Untracked by the change feed (same trade as
  // task_comments): every write bumps the parent project's updated_at, and the
  // web reads these through reactive queries, so clients stay fresh without
  // first-class sync plumbing. Access is always derived from the parent
  // project (owner or team member) — rows carry no workspace stamp of their
  // own, so they can never drift from the project's scope.
  project_updates: defineTable({
    project_id: v.id("projects"),
    // Short id ("pu-N") so the CLI can address an update for commenting.
    short_id: v.optional(v.string()),
    user_id: v.id("users"),
    author: v.string(),
    // The person behind the post; absent for agent/system authored rows.
    author_user_id: v.optional(v.id("users")),
    author_kind: v.union(v.literal("user"), v.literal("agent")),
    // "update" = a deliberate post; "digest" = an automated roll-up (the
    // weekly what-changed post). The UI badges digests differently.
    kind: v.union(v.literal("update"), v.literal("digest")),
    title: v.optional(v.string()),
    body: v.string(),
    conversation_id: v.optional(v.id("conversations")),
    created_at: v.number(),
    updated_at: v.number(),
    edited_at: v.optional(v.number()),
  })
    .index("by_project_created", ["project_id", "created_at"])
    .index("by_short_id", ["short_id"]),

  // Discussion under a project update. Mirrors task_comments: flat thread,
  // denormalized project_id so the timeline can scan one index.
  project_update_comments: defineTable({
    update_id: v.id("project_updates"),
    project_id: v.id("projects"),
    author: v.string(),
    author_user_id: v.optional(v.id("users")),
    author_kind: v.union(v.literal("user"), v.literal("agent")),
    text: v.string(),
    conversation_id: v.optional(v.id("conversations")),
    created_at: v.number(),
  })
    .index("by_update_created", ["update_id", "created_at"])
    .index("by_project_created", ["project_id", "created_at"]),


  // Saved list views — a named set of filters/grouping/sort for /tasks, /docs or
  // /plans. These used to live in the owner's client_state bag, which made them
  // per-user by construction: there was nowhere for a teammate to read them
  // from. As a table they can be SHARED, so a view one person tunes shows up on
  // everyone's rail instead of being rebuilt by hand three times.
  //
  // `shared` is the whole access rule: private rows are owner-only, shared rows
  // are readable by any member of the row's team. A shared row without a
  // team_id is a contradiction (nobody to share with), so writes require one.
  saved_views: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    name: v.string(),
    // "workspace" = a layout workbench: a saved arrangement of the chrome
    // itself (rails, panels, sizes) rather than of a list page's filters.
    page: v.union(v.literal("tasks"), v.literal("docs"), v.literal("plans"), v.literal("workspace")),
    // The list preferences this view restores. Deliberately loose: the pages own
    // their own pref vocabularies and grow new filters often, and a view is only
    // ever handed straight back to the page that wrote it.
    prefs: v.any(),
    shared: v.optional(v.boolean()),
    // Presentation, so a rail of views is scannable rather than a wall of text.
    icon: v.optional(v.string()),
    color: v.optional(v.string()),
    // Client-minted idempotency key: an optimistic create writes a stub under
    // this key and the server row supersedes it, so a retried create can never
    // leave two copies of the same view.
    client_key: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_team_id", ["team_id"])
    .index("by_client_key", ["client_key"]),

  // Entity-to-conversation association. Messages stay in the existing
  // conversations/messages substrate; this row only records that a conversation
  // relates to a Task/Plan and how. Existing direct task/plan conversation
  // fields remain part of their existing execution surfaces; new associations
  // also write here (see dispatch.linkConversationToObject).
  //
  // A row whose conversation / task / plan side is hard-deleted lingers:
  // reads re-check access and omit danglers (no leak) and unlink can clear
  // them, so a GC hook on those deleters is deliberately deferred.
  entity_conversations: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    entity_type: linkableEntityTypeValidator,
    entity_id: v.string(),
    conversation_id: v.id("conversations"),
    relationship: v.union(
      v.literal("discussion"),
      v.literal("work"),
      v.literal("investigation"),
      v.literal("evidence"),
    ),
    created_at: v.number(),
  })
    .index("by_entity", ["entity_type", "entity_id"])
    .index("by_conversation", ["conversation_id"]),

  plans: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    // ACCESS axis — see tasks.workspace.
    workspace: v.optional(v.string()),
    project_id: v.optional(v.id("projects")),
    project_path: v.optional(v.string()),
    short_id: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    goal: v.optional(v.string()),
    acceptance_criteria: v.optional(v.array(v.string())),
    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("paused"),
      v.literal("done"),
      v.literal("abandoned"),
    ),
    source: v.union(
      v.literal("human"),
      v.literal("agent"),
      v.literal("insight"),
      v.literal("promoted"),
      v.literal("plan_mode"),
      v.literal("imported"),
    ),
    owner_id: v.optional(v.id("users")),
    task_ids: v.optional(v.array(v.id("tasks"))),
    progress: v.optional(v.object({
      total: v.number(),
      done: v.number(),
      in_progress: v.number(),
      open: v.number(),
    })),
    progress_log: v.optional(v.array(v.object({
      timestamp: v.number(),
      entry: v.string(),
      session_id: v.optional(v.string()),
    }))),
    decision_log: v.optional(v.array(v.object({
      timestamp: v.number(),
      decision: v.string(),
      rationale: v.optional(v.string()),
      session_id: v.optional(v.string()),
    }))),
    discoveries: v.optional(v.array(v.object({
      timestamp: v.number(),
      finding: v.string(),
      session_id: v.optional(v.string()),
    }))),
    context_pointers: v.optional(v.array(v.object({
      label: v.string(),
      path_or_url: v.string(),
    }))),
    // Unified comment/entry timeline (replaces progress_log, decision_log, discoveries, context_pointers for new writes)
    entries: v.optional(v.array(v.object({
      type: v.union(
        v.literal("progress"),
        v.literal("decision"),
        v.literal("discovery"),
        v.literal("reference"),
        v.literal("blocker"),
        v.literal("note"),
      ),
      timestamp: v.number(),
      session_id: v.optional(v.string()),
      content: v.string(),
      author: v.optional(v.string()),
      rationale: v.optional(v.string()),
      path_or_url: v.optional(v.string()),
    }))),
    session_ids: v.optional(v.array(v.id("conversations"))),
    current_session_id: v.optional(v.id("conversations")),
    created_from_conversation_id: v.optional(v.id("conversations")),
    created_from_insight_id: v.optional(v.id("session_insights")),
    doc_id: v.optional(v.id("docs")),
    plan_version: v.optional(v.number()),
    drive_state: v.optional(
      v.object({
        current_round: v.number(),
        total_rounds: v.number(),
        rounds: v.array(
          v.object({
            round: v.number(),
            findings: v.array(v.string()),
            fixed: v.array(v.string()),
            deferred: v.optional(v.array(v.string())),
          }),
        ),
      }),
    ),
    model_stylesheet: v.optional(v.string()),
    fidelity: v.optional(v.union(
      v.literal("full"),
      v.literal("compact"),
      v.literal("summary_high"),
      v.literal("summary_medium"),
      v.literal("summary_low"),
      v.literal("truncate"),
    )),
    retro: v.optional(v.object({
      smoothness: v.string(),
      headline: v.string(),
      learnings: v.array(v.any()),
      friction_points: v.array(v.any()),
      open_items: v.array(v.any()),
      generated_at: v.number(),
    })),
    join_policy: v.optional(v.union(
      v.literal("wait_all"),
      v.literal("first_success"),
      v.literal("k_of_n"),
      v.literal("quorum"),
    )),
    join_k: v.optional(v.number()),
    orchestration_metadata: v.optional(
      v.object({
        wave_count: v.optional(v.number()),
        last_wave_at: v.optional(v.number()),
        agent_count: v.optional(v.number()),
        last_orchestrated_at: v.optional(v.number()),
      }),
    ),
    escalation_log: v.optional(
      v.array(
        v.object({
          task_id: v.optional(v.string()),
          reason: v.string(),
          created_at: v.number(),
          resolved: v.optional(v.boolean()),
        }),
      ),
    ),

    // Workflow binding
    workflow_id: v.optional(v.id("workflows")),
    workflow_run_id: v.optional(v.id("workflow_runs")),

    // Public sharing
    share_token: v.optional(v.string()),

    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_short_id", ["short_id"])
    .index("by_share_token", ["share_token"])
    .index("by_user_id", ["user_id"])
    .index("by_user_status", ["user_id", "status"])
    .index("by_team_id", ["team_id"])
    .index("by_team_status", ["team_id", "status"])
    .index("by_workspace", ["workspace"])
    .index("by_created_from_conversation_id", ["created_from_conversation_id"])
    .index("by_project_id", ["project_id"])
    .index("by_current_session", ["current_session_id"])
    .index("by_doc_id", ["doc_id"]),

  tasks: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    // ACCESS, independent of team_id (which stays routing): "team:<id>" or
    // "user:<id>" — see lib/access.ts workspaceKey. Written at create,
    // recomputed only when a linked conversation's visibility changes.
    workspace: v.optional(v.string()),
    project_id: v.optional(v.id("projects")),
    parent_id: v.optional(v.id("tasks")),
    plan_id: v.optional(v.id("plans")),
    // Client-minted idempotency key for optimistic creates: webCreate returns
    // the existing row for a repeat key, so a retried/replayed create (timeout
    // after commit, lost ack) never inserts a second task.
    client_key: v.optional(v.string()),
    short_id: v.string(),

    title: v.string(),
    description: v.optional(v.string()),
    task_type: v.union(
      v.literal("feature"),
      v.literal("bug"),
      v.literal("task"),
      v.literal("chore")
    ),
    // The status CATEGORY — one of the six canonical values every index,
    // filter and close predicate keys on. A team's custom statuses refine it
    // via status_id below; this field never holds a custom value.
    status: taskStatusCategoryValidator,
    // Id of a team-defined status within the category (teams.task_statuses).
    // Absent = the category's default. Resolution falls back to the category
    // default when the id no longer exists, so deleting a status needs no
    // task migration.
    status_id: v.optional(v.string()),
    priority: v.union(
      v.literal("urgent"),
      v.literal("high"),
      v.literal("medium"),
      v.literal("low"),
      v.literal("none")
    ),

    assignee: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),

    // Manual list rank (fractional; unranked rows fall back to created_at,
    // which shares the ms scale so midpoint inserts stay consistent).
    sort_order: v.optional(v.number()),
    // Short id of the canonical task this one duplicates; set when a human
    // marks a duplicate (which also drops this task).
    duplicate_of: v.optional(v.string()),

    model: v.optional(v.string()),
    verify_with: v.optional(v.string()),
    max_visits: v.optional(v.number()),
    retry_target: v.optional(v.string()),
    thread_id: v.optional(v.string()),
    fidelity: v.optional(v.string()),
    condition: v.optional(v.string()),

    // Dependencies
    blocked_by: v.optional(v.array(v.string())),
    blocks: v.optional(v.array(v.string())),

    // Session linkage
    conversation_ids: v.optional(v.array(v.id("conversations"))),
    created_from_conversation: v.optional(v.id("conversations")),
    created_from_insight: v.optional(v.id("session_insights")),
    last_session_summary: v.optional(v.string()),
    attempt_count: v.optional(v.number()),
    last_attempted_at: v.optional(v.number()),
    retry_count: v.optional(v.number()),
    max_retries: v.optional(v.number()),

    // Origin tracking. "agent" is the catch-all for a task an agent filed from
    // inside its own session; "meeting" is the narrower provenance for a task
    // an agent transcribed out of a human meeting, so the two can be told
    // apart in the UI (a meeting task represents something people agreed to do,
    // an agent task is usually machine bookkeeping). "template" and "fork" are
    // written by plans.instantiateTemplate / plans.fork — they were missing here,
    // so every insert on those two paths failed this validator at runtime.
    source: v.union(
      v.literal("human"),
      v.literal("agent"),
      v.literal("meeting"),
      v.literal("insight"),
      v.literal("import"),
      v.literal("plan_mode"),
      v.literal("todo_sync"),
      v.literal("template"),
      v.literal("fork"),
    ),
    confidence: v.optional(v.number()),
    promoted: v.optional(v.boolean()),
    triage_status: v.optional(v.union(
      v.literal("active"),
      v.literal("suggested"),
      v.literal("dismissed"),
    )),

    // Visibility (inherited from source conversation for mined tasks)
    is_private: v.optional(v.boolean()),
    team_visibility: v.optional(v.union(v.literal("summary"), v.literal("full"), v.literal("private"))),

    // Drive state (iterative polish)
    drive: v.optional(v.object({
      current_round: v.number(),
      total_rounds: v.number(),
      rounds: v.array(v.object({
        round: v.number(),
        findings: v.array(v.string()),
        fixed: v.array(v.string()),
        deferred: v.optional(v.array(v.string())),
      })),
    })),

    // Structured execution (superpowers-style orchestration)
    steps: v.optional(v.array(v.object({
      title: v.string(),
      done: v.optional(v.boolean()),
      verification: v.optional(v.string()),
    }))),
    acceptance_criteria: v.optional(v.array(v.string())),
    execution_status: v.optional(v.union(
      v.literal("done"),
      v.literal("done_with_concerns"),
      v.literal("blocked"),
      v.literal("needs_context"),
    )),
    execution_concerns: v.optional(v.string()),
    verification_evidence: v.optional(v.string()),
    files_changed: v.optional(v.array(v.string())),
    estimated_minutes: v.optional(v.number()),
    actual_minutes: v.optional(v.number()),
    started_at: v.optional(v.number()),
    agent_session_id: v.optional(v.string()),
    wave_number: v.optional(v.number()),
    priority_weight: v.optional(v.number()),
    last_heartbeat: v.optional(v.number()),
    progress_pct: v.optional(v.number()),

    // Workflow binding
    workflow_run_id: v.optional(v.id("workflow_runs")),
    workflow_node_id: v.optional(v.string()),

    project_path: v.optional(v.string()),

    created_at: v.number(),
    // Stamped by every task_comments insert (insertTaskComment): the one field
    // that tells a replica "a joined comment changed" — the sync log carries
    // task rows only, so this is the refetch trigger for cached comments.
    last_comment_at: v.optional(v.number()),
    updated_at: v.number(),
    closed_at: v.optional(v.number()),
    // Provider twin: a Linear issue or a GitHub issue backing this task.
    // Server authored only. docs/architecture/issue-sync.md S1.1.
    external: v.optional(taskExternalValidator),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_status", ["user_id", "status"])
    .index("by_user_updated", ["user_id", "updated_at"])
    .index("by_project_id", ["project_id"])
    .index("by_project_status", ["project_id", "status"])
    .index("by_parent_id", ["parent_id"])
    .index("by_short_id", ["short_id"])
    .index("by_client_key", ["user_id", "client_key"])
    .index("by_team_id", ["team_id"])
    .index("by_team_status", ["team_id", "status"])
    .index("by_team_updated", ["team_id", "updated_at"])
    .index("by_workspace", ["workspace"])
    .index("by_created_from_conversation", ["created_from_conversation"])
    .index("by_workflow_run", ["workflow_run_id"])
    .index("by_assignee_status", ["assignee", "status"])
    .index("by_assignee_updated", ["assignee", "updated_at"])
    // The provider twin lookup: every inbound issue event resolves its task
    // through this one index. issue-sync.md S1.1.
    .index("by_external", ["external.provider", "external.id"])
    .searchIndex("search_tasks_v2", {
      searchField: "title",
      filterFields: ["user_id", "project_id", "status"],
    }),

  orchestration_events: defineTable({
    user_id: v.id("users"),
    plan_id: v.optional(v.id("plans")),
    plan_short_id: v.optional(v.string()),
    task_short_id: v.optional(v.string()),
    event_type: v.union(
      v.literal("agent_spawned"),
      v.literal("agent_completed"),
      v.literal("agent_failed"),
      v.literal("agent_timeout"),
      v.literal("task_completed"),
      v.literal("task_blocked"),
      v.literal("task_needs_context"),
      v.literal("merge_succeeded"),
      v.literal("merge_failed"),
      v.literal("wave_started"),
      v.literal("drive_round_started"),
      v.literal("drive_round_completed"),
      v.literal("plan_completed"),
      v.literal("retro_generated"),
      v.literal("verification_spawned"),
    ),
    detail: v.optional(v.string()),
    metadata: v.optional(v.any()),
    created_at: v.number(),
  })
    .index("by_plan_id", ["plan_id", "created_at"])
    .index("by_plan_short_id", ["plan_short_id", "created_at"])
    .index("by_user_id", ["user_id", "created_at"]),

  progress_events: defineTable({
    user_id: v.id("users"),
    plan_id: v.optional(v.id("plans")),
    plan_short_id: v.optional(v.string()),
    task_short_id: v.optional(v.string()),
    event_type: v.string(),
    detail: v.optional(v.string()),
    metadata: v.optional(v.any()),
    sequence: v.number(),
    created_at: v.number(),
  })
    .index("by_plan_short_id", ["plan_short_id", "sequence"])
    .index("by_plan_id", ["plan_id", "sequence"])
    .index("by_user_id", ["user_id", "created_at"]),

  task_comments: defineTable({
    task_id: v.id("tasks"),
    author: v.string(),
    // The writer when a person wrote it. Absent on agent and system rows, so
    // the Threads unread rule counts them as someone else's.
    author_user_id: v.optional(v.id("users")),
    text: v.string(),
    conversation_id: v.optional(v.id("conversations")),
    comment_type: v.union(
      v.literal("progress"),
      v.literal("blocker"),
      v.literal("review"),
      v.literal("note")
    ),
    image_storage_ids: v.optional(v.array(v.string())),
    // Provider twin of this comment (Linear comment / GitHub issue comment).
    // Set when pulled from the provider or once a pushed comment gets its id
    // back. docs/architecture/issue-sync.md S1.2, S4.
    external: v.optional(taskCommentExternalValidator),
    created_at: v.number(),
  })
    .index("by_task_id", ["task_id"])
    .index("by_task_created", ["task_id", "created_at"])
    .index("by_external", ["external.provider", "external.id"]),

  task_history: defineTable({
    task_id: v.id("tasks"),
    user_id: v.optional(v.id("users")),
    actor_type: v.union(v.literal("user"), v.literal("agent"), v.literal("system")),
    action: v.string(),
    field: v.optional(v.string()),
    old_value: v.optional(v.string()),
    new_value: v.optional(v.string()),
    conversation_id: v.optional(v.id("conversations")),
    created_at: v.number(),
  })
    .index("by_task_id", ["task_id"]),

  docs: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    // ACCESS axis — see tasks.workspace.
    workspace: v.optional(v.string()),
    title: v.string(),
    content: v.string(),
    doc_type: v.union(
      v.literal("plan"),
      v.literal("design"),
      v.literal("spec"),
      v.literal("investigation"),
      v.literal("handoff"),
      v.literal("note")
    ),

    // Hierarchy: parent doc for nesting (Notion-like pages-within-pages)
    parent_id: v.optional(v.id("docs")),
    sort_order: v.optional(v.number()),
    // Explicit doc-to-doc links (wiki-style [[links]])
    linked_doc_ids: v.optional(v.array(v.id("docs"))),

    project_id: v.optional(v.id("projects")),
    task_ids: v.optional(v.array(v.id("tasks"))),
    conversation_id: v.optional(v.id("conversations")),
    related_conversation_ids: v.optional(v.array(v.id("conversations"))),

    source: v.union(
      v.literal("agent"),
      v.literal("human"),
      v.literal("plan_mode"),
      v.literal("file_sync"),
      v.literal("inline_extract"),
      v.literal("import")
    ),
    source_file: v.optional(v.string()),
    plan_id: v.optional(v.id("plans")),

    project_path: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    pinned: v.optional(v.boolean()),

    // Visibility (inherited from source conversation for mined docs)
    is_private: v.optional(v.boolean()),
    team_visibility: v.optional(v.union(v.literal("summary"), v.literal("full"), v.literal("private"))),

    embedding: v.optional(v.array(v.float64())),

    cli_edited_at: v.optional(v.number()),

    // Public sharing
    share_token: v.optional(v.string()),

    // Unified comment/entry timeline (symmetric with plans and tasks)
    entries: v.optional(v.array(v.object({
      type: v.union(
        v.literal("progress"),
        v.literal("decision"),
        v.literal("discovery"),
        v.literal("reference"),
        v.literal("blocker"),
        v.literal("note"),
      ),
      timestamp: v.number(),
      session_id: v.optional(v.string()),
      content: v.string(),
      author: v.optional(v.string()),
      rationale: v.optional(v.string()),
      path_or_url: v.optional(v.string()),
    }))),

    created_at: v.number(),
    updated_at: v.number(),
    archived_at: v.optional(v.number()),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_type", ["user_id", "doc_type"])
    .index("by_parent_id", ["parent_id"])
    .index("by_project_id", ["project_id"])
    .index("by_team_id", ["team_id"])
    .index("by_workspace", ["workspace"])
    .index("by_source_file", ["source_file"])
    .index("by_conversation_id", ["conversation_id"])
    .index("by_share_token", ["share_token"])
    .searchIndex("search_docs_v2", {
      searchField: "title",
      filterFields: ["user_id", "doc_type", "project_id"],
    }),

  // Published HTML artifacts (`cast publish` → codecast.sh/a/<slug>). The HTML
  // body lives in file storage, not the row; the unguessable slug is the only
  // access gate (same model as doc share links). See artifacts.ts.
  artifacts: defineTable({
    slug: v.string(),
    user_id: v.id("users"),
    title: v.string(),
    // Publish identity: re-publishing the same absolute path updates the same
    // artifact (stable URL). Absent for artifacts minted with --new.
    source_path: v.optional(v.string()),
    storage_id: v.id("_storage"),
    size: v.number(),
    version: v.number(),
    // sha-256 of the current content — republishing identical bytes is a no-op
    // instead of a junk history entry. Absent on rows from before history.
    content_hash: v.optional(v.string()),
    // "html" (default when absent) | "markdown" (source_storage_id holds the raw
    // md; storage_id holds the rendered reading-theme HTML) | "bundle" (assets in
    // artifact_assets, storage_id holds the entry HTML).
    kind: v.optional(v.string()),
    source_storage_id: v.optional(v.id("_storage")),
    // Provenance: the session that published this artifact.
    session_short_id: v.optional(v.string()),
    session_conversation_id: v.optional(v.id("conversations")),
    // Owner choice: keep the publishing session off the public page (bar chip
    // and ?meta=1). Absent = the session link is shown.
    hide_session: v.optional(v.boolean()),
    // Owner choice: no viewer discussion on this page. Absent = comments on.
    comments_disabled: v.optional(v.boolean()),
    // Secrets. owner_key grants in-page management (travels only in the URL
    // fragment, #o=). edit_key grants collaborative editing when edit_mode is
    // "link". Both are unguessable random strings, like the slug itself.
    owner_key: v.optional(v.string()),
    edit_key: v.optional(v.string()),
    // Who may publish new versions: absent/"owner" (api_token or owner_key),
    // "link" (edit_key holders too), "team" (owner's team members via web).
    edit_mode: v.optional(v.string()),
    // Access gates, all optional: password (sha256(password + ":" + slug)),
    // email capture wall, expiry.
    password_hash: v.optional(v.string()),
    email_gate: v.optional(v.boolean()),
    expires_at: v.optional(v.number()),
    thumb_storage_id: v.optional(v.id("_storage")),
    // Who created the CURRENT version when it came from a link/team editor
    // (absent for owner publishes). Carried into artifact_versions when the
    // next bump snapshots this version.
    last_edited_by: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_user", ["user_id"])
    .index("by_user_path", ["user_id", "source_path"]),

  // Superseded artifact versions: on republish the previous blob is snapshotted
  // here (instead of deleted) so past versions stay openable. Bounded — see
  // MAX_ARTIFACT_HISTORY in artifacts.ts. Invariant: every storage_id in the
  // artifact tables is referenced by exactly ONE row (rollback copies blobs).
  artifact_versions: defineTable({
    artifact_id: v.id("artifacts"),
    version: v.number(),
    title: v.string(),
    storage_id: v.id("_storage"),
    size: v.number(),
    published_at: v.number(),
    kind: v.optional(v.string()),
    source_storage_id: v.optional(v.id("_storage")),
    session_short_id: v.optional(v.string()),
    // Name of the link/team collaborator who published this version via the
    // in-browser editor; absent for owner publishes.
    edited_by: v.optional(v.string()),
  }).index("by_artifact", ["artifact_id", "version"]),

  // Files of a bundle artifact, one row per (version, path). Pruned with their
  // version. Paths are normalized relative ("img/chart.png", no leading slash).
  artifact_assets: defineTable({
    artifact_id: v.id("artifacts"),
    version: v.number(),
    path: v.string(),
    storage_id: v.id("_storage"),
    content_type: v.string(),
    size: v.number(),
  }).index("by_artifact_version", ["artifact_id", "version", "path"]),

  // Viewer comments. A batch_id groups the comments one viewer submitted
  // together (they arrive in the publishing session as ONE message).
  artifact_comments: defineTable({
    artifact_id: v.id("artifacts"),
    batch_id: v.string(),
    author_name: v.string(),
    author_email: v.optional(v.string()),
    // Verified identity: set when the comment arrived with a valid identity
    // token (artifact_identities), never from viewer-supplied text. The
    // avatar is snapshotted at comment time so the public ?meta=1 shape never
    // needs a user-table join.
    author_user_id: v.optional(v.id("users")),
    author_avatar: v.optional(v.string()),
    // Reply threading: top-level comments have no parent; replies point at a
    // top-level comment (one level deep, like the session comment threads).
    parent_comment_id: v.optional(v.id("artifact_comments")),
    text: v.string(),
    // Opaque anchor JSON from the viewer page (selector/snippet/position);
    // the server never interprets it.
    anchor: v.optional(v.string()),
    // Client-minted idempotency key: a retried submit with the same
    // (artifact, client_id) returns the existing row instead of a twin.
    client_id: v.optional(v.string()),
    version: v.number(),
    status: v.string(), // "open" | "resolved"
    delivered: v.boolean(),
    created_at: v.number(),
  })
    .index("by_artifact", ["artifact_id", "created_at"])
    .index("by_artifact_client_id", ["artifact_id", "client_id"]),

  // View counters, isolated from the artifacts row so beacon writes never churn
  // the row that queries/pages watch.
  artifact_stats: defineTable({
    artifact_id: v.id("artifacts"),
    view_count: v.number(),
    last_viewed_at: v.number(),
  }).index("by_artifact", ["artifact_id"]),

  // Signed-in commenter identity for the sandboxed artifact pages. The pages
  // are an opaque origin (CSP sandbox) and can never read codecast.sh auth, so
  // the web app mints an unguessable token per (user, artifact) that travels
  // back to the page in the #i= fragment — same transport as the owner key.
  // Holding the token lets its bearer comment AS that user on that one
  // artifact, nothing else; it grants no read access and no other writes.
  artifact_identities: defineTable({
    token: v.string(),
    user_id: v.id("users"),
    artifact_id: v.id("artifacts"),
    created_at: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_user_artifact", ["user_id", "artifact_id"]),

  // Email-gate audit: who has seen a gated artifact, per email.
  artifact_viewers: defineTable({
    artifact_id: v.id("artifacts"),
    email: v.string(),
    first_seen: v.number(),
    last_seen: v.number(),
    view_count: v.number(),
  }).index("by_artifact_email", ["artifact_id", "email"]),

  // Live screen of one tmux pane on one machine — the transport that lets the
  // terminal split watch a pane the browser cannot reach on loopback (an agent
  // running on your Mac mini while you sit at a laptop). See
  // convex/terminalStream.ts for the lease protocol and why this is snapshots
  // rather than a byte stream.
  //
  // One row per (user, device, pane), reused forever: the daemon overwrites
  // `frame` in place while a viewer holds the lease, and nothing writes at all
  // once the lease lapses or the screen stops changing. A row is therefore hot
  // only while a human is looking at it, and has exactly one writer, so the
  // usual hot-document contention doesn't apply.
  terminal_frames: defineTable({
    user_id: v.id("users"),
    device_id: v.string(),
    // tmux target (a managed session name, e.g. "cc-abc123").
    target: v.string(),
    // Current screen as tmux printed it (`capture-pane -p -e`): text plus SGR
    // escapes, no scrollback. Absent until the first capture lands.
    frame: v.optional(v.string()),
    // Pane geometry, so the viewer can size its xterm to the real pane instead
    // of reflowing someone else's columns.
    cols: v.optional(v.number()),
    rows: v.optional(v.number()),
    // Where tmux has the cursor. capture-pane returns text only, so without
    // this the viewer's cursor parks at the end of the last line instead of in
    // the agent's input box.
    cursor_x: v.optional(v.number()),
    cursor_y: v.optional(v.number()),
    // Bumped on every pushed frame. The viewer repaints on change; an idle
    // pane pushes nothing, so this is also how "still connected" is told apart
    // from "nothing new" (that's `streamer_seen_at`).
    seq: v.number(),
    // Why the stream stopped producing (pane gone, tmux missing). Cleared by
    // the next good frame.
    error: v.optional(v.string()),
    // Viewer lease. The daemon keeps capturing while now < watch_until and
    // stops on its own the moment it lapses — a closed tab, a killed browser
    // and a lost network all converge on "stop" with no teardown message.
    watch_until: v.number(),
    // Last time the daemon pushed anything for this pane (frame or heartbeat).
    // The viewer shows "connecting" until this moves.
    streamer_seen_at: v.optional(v.number()),
    // Last time a stream_pane command was queued for the device. A viewer
    // renews its lease every few seconds; without this stamp a machine that is
    // asleep or offline would collect one command row per renewal forever.
    requested_at: v.optional(v.number()),
    // While this is in the future a viewer has the pane FOCUSED, so the daemon
    // polls fast enough that the first keystroke of a sentence isn't swallowed
    // by the idle heartbeat. Only pushed forward, never cleared on blur: two
    // tabs on one pane must not switch each other's keyboard off.
    interactive_until: v.optional(v.number()),
    // Keystrokes waiting to reach the pane, as lowercase hex. The viewer
    // appends; the next frame push carries them back and clears this in the
    // same transaction, which is what makes delivery exactly-once. Small and
    // short-lived by construction — the daemon drains it a few times a second
    // while typing, and sendPaneInput refuses to let it grow past a few KB.
    pending_input: v.optional(v.string()),
    updated_at: v.number(),
  }).index("by_user_device_target", ["user_id", "device_id", "target"]),

  // Remote mirror of a local markdown vault: one row per registered vault the
  // user turned mirroring on for (`cast vault mirror <dir> --on`). The daemon on
  // the owning device is the only writer; the browser reads. Mirroring is opt-in
  // and off by default, so a row existing here IS the user's consent. See
  // convex/vaultMirror.ts and shared/contracts/vaultMirror.ts.
  vault_mirrors: defineTable({
    user_id: v.id("users"),
    // Which machine's disk this mirror projects. A vault id is derived from the
    // absolute root path, so two machines with ~/notes produce the SAME vault_id
    // — the device is what tells the two mirrors apart.
    device_id: v.string(),
    vault_id: v.string(),
    name: v.string(),
    root: v.string(),
    note_count: v.number(),
    last_synced_at: v.number(),
    // Reserved for the later sharing tier (directory_team_mappings). Nothing
    // reads it yet: this phase is strictly owner-only.
    is_public: v.optional(v.boolean()),
  })
    .index("by_user", ["user_id"])
    .index("by_user_vault", ["user_id", "vault_id", "device_id"]),

  // Note METADATA only. A body is never a field here: the docs table's 12-per-
  // page clamp exists because Convex materializes whole bodies into a 64MB
  // isolate heap before a handler can strip them, and a vault would hit that
  // harder. Bodies live in ctx.storage; body_storage_id points at one.
  vault_notes: defineTable({
    user_id: v.id("users"),
    device_id: v.string(),
    vault_id: v.string(),
    // Denormalized so a note row renders its vault's name without a join.
    vault_name: v.string(),
    // Vault-relative, "/"-separated.
    path: v.string(),
    title: v.string(),
    mtime: v.number(),
    size: v.number(),
    // 16-hex sha256 prefix — the same digest the loopback /vault/file route
    // serves as its ETag, so local and remote agree on file identity.
    content_hash: v.string(),
    tags: v.array(v.string()),
    // Wiki-link targets as written; the reader resolves them against its own
    // file list (it needs the whole vault to do that, and it has it).
    links: v.array(v.string()),
    heading_count: v.number(),
    is_dir: v.optional(v.boolean()),
    body_storage_id: v.optional(v.id("_storage")),
    // Stamp of the full scan that last touched this row. A `complete` push
    // sweeps rows carrying an older stamp — that is how deletions the daemon
    // never observed as events still reach the mirror.
    scan_id: v.optional(v.string()),
    updated_at: v.number(),
  })
    // A row's identity is (user, vault, DEVICE, path). The device belongs in the
    // key because a vault id is derived from the absolute root path, so two
    // machines that both keep ~/notes produce the same vault_id — without the
    // device in the key their daemons would overwrite each other's rows forever.
    .index("by_user_vault_device", ["user_id", "vault_id", "device_id", "path"])
    // Reader index: one vault across every device the user mirrors it from.
    .index("by_user_vault", ["user_id", "vault_id", "path"])
    .index("by_vault_path", ["vault_id", "path"])
    .index("by_user", ["user_id"]),

  doc_snapshots: defineTable({
    id: v.string(),
    version: v.number(),
    // The full ProseMirror doc serialized as JSON. Stored gzip-compressed in
    // `content_gz` (text compresses ~5-10x) so large docs stay under Convex's
    // 1 MiB per-document limit. `content` is the legacy uncompressed form —
    // still read for rows written before compression; never written anymore.
    content: v.optional(v.string()),
    content_gz: v.optional(v.bytes()),
  }).index("id_version", ["id", "version"]),

  doc_deltas: defineTable({
    id: v.string(),
    version: v.number(),
    clientId: v.union(v.string(), v.number()),
    steps: v.array(v.string()),
  }).index("id_version", ["id", "version"]),

  doc_presence: defineTable({
    doc_id: v.string(),
    user_id: v.id("users"),
    user_name: v.string(),
    user_color: v.string(),
    cursor_pos: v.optional(v.number()),
    anchor_pos: v.optional(v.number()),
    // Live draft text for composer co-presence (doc_id "compose:<conversationId>").
    // Lets each side watch the words the other is forming without a full OT buffer.
    // Unused by the document editor, which only sends cursor/anchor positions.
    draft_text: v.optional(v.string()),
    updated_at: v.number(),
  })
    .index("by_doc", ["doc_id"])
    .index("by_user_doc", ["user_id", "doc_id"]),

  // Huddle roster: one row per (room, member), each member writing ONLY their
  // own row — never a shared room document, so a full room has no hot-document
  // writer pileup. A room is a KEY, not an entity: "dm:<id>:<id>[:<id>…]" (a
  // sorted set of people — a chat DM or group thread huddles in the room of
  // its members), "channel:<chat_channel id>", "session:<conversation id>". It exists
  // while occupied and vanishes when the last row goes stale. Lifetime is a
  // lease (terminal-streaming philosophy): the client heartbeats last_seen
  // in-call, readers filter rows older than CALL_MEMBER_STALE_MS, so a crashed
  // client, killed tab and lost network all converge on "left" with no
  // teardown message. Media itself never touches Convex — this table is the
  // control-plane roster (who is in the room, muted/camera/sharing flags for
  // occupancy chips); audio/video flows through LiveKit.
  call_members: defineTable({
    room_key: v.string(),
    team_id: v.id("teams"),
    user_id: v.id("users"),
    // Denormalized for cheap occupancy-chip paint (no user join per row).
    user_name: v.string(),
    user_image: v.optional(v.string()),
    joined_at: v.number(),
    last_seen: v.number(),
    muted: v.boolean(),
    camera: v.boolean(),
    sharing: v.boolean(),
    // THIS PERSON STEPPED INTO A WALKIE BURST ON PURPOSE, and when.
    //
    // A burst puts everyone who hears it in the room, so being seated says
    // nothing about whether a conversation started. The mic used to answer
    // that — an open mic meant somebody had joined — and it stopped being an
    // answer when auto-listen went hot: every listener's mic is open now, so
    // every listener would read as a conversation.
    //
    // So the intent is stamped rather than inferred. The client sets it only
    // for the deliberate "Join live" gesture, and both sides read it off the
    // roster they already subscribe to: another person's stamp on my walkie
    // room is what turns the strip into the call dock, on their screen and on
    // mine. Absent on every ordinary join, which is why it is optional.
    walkie_joined_at: v.optional(v.number()),
    // NOBODY IS HERE. This row is a media connection held open ahead of a
    // burst, so the first word is audible instead of recorded: opening a DM or
    // resting on a face connects to the SFU early, publishes nothing, and
    // waits. The person has not walked in, cannot hear anyone and cannot be
    // heard.
    //
    // So a prewarm row is not a member, and `liveMembers` drops it — that one
    // helper is what every reader of this table already asks, which is why the
    // rule lives there rather than in each of them. Occupancy chips, "X hears
    // you", the live-rooms list, invite grants and the room's own lease all
    // inherit it. A real join clears the flag on the same row and the seat
    // becomes ordinary.
    prewarm: v.optional(v.boolean()),
  })
    .index("by_room", ["room_key"])
    .index("by_user", ["user_id"])
    .index("by_user_room", ["user_id", "room_key"])
    // Every live huddle in one of my teams (calls.getLiveRooms). A team-wide
    // subscription, so that query bucket-rounds every timestamp it returns and
    // sorts its rooms — a heartbeat writing last_seen must not re-push the
    // whole list to everyone on the team.
    .index("by_team", ["team_id"]),

  // A ring. Sync-driven, not push-driven: the recipient's client subscribes to
  // its own ringing rows (calls.getMyCalls) and renders the toast/sound
  // locally. TTL'd — a ring older than CALL_INVITE_TTL_MS reads as expired and
  // is deleted opportunistically by the next mutation that touches the pair,
  // so no cron and no zombie ringing. One active ring per (from,to) pair at a
  // time; re-inviting refreshes the existing row.
  call_invites: defineTable({
    room_key: v.string(),
    team_id: v.id("teams"),
    from_user: v.id("users"),
    to_user: v.id("users"),
    status: v.union(
      v.literal("ringing"),
      v.literal("accepted"),
      v.literal("declined"),
      v.literal("cancelled"),
      v.literal("expired"),
    ),
    // The ring's context line, ready to read under "<caller> wants to
    // huddle": "about: <session title>", "with Sam, Ana", "#design". Rendered
    // verbatim by the web toast, the push body and the phone's ring screen.
    // Resolved at invite time under the CALLER's visibility — the callee is
    // being invited into it, which is exactly the sharing gesture.
    anchor_title: v.optional(v.string()),
    created_at: v.number(),
    // Set when the recipient answers either way; lets the caller's UI settle.
    responded_at: v.optional(v.number()),
  })
    .index("by_to_status", ["to_user", "status"])
    // The invite grant (callRooms.acceptedInviteGrant): "was I rung into
    // THIS room" — the door a non-member enters a live huddle through.
    .index("by_to_room", ["to_user", "room_key"])
    .index("by_from_status", ["from_user", "status"])
    .index("by_room", ["room_key"]),

  // A room's door. Huddles are open by default (a live room admits any member
  // of its billing team — callRooms.openRoomDoor), so this table exists only
  // to say "not right now": one row per room, written by whoever is inside.
  // A lock belongs to the huddle that set it, not to the room, so it dies
  // with that huddle — joinRoom clears it (clearRoomState) whenever the room
  // restarts from empty, exactly like the invite grants. Locking never
  // touches membership or grants: the people whose room it is, and anyone
  // rung in, still walk through.
  call_room_state: defineTable({
    room_key: v.string(),
    team_id: v.id("teams"),
    locked: v.boolean(),
    locked_by: v.id("users"),
    // The huddle's opt-out from transcription. Every huddle transcribes by
    // default (any deliberate participant's client becomes the scribe), so
    // "stop transcribing" has to be a fact about the ROOM or the next client
    // to look would simply start again. Same lifetime as the lock: it belongs
    // to this huddle and dies with it.
    transcribe_off: v.optional(v.boolean()),
    updated_at: v.number(),
  }).index("by_room", ["room_key"]),

  // A knock at a locked room. Not a request queue: TTL'd like a ring
  // (CALL_KNOCK_TTL_MS), refreshed rather than duplicated, and swept by the
  // next mutation that touches the room. Admitting is not new machinery —
  // someone inside rings the knocker with the ordinary `invite` mutation and
  // the accepted-invite grant lets them in.
  call_knocks: defineTable({
    room_key: v.string(),
    team_id: v.id("teams"),
    from_user: v.id("users"),
    created_at: v.number(),
  }).index("by_room", ["room_key"]),

  // A huddle transcription session ("scribe"). One row per recording run,
  // owned by whoever toggled Transcribe on — that client holds every audio
  // track (its own mic + each subscribed remote track), transcribes each
  // track separately, and writes attributed segments below. Attribution is
  // therefore STRUCTURAL: one LiveKit track = one participant, no diarization.
  // Routes say where the words go: an agent session (delivered like `cast
  // send`, so the agent replies in its own thread), a doc (appended), or a
  // linked Slack channel. mode "live" ships accumulated segments every time
  // the room goes quiet (server VAD gap) — which is exactly the beat where an
  // agent should speak up; "after" ships one transcript at stop.
  transcripts: defineTable({
    room_key: v.string(),
    team_id: v.id("teams"),
    started_by: v.id("users"),
    status: v.union(v.literal("live"), v.literal("ended")),
    started_at: v.number(),
    ended_at: v.optional(v.number()),
    title: v.optional(v.string()),
    // A transcript IS the durable call object (the calls page, cast calls).
    // Who spoke — accumulated from segment speaker ids as they append, so it
    // reflects actual voices, not seat leases.
    participants: v.optional(
      v.array(v.object({ id: v.string(), name: v.string() })),
    ),
    // Generated when the transcript ends (internal.transcripts.generateSummary):
    // a few sentences of what happened, plus extracted action items.
    summary: v.optional(v.string()),
    action_items: v.optional(v.array(v.string())),
    summary_status: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("done"),
        v.literal("failed"),
        // Too little was said to summarize.
        v.literal("skipped"),
      ),
    ),
    routes: v.array(
      v.object({
        kind: v.union(v.literal("session"), v.literal("doc"), v.literal("slack")),
        // session: conversation short id or id (sendSessionMessage resolves);
        // doc: docs._id; slack: channel id of a linked channel.
        target: v.string(),
        mode: v.union(v.literal("live"), v.literal("after")),
        // Watermark: segments with seq <= this have been delivered.
        sent_seq: v.number(),
        // Who pointed this route at the call. Delivery acts as this user (a
        // participant feeding an agent speaks as themselves); absent on routes
        // the scribe configured before this field existed → started_by.
        added_by: v.optional(v.id("users")),
      }),
    ),
    // Monotonic per-transcript segment counter (writer-owned; the scribe is
    // the only appender, so no contention).
    last_seq: v.number(),
    // A RECORDING'S LEASE. A huddle's transcript is kept alive by the room's
    // seat leases (call_members), and the orphan sweep ends it when they go
    // stale. A recording has no room and therefore no seats, so it carries the
    // lease itself: the engine beats this field while it records, and a
    // transcript whose beat went stale is a browser tab that died mid-sentence.
    // Same window, same reason, one less table.
    last_beat: v.optional(v.number()),
    // The audio, when there is any. A recording (`rec:` room key) uploads what
    // its microphone heard once it stops; a huddle has no single recording to
    // keep. Best effort by design — the transcript is the artifact, and a
    // failed upload must never cost anyone their words.
    recording_storage_id: v.optional(v.id("_storage")),
    // Reading the words back OUT of that audio, for a recorder that had no
    // recognizer of its own. A phone cannot stream microphone audio to the live
    // recognizer — React Native has no AudioContext — so its recording arrives
    // as a finished file with an empty transcript, and the server transcribes
    // it once the upload lands. Absent on every transcript that got its words
    // live, which is every huddle and every desktop recording that worked.
    transcribe_status: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("done"),
        // The audio is there and playable; the words could not be read out of
        // it. Said plainly in the UI rather than left spinning.
        v.literal("failed"),
      ),
    ),
    // A recording (`rec:` room key) its creator shared into a team. Absent or
    // false is every recording's birth state: private to the creator, whatever
    // team_id says (team_id is routing, never access — canReadCall is the
    // gate). Meaningless on huddles, which have the room's own rules.
    rec_shared: v.optional(v.boolean()),
  })
    .index("by_room", ["room_key"])
    .index("by_status", ["status"])
    // The calls page / cast calls: a team's call history, newest first.
    .index("by_team_started", ["team_id", "started_at"])
    // The same page's personal shelf: everything I started, newest first —
    // how a recording is found regardless of which team it was filed under.
    .index("by_creator_started", ["started_by", "started_at"]),

  transcript_segments: defineTable({
    transcript_id: v.id("transcripts"),
    seq: v.number(),
    speaker_id: v.string(),
    speaker_name: v.string(),
    text: v.string(),
    // Milliseconds since transcript start (scribe's clock, one clock for all
    // tracks, so cross-speaker ordering is honest).
    t0: v.number(),
    t1: v.number(),
  })
    .index("by_transcript_seq", ["transcript_id", "seq"]),

  // Text chat alongside a huddle: one thread per room, visible on the call
  // stage and the call page. Keyed by room (not transcript) so the chat works
  // before anyone toggles transcription and persists across a room's calls.
  call_chat_messages: defineTable({
    room_key: v.string(),
    team_id: v.optional(v.id("teams")),
    user_id: v.id("users"),
    text: v.string(),
  })
    .index("by_room", ["room_key"]),

  workflows: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    name: v.string(),
    slug: v.string(),
    goal: v.optional(v.string()),
    source: v.optional(v.string()),
    nodes: v.array(v.object({
      id: v.string(),
      label: v.string(),
      shape: v.string(),
      type: v.string(),
      prompt: v.optional(v.string()),
      script: v.optional(v.string()),
      reasoning_effort: v.optional(v.string()),
      model: v.optional(v.string()),
      max_visits: v.optional(v.number()),
      max_retries: v.optional(v.number()),
      retry_target: v.optional(v.string()),
      goal_gate: v.optional(v.boolean()),
      backend: v.optional(v.string()),
    })),
    edges: v.array(v.object({
      from: v.string(),
      to: v.string(),
      label: v.optional(v.string()),
      condition: v.optional(v.string()),
    })),
    model_stylesheet: v.optional(v.string()),
    is_private: v.optional(v.boolean()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_team_id", ["team_id"])
    .index("by_user_slug", ["user_id", "slug"]),

  workflow_runs: defineTable({
    user_id: v.id("users"),
    workflow_id: v.optional(v.id("workflows")),
    task_id: v.optional(v.id("tasks")),
    plan_id: v.optional(v.id("plans")),
    status: v.union(v.literal("pending"), v.literal("running"), v.literal("paused"), v.literal("completed"), v.literal("failed")),
    current_node_id: v.optional(v.string()),
    node_statuses: v.array(v.object({
      node_id: v.string(),
      status: v.union(v.literal("pending"), v.literal("running"), v.literal("completed"), v.literal("failed")),
      outcome: v.optional(v.string()),
      session_id: v.optional(v.string()),
      started_at: v.optional(v.number()),
      completed_at: v.optional(v.number()),
      // Dynamic-workflow agents carry their own label/phase/tokens (no stored graph to look them up in)
      label: v.optional(v.string()),
      phase: v.optional(v.string()),
      tokens: v.optional(v.number()),
      result_preview: v.optional(v.string()),
      // Live "what it's doing" line for a running agent (runtime's last tool-call summary)
      activity: v.optional(v.string()),
    })),
    goal_override: v.optional(v.string()),
    project_path: v.optional(v.string()),
    primary_session_id: v.optional(v.string()),
    primary_conversation_id: v.optional(v.id("conversations")),
    tmux_session: v.optional(v.string()),
    gate_prompt: v.optional(v.string()),
    gate_choices: v.optional(v.array(v.object({
      key: v.string(),
      label: v.string(),
      target: v.string(),
    }))),
    gate_response: v.optional(v.string()),
    fail_reason: v.optional(v.string()),
    // "routine" = our DOT-graph runs (default/legacy); "workflow" = Anthropic dynamic workflows
    run_kind: v.optional(v.union(v.literal("routine"), v.literal("workflow"))),
    external_run_id: v.optional(v.string()), // the runtime's wf_<id>; idempotent upsert key for snapshot ingest
    workflow_name: v.optional(v.string()),
    phases: v.optional(v.array(v.object({ title: v.string(), detail: v.optional(v.string()) }))),
    total_tokens: v.optional(v.number()),
    agent_count: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_workflow_id", ["workflow_id"])
    .index("by_external_run", ["external_run_id"])
    .index("by_status", ["status"]),

  client_state: defineTable({
    user_id: v.id("users"),
    current_conversation_id: v.optional(v.string()),
    show_dismissed: v.optional(v.boolean()),
    dismissed_ids: v.optional(v.array(v.string())),

    // Client preference bags — typed on the client via ClientUI/ClientLayouts/etc.
    // Using v.any() so new prefs don't require schema migrations.
    ui: v.optional(v.any()),
    layouts: v.optional(v.any()),
    dismissed: v.optional(v.any()),
    tips: v.optional(v.any()),

    drafts: v.optional(v.any()),
    tabs: v.optional(v.any()),
    activeTabId: v.optional(v.string()),

    // deprecated: kept for backward compat during migration
    sidebar_collapsed: v.optional(v.boolean()),
    zen_mode: v.optional(v.boolean()),
    layout: v.optional(v.object({
      sidebar: v.number(),
      main: v.number(),
    })),

    updated_at: v.number(),
  })
    .index("by_user_id", ["user_id"]),

  // Strict server revisions for named local materialized-view contracts. These
  // are deliberately independent from change_log: a revision is advanced in
  // the same Convex transaction as every write that can affect the complete
  // view, whereas change_log is a best-effort repair signal ordered by wall
  // clock time. Clients compare revisions only within one exact
  // principal+contract+view domain.
  local_view_heads: defineTable({
    principal_id: v.id("users"),
    contract_id: v.string(),
    view_key: v.string(),
    revision: v.number(),
    updated_at: v.number(),
  })
    .index("by_principal_contract_view", ["principal_id", "contract_id", "view_key"]),

  // Durable, principal-scoped idempotency receipts for the v2 local command
  // protocol. Receipts are retained indefinitely in the initial protocol; a
  // future compactor must first negotiate a retry horizon with supported
  // clients. A SHA-256 fingerprint of canonical validated arguments prevents a
  // command id from being reused for different intent without retaining user
  // payload content in this long-lived table.
  local_command_receipts: defineTable({
    principal_id: v.id("users"),
    command_id: v.string(),
    command_name: v.string(),
    receipt_version: v.number(),
    argument_fingerprint: v.string(),
    status: v.union(v.literal("acknowledged"), v.literal("rejected")),
    result: v.optional(v.any()),
    rejection_code: v.optional(v.string()),
    rejection_message: v.optional(v.string()),
    correction: v.optional(v.any()),
    coverage: v.array(v.union(
      // Existing complete-view revision coverage (shape retained verbatim).
      v.object({
        contract_id: v.string(),
        view_key: v.string(),
        revision: v.number(),
      }),
      // Payload-free proof required by append/echo views such as messages.
      v.object({
        kind: v.literal("command-id"),
        contract_id: v.string(),
        view_key: v.string(),
        command_id: v.string(),
      }),
    )),
    created_at: v.number(),
  })
    .index("by_principal_command", ["principal_id", "command_id"])
    .index("by_principal_created", ["principal_id", "created_at"]),

  daemon_logs: defineTable({
    user_id: v.id("users"),
    level: v.union(
      v.literal("debug"),
      v.literal("info"),
      v.literal("warn"),
      v.literal("error")
    ),
    message: v.string(),
    metadata: v.optional(v.object({
      session_id: v.optional(v.string()),
      error_code: v.optional(v.string()),
      stack: v.optional(v.string()),
      command: v.optional(v.string()),
      args: v.optional(v.string()),
      error: v.optional(v.string()),
    })),
    daemon_version: v.optional(v.string()),
    platform: v.optional(v.string()),
    timestamp: v.number(),
  })
    // Deliberately the ONLY index: this is the highest-row-count table in the
    // DB (telemetry), and every index multiplies both its footprint in the
    // Convex `indexes` table and the tombstone cost of pruning it. user_id
    // lookups use this index's prefix; there is no by-level query path.
    .index("by_user_timestamp", ["user_id", "timestamp"]),

  plan_templates: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    name: v.string(),
    description: v.optional(v.string()),
    goal_template: v.optional(v.string()),
    task_templates: v.array(
      v.object({
        title: v.string(),
        description: v.optional(v.string()),
        task_type: v.optional(v.string()),
        priority: v.optional(v.string()),
        blocked_by_indices: v.optional(v.array(v.number())),
        estimated_minutes: v.optional(v.number()),
      }),
    ),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_team_id", ["team_id"]),

  entity_subscriptions: defineTable({
    user_id: v.id("users"),
    entity_type: v.union(
      v.literal("task"),
      v.literal("doc"),
      v.literal("plan"),
      v.literal("conversation"),
      v.literal("artifact"),
      // Chat notifications never fan out over this table — the sender computes the
      // recipient list and re-checks channel access for each one, because a chat
      // preview carries real message text. This member exists only so the
      // notification and subscription entity unions stay one shape. Should a row
      // ever appear, `emit` re-checks team membership for a chat_channel entity
      // and both membership-removal paths (`teams.removeMember` and
      // `teams.removeFromTeam`) delete the rows of a departing member.
      v.literal("chat_channel"),
      // Device alerts go straight to the machine's owner, so nothing subscribes
      // to a device either. Present for the same reason: one shape.
      v.literal("device")
    ),
    entity_id: v.string(),
    reason: v.union(
      v.literal("creator"),
      v.literal("assignee"),
      v.literal("mentioned"),
      v.literal("commenter"),
      v.literal("watching")
    ),
    // Who performed the act that enrolled this user. "human": a person typed
    // it (web, manual CLI, meeting, human board origin). "agent": an agent
    // acting under the owner's token. Absent = legacy row, classified by the
    // retroactive sweep. Membership rules (thread inbox) read this; identity
    // alone never implies attention.
    via: v.optional(v.union(v.literal("human"), v.literal("agent"))),
    muted: v.boolean(),
    created_at: v.number(),
  })
    .index("by_entity", ["entity_type", "entity_id"])
    .index("by_user", ["user_id", "entity_type"])
    .index("by_user_entity", ["user_id", "entity_type", "entity_id"]),

  counters: defineTable({
    name: v.string(),
    value: v.number(),
  })
    .index("by_name", ["name"]),

  // Cross-entity change feed — the per-user "what changed" log that lets a
  // client returning online catch up on EVERY change (including deletes) across
  // conversations, tasks, docs and plans, without re-reading whole lists and
  // diffing. One row PER ENTITY (not per change): every write upserts the row's
  // `seq` to now, so the table is bounded by entity count, not change volume.
  // The write interceptor in functions.ts is the sole writer (see changeLog.ts).
  //  - entity_id      the entity's _id as a string (entity_type says which table)
  //  - op             "upsert" (created/changed) | "delete" (hard-deleted)
  //  - owner_user_id  the entity's user_id — owner-scope catch-up (the inbox)
  //  - team_id        the entity's team_id when shared — team-scope catch-up
  //  - seq            Date.now() at write time; the monotonic cursor clients track
  change_log: defineTable({
    entity_type: v.union(
      v.literal("conversations"),
      v.literal("tasks"),
      v.literal("docs"),
      v.literal("plans"),
      v.literal("projects"),
    ),
    entity_id: v.string(),
    op: v.union(v.literal("upsert"), v.literal("delete")),
    owner_user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    seq: v.number(),
  })
    .index("by_entity", ["entity_id"])
    .index("by_owner_seq", ["owner_user_id", "seq"])
    .index("by_team_seq", ["team_id", "seq"]),

  // ── Sync log ────────────────────────────────────────────────────────────────
  // Append-only per-scope sync action log (docs/architecture/sync-log-migration.md).
  // Supersedes change_log's Date.now() heuristic for NEW clients; change_log stays
  // dual-written for deployed bundles. The write interceptor in functions.ts is
  // the sole writer (see syncLog.ts). `position` is allocated from sync_heads in
  // the same serializable transaction as the domain write, so per scope it is
  // strictly increasing and a reader who has applied up to a head has provably
  // seen every action at or below it. `ts` is retention/debug metadata only —
  // never an ordering key.
  sync_actions: defineTable({
    // "user:<userId>" | "team:<teamId>" — same vocabulary as the workspace key.
    scope_key: v.string(),
    position: v.number(),
    entity_type: v.union(
      v.literal("conversations"),
      v.literal("tasks"),
      v.literal("docs"),
      v.literal("plans"),
      v.literal("projects"),
      // Scope membership lifecycle: entity_id is the team id, op is
      // scope_added | scope_removed, emitted in the affected USER's scope.
      v.literal("scope"),
    ),
    entity_id: v.string(),
    op: v.union(
      v.literal("upsert"),
      v.literal("delete"),
      v.literal("scope_added"),
      v.literal("scope_removed"),
    ),
    ts: v.number(),
    // ── Cargo (docs/architecture/sync-log-cargo.md E1–E3) ──
    // The changed TOP-LEVEL fields as a merge patch ({ field: value }); `unset`
    // lists removed fields; `full` marks a whole-document patch (insert/replace,
    // self-heal) that needs no base row; `partial` marks a payload dropped by
    // the size guard or the cargo kill switch — the client applies what is here
    // and refetches the row. Denylisted (OMIT-class) fields are dropped silently
    // and only their NAMES ride in `omitted`; they never mark partial (E3).
    // Absent `patch` with op upsert means "no cargo": the client falls back to
    // the authorized byIds fetch (old rows, kill switch).
    patch: v.optional(v.any()),
    unset: v.optional(v.array(v.string())),
    full: v.optional(v.boolean()),
    partial: v.optional(v.boolean()),
    omitted: v.optional(v.array(v.string())),
    // ── Access stamp (E4) — enforced at READ by getRange, never by scope_key ──
    // scope_key stays ROUTING (which scopes the row fans to). These three say
    // who may read the cargo: the owner, explicit grants (a task's assignee),
    // and holders of the workspace access key. getRange projects a row the
    // caller may not read to a bare delete. Stamped from the post-write
    // document; a write that changes access is itself an action, so readers
    // who lose access see the delete on their next range.
    access_owner: v.optional(v.string()),
    access_key: v.optional(v.string()),
    access_grants: v.optional(v.array(v.string())),
  })
    .index("by_scope_position", ["scope_key", "position"])
    // Coalescing lookup: is this entity's latest action already at the head?
    .index("by_scope_entity", ["scope_key", "entity_id"])
    .index("by_ts", ["ts"]),

  // One row per scope: the head position (highest allocated) and the floor
  // (highest position retired by retention; a client whose cursor is below the
  // floor must resync via full backfill). Heads are never deleted.
  sync_heads: defineTable({
    scope_key: v.string(),
    position: v.number(),
    floor: v.number(),
    updated_at: v.number(),
  })
    .index("by_scope", ["scope_key"]),

  // ── Team chat ───────────────────────────────────────────────────────────────
  // A Slack-shaped chat inside codecast: channels, private channels, DMs, flat
  // threads, mentions, reactions, read state. Five tables, all routed to ONE
  // team.
  //
  // Scope notes:
  //  - A public channel (kind absent) is visible to every member of its team.
  //    Private channels and DMs gate on `chat_channel_members` rows on top of
  //    the team check — `canAccessChannel` (chatAccess.ts) is the one gate for all
  //    three kinds, and every read and write goes through it.
  //  - Nothing here denormalizes a counter onto a shared row. `last_message_at`
  //    and `message_count` on the channel would make EVERY member a writer of the
  //    same document on every send — the hot-document pattern that has cost this
  //    database three incidents, and that terminal_frames is explicitly allowed to
  //    skip only because it "has exactly one writer". The channel rail instead
  //    reads one row per channel off `by_channel_created` descending, which gives
  //    the sort key and the preview text together.
  //  - Thread rollups ("3 replies", participant faces) are derived the same way,
  //    from `by_thread_created`, so a reply never re-versions the fattest row in
  //    the table and a tombstoned reply cannot leave a stale count behind.
  //
  // The three PATCHED tables — channels, messages, reads — carry `updated_at`
  // and EVERY patch must bump it. The web store's sync layer keeps the previous
  // object identity when no *scalar* field changed
  // (syncProtocol.scalarFieldsEqual deliberately skips arrays and objects), so a
  // patch that only touches `mentions` or `attachments` would be silently
  // dropped on the way to the UI. chat.ts funnels all writes through `patchChat`
  // so this cannot be forgotten, and its signature admits exactly those three
  // table ids. `chat_reactions` is insert-or-delete only and carries no
  // `updated_at`: there is no patch to bump.

  chat_channels: defineTable({
    // ROUTING only — which team's chat surface this room appears in. Access is
    // decided by `kind` + membership, never by this field (the locked contract:
    // team_id routes, a separate access answer gates).
    team_id: v.id("teams"),
    // Slug, lowercase, unique per team on a best-effort basis only. Routing is by
    // _id — two concurrent creates can both pass the uniqueness read, so a name
    // must never be the thing that resolves to a channel row.
    // For a DM the name is "" — identity is the member set, and the client
    // renders the other side's names instead.
    name: v.string(),
    // Absent = "public" (every pre-membership channel). "private" and "dm" are
    // readable/writable only by their chat_channel_members rows. A DM is a
    // private room whose member set IS its identity: no name, no rename, no
    // invite affordance beyond group-DM creation.
    kind: v.optional(v.union(v.literal("public"), v.literal("private"), v.literal("dm"))),
    // ACCESS, workspaceKey-shaped: "team:<id>" for public, "restricted:<own id>"
    // for private/dm. Stamped so the workspace redesign's predicate can adopt
    // chat without a migration; chat's own gate is canAccessChannel.
    workspace: v.optional(v.string()),
    // Sorted member ids joined with ":" — the openDm idempotency key, so opening
    // the same conversation twice finds the same room. Set only when kind="dm".
    dm_key: v.optional(v.string()),
    topic: v.optional(v.string()),
    // The channel a new team member lands in. Team admins only.
    is_default: v.optional(v.boolean()),
    created_by: v.id("users"),
    created_at: v.number(),
    updated_at: v.number(),
    // null, not field-removal, when restored: a client's delta sync cannot see
    // an ABSENT field (absence means "no information" in an overlay), so a
    // restore that deletes the field leaves every client archived forever.
    archived_at: v.optional(v.union(v.number(), v.null())),
    // Optimistic-create altKey: the store writes a `chatstub-…` row carrying this
    // and the server row supersedes it when it syncs back.
    client_id: v.optional(v.string()),
  })
    // Prefix-matches serve "every channel in this team", so no separate by_team.
    .index("by_team_name", ["team_id", "name"])
    .index("by_client_id", ["client_id"])
    .index("by_dm_key", ["dm_key"]),

  // Who is inside a private channel or DM — the session_owners shape: one row
  // per (channel, member), provenance on the row, membership checked on
  // by_channel_user. Public channels have NO rows here; their audience is the
  // team, and writing rows for them would create a second membership model that
  // could disagree with the first.
  chat_channel_members: defineTable({
    channel_id: v.id("chat_channels"),
    user_id: v.id("users"),
    added_by: v.id("users"),
    added_at: v.number(),
  })
    // "Which private rooms am I in" — the rail merge for private/dm channels.
    .index("by_user", ["user_id"])
    // Roster of one room (member list, DM name derivation, notification fan-out).
    .index("by_channel", ["channel_id"])
    // The membership check and the add/remove dedupe.
    .index("by_channel_user", ["channel_id", "user_id"]),

  chat_messages: defineTable({
    // Denormalized from the channel so scope checks and the search index don't
    // need a second read. Derived on insert, never a mutation argument.
    team_id: v.id("teams"),
    channel_id: v.id("chat_channels"),
    // Threads are FLAT, like Slack's: a reply points at the ROOT message and a
    // root leaves this absent. Never set it to the row's own id — the thread view
    // reads the root by id and the replies by index, and a self-reference would
    // put the root in both halves.
    thread_root_id: v.optional(v.id("chat_messages")),
    // Slack's "also send to #channel": a thread reply that ALSO shows in the
    // channel timeline. Only meaningful with thread_root_id set — the channel
    // list includes replies carrying this flag, and nothing else changes: the
    // row still lives in its thread, still counts in the rollup.
    broadcast: v.optional(v.boolean()),
    // The author. For an anchor's reply this is the anchor's `bot_user_id`.
    user_id: v.id("users"),
    author_kind: v.optional(v.union(v.literal("user"), v.literal("agent"))),
    content: v.string(),
    // Resolved SERVER-side by parsing `content` against the team roster. Never a
    // caller argument: a client-supplied id array is a notification cannon.
    mentions: v.optional(v.array(v.id("users"))),
    // "here" notifies the members who are actually present (user_presence).
    // `@channel` is deliberately absent in v1 — on a team small enough to share
    // one codecast workspace it is the same blast radius with worse manners.
    mention_scope: v.optional(v.literal("here")),
    attachments: v.optional(v.array(v.object({
      storage_id: v.id("_storage"),
      name: v.optional(v.string()),
      mime: v.optional(v.string()),
      width: v.optional(v.number()),
      height: v.optional(v.number()),
    }))),
    // Push-to-talk. Present only on a walkie burst, which is an ordinary chat
    // message written in three steps: created "live" while the sender holds the
    // key, transcript streaming into `content`, then finalized with the audio.
    // The audio is a NORMAL attachment above (mime audio/webm) — a voice message
    // is a message with a recording, not a second kind of row, so playback,
    // search, permalinks and threads need nothing new. See
    // @codecast/shared/chat isLiveVoiceRow: a live row renders but has not
    // notified, so it counts for nothing until it is done.
    voice: v.optional(v.object({
      status: v.union(v.literal("live"), v.literal("done"), v.literal("canceled")),
      duration_ms: v.optional(v.number()),
      // The call room the burst was spoken into, so a teammate who sees it can
      // join the conversation. A join still runs through authorizeRoom, so this
      // string grants nothing on its own.
      room_key: v.optional(v.string()),
      // The words are being recovered from the recording right now. Set when a
      // burst lands carrying audio and no transcript — the live recognizer was
      // down, or heard nothing — and cleared by the action that transcribes it.
      // The bubble reads it to say "getting the words" instead of showing a
      // finished voice note that looks like it was said in silence.
      transcribing: v.optional(v.boolean()),
    })),
    // A huddle digest: the row a finished huddle leaves in the room it was held
    // in (transcripts.setSummary → chat.postCallDigest). `content` holds the
    // summary markdown so every client paints it from the row; this names the
    // transcript so the web can unfold the whole speaker-attributed transcript
    // inline. Written by the server only, as the scribe, once per transcript.
    call: v.optional(v.object({
      transcript_id: v.id("transcripts"),
    })),
    // Optimistic altKey AND the server's send-dedupe key: a retried send with the
    // same client_id returns the existing row instead of inserting a twin (and,
    // critically, does not wake the anchor a second time).
    client_id: v.optional(v.string()),
    // "agent" = this line was typed by a codecast session running as its human
    // host, not by the human. The author is still that human (`user_id`), so it
    // is not `author_kind` — that word is reserved for the anchor's own replies.
    // It exists so the anchor wake path can refuse to run a billed turn on
    // somebody's laptop because a machine asked for one. Self-declared by the
    // CLI, so it is an honest downgrade rather than a boundary: a caller who
    // omits it is treated exactly as a human, which is what it already was.
    origin: v.optional(v.literal("agent")),
    // Which session typed it, when `origin` is "agent" — so the line renders as
    // that session (agent logo + session title) instead of wearing the human's
    // face for words a machine wrote. Title/agent_type are a send-time snapshot,
    // taken server-side only when the sender OWNS the session (a caller-supplied
    // id must not leak someone else's private title into a channel). A viewer
    // who can see the session live shows its current title instead; the
    // snapshot is the fallback for everyone else.
    origin_session_id: v.optional(v.string()),
    origin_session_title: v.optional(v.string()),
    origin_agent_type: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
    edited_at: v.optional(v.number()),
    // Tombstone rather than a delete, so replies keep their root and a thread
    // count stays honest.
    deleted_at: v.optional(v.number()),
    // Anchor reply lifecycle. thinking/streaming/done/error are the visible
    // states the comment thread already uses. "listening" is a SILENT
    // placeholder: a reply in a thread the anchor follows woke it without
    // addressing it, and the anchor decides whether to speak; "passed" is its
    // decision to stay quiet. Neither renders anywhere and neither counts as a
    // reply — see @codecast/shared/chat isSilentAgentRow.
    agent_status: v.optional(v.union(
      v.literal("thinking"),
      v.literal("streaming"),
      v.literal("done"),
      v.literal("error"),
      v.literal("listening"),
      v.literal("passed"),
    )),
    // Which anchor owns this placeholder. `chat.replyAsAnchor` requires the row to
    // name an anchor, the row's author to BE that anchor's bot identity, and the
    // caller to be authorized for that anchor — otherwise any api_token holder
    // could overwrite any message and author content under the bot's face.
    agent_anchor_id: v.optional(v.id("anchors")),
    // When the wake's deadline will declare the answer missing. Lets the client
    // show an honest countdown on the thinking row instead of a bare shimmer.
    agent_deadline_at: v.optional(v.number()),
    // Thread-level switch for the anchor, set on the thread ROOT only. Absent
    // means the default: the anchor answers a plain reply in a thread it is
    // already part of, so asking a follow-up does not mean re-typing its name.
    // `false` is a member saying stop — nothing but an explicit @mention wakes it
    // in that thread again (and that mention flips this back to true).
    anchor_follow: v.optional(v.boolean()),
    fork_conversation_id: v.optional(v.id("conversations")),
  })
    .index("by_channel_created", ["channel_id", "created_at"])
    .index("by_thread_created", ["thread_root_id", "created_at"])
    .index("by_channel_client_id", ["channel_id", "client_id"])
    // Team-scoped full-text search backs `chat.searchMessages`. A chat nobody can
    // search is a write-only log. The team filter keeps one team's results out of
    // another's; the caller's membership is still checked before the query runs.
    .searchIndex("search_content", {
      searchField: "content",
      filterFields: ["team_id", "channel_id"],
    }),

  // Reactions are their own rows, NOT an array on the message.
  //
  // An inline array cannot survive the optimistic store: a pending field override
  // clears only when the echoed value is `===` the pending one, and Convex resends
  // arrays as fresh references, so the local value would mask the server's
  // forever. Worse, the patch collector reads the field name from the path and the
  // value from the patch, so a nested toggle would record the INNER array under
  // the outer field name and corrupt the row's shape locally.
  //
  // One row per (message, user, emoji) makes a toggle an insert or a delete, which
  // the pending machinery reconciles on presence, not on identity. It also takes
  // reactions off the message document entirely, so a popular message is not a
  // contended row.
  chat_reactions: defineTable({
    message_id: v.id("chat_messages"),
    // Denormalized so a reaction can be scoped/pruned with the channel without
    // re-reading its message.
    channel_id: v.id("chat_channels"),
    user_id: v.id("users"),
    emoji: v.string(),
    created_at: v.number(),
  })
    .index("by_message", ["message_id"])
    // The toggle's own lookup: exactly one row may exist per (message, user,
    // emoji), and the server splices the CALLER's id in or out — a client can
    // never write another user's reaction.
    .index("by_message_user_emoji", ["message_id", "user_id", "emoji"])
    .index("by_channel", ["channel_id"]),

  // Per (user, channel): where they have read to, and how loudly the channel may
  // interrupt them. One writer per row — the owner — so no contention, and every
  // mutation derives the user from the authenticated caller rather than an
  // argument (a `user_id` argument would let anyone clear someone else's badge or
  // silently mute them).
  //
  // A missing row is meaningful: it means the member has never opened the channel,
  // which reads as notify level "mentions". The row appears the first time they
  // read or post, and that is also the signal the toast layer uses for "a channel
  // I am actually in".
  chat_reads: defineTable({
    user_id: v.id("users"),
    channel_id: v.id("chat_channels"),
    team_id: v.id("teams"),
    last_read_at: v.number(),
    last_read_message_id: v.optional(v.id("chat_messages")),
    notify_level: v.union(v.literal("all"), v.literal("mentions"), v.literal("none")),
    joined_at: v.optional(v.number()),
    updated_at: v.number(),
  })
    // Prefix-matches serve "all of my read state", so no separate by_user. There
    // is deliberately no by_channel index: a query over everyone's read state in a
    // channel is a read-receipt surface nobody asked for.
    .index("by_user_channel", ["user_id", "channel_id"]),

  // One row per (user, thread) across every threaded system: chat threads,
  // session comment threads, task comment streams and published page
  // discussions. Unread is one comparison: last_activity_at > last_read_at.
  // team_id is the entity's routing team; undefined is the personal inbox
  // (personal is a value, not a missing pointer). Bots never get a row.
  thread_reads: defineTable({
    user_id: v.id("users"),
    kind: v.union(v.literal("chat"), v.literal("comment"), v.literal("task"), v.literal("page")),
    // chat: root chat_messages id. comment: `${conversation_id}:${anchorKey}`
    // where anchorKey is `msg:<message_id>` | `file:<path>:<line>` | `global`
    // (commentAnchorKey in @codecast/shared/comments). task: task id.
    // page: artifact id (one card per page discussion).
    root_key: v.string(),
    team_id: v.optional(v.id("teams")),
    last_activity_at: v.number(),
    last_read_at: v.number(),
    updated_at: v.number(),
    // Typed refs for access checks, payload loads and cleanup.
    channel_id: v.optional(v.id("chat_channels")),
    conversation_id: v.optional(v.id("conversations")),
    task_id: v.optional(v.id("tasks")),
    artifact_id: v.optional(v.id("artifacts")),
    // Comment anchor (comment kind only).
    message_id: v.optional(v.id("messages")),
    file_path: v.optional(v.string()),
    line_number: v.optional(v.number()),
  })
    .index("by_user_team_activity", ["user_id", "team_id", "last_activity_at"])
    .index("by_user_kind_root", ["user_id", "kind", "root_key"])
    .index("by_kind_root", ["kind", "root_key"])
    .index("by_channel", ["channel_id"]),

  // Who is typing where, right now. ONE row per (channel, user) — a person
  // types in one box at a time, so the row's thread_key just moves with them,
  // and the table stays bounded at members × channels rather than growing a
  // row per thread ever touched. Rows are refreshed while typing and deleted
  // on send/blur; readers treat anything older than a few seconds as gone, so
  // a leaked row (tab closed mid-word) misleads for one TTL and never again.
  // Deliberately NOT in the store/sync pipeline: this is presence, not state —
  // nothing persists it, and the only reader is the open channel's surface.
  chat_typing: defineTable({
    channel_id: v.id("chat_channels"),
    user_id: v.id("users"),
    // "" = the channel's main composer; a thread root id scopes the signal to
    // that thread's panel.
    thread_key: v.string(),
    updated_at: v.number(),
  })
    .index("by_channel_user", ["channel_id", "user_id"])
    .index("by_channel_updated", ["channel_id", "updated_at"]),

  ...issueSyncTables,

}, {
  // The `messages` table is in the millions of rows, and the default
  // `schemaValidation: true` re-scans every document on every `convex deploy` —
  // turning a one-field function change into a multi-minute full-table walk.
  // Disable the runtime/push-time scan: writes still flow through mutations with
  // `v.*` arg validators and the schema continues to generate the TypeScript
  // types, so the validators above remain the source of truth for shape — they
  // just aren't re-checked against the whole DB on each push.
  schemaValidation: false,
});
