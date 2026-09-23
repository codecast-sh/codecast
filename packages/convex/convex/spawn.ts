import { mutation } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { resolveCreationPrivacy } from "./privacy";
import { enqueueStartSession } from "./devices";
import { enqueuePendingMessage } from "./pendingMessages";
import { UNATTENDED_MANDATE, checkoutInUseMessage, deviceDisplayName, fromConvexAgentType, resolveAgentLaunch, toConvexAgentType, type AgentDefinitionSpec, type CloudWorkspaceMode } from "@codecast/shared/contracts";
import { resolveDefinitionFor } from "./agentDefinitions";
import { cloudSeedArg, cloudWorkspaceValidator, findSharedCheckoutOccupant, resolveCloudDevice } from "./cloudPlacement";
import { findConversationByAnyRef } from "./conversationSessionLookup";
import { listAgentBoxDevices, retainSessionCreator, sessionLaunchRunner } from "./sessionLaunch";
import { roleOfConversation } from "./lib/actor";
import { canAccessTask } from "./lib/access";
import { capsFor, countersFor, roleStartsOnItsOwn } from "./orgEvents";
import { charterLine, type CharterRow } from "./lib/orgCharter";
import { applyHandoffLink, findHandoffSource, handoffChildFields } from "./handoff";

async function getAuthenticatedUserId(
  ctx: { db: any },
  apiToken?: string,
): Promise<Id<"users"> | null> {
  const sessionUserId = await getAuthUserId(ctx as any);
  if (sessionUserId) return sessionUserId;
  if (apiToken) {
    const result = await verifyApiToken(ctx, apiToken);
    if (result) return result.userId;
  }
  return null;
}

/**
 * Resolve a `cast spawn --device <value>` selector against the user's devices
 * (and, for id/label only, the team agent boxes they may target). The value is
 * whatever the human typed: a device_id, the stored label, or the name the UI
 * shows (deviceDisplayName — "Cloud Linux" for the host whose stored label is
 * "Linux - ip-172-31-40-243"), the last two matched case-insensitively.
 * device_id wins outright, then the stored label — a display name that
 * happens to equal another machine's label must not shadow it.
 *
 * Display names are matched against the user's OWN devices only: a teammate's
 * agent box (is_remote + linux) also displays as "Cloud Linux", and a user
 * without a host of their own must not land on it by name. A display name is
 * not unique either (two remote Linux boxes), so more than one match throws
 * rather than picking whichever came first.
 *
 * Throws on an unknown value rather than falling back to auto-routing: a typo'd
 * `--device` silently starting the session on the laptop is exactly the failure
 * the flag exists to prevent.
 */
export function resolveDeviceSelector(
  devices: { device_id: string; label?: string; platform?: string; is_remote?: boolean }[],
  value: string,
  boxes: { device_id: string; label?: string; platform?: string; is_remote?: boolean }[] = [],
): string {
  const wanted = value.trim();
  const all = [...devices, ...boxes];
  const byId = all.find((d) => d.device_id === wanted);
  if (byId) return byId.device_id;
  const byLabel = all.find((d) => (d.label ?? "").toLowerCase() === wanted.toLowerCase());
  if (byLabel) return byLabel.device_id;
  const byDisplayName = devices.filter((d) =>
    deviceDisplayName({ label: d.label ?? d.device_id, platform: d.platform ?? "", is_remote: d.is_remote }).toLowerCase() === wanted.toLowerCase());
  if (byDisplayName.length > 1) {
    throw new Error(`"${wanted}" names ${byDisplayName.length} of your devices — use the device id: ${byDisplayName.map((d) => d.device_id).join(", ")}`);
  }
  if (byDisplayName.length === 1) return byDisplayName[0].device_id;
  const known = all.map((d) => d.label || d.device_id).join(", ") || "(none registered)";
  throw new Error(`Unknown device "${wanted}". Your devices: ${known}`);
}

/**
 * Resolve a `cast spawn --subagent [parent]` ref to the parent conversation.
 * The ref is whatever the calling session has on hand — its session UUID
 * (detectCurrentSessionId), a short_id, or a full conversation id — resolved
 * own-only: nesting a session under someone else's row would hide it from its
 * own spawner and surface it in a teammate's inbox tree.
 *
 * Throws on an unresolved ref instead of falling back to a first-class spawn:
 * the caller asked for a subagent, and silently landing a loose inbox card is
 * exactly the failure the flag exists to prevent.
 */
export async function resolveSpawnParent(
  ctx: { db: any },
  userId: Id<"users">,
  parentRef: string,
): Promise<{ parent_conversation_id: Id<"conversations">; is_subagent: true }> {
  const parent = await findConversationByAnyRef(ctx, parentRef, userId);
  if (!parent) {
    throw new Error(`Parent session "${parentRef}" not found among your sessions`);
  }
  // Presence of parent_conversation_id alone marks a row a subagent for the
  // client (isSubagentConversation); is_subagent makes the row self-identify
  // even before links resolve, same as the daemon's transcript-asserted flag.
  return { parent_conversation_id: parent._id, is_subagent: true };
}

// The create-and-start core shared by `cast spawn` and other "hand fresh work
// to a new session" callers (e.g. sending a call transcript to a new agent):
// conversation row + short_id, start_session enqueue, optional seeded first
// turn over the pending-message rail.
export async function spawnSessionCore(
  ctx: any,
  userId: Id<"users">,
  opts: {
    agentType?: "claude_code" | "codex" | "cursor" | "gemini" | "opencode" | "pi" | "grok" | "muse";
    projectPath?: string;
    gitRoot?: string;
    model?: string;
    effort?: string;
    ccAccount?: string;
    isolated?: boolean;
    worktreeName?: string;
    // A worktree that already exists on the target device (`cast spawn
    // --cloud` acquires it over SSH before creating the row): stamped on the
    // row so the header and the host list show it from the first frame.
    worktree?: { name: string; branch?: string; path?: string; seed?: { source: "checkout" | "origin_main"; base: string; branch?: string; dirty?: boolean; laptop_root?: string; device_id?: string; reason?: string } };
    // `cast spawn --cloud --shared`: the row is created PARKED on the host
    // (owner = the host, cloud_placement pending, no start, no seed) as the
    // atomic claim of its main checkout — the CLI then prepares the host and
    // places the row with the prompt. Refused here, before any insert, when
    // another alive session holds that checkout.
    cloudPark?: { deviceId: string; workspace: CloudWorkspaceMode; checkoutPath: string };
    // Team/privacy resolve from THIS path when project_path lives on another
    // machine — the directory mappings are keyed by the laptop's checkouts.
    privacyPath?: string;
    targetDeviceId?: string | null;
    spawnerConversationId?: Id<"conversations">;
    subagentFields?: { parent_conversation_id: Id<"conversations">; is_subagent: true } | null;
    // `cast handoff --to` / handoff.start: the session this one continues. The
    // child is born linked and bound to the source's task/plan, the source is
    // patched to point forward and its state pinned done (handoff.applyHandoffLink).
    handoffFrom?: any;
    prompt?: string;
    // A resolved agent definition (`cast spawn --as`): the daemon applies its
    // tool policy and system prompt at launch; agent/model/effort were folded
    // into the fields above by resolveSpawnDefinition.
    definition?: AgentDefinitionSpec;
  },
): Promise<{ conversationId: Id<"conversations">; shortId: string }> {
  const now = Date.now();
  const sessionId = crypto.randomUUID();
  const agentType = opts.agentType || "claude_code";
  const runnerUserId = await sessionLaunchRunner(ctx, userId, opts.targetDeviceId);

  const privacy = await resolveCreationPrivacy(ctx, userId, opts.privacyPath || opts.gitRoot || opts.projectPath);
  if (opts.cloudPark?.workspace === "shared") {
    // The device has to be the ROW OWNER's own wake-on-use host, checked here
    // the way every other cloud creator checks it (conversations.createConversation,
    // reconfigureSession, dispatch.createSession): the park writes
    // owner_device_id and claims a checkout, and an unchecked id would claim a
    // checkout on a machine nobody here owns.
    await resolveCloudDevice(ctx, runnerUserId, opts.cloudPark.deviceId);
    const occupant = await findSharedCheckoutOccupant(ctx, runnerUserId, opts.cloudPark.deviceId, { projectPath: opts.cloudPark.checkoutPath });
    if (occupant) throw new Error(checkoutInUseMessage(opts.cloudPark.checkoutPath, occupant));
  }

  const conversationId = await ctx.db.insert("conversations", {
    user_id: runnerUserId,
    ...(runnerUserId !== userId ? { author_user_id: userId } : {}),
    agent_type: agentType,
    session_id: sessionId,
    project_path: opts.projectPath,
    git_root: opts.gitRoot,
    started_at: now,
    updated_at: now,
    message_count: 0,
    ...privacy,
    ...(opts.subagentFields ?? {}),
    ...(opts.spawnerConversationId ? { spawned_by_conversation_id: opts.spawnerConversationId } : {}),
    ...(opts.handoffFrom ? handoffChildFields(opts.handoffFrom) : {}),
    ...(opts.ccAccount ? { cc_account: opts.ccAccount } : {}),
    ...(opts.worktree
      ? {
          worktree_name: opts.worktree.name,
          worktree_branch: opts.worktree.branch,
          worktree_path: opts.worktree.path,
          worktree_status: "active" as const,
          cloud_workspace: "isolated" as const,
          ...(opts.worktree.seed ? { cloud_seed: { ...opts.worktree.seed, at: now } } : {}),
        }
      : {}),
    ...(opts.cloudPark
      ? {
          owner_device_id: opts.cloudPark.deviceId,
          cloud_placement: "pending" as const,
          cloud_workspace: opts.cloudPark.workspace,
          cloud_checkout_path: opts.cloudPark.checkoutPath,
        }
      : {}),
    status: "active",
  });

  const shortId = conversationId.toString().slice(0, 7);
  await ctx.db.patch(conversationId, { short_id: shortId });
  await retainSessionCreator(ctx, conversationId, userId, runnerUserId);
  if (opts.handoffFrom) {
    await applyHandoffLink(ctx, userId, opts.handoffFrom, { _id: conversationId, short_id: shortId, agent_type: agentType, model: opts.model });
  }
  // A parked row starts nowhere yet: the CLI places it (cloud.placeConversation)
  // with the prompt once the host has the checkout ready.
  if (opts.cloudPark) return { conversationId, shortId };

  const daemonAgentType = fromConvexAgentType(agentType);
  await enqueueStartSession(ctx, runnerUserId, {
    conversationId,
    agentType: daemonAgentType,
    projectPath: opts.projectPath || opts.gitRoot,
    sessionId,
    isolated: opts.isolated,
    worktreeName: opts.worktreeName,
    model: opts.model,
    effort: opts.effort,
    ccAccount: opts.ccAccount,
    createdAt: now,
    targetDeviceId: opts.targetDeviceId ?? null,
    definition: opts.definition,
    // The cloud upgrade fires only when the spawner runs its own session
    // (runnerUserId === userId); a team agent box target keeps a plain start.
    callerUserId: userId,
  });

  // Seed the first turn as a plain user message (raw, not wrapped as a
  // session-message) over the same pending-message rail the UI uses for a new
  // session's first message — delivered once the daemon spawns and the agent
  // is ready.
  const prompt = (opts.prompt ?? "").trim();
  if (prompt) {
    const conversation = await ctx.db.get(conversationId);
    await enqueuePendingMessage(ctx, conversation, userId, { content: prompt });
  }

  return { conversationId, shortId };
}


/** `--as <name>`: fold a definition into a spawn's agent/model/effort (explicit
 *  values win) and hand the rest (tools, prompt, mode, worktree) to the daemon.
 *  Clients with no system prompt flag get the prompt prefixed to the seeded
 *  first turn instead, so the role is never silently dropped. */
export async function resolveSpawnDefinition(
  ctx: any,
  userId: Id<"users">,
  name: string | undefined,
  explicit: { agentType?: string; model?: string; effort?: string; prompt?: string; isolated?: boolean },
): Promise<{ agentType?: any; model?: string; effort?: string; prompt?: string; isolated?: boolean; definition?: AgentDefinitionSpec }> {
  if (!name) return explicit;
  const def = await resolveDefinitionFor(ctx, userId, name);
  if (!def) throw new Error(`No agent definition named "${name}"`);
  const explicitAgent = explicit.agentType ? fromConvexAgentType(explicit.agentType) : undefined;
  const launch = resolveAgentLaunch(def, { agent: explicitAgent, model: explicit.model, effort: explicit.effort }, "claude");
  const promptViaFlag = launch.agent === "claude" || launch.agent === "pi";
  let prompt = explicit.prompt;
  if (!promptViaFlag && def.system_prompt?.trim()) {
    prompt = `${def.system_prompt.trim()}\n\n---\n\n${explicit.prompt ?? ""}`.trim();
  }
  return {
    agentType: toConvexAgentType(launch.agent),
    model: launch.model,
    effort: launch.effort,
    prompt,
    isolated: explicit.isolated || launch.isolated || undefined,
    definition: def,
  };
}

// createSessionFromCli — start a fresh, inbox-visible session and optionally
// seed its first turn. The backend for `cast spawn`.
//
// This is the api_token-authenticated sibling of conversations.createQuickSession
// (the UI's "New Session" path): same team/privacy resolution + start_session
// enqueue, but it authenticates a CLI caller and delivers a first prompt so a
// running session can hand fresh work to the human's inbox. By default it does
// NOT set is_subagent / parent_conversation_id — that absence is what makes the
// new session land in the inbox as a first-class card. With `parent_session`
// (`cast spawn --subagent`) it stamps both, so the new session nests in the UI
// as a subagent row under its parent — a worker the parent session manages —
// while still running on any agent backend (codex, gemini, …).
export const createSessionFromCli = mutation({
  args: {
    api_token: v.optional(v.string()),
    prompt: v.optional(v.string()),
    agent_type: v.optional(
      v.union(
        v.literal("claude_code"),
        v.literal("codex"),
        v.literal("cursor"),
        v.literal("gemini"),
        v.literal("opencode"),
        v.literal("pi"),
        v.literal("grok"),
        v.literal("muse"),
      ),
    ),
    project_path: v.optional(v.string()),
    git_root: v.optional(v.string()),
    model: v.optional(v.string()),
    effort: v.optional(v.string()),
    // Saved Claude account profile name (cast accounts token <name>); the
    // daemon sources that account's setup-token into the launch env.
    cc_account: v.optional(v.string()),
    isolated: v.optional(v.boolean()),
    worktree_name: v.optional(v.string()),
    // A worktree the CLI already acquired on the target device (--cloud).
    worktree_branch: v.optional(v.string()),
    worktree_path: v.optional(v.string()),
    // What that worktree started from (with worktree_path + worktree_name).
    cloud_seed: v.optional(cloudSeedArg),
    // Local git root for team/privacy resolution when project_path is remote.
    privacy_path: v.optional(v.string()),
    // `cast spawn --cloud --shared`: all three together park the row on the
    // host as the claim of its main checkout (see spawnSessionCore.cloudPark).
    cloud_device_id: v.optional(v.string()),
    cloud_workspace: v.optional(cloudWorkspaceValidator),
    cloud_checkout_path: v.optional(v.string()),
    // A device_id or label; routes start_session at that machine (see
    // resolveDeviceSelector).
    device: v.optional(v.string()),
    // Any ref to one of the caller's own sessions (session UUID, short_id, or
    // conversation id). When set, the new session is created as a subagent row
    // nested under it (see resolveSpawnParent).
    parent_session: v.optional(v.string()),
    spawner_session: v.optional(v.string()),
    // `cast spawn --as <name>`: a definition in the caller's workspace.
    definition: v.optional(v.string()),
    // The line's review station (the-line.md L3): a task short id. The new
    // session is stamped review_of_task_id, never org_role_id, and counts
    // against the caps of the role doing the task's work.
    review_for_task: v.optional(v.string()),
    // `cast handoff --to` / handoff.start: any ref to a session the caller
    // runs or owns. The new session continues it: born with
    // handed_off_from_conversation_id and the source's task/plan binding, and
    // the source is patched forward and pinned done in this same mutation.
    handoff_from_session: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) {
      throw new Error("Authentication failed: invalid token or session");
    }
    const handoffFrom = args.handoff_from_session ? await findHandoffSource(ctx, userId, args.handoff_from_session) : undefined;
    const asDef = await resolveSpawnDefinition(ctx, userId, args.definition, {
      agentType: args.agent_type,
      model: args.model,
      effort: args.effort,
      prompt: args.prompt,
      isolated: args.isolated,
    });

    let targetDeviceId: string | null = null;
    if (args.device) {
      const devices = await ctx.db
        .query("devices")
        .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
        .collect();
      const boxes = await listAgentBoxDevices(ctx, userId);
      targetDeviceId = resolveDeviceSelector(devices, args.device, boxes.map(({ device }) => device));
    }

    const subagentFields = args.parent_session
      ? await resolveSpawnParent(ctx, userId, args.parent_session)
      : null;
    const spawner = args.spawner_session
      ? await findConversationByAnyRef(ctx, args.spawner_session, userId)
      : null;
    // A role's standing session, or one of its hands, starting a hand: the
    // trust stage and the daily hand cap gate it (org-roles-standing.md T4).
    const roleGate = await gateHandStart(ctx, spawner);
    // A review hand is gated by the role whose work it judges, not filed
    // under it: the verdict must come from outside the role.
    const review = args.review_for_task ? await resolveReviewTarget(ctx, userId, args.review_for_task) : null;
    if (review?.role) await gateRoleCaps(review.role);
    // A hand's first turn opens with the unattended mandate and the hand
    // briefing (the-line.md L2): who it works for and how it ends its turn.
    const handTask: any = roleGate && spawner?.active_task_id ? await ctx.db.get(spawner.active_task_id) : null;
    const handProject: any = handTask?.project_id ? await ctx.db.get(handTask.project_id) : null;
    const prompt = roleGate ? handBriefing(roleGate, asDef.prompt, handTask?.short_id ?? undefined, handProject) : asDef.prompt;

    let cloudPark: { deviceId: string; workspace: CloudWorkspaceMode; checkoutPath: string } | undefined;
    if (args.cloud_workspace === "shared") {
      if (!args.cloud_device_id || !args.cloud_checkout_path) {
        throw new Error("a shared cloud spawn needs cloud_device_id and cloud_checkout_path");
      }
      cloudPark = { deviceId: args.cloud_device_id, workspace: "shared", checkoutPath: args.cloud_checkout_path };
    }

    const { conversationId, shortId } = await spawnSessionCore(ctx, userId, {
      agentType: asDef.agentType ?? args.agent_type,
      projectPath: args.project_path,
      gitRoot: args.git_root,
      model: asDef.model,
      effort: asDef.effort,
      ccAccount: args.cc_account,
      isolated: asDef.isolated,
      definition: asDef.definition,
      worktreeName: args.worktree_name,
      worktree: args.worktree_path && args.worktree_name
        ? { name: args.worktree_name, branch: args.worktree_branch, path: args.worktree_path, seed: args.cloud_seed }
        : undefined,
      cloudPark,
      privacyPath: args.privacy_path,
      targetDeviceId,
      subagentFields,
      spawnerConversationId: spawner?._id,
      handoffFrom,
      prompt,
    });
    if (roleGate) await recordHandStart(ctx, roleGate, conversationId);
    if (review) {
      await ctx.db.patch(conversationId, { review_of_task_id: review.task._id });
      if (review.role) await countHand(ctx, review.role);
    }

    return {
      conversation_id: conversationId,
      short_id: shortId,
      parent_short_id: subagentFields
        ? subagentFields.parent_conversation_id.toString().slice(0, 7)
        : undefined,
    };
  },
});

// ── Hands under a role (org-roles-standing.md T4) ────────────────────────────
//
// The spawner's row says who is starting the session. A standing session or a
// hand acts for its role: the role must be active, starting work on its own
// (org-staffing.md S23.1), and under its daily hand limit. The new session is filed under the role (it
// reports to it and shows under it on the org page) and the cap counter
// advances. A person spawning from a plain terminal is unaffected.
export async function gateHandStart(ctx: { db: any }, spawner: any | null): Promise<any | null> {
  const role = spawner ? await roleOfConversation(ctx, spawner) : null;
  if (!role) return null;
  await gateRoleCaps(role);
  return role;
}

// The task a review hand judges and the role doing its work: the role of the
// first session still bound to the task (active_task_id) that carries one.
async function resolveReviewTarget(ctx: { db: any }, userId: Id<"users">, shortId: string): Promise<{ task: any; role: any | null }> {
  const task = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", shortId)).first();
  if (!task || !(await canAccessTask(ctx, userId, task))) throw new Error(`Task not found: ${shortId}`);
  for (const id of task.conversation_ids ?? []) {
    const conv = await ctx.db.get(id);
    if (!conv || String(conv.active_task_id) !== String(task._id)) continue;
    const role = await roleOfConversation(ctx, conv);
    if (role) return { task, role };
  }
  return { task, role: null };
}

export async function gateRoleCaps(role: any): Promise<void> {
  if (role.status === "paused") throw new Error(`${role.name} (@${role.handle}) is paused: no new hands until a person resumes it`);
  if (role.status === "retired") throw new Error(`${role.name} (@${role.handle}) is retired`);
  // Off, the role recommends and a person starts the work; it never asks a
  // person to change its own settings (S23.1), so the message names no verb.
  if (!roleStartsOnItsOwn(role)) {
    throw new Error(`${role.name} (@${role.handle}) does not start work on its own; say in one line that this needs starting and recommend it`);
  }
  const now = Date.now();
  const caps = capsFor(role);
  const counters = countersFor(role, now);
  if (counters.hands >= caps.hands_per_day) {
    throw new Error(`${role.name} (@${role.handle}) reached today's limit of ${caps.hands_per_day} hands; write one line in the brief, pin that you are waiting for tomorrow, and wait`);
  }
  if (counters.tokens >= caps.tokens_per_day) {
    throw new Error(`${role.name} (@${role.handle}) reached today's limit; write one line in the brief, pin that you are waiting for tomorrow, and wait`);
  }
}

async function countHand(ctx: { db: any }, role: any): Promise<void> {
  const now = Date.now();
  const counters = countersFor(role, now);
  await ctx.db.patch(role._id, { counters: { ...counters, hands: counters.hands + 1 }, updated_at: now });
}

export async function recordHandStart(ctx: { db: any }, role: any, conversationId: Id<"conversations">): Promise<void> {
  await countHand(ctx, role);
  await ctx.db.patch(conversationId, { org_role_id: role._id });
}

// The briefing a hand starts with (org-roles-standing.md T4, the-line.md L2):
// the unattended mandate, who the hand works for, the goal of the project the
// task serves (org-staffing.md S7), and the structured ending. Written where
// the hand pointer is written, so no hand can start without it.
export function handBriefing(
  role: { name: string; handle: string; short_id?: string },
  prompt: string | undefined,
  taskShortId?: string,
  project?: ({ title: string } & CharterRow) | null,
): string {
  const ct = taskShortId ?? "<ct-id>";
  const direction = charterLine(`Project ${project?.title ?? ""}`, project);
  const header = [
    `## You are a hand of ${role.name} (@${role.handle})`,
    `You work for that role, not for a person. It reads your handoff, not your transcript.`,
    ...(direction ? [`${direction}. Your work serves that goal; say in the handoff how it moved.`] : []),
    `- Bind your work: \`cast task start ${ct}\` if this session was not started on it.`,
    `- A question you cannot answer yourself goes to your role, attached to the task: \`cast decide --task ${ct} "<question>" -o ... -o ...\`, then end your turn.`,
    `- If you review another hand's work, end with \`cast task verdict ${ct} approve|changes|reject --note -\`.`,
    `- End EVERY turn with a handoff, never a pin: \`cast task handoff ${ct} --status done|blocked|needs_context --evidence - <<'EOF'\` with what you changed, what you verified, and what is left.`,
  ].join("\n");
  return `${UNATTENDED_MANDATE}\n\n${header}\n\n${(prompt ?? "").trim()}`.trim();
}
