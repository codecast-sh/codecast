import { mutation, query } from "./functions";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { buildShareUpdate, resolveCreationPrivacy } from "./privacy";
import { patchConversationVisibility } from "./lib/access";
import { enqueueStartSession } from "./devices";
import { fromConvexAgentType } from "@codecast/shared/contracts";
import { enqueueKillSessionCommand } from "./cleanup";
import { enqueuePendingMessage, formatSessionMessage, getAuthenticatedUserId } from "./pendingMessages";
import { CHIEF_OF_STAFF_HANDLE, roleGrants } from "./lib/orgAccess";

// An Anchor is codecast's standing agent member: one per team (shared) and one
// per user (personal). It owns a long-lived `persistent` conversation that is
// pinned in the inbox, rendered under a synthetic bot identity, woken by events,
// and delegates code work to ephemeral `cast spawn` hands.
//
// Identity is decoupled from hosting on purpose (see schema): `bot_user_id` is
// the name/avatar the session renders as; `host_user_id` (= the human caller) is
// who actually runs and bills it on their daemon. That lets a personal anchor run
// on a laptop and a team anchor run on whichever member hosts it, with no separate
// bot daemon or bot credentials in v1.

// Authorization for an anchor: the human host that runs it, the user a personal
// anchor belongs to, or any member of a team anchor's team. Every ACT path (wake,
// decommission) and the channel/post paths gate on this — authentication alone is
// not enough (injecting a turn runs and bills code on the host's daemon). The
// rule itself lives in lib/orgAccess (roleGrants): an anchor and an org role
// carry the same boundary shape, so the two tables share one grant.
export async function userCanAccessAnchor(
  ctx: { db: any },
  userId: Id<"users">,
  anchor: { host_user_id?: Id<"users">; scope_user_id?: Id<"users">; team_id?: Id<"teams"> } | null,
): Promise<boolean> {
  return roleGrants(ctx, userId, anchor, () => true);
}

// Stricter gate for DESTRUCTIVE / config changes (retire, rename, persona): the
// host, the personal-anchor owner, or a team ADMIN — not every team member. Any
// member can wake/use the anchor (userCanAccessAnchor); only admins reshape it.
export async function userCanAdminAnchor(
  ctx: { db: any },
  userId: Id<"users">,
  anchor: { host_user_id?: Id<"users">; scope_user_id?: Id<"users">; team_id?: Id<"teams"> } | null,
): Promise<boolean> {
  return roleGrants(ctx, userId, anchor, (m) => m.role === "admin");
}

// The anchors a caller may see/act on: their personal anchor plus the team anchor
// of every team they belong to, deduped and excluding decommissioned. Shared by
// listAnchors and the Slack channel listing so the two can't drift.
export async function visibleAnchorsForUser(
  ctx: { db: any },
  userId: Id<"users">,
): Promise<any[]> {
  const personal = await ctx.db
    .query("anchors")
    .withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", userId))
    .collect();
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  const teamAnchors: any[] = [];
  for (const m of memberships) {
    const rows = await ctx.db
      .query("anchors")
      .withIndex("by_team", (q: any) => q.eq("team_id", m.team_id))
      .collect();
    teamAnchors.push(...rows);
  }
  const seen = new Set<string>();
  const out: any[] = [];
  for (const a of [...personal, ...teamAnchors]) {
    if (a.status === "decommissioned") continue;
    if (seen.has(a._id.toString())) continue;
    seen.add(a._id.toString());
    out.push(a);
  }
  return out;
}

// The default first turn that brings a freshly-provisioned anchor "online": it
// tells the agent who it is, what it is for, and how it reaches the world, then
// asks for a one-line hello so the human can see it is live. Deliberately
// principle-level: the persona and the standing rules grow in its own memory
// and the project's CLAUDE.md; this only sets the frame.
export type RoleBootstrap = {
  handle: string;
  scopeNames: string[];
  parentName: string;
  trust: "understand" | "decide" | "direct";
};

export function bootstrapMessage(opts: {
  name: string;
  scopeType: "team" | "user";
  scopeLabel: string;
  ownerName?: string;
  teamName?: string;
  persona?: string;
  // Set when the standing agent is an org ROLE (org-roles-standing.md T1)
  // rather than the workspace anchor: the frame names its seat, its scope,
  // its parent and its trust stage, and the rules of a role replace the
  // anchor's memory-and-delegation bullets. A person writing into the scope
  // is the front door (scopes-and-feed.md F4.2, F4.4): the role says where
  // each message went, and remembering is a brief write it says it made.
  role?: RoleBootstrap;
}): string {
  const { name, scopeType, scopeLabel, persona, role } = opts;
  const who = role
    ? `the standing agent for the **${name}** role (@${role.handle}) in ${scopeType === "team" ? `the ${opts.teamName ?? "team"} workspace` : `${opts.ownerName ?? "one person"}'s personal workspace`}. You report to ${role.parentName}. Your scope: ${role.scopeNames.length ? role.scopeNames.join(", ") : "the whole workspace"}. Your trust stage is **${role.trust}**`
    : scopeType === "team"
      ? `the **team** anchor for ${opts.teamName ?? "this team"} — every member of that team can reach you, and you speak for the team's shared context`
      : `the **personal** anchor for ${opts.ownerName ?? "one person"} — private to them, and you speak only in their voice and interest`;
  const memoryBullet = role
    ? [
      `- **Your brief is your memory.** Your transcript gets compacted; the brief (\`cast brief\`) is`,
      `  what survives. Its first line is the state of your scope, then Status:/Next:/Blocked: lines.`,
      `  The paragraphs after are what must not be lost: standing facts about your area, decisions`,
      `  with the reason they were taken, who to ask before touching what, pitfalls, and how the`,
      `  people here want you to work. Not status, not a log of what happened, and nothing a task or`,
      `  a plan already holds. \`cast brief edit -\` writes the whole narrative: keep what still holds,`,
      `  drop what does not, and run it at the end of any turn that changed it.`,
      `- **Remembering is something a person says.** When someone tells you to remember a decision,`,
      `  a requirement or a pitfall, it goes into the brief in that same turn, in your own words, and`,
      `  your reply says so. When they tell you to forget one, it comes out of the brief; forgetting`,
      `  is removing the line, not adding a note that it was forgotten.`,
      `- **Delegate real work.** A hand is a session you start with \`cast spawn\`; it reports to you`,
      `  and shows under you on the org page. Start hands only when your trust stage allows it, and`,
      `  stay responsive yourself.`,
    ]
    : [
      `- **Keep durable memory.** Your transcript gets compacted, so persist anything worth`,
      `  remembering to this project's memory dir and CLAUDE.md — starting now with a short note`,
      `  that you are ${name}, ${scopeType === "team" ? "the team anchor" : "the personal anchor"} for ${scopeLabel}, and how you operate.`,
      `- **Delegate real work.** For code changes or anything long, start background subagents`,
      `  (the Agent tool) and stay responsive yourself; call them subagents. Reserve \`cast spawn\``,
      `  for when a person explicitly wants a session they will steer themselves.`,
    ];
  const roleRules = role
    ? [
      ``,
      `## When a person writes to you`,
      `A person who writes to you is talking to the agent that owns this area, and they should not`,
      `need to know how the work is organized to get something done.`,
      `- **Say where it went.** Your reply either answers them here or moves the work into a hand,`,
      `  and it says which, in your own words, in the same turn. A question gets its answer here,`,
      `  in the text you write back: your pinned state and your brief are status a person may`,
      `  glance at, never the reply, so an answer that lives only there was not given.`,
      `  New work goes to a new hand, or to a hand already working in that area (\`cast send <id>\`),`,
      `  and you name the hand so they can open it; several unrelated pieces of work in one message`,
      `  become separate hands. Never start work in silence, and never ask for a permission you`,
      `  already hold: your trust stage says whether you may start hands, so at the direct stage you`,
      `  start them and say so, and below it you say plainly that you cannot start one and answer or`,
      `  recommend here instead.`,
      `- **Say only what you did.** A hand you name as started is one \`cast spawn\` returned in this`,
      `  turn; a hand you say you sent to is one \`cast send\` reached. A hand you could not start (a`,
      `  cap, your trust stage, a failed spawn) is said as that, never as started.`,
      `- **The person can redirect you in plain words** ("answer that here", "put this in the pricing`,
      `  thread", "ask me before you start one"), and you keep to it from then on: write the`,
      `  preference into the brief so it survives your next wake.`,
      ``,
      `## The rules of a role`,
      `- **Wake, read, act, brief.** Every turn starts with a frame: why you are awake, your scope`,
      `  now, what your hands say. Read your charter and brief before acting, and end by updating`,
      `  the brief. Understand first; a role at the understand stage reports and recommends, it`,
      `  does not start hands or answer decisions.`,
      `- **Stay inside your scope.** You own the projects and plans named above and nothing else;`,
      `  what falls outside goes up to ${role.parentName}.`,
      `- **Escalate with a recommendation.** A decision you cannot take yourself goes to a person`,
      `  with your recommendation attached (\`cast decide recommend\`), never as a bare question.`,
      `- **Caps are real.** Wakes, hands and tokens per day are bounded; when a cap holds you, say so`,
      `  in the brief and wait.`,
      `- **Say where it went.** A person's message is answered here or handed on, and the reply says`,
      `  which; a request to remember or forget is a brief write in the same turn.`,
    ]
    : [];
  return [
    `You are **${name}**, ${who}. You are codecast's standing agent for ${scopeLabel}: a`,
    `general agent and a persistent member, not a one-shot task. People will ask you`,
    `anything about the work — questions, coordination, monitoring, reminders, small tasks,`,
    `judgment calls — and you act with a peer's judgment.`,
    ``,
    role
      ? `Your charter (the humans' statement of your job) and your brief (your own running account) are`
      + ` documents; \`cast brief\` prints the brief with live facts about your scope.`
      : `A person may have several anchors (a personal one, and one per team). When there is any`,
    role ? `` : `chance of confusion, say which one you are.`,
    ``,
    `## How you work`,
    `- **Stay resident.** This conversation is long-lived and never "completes". When you finish`,
    `  a turn you go dormant and are woken by the next event: a message here, a mention or`,
    `  reply in team chat, a direct message, a Slack mention, a routine firing, a finished`,
    `  delegated job. Don't wrap up or sign off for good.`,
    ...memoryBullet,
    ...roleRules,
    ...(role ? [] : [
      ``,
      `## Roles that report into this workspace`,
      `Standing roles are agents with a seat and a handle (@infra-lead). \`cast org\` lists them with`,
      `their scope and state; \`cast brief @handle\` prints a role's live facts and its own narrative.`,
      `A workspace summary is a routine a person can ask you for: read each role's brief with`,
      `\`cast brief @handle\`, then post the summary with \`cast anchor say --chat #general\`. Never wake`,
      `a role to get its status; a parent reads the brief line, it does not ask.`,
    ]),
    ``,
    `## Your routines are yours to run`,
    `People will talk to you about your own recurring behavior — "check the deploy every`,
    `morning", "stop the weekly digest", "do that at 3pm instead". Own it: create, list, pause`,
    `and cancel your routines with \`cast trigger add/ls/pause/cancel\` (a trigger you create here`,
    `wakes THIS session), keep one trigger per routine, and when asked, describe what you do`,
    `on a schedule in plain words. A routine you cannot name is one nobody can stop.`,
    ``,
    `## Reaching people`,
    `- **You can start conversations.** Post in a channel or a thread with`,
    `  \`cast anchor say --chat <channel> [--thread <root>] "..."\`, or message people directly`,
    `  with \`cast anchor say --dm <handle>[,<handle>] "..."\`. Use this to be proactive — a`,
    `  routine found something, a question needs a person, a promise came due — and use it`,
    `  sparingly: speak when it adds something, once, in the place it belongs.`,
    `- **Reply where you were called.** A chat wake tells you the placeholder to fill`,
    `  (\`cast chat reply <id> "..."\`); a Slack wake gives you \`cast anchor say --channel <C>\`.`,
    `- **In group conversations, be a good participant.** Once someone names you in a thread`,
    `  you follow it and hear every reply; most lines are people talking to each other. Pass`,
    `  (\`cast chat reply <id> --pass\`) unless a line is clearly for you. When unsure, pass.`,
    ``,
    `## Judgment`,
    `- Decline rather than half-do: if a request exceeds what is safe or cannot be finished`,
    `  properly, say so and escalate to a person — never ship a truncated or guessed result.`,
    `- Be concise and additive. Don't repeat yourself across channels.`,
    persona ? `\n## Your persona\nAdopt the **${persona}** persona/skill if it is available in this project.` : ``,
    ``,
    role
      ? `Read \`cast brief\` now, post a one-line hello confirming you are online as @${role.handle}, then stand by.`
      : `Save your role to memory now, post a one-line hello confirming you are online and which`,
    role ? `` : `anchor you are, then stand by.`,
  ].filter((line) => line !== ``).join("\n");
}

async function findExistingAnchor(
  ctx: { db: any },
  scope: { scope_type: "team" | "user"; team_id?: Id<"teams">; scope_user_id?: Id<"users">; org_role_id?: Id<"org_roles"> },
) {
  const rows: any[] = scope.scope_type === "team" && scope.team_id
    ? await ctx.db.query("anchors").withIndex("by_team", (q: any) => q.eq("team_id", scope.team_id)).collect()
    : scope.scope_user_id
      ? await ctx.db.query("anchors").withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", scope.scope_user_id)).collect()
      : [];
  const live = rows.filter((a: any) => a.status !== "decommissioned");
  // A role's standing agent is one per role, whatever the boundary holds;
  // the workspace anchor stays one per scope (and never matches a role's).
  if (scope.org_role_id) return live.find((a: any) => String(a.org_role_id ?? "") === String(scope.org_role_id)) ?? null;
  const plain = live.find((a: any) => !a.org_role_id);
  if (plain) return plain;
  // The chief of staff IS the workspace's standing agent (org-staffing.md
  // S12): once `cast org staff` has seated the anchor as the chief, its row
  // carries the role pointer and still answers as the workspace anchor, so
  // Slack, chat and `cast anchor say` keep working as aliases of the chief.
  for (const a of live) {
    const role = a.org_role_id ? await ctx.db.get(a.org_role_id) : null;
    if (role && role.handle === CHIEF_OF_STAFF_HANDLE && role.status !== "retired") return a;
  }
  return null;
}

// The workspace anchor of a boundary (a team's, or a person's own), or null.
export async function workspaceAnchorFor(ctx: { db: any }, boundary: { team_id?: Id<"teams">; scope_user_id?: Id<"users"> }): Promise<any | null> {
  return boundary.team_id
    ? findExistingAnchor(ctx, { scope_type: "team", team_id: boundary.team_id })
    : findExistingAnchor(ctx, { scope_type: "user", scope_user_id: boundary.scope_user_id });
}

// provisionStandingAgent — idempotently create (or return) a standing agent:
// mint its bot identity, its anchors row, and its persistent session, and
// queue the bootstrap turn. Shared by the workspace anchor (`cast anchor
// create`) and an org role's standing session (orgRoles.provision,
// org-roles-standing.md T1): a role IS an anchor row with `org_role_id` set,
// a `users.bot_kind` of "role", and a conversation that carries
// `standing_role_id`.
export type ProvisionStandingAgentOpts = {
  scope_type: "team" | "user";
  team_id?: Id<"teams">;
  name?: string;
  avatar_url?: string;
  persona?: string;
  project_path?: string;
  model?: string;
  agent_type?: "claude_code" | "codex" | "cursor" | "gemini" | "opencode" | "pi" | "grok";
  bootstrap?: boolean;
  // Role provisioning: the role row and the extra bootstrap frame. `adopt` is
  // an existing conversation row that BECOMES the standing session
  // (org-staffing.md S6): no new session is started, the row is re-identified
  // as the role and the bootstrap lands in it as its next turn.
  // `announce` is the seating note (org-staffing.md S16): one message from
  // the acting person, delivered ahead of the bootstrap, that names the new
  // job and what did not change. Only an adopted session needs it; a fresh
  // session has no history to explain.
  role?: { _id: Id<"org_roles">; bootstrap: RoleBootstrap; adopt?: any; announce?: string };
};

// An adopted thread looks like the role (S16): its title becomes the role's
// display name and the old title is kept so unseating can restore it.
// `seat_previous` is also the mark that the seating was explained, so it is
// stamped even when the title already matches; an earlier stamp is kept, so a
// second seating never forgets the title the person chose.
export function seatTitlePatch(adopt: any, roleName: string): Record<string, any> {
  return { title: roleName, title_is_custom: true, seat_previous: adopt.seat_previous ?? { title: adopt.title ?? undefined, title_is_custom: adopt.title_is_custom ?? undefined } };
}

// The seating note lands as a plain turn, never a held wake: it must read
// before the bootstrap, and a held row would only surface inside a frame.
export async function announceSeating(ctx: any, conversationId: Id<"conversations">, hostUserId: Id<"users">, announce: string | undefined): Promise<void> {
  if (!announce) return;
  const host = await ctx.db.get(hostUserId);
  const conversation = await ctx.db.get(conversationId);
  await enqueuePendingMessage(ctx, conversation, hostUserId, {
    content: formatSessionMessage("unknown", announce, host?.name || host?.github_username || host?.email?.split("@")[0] || undefined),
    client_id: `seat:${conversationId}:${Date.now()}`,
  });
}

export async function provisionStandingAgent(
  ctx: any,
  hostUserId: Id<"users">,
  args: ProvisionStandingAgentOpts,
): Promise<{
  anchor_id: Id<"anchors">;
  bot_user_id: Id<"users">;
  conversation_id: Id<"conversations"> | null;
  short_id?: string;
  already_existed: boolean;
}> {
  const now = Date.now();
  const name = (args.name ?? "Anchor").trim() || "Anchor";

  // Resolve + authorize scope.
  let teamId: Id<"teams"> | undefined;
  let scopeUserId: Id<"users"> | undefined;
  let scopeLabel: string;
  let teamName: string | undefined;
  if (args.scope_type === "team") {
    // Resolve the team: explicit team_id, else the host's active team.
    let resolved = args.team_id;
    if (!resolved) {
      const host = await ctx.db.get(hostUserId);
      resolved = host?.active_team_id ?? host?.team_id ?? undefined;
    }
    if (!resolved) {
      throw new Error("No team to anchor: pass --team <id> or set an active team");
    }
    const membership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q: any) =>
        q.eq("user_id", hostUserId).eq("team_id", resolved),
      )
      .first();
    if (!membership) throw new Error("Not a member of that team");
    teamId = resolved;
    const team = await ctx.db.get(resolved);
    teamName = team?.name ?? undefined;
    scopeLabel = `the ${team?.name ?? "team"} workspace`;
  } else {
    scopeUserId = hostUserId;
    scopeLabel = "your personal workspace";
  }
  const host = await ctx.db.get(hostUserId);
  const ownerName = host?.name || host?.github_username || host?.email?.split("@")[0] || undefined;

  // Idempotent: one anchor per scope, one standing agent per role.
  const existing = await findExistingAnchor(ctx, {
    scope_type: args.scope_type,
    team_id: teamId,
    scope_user_id: scopeUserId,
    org_role_id: args.role?._id,
  });
  if (existing) {
    return {
      anchor_id: existing._id,
      bot_user_id: existing.bot_user_id,
      conversation_id: existing.conversation_id ?? null,
      already_existed: true,
    };
  }

  // Seating the workspace anchor itself (org-staffing.md S12): its session
  // already has a bot, an anchors row and a machine. The row gains the role
  // pointer, the session gains the standing marker, and nothing restarts.
  const adoptedAnchor = args.role?.adopt?.anchor_id && !args.role.adopt.standing_role_id ? await ctx.db.get(args.role.adopt.anchor_id) : null;
  if (adoptedAnchor && adoptedAnchor.status !== "decommissioned" && !adoptedAnchor.org_role_id
    && String(adoptedAnchor.team_id ?? "") === String(teamId ?? "") && String(adoptedAnchor.scope_user_id ?? "") === String(scopeUserId ?? "")) {
    await ctx.db.patch(adoptedAnchor._id, { org_role_id: args.role!._id, updated_at: now });
    await ctx.db.patch(adoptedAnchor.bot_user_id, { bot_kind: "role" });
    await ctx.db.patch(args.role!.adopt._id, { standing_role_id: args.role!._id, persistent: true, updated_at: now, ...seatTitlePatch(args.role!.adopt, name) });
    await announceSeating(ctx, args.role!.adopt._id, hostUserId, args.role!.announce);
    if (args.bootstrap !== false) {
      await enqueuePendingMessage(ctx, await ctx.db.get(args.role!.adopt._id), hostUserId, {
        content: bootstrapMessage({ name, scopeType: args.scope_type, scopeLabel, ownerName, teamName, persona: adoptedAnchor.persona, role: args.role!.bootstrap }),
      });
    }
    return {
      anchor_id: adoptedAnchor._id,
      bot_user_id: adoptedAnchor.bot_user_id,
      conversation_id: args.role!.adopt._id,
      short_id: args.role!.adopt.short_id ?? String(args.role!.adopt._id).slice(0, 7),
      already_existed: false,
    };
  }

  // Mint the synthetic bot identity (no login; identity only).
  const botUserId = await ctx.db.insert("users", {
    name,
    image: args.avatar_url,
    is_bot: true,
    bot_kind: args.role ? "role" : "anchor",
    created_at: now,
    team_id: teamId,
    active_team_id: teamId,
  });
  if (teamId) {
    await ctx.db.insert("team_memberships", {
      user_id: botUserId,
      team_id: teamId,
      role: "member",
      joined_at: now,
      visibility: "full",
    });
  }

  // Create the anchor row first so the conversation can back-link to it.
  const anchorId = await ctx.db.insert("anchors", {
    scope_type: args.scope_type,
    team_id: teamId,
    scope_user_id: scopeUserId,
    bot_user_id: botUserId,
    host_user_id: hostUserId,
    name,
    persona: args.persona,
    project_path: args.project_path,
    model: args.model,
    status: "provisioning",
    org_role_id: args.role?._id,
    created_at: now,
    updated_at: now,
  });

  const adopt = args.role?.adopt ?? null;
  const conversationId: Id<"conversations"> = adopt ? adopt._id : await insertStandingConversation();

  async function insertStandingConversation(): Promise<Id<"conversations">> {
    // The persistent session: owned (run + billed) by the human host, rendered as
    // the bot, pinned, and exempt from auto-completion.
    const sessionId = crypto.randomUUID();
    // A team anchor always belongs to its team and is shared; a personal anchor
    // resolves team/privacy from its project path like any session.
    const privacy = args.scope_type === "user"
      ? await resolveCreationPrivacy(ctx, hostUserId, args.project_path)
      : { team_id: teamId, is_private: false, auto_shared: undefined };

    const agentType = args.agent_type ?? "claude_code";
    const conversationId = await ctx.db.insert("conversations", {
      user_id: hostUserId,
      acting_user_id: botUserId,
      anchor_id: anchorId,
      // The row IS the role's session (T1); inbox placement treats it as an
      // anchor's. org_role_id stays unset: a standing session reports to no seat.
      standing_role_id: args.role?._id,
      agent_type: agentType,
      session_id: sessionId,
      title: name,
      title_is_custom: true,
      project_path: args.project_path,
      git_root: args.project_path,
      model: args.model,
      started_at: now,
      updated_at: now,
      message_count: 0,
      ...privacy,
      status: "active",
      persistent: true,
      // Not pinned in the inbox — the anchor lives in its dedicated /anchor space
      // and only surfaces in the inbox when it's waiting on the user.
    });
    await ctx.db.patch(conversationId, {
      short_id: conversationId.toString().slice(0, 7),
    });

    await enqueueStartSession(ctx, hostUserId, {
      conversationId,
      agentType: fromConvexAgentType(agentType),
      projectPath: args.project_path,
      sessionId,
      model: args.model,
      createdAt: now,
    });
    return conversationId;
  }

  // An adopted session keeps its owner, history and machine; it gains the
  // role's identity and the standing markers a provisioned row is born with.
  // A team seat is the team's: a private analyzer session that becomes the
  // chief of staff must be visible to every member, or the org page shows
  // the anchor with no session for everyone but the hirer. Visibility goes
  // through the chokepoint so linked work items get their key recomputed.
  if (adopt) {
    const markers = { acting_user_id: botUserId, anchor_id: anchorId, standing_role_id: args.role!._id, persistent: true, updated_at: now, ...seatTitlePatch(adopt, name) };
    if (args.scope_type === "team" && adopt.is_private !== false) {
      await patchConversationVisibility(ctx, adopt, { ...(await buildShareUpdate(ctx, adopt, adopt.user_id)), ...markers });
    } else {
      await ctx.db.patch(conversationId, markers);
    }
    await announceSeating(ctx, conversationId, hostUserId, args.role!.announce);
  }

  await ctx.db.patch(anchorId, {
    conversation_id: conversationId,
    status: "active",
    updated_at: now,
  });

  if (args.bootstrap !== false) {
    const conversation = await ctx.db.get(conversationId);
    await enqueuePendingMessage(ctx, conversation, hostUserId, {
      content: bootstrapMessage({
        name,
        scopeType: args.scope_type,
        scopeLabel,
        ownerName,
        teamName,
        persona: args.persona,
        role: args.role?.bootstrap,
      }),
    });
  }

  return {
    anchor_id: anchorId,
    bot_user_id: botUserId,
    conversation_id: conversationId,
    short_id: adopt?.short_id ?? conversationId.toString().slice(0, 7),
    already_existed: false,
  };
}

// provisionAnchor — the workspace anchor. Backs `cast anchor create`.
export const provisionAnchor = mutation({
  args: {
    api_token: v.optional(v.string()),
    scope_type: v.union(v.literal("team"), v.literal("user")),
    team_id: v.optional(v.id("teams")),
    name: v.optional(v.string()),
    avatar_url: v.optional(v.string()),
    persona: v.optional(v.string()),
    project_path: v.optional(v.string()),
    model: v.optional(v.string()),
    bootstrap: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const hostUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!hostUserId) throw new Error("Authentication failed: invalid token or session");
    return await provisionStandingAgent(ctx, hostUserId, args);
  },
});

// Deliver a message into an anchor's standing session, auto-resuming it if
// dormant (the normal pending-message rail does the resume). This is the
// primitive every trigger (Slack mention, schedule, a finished hand) funnels
// into. Shared by the auth'd `wakeAnchor` and the internal `wakeAnchorInternal`.
// `clientId` makes the delivery both idempotent and CANCELLABLE: the enqueue
// dedupes on it, and a caller that owns a deadline (chat's placeholder timeout)
// can find the queued row by the same key and drop it when the answer is no
// longer wanted. Without that, a wake queued while a laptop was shut is injected
// hours later and the agent spends a turn on a question nobody is waiting for.
export async function deliverToAnchor(
  ctx: any,
  anchorId: Id<"anchors">,
  message: string,
  clientId?: string,
) {
  const anchor = await ctx.db.get(anchorId);
  if (!anchor) throw new Error("Anchor not found");
  if (anchor.status === "decommissioned") throw new Error("Anchor is decommissioned");
  if (!anchor.conversation_id) throw new Error("Anchor has no session yet");
  const conversation = await ctx.db.get(anchor.conversation_id);
  if (!conversation) throw new Error("Anchor session missing");
  await enqueuePendingMessage(ctx, conversation, conversation.user_id, {
    content: message,
    client_id: clientId,
  });
  return { conversation_id: anchor.conversation_id, woke: true };
}

// wakeAnchor — auth'd entry (CLI / web): a human or their session pokes the anchor.
export const wakeAnchor = mutation({
  args: {
    api_token: v.optional(v.string()),
    anchor_id: v.id("anchors"),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    const anchor = await ctx.db.get(args.anchor_id);
    if (!anchor) throw new Error("Anchor not found");
    if (!(await userCanAccessAnchor(ctx, userId, anchor))) {
      throw new Error("Not authorized for this anchor");
    }
    return await deliverToAnchor(ctx, args.anchor_id, args.message);
  },
});

// The briefing for an EXISTING anchor, rebuilt from its row. Used by
// rebriefAnchor so a running anchor can be handed the current frame (its scope,
// its routines, how it reaches people) without being retired and re-created.
async function briefingFor(ctx: { db: any }, anchor: any): Promise<string> {
  const team = anchor.team_id ? await ctx.db.get(anchor.team_id) : null;
  const owner = anchor.scope_user_id ? await ctx.db.get(anchor.scope_user_id) : null;
  return bootstrapMessage({
    name: anchor.name,
    scopeType: anchor.scope_type,
    scopeLabel: anchor.scope_type === "team"
      ? `the ${team?.name ?? "team"} workspace`
      : `${owner?.name ?? "their"}'s personal workspace`,
    ownerName: owner?.name || owner?.github_username || owner?.email?.split("@")[0] || undefined,
    teamName: team?.name ?? undefined,
    persona: anchor.persona,
  });
}

// rebriefAnchor — re-send the standing briefing to a live anchor. Admin gated
// like every reshaping of the anchor: it changes how the agent behaves from
// here on. Backs `cast anchor brief` and the settings panel's "Re-brief".
export const rebriefAnchor = mutation({
  args: { api_token: v.optional(v.string()), anchor_id: v.id("anchors") },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    const anchor = await ctx.db.get(args.anchor_id);
    if (!anchor) throw new Error("Anchor not found");
    if (!(await userCanAdminAnchor(ctx, userId, anchor))) {
      throw new Error("Only an admin (or the host) can re-brief this anchor");
    }
    const briefing = await briefingFor(ctx, anchor);
    return await deliverToAnchor(ctx, args.anchor_id, briefing, `anchor-brief:${Date.now()}`);
  },
});

// resolveAnchorForScope — the lookup wake routing uses to find which anchor
// answers for a team or user. Public for the CLI; reused internally by adapters.
export const resolveAnchorForScope = query({
  args: {
    api_token: v.optional(v.string()),
    scope_type: v.union(v.literal("team"), v.literal("user")),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const scopeUserId = args.scope_type === "user" ? userId : undefined;
    let teamId = args.team_id;
    if (args.scope_type === "team" && !teamId) {
      const host = await ctx.db.get(userId);
      teamId = host?.active_team_id ?? host?.team_id ?? undefined;
    }
    // Authorize team scope: only a member may resolve a team's anchor (team_id is
    // not a secret, so without this any user could fetch another team's anchor id).
    if (args.scope_type === "team") {
      if (!teamId) return null;
      const member = await ctx.db
        .query("team_memberships")
        .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", teamId))
        .first();
      if (!member) return null;
    }
    const anchor = await findExistingAnchor(ctx, {
      scope_type: args.scope_type,
      team_id: teamId,
      scope_user_id: scopeUserId,
    });
    return anchor ?? null;
  },
});

// listAnchors — anchors visible to the caller: their personal one plus the team
// anchors of every team they belong to. Backs `cast anchor ls`.
export const listAnchors = query({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return [];

    const memberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
      .collect();
    const teamIds = new Set(memberships.map((m: any) => m.team_id.toString()));

    const anchors = await visibleAnchorsForUser(ctx, userId);
    // Enrich with the bot's display name/avatar, the scope's name, and the
    // session's coarse state — everything a picker or a status chip needs
    // without a second query per anchor.
    const out: any[] = [];
    for (const a of anchors) {
      const bot = await ctx.db.get(a.bot_user_id as Id<"users">);
      const team = a.team_id ? await ctx.db.get(a.team_id as Id<"teams">) : null;
      const conv = a.conversation_id ? await ctx.db.get(a.conversation_id as Id<"conversations">) : null;
      out.push({
        ...a,
        bot_name: bot?.name ?? a.name,
        // Set once the anchor is a role's seat (the chief of staff, S12).
        org_role_id: a.org_role_id ?? null,
        bot_avatar: bot?.image ?? null,
        team_name: (team as any)?.name ?? null,
        in_my_team: a.team_id ? teamIds.has(a.team_id.toString()) : false,
        is_host: a.host_user_id.toString() === userId.toString(),
        conversation_short_id: (conv as any)?.short_id ?? null,
        conv_status: (conv as any)?.status ?? null,
        agent_status: (conv as any)?.agent_status ?? null,
        awaiting_input: (conv as any)?.awaiting_input ?? false,
        has_pending_messages: (conv as any)?.has_pending_messages ?? false,
        conv_updated_at: (conv as any)?.updated_at ?? a.created_at,
      });
    }
    return out;
  },
});

// decommissionAnchor — the explicit retire path the never-complete invariant
// depends on: clear `persistent` (so the session may complete normally), unpin,
// mark it completed, drop channel mappings, and mark the anchor decommissioned so
// a fresh `cast anchor create` can provision a new one.
export const decommissionAnchor = mutation({
  args: { api_token: v.optional(v.string()), anchor_id: v.id("anchors") },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    const anchor = await ctx.db.get(args.anchor_id);
    if (!anchor) throw new Error("Anchor not found");
    if (!(await userCanAdminAnchor(ctx, userId, anchor))) {
      throw new Error("Only an admin (or the host) can retire this anchor");
    }
    await decommissionAnchorRow(ctx, anchor);
    return { decommissioned: true };
  },
});

// Retire one anchor: kill its host session, drop its channel bindings and
// roster seats, and mark the row. Shared by the admin verb above and by team
// deletion, which retires every anchor the team owned.
export async function decommissionAnchorRow(ctx: any, anchor: any): Promise<void> {
  if (anchor.conversation_id) {
    const conv = await ctx.db.get(anchor.conversation_id);
    if (conv) {
      // Tear down the running host agent (status alone doesn't stop the daemon's
      // tmux/process — kill_session does), clear persistence so the row can
      // complete, unpin it, and mark it completed. (All writes here commit
      // atomically, so the relative order is for readability, not correctness.)
      await enqueueKillSessionCommand(ctx, conv as any);
      await ctx.db.patch(anchor.conversation_id, {
        persistent: false,
        inbox_pinned_at: undefined,
        status: "completed",
      });
      // Drop any already-queued turns so the daemon can't auto-resume the
      // just-killed session for one more billed turn (the pending-message rail
      // ignores conversation.status).
      const pending = await ctx.db
        .query("pending_messages")
        .withIndex("by_conversation_status", (q: any) =>
          q.eq("conversation_id", anchor.conversation_id).eq("status", "pending"),
        )
        .collect();
      for (const p of pending) await ctx.db.delete(p._id);
    }
  }
  const chans = await ctx.db
    .query("anchor_channels")
    .withIndex("by_anchor", (q: any) => q.eq("anchor_id", anchor._id))
    .collect();
  for (const ch of chans) await ctx.db.delete(ch._id);
  // Remove the bot from team rosters so retired anchors don't pile up as dead
  // members. Keep the bot user row itself so its past messages still resolve an
  // author.
  const botMemberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", anchor.bot_user_id))
    .collect();
  for (const m of botMemberships) await ctx.db.delete(m._id);
  await ctx.db.patch(anchor._id, {
    status: "decommissioned",
    updated_at: Date.now(),
  });
}

// The Slack workspace installation bound to an anchor's scope (inline lookup to
// avoid importing slack.ts, which imports this module).
async function installForAnchor(ctx: any, anchor: any): Promise<any | null> {
  if (anchor.team_id) {
    return await ctx.db
      .query("slack_installations")
      .withIndex("by_team", (q: any) => q.eq("team_id", anchor.team_id))
      .first();
  }
  if (anchor.scope_user_id) {
    return await ctx.db
      .query("slack_installations")
      .withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", anchor.scope_user_id))
      .first();
  }
  return null;
}

// getAnchorSpace — everything the dedicated Anchor page needs for one scope: the
// anchor (with bot identity + coarse status), its Slack connection, and channels.
// `anchor: null` means "none yet" → the page shows onboarding. The conversation
// itself is loaded by the page via the normal conversation queries.
export const getAnchorSpace = query({
  args: {
    api_token: v.optional(v.string()),
    scope_type: v.union(v.literal("team"), v.literal("user")),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args): Promise<any> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const scopeUserId = args.scope_type === "user" ? userId : undefined;
    let teamId = args.team_id;
    if (args.scope_type === "team" && !teamId) {
      const host = await ctx.db.get(userId);
      teamId = host?.active_team_id ?? host?.team_id ?? undefined;
    }
    if (args.scope_type === "team") {
      if (!teamId) return { scope_type: args.scope_type, anchor: null, no_team: true };
      const member = await ctx.db
        .query("team_memberships")
        .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", teamId))
        .first();
      if (!member) return { scope_type: args.scope_type, anchor: null, forbidden: true };
    }
    const anchor = await findExistingAnchor(ctx, {
      scope_type: args.scope_type,
      team_id: teamId,
      scope_user_id: scopeUserId,
    });
    if (!anchor) return { scope_type: args.scope_type, anchor: null };

    const bot = await ctx.db.get(anchor.bot_user_id as Id<"users">);
    const conv = anchor.conversation_id ? await ctx.db.get(anchor.conversation_id) : null;
    const channels = await ctx.db
      .query("anchor_channels")
      .withIndex("by_anchor", (q: any) => q.eq("anchor_id", anchor._id))
      .collect();
    const install = await installForAnchor(ctx, anchor);

    return {
      scope_type: args.scope_type,
      anchor: {
        _id: anchor._id,
        name: anchor.name,
        persona: anchor.persona ?? null,
        project_path: anchor.project_path ?? null,
        model: anchor.model ?? null,
        status: anchor.status,
        team_id: anchor.team_id ?? null,
        conversation_id: anchor.conversation_id ?? null,
        conversation_short_id: (conv as any)?.short_id ?? null,
        bot_name: (bot as any)?.name ?? anchor.name,
        bot_avatar: (bot as any)?.image ?? null,
        conv_status: (conv as any)?.status ?? null,
        agent_status: (conv as any)?.agent_status ?? null,
        awaiting_input: (conv as any)?.awaiting_input ?? false,
        message_count: (conv as any)?.message_count ?? 0,
        has_pending_messages: (conv as any)?.has_pending_messages ?? false,
        updated_at: (conv as any)?.updated_at ?? anchor.created_at,
        team_name: teamId ? ((await ctx.db.get(teamId)) as any)?.name ?? null : null,
      },
      slack: {
        connected: !!install,
        workspace_name: install?.workspace_name ?? null,
      },
      channels: channels.map((c: any) => ({
        channel_key: c.channel_key,
        workspace_key: c.workspace_key ?? null,
        project_path: c.project_path ?? null,
      })),
    };
  },
});

// updateAnchor — edit an anchor's presentation (name/avatar/persona/model) from
// the settings panel. Name/avatar mirror onto the bot identity so the chip updates.
export const updateAnchor = mutation({
  args: {
    api_token: v.optional(v.string()),
    anchor_id: v.id("anchors"),
    name: v.optional(v.string()),
    avatar_url: v.optional(v.string()),
    persona: v.optional(v.string()),
    model: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    const anchor = await ctx.db.get(args.anchor_id);
    if (!anchor) throw new Error("Anchor not found");
    if (!(await userCanAdminAnchor(ctx, userId, anchor))) {
      throw new Error("Only an admin (or the host) can edit this anchor");
    }
    const patch: Record<string, any> = { updated_at: Date.now() };
    if (args.name !== undefined) patch.name = args.name;
    if (args.persona !== undefined) patch.persona = args.persona;
    if (args.model !== undefined) patch.model = args.model;
    await ctx.db.patch(args.anchor_id, patch);
    const botPatch: Record<string, any> = {};
    if (args.name !== undefined) botPatch.name = args.name;
    if (args.avatar_url !== undefined) botPatch.image = args.avatar_url;
    if (Object.keys(botPatch).length) await ctx.db.patch(anchor.bot_user_id as Id<"users">, botPatch);
    return { ok: true };
  },
});
