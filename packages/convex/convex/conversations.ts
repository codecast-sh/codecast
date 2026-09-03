import { mutation, query, internalMutation, internalQuery, type QueryCtx, type MutationCtx } from "./functions";
import { v } from "convex/values";
import { enqueueStartSession, resolveOwnerDevice } from "./devices";
import { findConversationBySessionReference, resolveConversationRefRanked, findConversationByAnyRefWhere, findConversationByAnyRef } from "./conversationSessionLookup";
import { applyHideTransition, cascadeHideToNestedChildren } from "./cleanup";
import { paginationOptsValidator } from "convex/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { AgentStatus } from "@codecast/shared/contracts";
import {
  openTasksVouchForWaiting,
  OPEN_TASKS_FRESH_MS,
  LOOP_OVERDUE_GRACE_MS,
  computeBucketStale,
  digestProjection,
  inboxEpoch,
  emptyInboxTally,
  computeFold,
  isBelowFoldAt,
  rollupParentIdOf,
  rideLeadPlacements,
  selectWorkingSet,
  WORKING_SET_RECENCY_MS,
  BLOCKED_BANNER_KINDS,
  placeProjectableRow,
  rowLastTurnAllowsPark,
  INBOX_FACT_FIELDS,
  INBOX_PROJECTION_VERSION,
  INBOX_TRUNCATION_KINDS,
  INBOX_WINDOW_CAPS,
  type InboxBucket,
  type InboxPlacement,
  type InboxProjection,
  type InboxTruncation,
} from "@codecast/shared/contracts";
import { Doc, Id } from "./_generated/dataModel";
import { checkRateLimit } from "./rateLimit";
import { verifyApiToken } from "./apiTokens";
import { internal } from "./_generated/api";
import { resetConversationPendingMessages, cancelQueuedMessagesOnKill, enqueuePendingMessage } from "./pendingMessages";
import { latestImagePreviewUrl } from "./messages";
import { inboxVisibilityFields, INBOX_PINNED_CAP, pinCapExceeded, PIN_CAP_ERROR } from "./inboxProjection";
import { cancelTasksBoundToConversation, reactivateTasksCanceledOnKill } from "./agentTasks";
import { advanceForkCopy, type ForkCopyCtx } from "./forkCopy";
import { hasRecentPendingDaemonCommand, extractDaemonCommandConversationId, enqueueResumeSession, requireSessionCommandTarget } from "./daemonCommandUtils";
import { AGENT_MODEL_CONFIG, AGENT_CLIENTS, modelAgentKey, fromConvexAgentType, toConvexAgentType, normalizeThreadState, parseThreadStateStatus, formatAgentSwitchNotice, findModelOption } from "@codecast/shared/contracts";
import { shouldShowInInbox, isSessionIdle, deriveSessionActivity, classifyWorkState, classifyRetirement, normalizeWorkStateFilter, trustedAgentStatus, subagentKeepsParentWorking, isUserDormant, isSettleVerdictCurrent, ACTIVE_AGENT_STATUSES, SUBAGENT_PRODUCING_GRACE_MS, HEARTBEAT_ALIVE_MS, STATUS_TRUST_TTL_MS, AGENT_IDLE_GRACE_MS, type WorkState } from "./inboxFilters";
import { armedTriggerHomeLoader, isArmedTriggerHome, isArmedTriggerHomeOfKind, isArmedLoopHome } from "./dormancy";
import { subagentLinkFields } from "./ccAccountsShared";
import { isSessionOwner } from "./sessionOwners";
import { filterUserMessages, isImportNotice } from "./userMessagesFilter";
import {
  isTeamMember,
  canTeamMemberAccess,
  canOwnerOrTeamAccess,
  checkConversationAccess,
  isConversationTeamVisible,
  createTeamFeedFilter,
  resolveTeamForPath,
  resolveCreationPrivacy,
  resolveVisibilityMode,
  buildShareUpdate,
  buildPathRestampUpdate,
  type AccessLevel,
} from "./privacy";
import { patchConversationVisibility } from "./lib/access";
import { batchScanConversations, paginateTeamFeed } from "./feedPagination";
import { mergeUserMessageFeed, type FeedCandidate } from "./messageFeed";
import { assignConversationToBucketForUser, resolveLabelConvIds, matchBucketByName } from "./buckets";
import { advanceCommentsAccessRevision } from "./commentViewWrites";
import { projectOverlaps } from "./projectPaths";
import {
  parseSearchTerms,
  contentMatchesAnyTerm,
  conversationMatchesAllTerms,
  calculateProximityScore,
  rankConversationsByCoverage,
  type ParsedTerms,
} from "./searchCore";
import { MIRROR_WINDOW_MS } from "./searchMirror";
import { requireUser } from "./lib/auth";
import { liveConversationIdSet } from "./lib/liveSessions";
import { readLocalViewRevision, runLocalCommand } from "./localFirstCommands";
import {
  FAVORITES_GRANT_KEY,
  FAVORITES_VIEW_CONTRACT_ID,
  FAVORITES_VIEW_KEY,
  grantedView,
  projectFavoriteMembership,
  unauthenticatedView,
} from "./smallViewContracts";
import {
  favoriteCoverageForConversation,
  setFavoriteWithRevision,
  toggleFavoriteWithRevision,
} from "./favoriteViewWrites";

// Single relevance-ranked search-index lookup shared by every message-search
// surface (web searchConversations, searchForCLI, feedForCLI). One combined
// lookup instead of a per-term fan-out: per-lookup overhead dominates on long
// queries (a 7-term query = 7 index scans) and timed out the whole Convex query.
// BM25 already ranks docs matching more/rarer terms first, so a single pool is
// also the better candidate set for coverage ranking. The take() is the recall/speed
// knob: message docs can be large (tool results), so a bigger pool costs bytes.
//
// NOTE: `.take()` bounds only what's RETURNED, not what the full-text index
// SCANS. For a token that appears across a large fraction of the multi-million-
// row messages table (any common word), search_content_v2 scores the whole
// posting list and exceeds the query budget regardless of take size. That is
// why content search serves from the message_search_recent mirror (bounded
// corpus, see searchMirror.ts) whenever its cron is caught up — the deep index
// below is only the fallback while the mirror is cold or its walker is behind
// (its staleness then shows as timeouts again, ct-37627).
// The narrow shape every search consumer actually reads. Both tiers project
// to it so the mirror and the deep index are interchangeable downstream
// (_id is the real messages id either way — deep links depend on it).
type SearchPoolMessage = {
  _id: Id<"messages">;
  conversation_id: Id<"conversations">;
  role: Doc<"messages">["role"];
  content: string;
  timestamp: number;
  tool_calls_count?: number;
  tool_results_count?: number;
};

async function fetchMessageSearchPool(
  ctx: QueryCtx,
  terms: ParsedTerms,
  // Caller identity for SCOPED lookups. The global lookup truncates at 512
  // BM25-ranked rows BEFORE any visibility filtering, so one user's
  // term-heavy private sessions can push every hit the caller may actually
  // see below the cutoff ("workflow" returned zero for everyone while one
  // account's eval sessions owned 464 of the 512 pooled rows). Per-caller and
  // per-team lookups carve out pools the flood cannot touch; the global
  // lookup stays as the catch-all for restamped/edge rows. Scope stamps on
  // mirror rows are snapshots — visibility is still enforced downstream
  // against the live conversation doc.
  scope?: { userId: Id<"users">; teamIds: Id<"teams">[] },
): Promise<{ pool: SearchPoolMessage[]; tier: "recent" | "deep" }> {
  if (terms.all.length === 0) return { pool: [], tier: "deep" };
  const searchQuery = terms.all.join(" ");
  // search_mirror_live changes only on liveness transitions, so this read
  // keeps open search subscriptions stable (the walker's per-tick cursor row
  // must never be read here — it would re-run every open search each tick).
  const mirror = await ctx.db.query("search_mirror_live").first();
  if (mirror?.live) {
    const search = (refine?: (q: any) => any) =>
      ctx.db
        .query("message_search_recent")
        .withSearchIndex("search_content_r2", (q) => {
          const base = q.search("content", searchQuery);
          return refine ? refine(base) : base;
        })
        .take(512);
    // Scoped lookups FIRST: coverage ranking downstream is a stable sort, so
    // within a coverage tier pool order decides who survives the candidate
    // slice — the caller's own rows must precede the (possibly flooded)
    // global batch.
    const lookups = [];
    if (scope) {
      lookups.push(search((q) => q.eq("user_id", scope.userId)));
      // Bounded: lookup count is what blows budgets, and the global lookup
      // already covers whatever a capped-out team list would have added.
      for (const teamId of scope.teamIds.slice(0, 4)) {
        lookups.push(search((q) => q.eq("team_id", teamId)));
      }
    }
    lookups.push(search());
    const batches = await Promise.all(lookups);
    const seen = new Set<string>();
    const rows: Doc<"message_search_recent">[] = [];
    for (const batch of batches) {
      for (const r of batch) {
        const key = r.message_id.toString();
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(r);
      }
    }
    return {
      tier: "recent",
      pool: rows.map((r) => ({
        _id: r.message_id,
        conversation_id: r.conversation_id,
        role: r.role,
        content: r.content,
        timestamp: r.timestamp,
        tool_calls_count: r.tool_calls_count,
        tool_results_count: r.tool_results_count,
      })),
    };
  }
  const docs = await ctx.db
    .query("messages")
    .withSearchIndex("search_content_v2", (q) => q.search("content", searchQuery))
    .take(512);
  return {
    tier: "deep",
    pool: docs.map((m) => ({
      _id: m._id,
      conversation_id: m.conversation_id,
      role: m.role,
      content: m.content ?? "",
      timestamp: m.timestamp,
      tool_calls_count: m.tool_calls?.length,
      tool_results_count: m.tool_results?.length,
    })),
  };
}

// Days of message history the recent tier covers — returned to clients so UI
// copy about content-search coverage stays truthful if the window changes.
const CONTENT_WINDOW_DAYS = Math.round(MIRROR_WINDOW_MS / 86_400_000);

// Team-scoped visibility context shared by the conversation-search queries:
// the rosters of every team the caller can see, the per-team feed filters,
// and the visibility predicate built from them. mineOnly skips roster loading
// entirely — the predicate then only passes the caller's own conversations.
async function loadConversationSearchScope(
  ctx: QueryCtx,
  userId: Id<"users">,
  user: Doc<"users">,
  args: { mineOnly?: boolean; activeTeamId?: Id<"teams"> },
) {
  const userMemberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .collect();
  const userTeamIds = userMemberships.map(m => m.team_id);

  const effectiveTeamIds = args.mineOnly
    ? []
    : args.activeTeamId ? [args.activeTeamId] : userTeamIds;

  const allTeamUsers: Doc<"users">[] = [];
  for (const teamId of effectiveTeamIds) {
    const teamMemberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_team_id", (q) => q.eq("team_id", teamId))
      .collect();
    const memberUsers = await Promise.all(
      teamMemberships.map(m => ctx.db.get(m.user_id))
    );
    allTeamUsers.push(...memberUsers.filter((u): u is Doc<"users"> => u !== null));
  }
  const teamUsers = [...new Map(allTeamUsers.map(u => [u._id.toString(), u])).values()];
  const teamUserIds = new Set(teamUsers.map(u => u._id.toString()));
  const effectiveTeamIdSet = new Set(effectiveTeamIds.map(id => id.toString()));

  const feedFilters = new Map<string, Awaited<ReturnType<typeof createTeamFeedFilter>>>();
  for (const teamId of effectiveTeamIds) {
    feedFilters.set(teamId.toString(), await createTeamFeedFilter(ctx, teamId));
  }

  // Author identities for result rows: every visible conversation is authored
  // by the caller or a loaded team member, so no per-result ctx.db.get needed.
  const userById = new Map<string, Doc<"users">>(teamUsers.map(u => [u._id.toString(), u]));
  userById.set(userId.toString(), user);

  const isVisible = (conv: Doc<"conversations">): boolean => {
    if (conv.user_id.toString() === userId.toString()) return true;
    if (!conv.team_id || !effectiveTeamIdSet.has(conv.team_id.toString())) return false;
    const filter = feedFilters.get(conv.team_id.toString());
    if (!filter || !filter.isVisible(conv)) return false;
    if (!teamUserIds.has(conv.user_id.toString())) return false;
    return true;
  };

  return { userById, isVisible, effectiveTeamIds };
}

// Titles and summaries aren't covered by the message index — search them
// directly so a session like "Poll render debug" surfaces even when no
// message body matches. subtitle (multi-line generated summary) and
// idle_summary (one-line blurb) catch sessions the user remembers by their
// summary wording rather than their title. These scans run over the (small)
// conversations table, so they stay within budget even when the message
// full-text search can't (see the fetchMessageSearchPool NOTE) — which is why
// searchConversationTitles exposes them on their own.
async function fetchTitleFieldHits(ctx: QueryCtx, terms: ParsedTerms) {
  const searchQuery = terms.all.join(" ");
  const fieldHits = await Promise.all([
    ctx.db
      .query("conversations")
      .withSearchIndex("search_title_v2", (q) => q.search("title", searchQuery))
      .take(50),
    ctx.db
      .query("conversations")
      .withSearchIndex("search_subtitle", (q) => q.search("subtitle", searchQuery))
      .take(50),
    ctx.db
      .query("conversations")
      .withSearchIndex("search_idle_summary", (q) => q.search("idle_summary", searchQuery))
      .take(50),
  ]);
  const hits = new Map<string, Doc<"conversations">>();
  for (const conv of fieldHits.flat()) {
    const convId = conv._id.toString();
    if (hits.has(convId)) continue;
    const directFields = `${conv.title || ""} ${conv.subtitle || ""} ${conv.idle_summary || ""}`;
    if (!contentMatchesAnyTerm(directFields, terms)) continue;
    hits.set(convId, conv);
  }
  return hits;
}

// First-message fetch only feeds a title fallback, so it's only needed for
// the title-less conversations that actually made the displayed slice.
async function resolveFirstMessageTitles(ctx: QueryCtx, convs: Doc<"conversations">[]) {
  const firstMsgByConv = new Map<string, string>();
  await Promise.all(
    convs.map(async (conv) => {
      if (conv.title) return;
      const firstMessages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
        .order("asc")
        .take(10);
      for (const msg of firstMessages) {
        const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
        if (msg.role === "user" && !hasToolResults) {
          const text = msg.content?.trim();
          if (text) {
            let firstUserMessage = text.slice(0, 120);
            if (text.length > 120) firstUserMessage += "...";
            firstMsgByConv.set(conv._id.toString(), firstUserMessage);
            break;
          }
        }
      }
    })
  );
  return firstMsgByConv;
}

const NOISE_TITLE_PREFIXES = ["[Using:", "[Request", "[SUGGESTION MODE:"];

// Hard cap on per-field diff size stored on conversation rows. Daemon already
// truncates at 100KB before send, but the server defends against any future
// client that bypasses that. Oversized diffs blow the Convex isolate's 96 MiB
// memory limit when collateral queries (heartbeat, webListPaginated, webList)
// do `ctx.db.get(conversationId)` and pull the whole row.
const MAX_GIT_DIFF_SIZE = 100_000;
function truncateGitDiff(s: string | undefined): string | undefined {
  return s && s.length > MAX_GIT_DIFF_SIZE ? s.slice(0, MAX_GIT_DIFF_SIZE) : s;
}

// Upsert the git side row for a conversation. The diff blobs and the status
// text live off the conversations hot doc (see conversation_git_diffs in
// schema.ts): the inbox scan reads every candidate doc in full, so any bytes a
// list never renders are paid on every recompute. Only getConversationGitDiff
// reads them. Deletes the row when everything is empty.
export async function setConvGitDiff(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  gitDiff: string | undefined,
  gitDiffStaged: string | undefined,
  gitStatus?: string,
) {
  const diff = truncateGitDiff(gitDiff);
  const staged = truncateGitDiff(gitDiffStaged);
  const status = truncateGitDiff(gitStatus);
  const existing = await ctx.db
    .query("conversation_git_diffs")
    .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conversationId))
    .first();
  if (!diff && !staged && !status) {
    if (existing) await ctx.db.delete(existing._id);
    return;
  }
  if (existing) {
    await ctx.db.patch(existing._id, { git_diff: diff, git_diff_staged: staged, git_status: status, updated_at: Date.now() });
  } else {
    await ctx.db.insert("conversation_git_diffs", {
      conversation_id: conversationId,
      git_diff: diff,
      git_diff_staged: staged,
      git_status: status,
      updated_at: Date.now(),
    });
  }
}

// Upsert / read the stable-context side row (conversation_context). Same
// hot-doc rationale as the git side row; the sweep in debugTmp moves legacy
// on-doc values here.
export async function setConvStableContext(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  data: string,
) {
  const existing = await ctx.db
    .query("conversation_context")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conversationId))
    .first();
  if (existing) {
    await ctx.db.patch(existing._id, { stable_context: data, updated_at: Date.now() });
  } else {
    await ctx.db.insert("conversation_context", {
      conversation_id: conversationId,
      stable_context: data,
      updated_at: Date.now(),
    });
  }
}

async function getConvStableContext(
  ctx: { db: any },
  conversationId: Id<"conversations">,
): Promise<string | null> {
  const row = await ctx.db
    .query("conversation_context")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conversationId))
    .first();
  return row?.stable_context ?? null;
}

// Read the git side row (conversation_git_diffs). Blobs no longer live on the
// conversation doc.
async function getConvGitDiff(
  ctx: QueryCtx,
  conversationId: Id<"conversations">,
): Promise<{ git_diff: string | null; git_diff_staged: string | null; git_status: string | null }> {
  const row = await ctx.db
    .query("conversation_git_diffs")
    .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conversationId))
    .first();
  return {
    git_diff: row?.git_diff ?? null,
    git_diff_staged: row?.git_diff_staged ?? null,
    git_status: row?.git_status ?? null,
  };
}

// Compress a raw message body into a short chip/snippet. Strips command/HTML
// wrappers (e.g. `<command-name>/commit</command-name>`) and collapses
// whitespace so a branch's divergent prompt reads cleanly in ~one line.
function previewText(content: string | null | undefined): string | undefined {
  if (!content) return undefined;
  const cleaned = content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.length > 100 ? cleaned.slice(0, 100) + "…" : cleaned;
}

// The first *genuine* user prompt on a branch after `afterTs` — i.e. the message
// the human typed that sent this branch its own way. For a fork that's the
// prompt past the fork cutoff; for the origin line it's the next human turn
// after the fork point. This is what distinguishes otherwise-identical sibling
// branches.
//
// Routes rows through the same `filterUserMessages` gate the message browser /
// rewind navigator uses, so the chip label matches a prompt you could actually
// navigate to. That gate strips harness context blocks (`<task-notification>`,
// `<system-reminder>`, `<task-reminder>`) and drops noise (tool-result echoes,
// interrupt stubs, compact boundaries, import notices) — without it a
// background-task notification leaked through as a chip reading like its raw
// ids ("w68f2jcpo toolu_01…"). Read window is generous because an
// orchestration origin line can run many tool/notification rows between the
// fork point and its next human prompt.
async function firstDivergentPreview(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  afterTs: number,
): Promise<string | undefined> {
  const rows = await ctx.db
    .query("messages")
    .withIndex("by_conversation_timestamp", (q: any) =>
      q.eq("conversation_id", conversationId).gt("timestamp", afterTs)
    )
    .order("asc")
    .take(40);
  for (const m of filterUserMessages(rows)) {
    const p = previewText(m.content);
    if (p) return p;
  }
  return undefined;
}

// The origin line is just another sibling branch in the UI, so it needs the
// same "what prompt sent it this way" snippet the forks carry: its next user
// turn after the fork point. Which line is "the origin" depends on where each
// fork anchored — a child forked off THIS conversation (origin = this one),
// while a sibling forked off our parent (origin = forked_from). Fork-point
// timestamps come from a uuid lookup (it's shared history) so this needs no
// loaded message window — callable from the meta-only query.
async function computeOriginDivergentPreviews(
  ctx: { db: any },
  conversation: any,
  forkChildrenDetails: Array<{ parent_message_uuid?: string }>,
  forkSiblings: Array<{ parent_message_uuid?: string }>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const fill = async (
    forks: Array<{ parent_message_uuid?: string }>,
    originLineId: Id<"conversations"> | undefined,
  ) => {
    if (!originLineId) return;
    for (const fork of forks) {
      const uuid = fork.parent_message_uuid;
      if (!uuid || out[uuid]) continue;
      const fp = await ctx.db
        .query("messages")
        .withIndex("by_message_uuid", (q: any) => q.eq("message_uuid", uuid))
        .first();
      if (!fp) continue;
      const preview = await firstDivergentPreview(ctx, originLineId, fp.timestamp);
      if (preview) out[uuid] = preview;
    }
  };
  await fill(forkChildrenDetails, conversation._id);
  await fill(forkSiblings, conversation.forked_from ?? undefined);
  return out;
}

async function mapForkDetails(ctx: { db: any }, forks: any[]) {
  return Promise.all(
    forks.map(async (fork: any) => {
      const forkUser = await ctx.db.get(fork.user_id);
      // The prompt that defines this branch: first user message past the fork
      // cutoff. Drives the chip label so siblings read distinctly instead of by
      // their convergent auto-titles.
      const first_divergent_preview = await firstDivergentPreview(
        ctx,
        fork._id,
        fork.fork_cutoff_timestamp ?? 0,
      );
      return {
        _id: fork._id,
        user_id: fork.user_id,
        title: fork.title || "New Session",
        short_id: fork.short_id,
        started_at: fork.started_at,
        username: forkUser?.name || forkUser?.email?.split("@")[0] || "Unknown",
        parent_message_uuid: fork.parent_message_uuid,
        agent_type: fork.agent_type,
        message_count: fork.message_count,
        first_divergent_preview,
        // Free fields straight off the conversation row — no extra reads. The
        // client subtracts fork_copied (messages inherited from the parent up to
        // the fork point) from message_count to show this branch's *own* size,
        // and uses updated_at to derive an unread badge against its local
        // _seenMessageCount cursor. The rest enriches the hover.
        updated_at: fork.updated_at,
        last_message_preview: fork.last_message_preview,
        last_message_role: fork.last_message_role,
        last_user_message_at: fork.last_user_message_at,
        status: fork.status,
        git_branch: fork.git_branch,
        fork_copied: fork.fork_copied,
        // Triage/visibility state, free off the same row. The client preloads
        // every returned branch into its sessions cache (preloadForkSessions);
        // omitting these seeded a stashed/dismissed branch as an ACTIVE row,
        // which rendered as a needs-input card on every boot until the live
        // inbox payload delivered the real stamps (the "forks flash in the
        // inbox on reload" bug). A seeded row must never claim more liveness
        // than the server row it came from.
        forked_from: fork.forked_from,
        project_path: fork.project_path,
        git_root: fork.git_root,
        ...inboxVisibilityFields(fork),
      };
    })
  );
}

// Forks of `parentId` the viewer may actually open, shaped for the branch UI.
// Filtering by access is load-bearing, not cosmetic: the client preloads every
// returned branch into its local store for instant switching, so an unfiltered
// list would both leak teammates' private forks into the inbox AND surface chips
// that deny on click (the "branch spins forever" bug). Owner forks short-circuit
// the access check, so the common all-mine case stays cheap.
async function getAccessibleForkChildren(
  ctx: QueryCtx,
  authUserId: Id<"users"> | null,
  parentId: Id<"conversations">,
) {
  const forks = await ctx.db
    .query("conversations")
    .withIndex("by_forked_from", (q) => q.eq("forked_from", parentId))
    .collect();
  const visible = [];
  for (const fork of forks) {
    if ((await checkConversationAccess(ctx, authUserId, fork)) !== "denied") {
      visible.push(fork);
    }
  }
  return mapForkDetails(ctx, visible);
}

async function getAuthenticatedUserId(
  ctx: { db: any },
  apiToken?: string
): Promise<Id<"users"> | null> {
  const sessionUserId = await getAuthUserId(ctx as any);
  if (sessionUserId) {
    return sessionUserId;
  }

  if (apiToken) {
    const result = await verifyApiToken(ctx, apiToken);
    if (result) {
      return result.userId;
    }
  }

  return null;
}

async function getAuthenticatedUserIdReadOnly(
  ctx: { db: any },
  apiToken?: string
): Promise<Id<"users"> | null> {
  const sessionUserId = await getAuthUserId(ctx as any);
  if (sessionUserId) {
    return sessionUserId;
  }

  if (apiToken) {
    const result = await verifyApiToken(ctx, apiToken, false);
    if (result) {
      return result.userId;
    }
  }

  return null;
}

function resolveUserSkills(userSkillsJson: string | undefined, projectPath: string | undefined | null): string | undefined {
  if (!userSkillsJson) return undefined;
  try {
    const parsed = JSON.parse(userSkillsJson);
    if (Array.isArray(parsed)) return userSkillsJson;
    const global: Array<{ name: string }> = parsed["global"] || [];
    const project: Array<{ name: string }> = projectPath ? (parsed[projectPath] || []) : [];
    const seen = new Set<string>();
    const merged = [];
    for (const s of [...global, ...project]) {
      if (!seen.has(s.name)) { seen.add(s.name); merged.push(s); }
    }
    return merged.length > 0 ? JSON.stringify(merged) : undefined;
  } catch { return userSkillsJson; }
}

function isValidConvexFieldName(key: string): boolean {
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function sanitizeConvexObjectKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeConvexObjectKeys(item)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (!isValidConvexFieldName(key)) continue;
      out[key] = sanitizeConvexObjectKeys(child);
    }
    return out as T;
  }
  return value;
}

/**
 * Stable context is a snapshot of the owner's recent solo/team feed, not part
 * of the shared conversation itself. It can contain unrelated session titles,
 * teammate names, full project paths, and private conversation ids. Preserve it
 * for authenticated owner/team views, but never let a share token turn that
 * feed snapshot into public data.
 */
export function conversationForAccess<T extends Record<string, any>>(
  conversation: T,
  access: AccessLevel,
): T {
  if (access === "owner" || access === "team") return conversation;
  const { stable_context: _stableContext, ...publicConversation } = conversation;
  return publicConversation as T;
}

function matchChildByPrompt(
  prompt: string,
  subagents: Array<{ _id: string; preview: string }>,
): string | undefined {
  if (!prompt || subagents.length === 0) return undefined;
  const promptStart = prompt.slice(0, 100).toLowerCase().trim();
  for (const child of subagents) {
    const preview = child.preview.slice(0, 100).toLowerCase().trim();
    if (promptStart === preview || promptStart.startsWith(preview) || preview.startsWith(promptStart)) {
      return child._id;
    }
  }
  return undefined;
}

async function findChildConversations(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  messages: Array<{ message_uuid?: string; tool_calls?: Array<{ name: string; input: string }> }>,
): Promise<{
  children: Array<{ _id: string; title: string; is_subagent?: boolean; first_message_preview?: string }>;
  map: Record<string, string>;
  agentNameEntries: Array<[string, string]>;
}> {
  const map: Record<string, string> = {};

  const CHILDREN_LIMIT = 2000;
  const allChildren = await ctx.db
    .query("conversations")
    .withIndex("by_parent_conversation_id", (q: any) => q.eq("parent_conversation_id", conversationId))
    .order("desc")
    .take(CHILDREN_LIMIT);

  const subagentChildren = allChildren.filter((c: any) => c.is_subagent || !c.parent_message_uuid);
  // Each preview costs a separate messages query. Convex budgets ~4k system
  // operations per function; a session with thousands of spawned children blew
  // straight through it ("too many system operations" timeouts). Cap the N+1 —
  // allChildren is newest-first, so the newest children keep their previews.
  const PREVIEW_LIMIT = 300;
  const firstMessagePreviews = new Map<string, string>();
  for (const child of subagentChildren.slice(0, PREVIEW_LIMIT)) {
    const firstMsg = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", child._id))
      .first();
    if (firstMsg?.content) {
      const content = typeof firstMsg.content === "string" ? firstMsg.content : "";
      const cleaned = content.replace(/<[^>]+>/g, "").trim();
      firstMessagePreviews.set(child._id as string, cleaned.slice(0, 150));
    }
  }

  const children = allChildren
    .filter((conv: any) => !NOISE_TITLE_PREFIXES.some((p) => (conv.title || "").startsWith(p)))
    .map((conv: any) => ({
      _id: conv._id,
      title: conv.title || "New Session",
      is_subagent: conv.is_subagent || !conv.parent_message_uuid,
      first_message_preview: firstMessagePreviews.get(conv._id as string),
    }));

  const childByParentUuid = new Map<string, string>(
    allChildren
      .filter((c: any) => c.parent_message_uuid)
      .map((c: any) => [c.parent_message_uuid as string, c._id as string])
  );
  for (const msg of messages) {
    if (msg.message_uuid && childByParentUuid.has(msg.message_uuid)) {
      map[msg.message_uuid] = childByParentUuid.get(msg.message_uuid)!;
    }
  }

  // Build agent name -> child conversation ID map from stored subagent_description
  const agentNameMap: Record<string, string> = {};
  for (const child of subagentChildren) {
    if (child.subagent_description) {
      agentNameMap[child.subagent_description] = child._id as string;
    }
  }

  // Fallback: scan parent messages for Agent/Task tool calls to build UUID map and
  // fill agentNameMap for children without subagent_description (legacy data)
  const unmappedChildren = subagentChildren.filter(
    (c: any) => !c.subagent_description && firstMessagePreviews.has(c._id as string)
  );
  if (unmappedChildren.length > 0) {
    const subagentMatchData = unmappedChildren
      .map((c: any) => ({ _id: c._id as string, preview: firstMessagePreviews.get(c._id as string)! }));

    const matchToolCall = (msg: any, tc: any) => {
      try {
        const inp = JSON.parse(tc.input);
        if (!inp.prompt) return;
        const childId = matchChildByPrompt(inp.prompt, subagentMatchData);
        if (!childId) return;
        if (inp.name) agentNameMap[inp.name] = childId;
        if (inp.description) agentNameMap[inp.description] = childId;
        if (msg.message_uuid) map[msg.message_uuid] = childId;
      } catch {}
    };

    for (const msg of messages) {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.name === "Task" || tc.name === "Agent") matchToolCall(msg, tc);
        }
      }
    }

    const matchedChildIds = new Set([...Object.values(map), ...Object.values(agentNameMap)]);
    if (matchedChildIds.size < subagentChildren.length) {
      // Bounded newest-first scan, NOT .collect(): collecting a 7k-message
      // transcript here was the other half of the operation-budget timeout.
      // Recent messages hold the spawns most likely to still need matching.
      const allParentMessages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", conversationId))
        .order("desc")
        .take(2000);
      for (const msg of allParentMessages) {
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            if (tc.name === "Task" || tc.name === "Agent") matchToolCall(msg, tc);
          }
        }
      }
    }
  }

  return { children, map, agentNameEntries: Object.entries(agentNameMap) };
}

export function generateShareToken(): string {
  return crypto.randomUUID();
}

function formatSlugAsTitle(slug: string): string {
  return slug
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

type MessageLike = {
  content?: string | null;
  tool_calls?: unknown[] | null;
  tool_results?: unknown[] | null;
};

function isNonEmptyMessage(m: MessageLike): boolean {
  const hasContent = m.content && m.content.trim();
  const hasToolCalls = m.tool_calls && m.tool_calls.length > 0;
  const hasToolResults = m.tool_results && m.tool_results.length > 0;
  return !!(hasContent || hasToolCalls || hasToolResults);
}

export const resolveTeamFromDirectory = query({
  args: {
    api_token: v.string(),
    project_path: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      return null;
    }

    const mappings = await ctx.db
      .query("directory_team_mappings")
      .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
      .collect();

    let bestMatch: { teamId: Id<"teams">; pathLength: number } | null = null;
    for (const mapping of mappings) {
      if (args.project_path === mapping.path_prefix || args.project_path.startsWith(mapping.path_prefix + "/")) {
        if (!bestMatch || mapping.path_prefix.length > bestMatch.pathLength) {
          bestMatch = {
            teamId: mapping.team_id,
            pathLength: mapping.path_prefix.length,
          };
        }
      }
    }

    return bestMatch?.teamId || null;
  },
});

export const createConversation = mutation({
  args: {
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    agent_type: v.union(
      v.literal("claude_code"),
      v.literal("codex"),
      v.literal("cursor"),
      v.literal("gemini"),
      v.literal("opencode"),
      v.literal("pi"),
      v.literal("grok")
    ),
    session_id: v.string(),
    project_hash: v.optional(v.string()),
    project_path: v.optional(v.string()),
    slug: v.optional(v.string()),
    title: v.optional(v.string()),
    started_at: v.optional(v.number()),
    parent_message_uuid: v.optional(v.string()),
    parent_conversation_id: v.optional(v.string()),
    git_commit_hash: v.optional(v.string()),
    git_branch: v.optional(v.string()),
    git_remote_url: v.optional(v.string()),
    git_status: v.optional(v.string()),
    git_diff: v.optional(v.string()),
    git_diff_staged: v.optional(v.string()),
    git_root: v.optional(v.string()),
    cli_flags: v.optional(v.string()),
    worktree_name: v.optional(v.string()),
    worktree_branch: v.optional(v.string()),
    worktree_path: v.optional(v.string()),
    worktree_status: v.optional(v.union(
      v.literal("active"),
      v.literal("merged"),
      v.literal("archived")
    )),
    subagent_description: v.optional(v.string()),
    // Daemon-asserted subagent flag (transcript lives under a subagents/ dir).
    // The parent LINK may resolve much later (parent not yet in the daemon's
    // cache), so without this the row is born looking like a normal session
    // and teammates get a "started coding" push for it.
    is_subagent: v.optional(v.boolean()),
    agent_team_name: v.optional(v.string()),
    agent_name: v.optional(v.string()),
    // Device id of the daemon syncing this transcript. The transcript (and any
    // tmux session) lives on that machine, so it is the only daemon that can
    // deliver messages here. Without this stamp, ownership was only set lazily
    // when a daemon claimed the conversation's FIRST pending message — a
    // broadcast race every one of the user's daemons entered, and a remote
    // daemon (no transcript, no pane) sometimes won, silently black-holing
    // delivery. Optional for older CLIs; claim-time stamping remains the
    // fallback for conversations created without it.
    owner_device_id: v.optional(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }
    if (authUserId.toString() !== args.user_id.toString()) {
      throw new Error("Unauthorized: can only create conversations for yourself");
    }

    await checkRateLimit(ctx, args.user_id, "createConversation");

    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .filter((q) => q.eq(q.field("user_id"), args.user_id))
      .first();

    if (existing) {
      const patch: Record<string, any> = {};
      if (args.parent_conversation_id) {
        if (!existing.parent_conversation_id) {
          patch.parent_conversation_id = args.parent_conversation_id as Id<"conversations">;
        }
        if (args.parent_message_uuid && !existing.parent_message_uuid) {
          patch.parent_message_uuid = args.parent_message_uuid;
          patch.is_subagent = undefined;
        } else if (!existing.parent_conversation_id && !args.parent_message_uuid) {
          patch.is_subagent = true;
        }
        if (args.subagent_description && !existing.subagent_description) {
          patch.subagent_description = args.subagent_description;
        }
      }
      if (
        args.is_subagent &&
        !("is_subagent" in patch) &&
        !existing.is_subagent &&
        !existing.parent_message_uuid &&
        !args.parent_message_uuid
      ) {
        patch.is_subagent = true;
      }
      if (args.agent_team_name && !existing.agent_team_name) {
        patch.agent_team_name = args.agent_team_name;
        if (args.agent_name && !existing.agent_name) patch.agent_name = args.agent_name;
      }
      // Adopt an unowned conversation; never steal one another device owns
      // (explicit ownership transfers go through sessionOwnership).
      if (args.owner_device_id && !existing.owner_device_id) {
        patch.owner_device_id = args.owner_device_id;
      }
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(existing._id, patch);
      }
      return existing._id;
    }

    const now = Date.now();
    const startedAt = args.started_at ?? now;

    const conversationPath = args.git_root || args.project_path;
    const { team_id: resolvedTeamId, is_private: isPrivate, auto_shared: autoShared } =
      await resolveCreationPrivacy(ctx, args.user_id, conversationPath, args.team_id as Id<"teams"> | undefined);

    let parentConversationId: Id<"conversations"> | undefined;
    if (args.parent_conversation_id) {
      parentConversationId = args.parent_conversation_id as Id<"conversations">;
    } else if (args.parent_message_uuid) {
      const parentMsg = await ctx.db
        .query("messages")
        .withIndex("by_message_uuid", (q) => q.eq("message_uuid", args.parent_message_uuid!))
        .first();
      if (parentMsg) {
        parentConversationId = parentMsg.conversation_id;
      }
    }

    const conversationId = await ctx.db.insert("conversations", {
      user_id: args.user_id,
      team_id: resolvedTeamId,
      agent_type: args.agent_type,
      session_id: args.session_id,
      slug: args.slug,
      title: args.title,
      project_hash: args.project_hash,
      project_path: args.project_path,
      owner_device_id: args.owner_device_id,
      started_at: startedAt,
      updated_at: startedAt,
      message_count: 0,
      is_private: isPrivate,
      auto_shared: autoShared || undefined,
      status: "active",
      parent_message_uuid: args.parent_message_uuid,
      parent_conversation_id: parentConversationId,
      is_subagent: (args.is_subagent === true && !args.parent_message_uuid) ||
        (!!parentConversationId && !args.parent_message_uuid) || undefined,
      agent_team_name: args.agent_team_name,
      agent_name: args.agent_name,
      git_commit_hash: args.git_commit_hash,
      git_branch: args.git_branch,
      git_remote_url: args.git_remote_url,
      git_root: args.git_root,
      cli_flags: args.cli_flags,
      worktree_name: args.worktree_name,
      worktree_branch: args.worktree_branch,
      worktree_path: args.worktree_path,
      worktree_status: args.worktree_status,
      subagent_description: args.subagent_description,
    });
    // Set short_id for O(1) lookup by truncated ID
    await ctx.db.patch(conversationId, {
      short_id: conversationId.toString().slice(0, 7),
    });
    // Funnel: the user's first synced session ever. Stamped on the users doc so
    // this stays an O(1) check instead of a conversations scan per create.
    const creator = await ctx.db.get(args.user_id);
    if (creator && !(creator as any).first_session_synced_at) {
      await ctx.db.patch(args.user_id, { first_session_synced_at: now } as any);
      await ctx.scheduler.runAfter(0, internal.analytics.capture, {
        event: "first_session_synced",
        distinctId: args.user_id.toString(),
        properties: { agent_type: args.agent_type },
      });
    }
    // git_diff blobs and git_status live off the hot doc in conversation_git_diffs.
    await setConvGitDiff(ctx, conversationId, args.git_diff, args.git_diff_staged, args.git_status);
    // Terminal-started sessions: the SessionStart hook usually reports the
    // injected stable context before this registration — attach the parked record.
    await consumeStableContextSpool(ctx, args.user_id, args.session_id, conversationId);

    // Auto-dismiss parent only for plan handoffs (clear context -> implementation session)
    if (parentConversationId && args.parent_message_uuid === "plan-handoff") {
      const parent = await ctx.db.get(parentConversationId);
      if (parent && !parent.inbox_dismissed_at) {
        await ctx.db.patch(parentConversationId, {
          inbox_dismissed_at: Date.now(),
          status: "completed",
        });

        if (parent.team_id && await isConversationTeamVisible(ctx, parent)) {
          await ctx.scheduler.runAfter(0, internal.teamActivity.recordTeamActivity, {
            team_id: parent.team_id,
            actor_user_id: parent.user_id,
            event_type: "session_completed" as const,
            title: parent.title || (parent.slug ? formatSlugAsTitle(parent.slug) : "Session completed"),
            description: parent.project_path,
            related_conversation_id: parentConversationId,
            metadata: {
              duration_ms: parent.updated_at - parent.started_at,
              message_count: parent.message_count,
              git_branch: parent.git_branch,
            },
          });
        }

        await ctx.scheduler.runAfter(0, internal.sessionInsights.generateSessionInsight, {
          conversation_id: parentConversationId,
          reason: "periodic",
        });
      }
    }

    if (args.api_token) {
      await ctx.db.patch(args.user_id, {
        daemon_last_seen: now,
      });
    }

    if (resolvedTeamId && !existing) {
      const bornSubagent =
        args.is_subagent === true || (!!parentConversationId && !args.parent_message_uuid);
      if (!bornSubagent) {
        // Grace delay: subagent/spawned-by links are often stamped seconds
        // after registration (linkSessions/linkSpawnedBy). notifyTeamSessionStart
        // re-reads the conversation at fire time, so the delay lets a late
        // link suppress the push instead of racing it.
        const NOTIFY_GRACE_MS = 60 * 1000;
        await ctx.scheduler.runAfter(NOTIFY_GRACE_MS, internal.notifications.notifyTeamSessionStart, {
          conversation_id: conversationId,
          user_id: args.user_id,
        });
      }

      await ctx.scheduler.runAfter(0, internal.teamActivity.recordTeamActivity, {
        team_id: resolvedTeamId,
        actor_user_id: args.user_id,
        event_type: "session_started" as const,
        title: args.title || (args.slug ? formatSlugAsTitle(args.slug) : "New session"),
        description: args.project_path,
        related_conversation_id: conversationId,
        metadata: {
          git_branch: args.git_branch,
        },
      });
    }

    return conversationId;
  },
});

export const createQuickSession = mutation({
  args: {
    agent_type: v.optional(v.union(
      v.literal("claude_code"),
      v.literal("codex"),
      v.literal("cursor"),
      v.literal("gemini"),
      v.literal("opencode"),
      v.literal("pi"),
      v.literal("grok")
    )),
    project_path: v.optional(v.string()),
    git_root: v.optional(v.string()),
    session_id: v.optional(v.string()),
    isolated: v.optional(v.boolean()),
    worktree_name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    await checkRateLimit(ctx, userId, "createConversation");

    const now = Date.now();
    const sessionId = args.session_id || crypto.randomUUID();
    const agentType = args.agent_type || "claude_code";

    const privacy = await resolveCreationPrivacy(ctx, userId, args.git_root || args.project_path);

    const conversationId = await ctx.db.insert("conversations", {
      user_id: userId,
      agent_type: agentType,
      session_id: sessionId,
      project_path: args.project_path,
      git_root: args.git_root,
      started_at: now,
      updated_at: now,
      message_count: 0,
      ...privacy,
      status: "active",
    });

    await ctx.db.patch(conversationId, {
      short_id: conversationId.toString().slice(0, 7),
    });

    const daemonAgentType = fromConvexAgentType(agentType);
    await enqueueStartSession(ctx, userId, {
      conversationId,
      agentType: daemonAgentType,
      projectPath: args.project_path || args.git_root,
      sessionId,
      isolated: args.isolated,
      worktreeName: args.worktree_name,
      createdAt: now,
    });

    return conversationId;
  },
});

export const getConversations = query({
  args: {
    user_id: v.id("users"),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId || authUserId.toString() !== args.user_id.toString()) {
      return [];
    }
    const user = await ctx.db.get(args.user_id);
    if (!user) {
      return [];
    }
    const memberships = await ctx.db.query("team_memberships")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", args.user_id))
      .collect();
    const userTeamIds = new Set(memberships.map((m: any) => m.team_id.toString()));

    const feedFilters = new Map<string, Awaited<ReturnType<typeof createTeamFeedFilter>>>();
    for (const m of memberships) {
      feedFilters.set(m.team_id.toString(), await createTeamFeedFilter(ctx, m.team_id));
    }

    const ownConversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q: any) => q.eq("user_id", args.user_id))
      .collect();

    const teamConvArrays = await Promise.all(
      memberships.map((m: any) =>
        ctx.db
          .query("conversations")
          .withIndex("by_team_id", (q: any) => q.eq("team_id", m.team_id))
          .collect()
      )
    );

    const ownIds = new Set(ownConversations.map((c: any) => c._id.toString()));
    const allConversations = [...ownConversations];
    for (const teamConvs of teamConvArrays) {
      for (const c of teamConvs) {
        if (!ownIds.has(c._id.toString())) {
          allConversations.push(c);
        }
      }
    }

    const filtered = allConversations.filter((c) => {
      const isOwn = c.user_id.toString() === args.user_id.toString();
      if (isOwn) return true;
      if (!c.team_id || !userTeamIds.has(c.team_id.toString())) return false;
      const filter = feedFilters.get(c.team_id.toString());
      return filter ? filter.isVisible(c) : false;
    });
    return filtered.sort((a, b) => b.updated_at - a.updated_at);
  },
});

// An anchor's session renders under its bot identity (acting_user_id), not the
// human host that runs and bills it. Resolve that identity for the author chip;
// returns null for ordinary sessions so callers fall back to the owner. Cheap:
// only anchors set acting_user_id, so the extra read is sparse.
async function resolveActingAuthor(
  ctx: any,
  conv: { acting_user_id?: Id<"users"> | null },
  getDoc: (id: any) => Promise<any> = (id) => ctx.db.get(id),
): Promise<{ name: string; avatar: string | null } | null> {
  if (!conv.acting_user_id) return null;
  const bot = await getDoc(conv.acting_user_id);
  if (!bot) return null;
  return {
    name: (bot as any).name || "Anchor",
    avatar: (bot as any).image || (bot as any).github_avatar_url || null,
  };
}

// Resolve a conversation reference (full id or 7-char short id) for a signed-in
// caller. Short ids collide across users (they're just the id's first 7 chars),
// so this ranks candidates own > team-accessible > newest via the shared
// resolver, keeping "found but not accessible" distinguishable from "not
// found" — callers still run their usual access check on the result.
export async function resolveConversationRef(
  ctx: any,
  ref: string,
  userId: Id<"users">,
): Promise<Doc<"conversations"> | null> {
  return resolveConversationRefRanked(ctx, ref, userId, (conversation) =>
    canTeamMemberAccess(ctx, userId, conversation)
  );
}

export const webGet = query({
  args: {
    short_id: v.optional(v.string()),
    id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    let conv;
    if (args.short_id) {
      conv = await resolveConversationRef(ctx, args.short_id, userId);
    } else if (args.id) {
      try {
        conv = await ctx.db.get(args.id as Id<"conversations">);
      } catch {}
    }

    if (!conv) return null;
    const isOwner = conv.user_id.toString() === userId.toString();
    if (!(await canOwnerOrTeamAccess(ctx, userId, conv))) return null;

    // Author identity, only for teammates' sessions (own sessions skip the read).
    // The reference pill/hover use this to show the author's avatar when the
    // session isn't yours — same name/avatar convention as the inbox feed rows.
    // An anchor always shows its bot identity, even on the host's own session.
    const owner = isOwner ? null : await ctx.db.get(conv.user_id);
    const acting = await resolveActingAuthor(ctx, conv);

    return {
      _id: conv._id,
      short_id: conv.short_id,
      title: conv.title,
      status: conv.status,
      message_count: conv.message_count,
      project_path: conv.project_path,
      model: conv.model,
      agent_type: conv.agent_type,
      updated_at: conv.updated_at,
      // Session-open contract (useOpenLinkedSession seeds this snapshot into the
      // client's sessions cache): the real session_id — never fabricated from the
      // document id — a liveness verdict matching taskMining's, and the triage
      // stamps so a stashed/dismissed session must not seed as an active row
      // (ct-42666).
      session_id: conv.session_id,
      is_active: conv.status === "active" && conv.updated_at > Date.now() - 5 * 60 * 1000,
      started_at: (conv as any).started_at || conv._creationTime,
      ...inboxVisibilityFields(conv),
      is_own: isOwner,
      acting_user_id: conv.acting_user_id ?? null,
      is_anchor: !!conv.anchor_id,
      anchor_id: conv.anchor_id ?? null,
      author_name: acting ? acting.name : owner ? (owner.name || owner.email?.split("@")[0] || "Unknown") : null,
      author_avatar: acting ? acting.avatar : owner ? (owner.image || owner.github_avatar_url || null) : null,
      // Summary/context fields (already on the doc — no extra reads). The pill
      // card coalesces these into a one-line summary + last-message preview so
      // an expanded session reference shows what it's about, not just metadata.
      idle_summary: conv.idle_summary,
      subtitle: conv.subtitle,
      last_message_preview: conv.last_message_preview,
      last_message_role: conv.last_message_role,
      // Inbox-card parity for the chat object card: the row thumbnail and the
      // branch line come straight off the doc, no extra reads.
      image_preview_url: conv.image_preview_url ?? null,
      git_branch: conv.git_branch ?? null,
    };
  },
});

export const getConversation = query({
  args: {
    // v.string, not v.id: this id arrives raw from the inbox `?s=` deep-link
    // param, and a 32-char id from another table must resolve to null (the
    // not-found path) instead of an ArgumentValidationError that throws into
    // the subscribing component's render.
    conversation_id: v.string(),
    limit: v.optional(v.number()),
    share_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    const conversationId = ctx.db.normalizeId("conversations", args.conversation_id);
    const conversation = conversationId ? await ctx.db.get(conversationId) : null;
    if (!conversation || !conversationId) {
      return null;
    }
    const accessLevel = await checkConversationAccess(ctx, authUserId, conversation, args.share_token);
    if (accessLevel === "denied") {
      return null;
    }

    const limit = args.limit ?? 100;
    // Fetch most recent messages (descending), then reverse for display
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", conversationId)
      )
      .order("desc")
      .take(limit + 1);

    const hasMore = messages.length > limit;
    const resultMessages = hasMore ? messages.slice(0, limit) : messages;
    const sortedMessages = resultMessages.sort((a, b) => a.timestamp - b.timestamp);
    const oldestTimestamp = sortedMessages.length > 0 ? sortedMessages[0].timestamp : null;

    const user = await ctx.db.get(conversation.user_id);

    let firstUserMessage = "";
    for (const msg of sortedMessages) {
      const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
      if (msg.role === "user" && !hasToolResults) {
        const text = msg.content?.trim();
        if (text) {
          firstUserMessage = text.slice(0, 120);
          if (text.length > 120) firstUserMessage += "...";
          break;
        }
      }
    }

    const title = conversation.title
      || firstUserMessage
      || (conversation.slug ? formatSlugAsTitle(conversation.slug) : null)
      || "New Session";

    // active_plan / active_task are team-scoped work items. A share-token guest
    // (accessLevel "shared") must never receive them — only an owner or a
    // team-visible viewer.
    const hasFullAccess = accessLevel === "owner" || accessLevel === "team";
    let active_plan = null;
    if (hasFullAccess && conversation.active_plan_id) {
      const plan = await ctx.db.get(conversation.active_plan_id);
      if (plan) active_plan = { _id: plan._id, short_id: plan.short_id, title: plan.title, status: plan.status };
    }

    let active_task = null;
    if (hasFullAccess && conversation.active_task_id) {
      const task = await ctx.db.get(conversation.active_task_id);
      if (task) active_task = { _id: task._id, short_id: task.short_id, title: task.title, status: task.status };
    }

    return sanitizeConvexObjectKeys({
      ...conversationForAccess(conversation, accessLevel),
      title,
      messages: sortedMessages,
      user: user ? { name: user.name, email: user.email } : null,
      has_more_above: hasMore,
      oldest_timestamp: oldestTimestamp,
      active_plan,
      active_task,
    });
  },
});

export const getAllMessages = query({
  args: {
    conversation_id: v.id("conversations"),
    limit: v.optional(v.number()),
    before_timestamp: v.optional(v.number()),
    share_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }

    const accessLevel = await checkConversationAccess(ctx, authUserId, conversation, args.share_token);
    if (accessLevel === "denied") {
      return null;
    }

    const messageLimit = Math.min(args.limit ?? 50, 100);

    let messagesQuery = ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id)
      );

    if (args.before_timestamp !== undefined) {
      messagesQuery = messagesQuery.filter((q) =>
        q.lt(q.field("timestamp"), args.before_timestamp!)
      );
    }

    const messages = await messagesQuery
      .order("desc")
      .take(messageLimit + 1);

    const hasMore = messages.length > messageLimit;
    if (hasMore) {
      messages.pop();
    }
    messages.reverse();
    const enrichedMessages = await attachSenderIdentities(ctx, conversation.user_id, messages);

    const user = await ctx.db.get(conversation.user_id);

    let firstUserMessage = "";
    for (const msg of messages) {
      const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
      if (msg.role === "user" && !hasToolResults) {
        const text = msg.content?.trim();
        if (text) {
          firstUserMessage = text.slice(0, 120);
          if (text.length > 120) firstUserMessage += "...";
          break;
        }
      }
    }

    const title = conversation.title
      || firstUserMessage
      || (conversation.slug ? formatSlugAsTitle(conversation.slug) : null)
      || "New Session";

    // Child conversations are independent sessions with their own privacy. A
    // share-token guest (accessLevel "shared") must not enumerate them or read
    // their previews through the parent's grant — only an owner/team viewer does.
    const hasFullAccess = accessLevel === "owner" || accessLevel === "team";
    const { children: childConversations, map: childConversationMap, agentNameEntries } =
      hasFullAccess && messages.length > 0
        ? await findChildConversations(ctx, args.conversation_id, messages)
        : { children: [], map: {}, agentNameEntries: [] };

    let forkedFromDetails = null;
    if (conversation.forked_from) {
      const originalConv = await ctx.db.get(conversation.forked_from);
      // The parent is an independent conversation. Reveal it (and NEVER its
      // share_token) only when THIS viewer can access the parent in its own
      // right — otherwise a guest holding the fork's token would inherit the
      // parent's shared view.
      if (
        originalConv &&
        (await checkConversationAccess(ctx, authUserId, originalConv)) !== "denied"
      ) {
        const originalUser = await ctx.db.get(originalConv.user_id);
        forkedFromDetails = {
          conversation_id: originalConv._id,
          title: originalConv.title,
          share_token: originalConv.share_token,
          username: originalUser?.name || originalUser?.email?.split("@")[0] || "Unknown",
          // Triage state for the client-side parent preload (same contract as
          // mapForkDetails): a stashed/dismissed parent must seed as such, not
          // as an active row that flashes into the inbox at boot.
          ...inboxVisibilityFields(originalConv),
        };
      }
    }

    const compactionCount = messages.filter(m => m.subtype === "compact_boundary").length;

    let parentConversationId: string | null = conversation.parent_conversation_id || null;
    if (!parentConversationId && conversation.parent_message_uuid) {
      const parentMsg = await ctx.db
        .query("messages")
        .withIndex("by_message_uuid", (q) => q.eq("message_uuid", conversation.parent_message_uuid))
        .first();
      if (parentMsg) {
        parentConversationId = parentMsg.conversation_id;
      }
    }

    const forkChildrenDetails = await getAccessibleForkChildren(ctx, authUserId, args.conversation_id);

    let forkSiblings: typeof forkChildrenDetails = [];
    if (conversation.forked_from) {
      forkSiblings = await getAccessibleForkChildren(ctx, authUserId, conversation.forked_from);
    }

    const mainMsgCountsByFork: Record<string, number> = {};
    const forkPointUuids = new Set(forkChildrenDetails.map(f => f.parent_message_uuid).filter(Boolean));
    if (forkPointUuids.size > 0) {
      for (const uuid of forkPointUuids) {
        const forkPointMsg = messages.find(m => m.message_uuid === uuid);
        if (forkPointMsg) {
          const afterCount = messages.filter(m => m.timestamp > forkPointMsg.timestamp).length;
          mainMsgCountsByFork[uuid!] = afterCount;
        }
      }
    }

    const oldestTimestamp = messages.length > 0 ? messages[0].timestamp : null;

    return sanitizeConvexObjectKeys({
      ...conversationForAccess(conversation, accessLevel),
      title,
      messages: enrichedMessages,
      user: user ? { name: user.name, email: user.email, avatar_url: user.image || user.github_avatar_url || null } : null,
      child_conversations: childConversations,
      child_conversation_map: childConversationMap,
      agent_name_entries: agentNameEntries,
      last_timestamp: messages.length > 0 ? messages[messages.length - 1].timestamp : null,
      has_more_above: hasMore,
      oldest_timestamp: oldestTimestamp,
      fork_count: conversation.fork_count,
      forked_from: conversation.forked_from,
      forked_from_details: forkedFromDetails,
      compaction_count: compactionCount,
      fork_children: forkChildrenDetails,
      fork_siblings: forkSiblings.length > 0 ? forkSiblings : undefined,
      parent_conversation_id: parentConversationId,
      main_message_counts_by_fork: mainMsgCountsByFork,
    });
  },
});

// Returns this user's distinct git_root values for the given remote URL,
// most-recently-updated first. The CLI/daemon uses this to remap a foreign
// project_path (created on another machine, or forked from another user) to
// a local checkout of the same repo. Pure metadata — no message bodies.
export const findUserLocalCheckouts = query({
  args: {
    git_remote_url: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return [];
    if (!args.git_remote_url) return [];
    const convs = await ctx.db
      .query("conversations")
      .withIndex("by_user_git_remote_url", (q) =>
        q.eq("user_id", userId).eq("git_remote_url", args.git_remote_url)
      )
      .collect();
    const seen = new Set<string>();
    const out: { git_root: string; project_path: string | null; updated_at: number }[] = [];
    convs.sort((a, b) => b.updated_at - a.updated_at);
    for (const c of convs) {
      const root = c.git_root;
      if (!root || seen.has(root)) continue;
      seen.add(root);
      out.push({ git_root: root, project_path: c.project_path ?? null, updated_at: c.updated_at });
    }
    return out;
  },
});

// Lightweight metadata fetch used by the daemon to resolve project paths
// without pulling the full conversation + messages. Auth-checked.
export const getProjectInfo = query({
  args: {
    conversation_id: v.id("conversations"),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv) return null;
    if (!(await canOwnerOrTeamAccess(ctx, userId, conv))) return null;
    return {
      project_path: conv.project_path ?? null,
      git_root: conv.git_root ?? null,
      git_remote_url: conv.git_remote_url ?? null,
      // Resume effort fallback: a session launched with --effort but never
      // switched in-session has no transcript echo to re-pin from; the
      // conversation row is the only durable record.
      effort: conv.effort ?? null,
      // Same for the per-session Claude account: a resume must re-source that
      // account's token file or the session hops to the keychain login.
      cc_account: conv.cc_account ?? null,
      // Lets the daemon refuse a legacy start_session that was enqueued before
      // this conversation crossed onto the fenced execution rail.
      execution_protocol_state: conv.execution_protocol_state ?? null,
    };
  },
});

export const getMessagesAroundTimestamp = query({
  args: {
    conversation_id: v.id("conversations"),
    center_timestamp: v.number(),
    limit_before: v.optional(v.number()),
    limit_after: v.optional(v.number()),
    share_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }

    const accessLevel = await checkConversationAccess(ctx, authUserId, conversation, args.share_token);
    if (accessLevel === "denied") {
      return null;
    }

    const limitBefore = Math.min(args.limit_before ?? 50, 100);
    const limitAfter = Math.min(args.limit_after ?? 50, 100);

    const messagesBefore = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .filter((q) => q.lt(q.field("timestamp"), args.center_timestamp))
      .order("desc")
      .take(limitBefore + 1);

    const hasMoreAbove = messagesBefore.length > limitBefore;
    if (hasMoreAbove) {
      messagesBefore.pop();
    }
    messagesBefore.reverse();

    const messagesAfter = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .filter((q) => q.gte(q.field("timestamp"), args.center_timestamp))
      .order("asc")
      .take(limitAfter + 1);

    const hasMoreBelow = messagesAfter.length > limitAfter;
    if (hasMoreBelow) {
      messagesAfter.pop();
    }

    const messages = await attachSenderIdentities(
      ctx, conversation.user_id, [...messagesBefore, ...messagesAfter],
    );

    const user = await ctx.db.get(conversation.user_id);

    let firstUserMessage = "";
    for (const msg of messages) {
      const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
      if (msg.role === "user" && !hasToolResults) {
        const text = msg.content?.trim();
        if (text) {
          firstUserMessage = text.slice(0, 120);
          if (text.length > 120) firstUserMessage += "...";
          break;
        }
      }
    }

    const title = conversation.title
      || firstUserMessage
      || (conversation.slug ? formatSlugAsTitle(conversation.slug) : null)
      || "New Session";

    const oldestTimestamp = messages.length > 0 ? messages[0].timestamp : null;
    const newestTimestamp = messages.length > 0 ? messages[messages.length - 1].timestamp : null;

    let parentConversationId: string | null = conversation.parent_conversation_id || null;
    if (!parentConversationId && conversation.parent_message_uuid) {
      const parentMsg = await ctx.db
        .query("messages")
        .withIndex("by_message_uuid", (q) => q.eq("message_uuid", conversation.parent_message_uuid))
        .first();
      if (parentMsg) {
        parentConversationId = parentMsg.conversation_id;
      }
    }

    const { children: childConversations, map: childConversationMap, agentNameEntries } =
      messages.length > 0
        ? await findChildConversations(ctx, args.conversation_id, messages)
        : { children: [], map: {}, agentNameEntries: [] };

    return sanitizeConvexObjectKeys({
      ...conversationForAccess(conversation, accessLevel),
      title,
      messages,
      user: user ? { name: user.name, email: user.email, avatar_url: user.image || user.github_avatar_url || null } : null,
      last_timestamp: newestTimestamp,
      oldest_timestamp: oldestTimestamp,
      has_more_above: hasMoreAbove,
      has_more_below: hasMoreBelow,
      parent_conversation_id: parentConversationId,
      child_conversations: childConversations,
      child_conversation_map: childConversationMap,
      agent_name_entries: agentNameEntries,
    });
  },
});

export const getNewMessages = query({
  args: {
    conversation_id: v.id("conversations"),
    after_timestamp: v.number(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return null;
    }
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }
    if (!(await canOwnerOrTeamAccess(ctx, authUserId, conversation))) {
      return null;
    }

    const PAGE_LIMIT = 2000;
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id).gt("timestamp", args.after_timestamp)
      )
      .order("asc")
      .take(PAGE_LIMIT + 1);
    const hasMore = messages.length > PAGE_LIMIT;
    if (hasMore) messages.length = PAGE_LIMIT;

    // Deliberately NO findChildConversations here: this is the 1s recovery-poll /
    // background delta-sync query, and its consumers read only messages +
    // has_more + last_timestamp. Child data comes from the full-load queries;
    // computing it here cost O(children) queries per poll and timed out on
    // sessions with many subagent children.
    return sanitizeConvexObjectKeys({
      messages: await attachSenderIdentities(ctx, conversation.user_id, messages),
      last_timestamp: messages.length > 0 ? messages[messages.length - 1].timestamp : null,
      has_more: hasMore,
      updated_at: conversation.updated_at,
      title: conversation.title,
    });
  },
});

// The live transcript subscription. The paginated listMessages page is anchored
// at the NEWEST end of the index, so subscribing to it re-ships the whole grown
// first page (200+ full bodies) on every streaming patch. This query covers only
// the range that actually changes — rows strictly after a fixed anchor — so a
// streaming tick re-ships the tail (typically 1-30 rows), not the page. The
// client one-shots listMessages for history and subscribes to this for updates.
//
// Two deliberate choices:
// - Access goes through checkConversationAccess WITH share_token (unlike
//   getNewMessages), so share-link viewers keep live updates.
// - The result carries NO volatile conversation fields (no updated_at/title).
//   The conversation row is unavoidably in the read set (access check), so the
//   query re-RUNS on churny conversation patches — a cheap bounded index walk —
//   but the result stays byte-identical and Convex skips the push.
export const listMessagesTail = query({
  args: {
    conversation_id: v.id("conversations"),
    after_timestamp: v.number(),
    share_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return null;
    if ((await checkConversationAccess(ctx, authUserId, conversation, args.share_token)) === "denied") {
      return null;
    }

    const TAIL_LIMIT = 500;
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id).gt("timestamp", args.after_timestamp)
      )
      .order("asc")
      .take(TAIL_LIMIT + 1);
    const hasMore = messages.length > TAIL_LIMIT;
    if (hasMore) messages.length = TAIL_LIMIT;

    return sanitizeConvexObjectKeys({
      messages: await attachSenderIdentities(ctx, conversation.user_id, messages),
      last_timestamp: messages.length > 0 ? messages[messages.length - 1].timestamp : null,
      has_more: hasMore,
    });
  },
});

// The transcript's tiny change watermark. The client pairs this with
// listMessagesTail: message_count moves on insert/delete (the recovery poll
// compares it against local length), transcript_revision moves when a row
// OUTSIDE the live tail is edited (resync backfill after resume/fork) — the
// client answers a jump with a snapshot refetch. Result is a few integers, so
// churny conversation patches re-run it cheaply and re-push only when one of
// these actually moves.
export const getTranscriptWatermark = query({
  args: {
    conversation_id: v.id("conversations"),
    share_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return null;
    if ((await checkConversationAccess(ctx, authUserId, conversation, args.share_token)) === "denied") {
      return null;
    }
    return {
      message_count: conversation.message_count ?? 0,
      transcript_revision: conversation.transcript_revision ?? 0,
    };
  },
});

export const copyAllMessages = query({
  args: {
    conversation_id: v.id("conversations"),
    paginationOpts: v.optional(paginationOptsValidator),
    share_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return null;

    if ((await checkConversationAccess(ctx, authUserId, conversation, args.share_token)) === "denied") {
      return null;
    }

    const mapMsg = (m: any) => ({
      role: m.role,
      content: m.content || "",
      thinking: m.thinking || undefined,
      timestamp: m.timestamp,
      tool_calls: m.tool_calls,
      tool_results: m.tool_results,
      subtype: m.subtype || undefined,
    });

    if (args.paginationOpts) {
      const result = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) =>
          q.eq("conversation_id", args.conversation_id)
        )
        .order("asc")
        .paginate(args.paginationOpts);
      const page = sanitizeConvexObjectKeys(result.page.filter(isNonEmptyMessage).map(mapMsg));
      return { page, isDone: result.isDone, continueCursor: result.continueCursor };
    }

    const allMessages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("asc")
      .collect();
    return sanitizeConvexObjectKeys(allMessages.filter(isNonEmptyMessage).map(mapMsg));
  },
});

// A user turn delivered by a teammate (web or `cast send` into someone else's
// session) carries from_user_id — the sender, stamped when the echo is matched
// to its pending row. Attach that sender's display identity so the UI renders
// the turn as them instead of the conversation owner. Owner turns stay bare,
// so the payload only grows for the rare cross-user message.
export async function attachSenderIdentities<T extends { role?: string; from_user_id?: Id<"users"> }>(
  ctx: { db: { get: (id: Id<"users">) => Promise<any> } },
  ownerUserId: Id<"users">,
  messages: T[],
): Promise<T[]> {
  const senderIds = new Set<string>();
  for (const m of messages) {
    if (m.role === "user" && m.from_user_id && m.from_user_id.toString() !== ownerUserId.toString()) {
      senderIds.add(m.from_user_id.toString());
    }
  }
  if (senderIds.size === 0) return messages;
  const senders = new Map<string, { name: string; avatar_url: string | null }>();
  for (const id of senderIds) {
    const u = await ctx.db.get(id as Id<"users">);
    if (u) {
      senders.set(id, {
        name: u.name || u.email?.split("@")[0] || "Unknown",
        avatar_url: u.image || u.github_avatar_url || null,
      });
    }
  }
  return messages.map((m) => {
    const sender = m.from_user_id ? senders.get(m.from_user_id.toString()) : undefined;
    return sender ? { ...m, sender_name: sender.name, sender_avatar_url: sender.avatar_url } : m;
  });
}

export const listMessages = query({
  args: {
    conversation_id: v.id("conversations"),
    paginationOpts: paginationOptsValidator,
    share_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    // Missing conversation must return the empty-page shape, not throw — a
    // client can hold a stale conversation_id (deleted row, lost access) in
    // local state, and throwing crashes the React tree via usePaginatedQuery.
    // Sibling queries (getConversationWithMeta, copyAllMessages) already
    // degrade gracefully on this; align with them.
    if (!conversation) {
      return { page: [], isDone: true, continueCursor: "" };
    }

    if ((await checkConversationAccess(ctx, authUserId, conversation, args.share_token)) === "denied") {
      return { page: [], isDone: true, continueCursor: "" };
    }

    const result = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("desc")
      .paginate(args.paginationOpts);
    const page = await attachSenderIdentities(ctx, conversation.user_id, result.page);
    return { ...result, page: sanitizeConvexObjectKeys(page) };
  },
});

export const getConversationWithMeta = query({
  args: {
    conversation_id: v.id("conversations"),
    share_token: v.optional(v.string()),
    // Opt-in: omit the churny per-flush fields from the returned doc. The
    // client merge (syncRecord) keeps its prior values for omitted keys, and
    // reads the live values from getTranscriptWatermark / the liveness overlay
    // instead. Without this, every message flush re-pushed the whole fork
    // graph + child map because updated_at/message_count changed.
    strip_volatile: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }

    const access = await checkConversationAccess(ctx, authUserId, conversation, args.share_token);
    if (access === "denied") {
      return null;
    }
    const isOwner = access === "owner";

    const user = await ctx.db.get(conversation.user_id);

    const title = conversation.title
      || (conversation.slug ? formatSlugAsTitle(conversation.slug) : null)
      || "New Session";

    const { children: childConversations, map: childByParentUuid, agentNameEntries } =
      await findChildConversations(ctx, args.conversation_id, []);

    let forkedFromDetails = null;
    if (conversation.forked_from) {
      const originalConv = await ctx.db.get(conversation.forked_from);
      if (originalConv) {
        const originalUser = await ctx.db.get(originalConv.user_id);
        forkedFromDetails = {
          conversation_id: originalConv._id,
          title: originalConv.title,
          share_token: originalConv.share_token,
          username: originalUser?.name || originalUser?.email?.split("@")[0] || "Unknown",
          // Triage state for the client-side parent preload (same contract as
          // mapForkDetails): a stashed/dismissed parent must seed as such, not
          // as an active row that flashes into the inbox at boot.
          ...inboxVisibilityFields(originalConv),
        };
      }
    }

    let parentConversationId: string | null = conversation.parent_conversation_id || null;
    if (!parentConversationId && conversation.parent_message_uuid) {
      const parentMsg = await ctx.db
        .query("messages")
        .withIndex("by_message_uuid", (q) => q.eq("message_uuid", conversation.parent_message_uuid))
        .first();
      if (parentMsg) {
        parentConversationId = parentMsg.conversation_id;
      }
    }

    const forkChildrenDetails = await getAccessibleForkChildren(ctx, authUserId, args.conversation_id);

    let forkSiblings: typeof forkChildrenDetails = [];
    if (conversation.forked_from) {
      forkSiblings = await getAccessibleForkChildren(ctx, authUserId, conversation.forked_from);
    }

    const mainDivergentPreviewsByFork = await computeOriginDivergentPreviews(
      ctx,
      conversation,
      forkChildrenDetails,
      forkSiblings,
    );

    let effective_team_visibility = conversation.team_visibility;
    if (!effective_team_visibility && conversation.team_id && isOwner) {
      const membership = await ctx.db
        .query("team_memberships")
        .withIndex("by_user_team", (q: any) =>
          q.eq("user_id", conversation.user_id).eq("team_id", conversation.team_id!)
        )
        .first();
      effective_team_visibility = (membership?.visibility as any) || "summary";
    }

    let active_plan = null;
    if (conversation.active_plan_id) {
      const plan = await ctx.db.get(conversation.active_plan_id);
      if (plan) active_plan = { _id: plan._id, short_id: plan.short_id, title: plan.title, status: plan.status };
    }

    let active_task = null;
    if (conversation.active_task_id) {
      const task = await ctx.db.get(conversation.active_task_id);
      if (task) active_task = { _id: task._id, short_id: task.short_id, title: task.title, status: task.status };
    }

    // Strip the large on-demand field (available_skills). git_diff /
    // git_diff_staged now live in conversation_git_diffs, not on the doc.
    const {
      available_skills: _convSkills,
      ...conversationLight
    } = conversationForAccess(conversation, access);
    if (args.strip_volatile) {
      for (const k of ["updated_at", "message_count", "last_message_at", "last_metrics_at", "last_active_at", "last_heartbeat"]) {
        delete (conversationLight as any)[k];
      }
    }

    // stable_context lives in the conversation_context side row (legacy rows
    // still carry it on the doc until swept). Owner/team only — the same rule
    // conversationForAccess applies to the legacy field.
    const sideStableContext =
      access === "owner" || access === "team"
        ? await getConvStableContext(ctx, args.conversation_id)
        : null;

    return sanitizeConvexObjectKeys({
      ...conversationLight,
      stable_context: (conversationLight as any).stable_context ?? sideStableContext ?? undefined,
      is_own: !!isOwner,
      title,
      effective_team_visibility,
      user: user ? { name: user.name, email: user.email, avatar_url: user.image || user.github_avatar_url || null } : null,
      child_conversations: childConversations,
      child_by_parent_uuid_entries: Object.entries(childByParentUuid),
      agent_name_entries: agentNameEntries,
      fork_count: conversation.fork_count,
      forked_from: conversation.forked_from,
      forked_from_details: forkedFromDetails,
      fork_children: forkChildrenDetails,
      fork_siblings: forkSiblings.length > 0 ? forkSiblings : undefined,
      parent_conversation_id: parentConversationId,
      main_divergent_previews_by_fork: mainDivergentPreviewsByFork,
      active_plan,
      active_task,
    });
  },
});

export const getConversationGitDiff = query({
  args: {
    conversation_id: v.id("conversations"),
    share_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return null;

    if ((await checkConversationAccess(ctx, authUserId, conversation, args.share_token)) === "denied") return null;

    return await getConvGitDiff(ctx, args.conversation_id);
  },
});

export const getConversationToolStats = query({
  args: {
    conversation_id: v.id("conversations"),
    share_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return null;

    if ((await checkConversationAccess(ctx, authUserId, conversation, args.share_token)) === "denied") return null;

    let latestTodos: any[] | null = null;
    // Collect creates and updates separately since we iterate newest-first
    const taskCreates: { subject: string }[] = [];
    const taskStatusMap = new Map<string, string>(); // taskId -> latest status (first seen = newest)

    // Bounded scan: this query stays subscribed for the whole visit and
    // re-runs on every new assistant message, so its cost must not grow with
    // session length. The newest TodoWrite (the common case) is found within
    // a few rows; only the rare TaskCreate/TaskUpdate bookkeeping can reach
    // deep history, and for a 1000+ assistant-message session losing the
    // oldest task rows from the panel is an acceptable bound.
    let scanned = 0;
    for await (const msg of ctx.db
      .query("messages")
      .withIndex("by_conversation_role_timestamp", (q: any) =>
        q.eq("conversation_id", args.conversation_id).eq("role", "assistant")
      )
      .order("desc")) {
      if (++scanned > 1000) break;
      if (!msg.tool_calls) continue;
      for (const tc of msg.tool_calls) {
        if (tc.name === "TodoWrite" && !latestTodos) {
          try {
            const input = JSON.parse(tc.input);
            if (input.todos) latestTodos = input.todos;
          } catch {}
        }
        if (tc.name === "TaskCreate") {
          try {
            const inp = JSON.parse(tc.input);
            taskCreates.push({ subject: inp.subject || inp.title || inp.description || "" });
          } catch {}
        }
        if (tc.name === "TaskUpdate") {
          try {
            const inp = JSON.parse(tc.input);
            if (inp.taskId && inp.status && !taskStatusMap.has(inp.taskId)) {
              taskStatusMap.set(inp.taskId, inp.status);
            }
          } catch {}
        }
      }
    }

    // Reverse creates to get chronological order (IDs are assigned 1, 2, 3, ...)
    taskCreates.reverse();
    const normalizeStatus = (s: string) => s === "completed" ? "done" : s === "in_progress" ? "in_progress" : "open";
    const taskItems = taskCreates
      .map((tc, i) => {
        const id = String(i + 1);
        const rawStatus = taskStatusMap.get(id) ?? "pending";
        return { id, content: tc.subject, status: normalizeStatus(rawStatus) };
      })
      .filter(t => taskStatusMap.get(t.id) !== "deleted");

    // Normalize todo items and merge with task items
    const todoItems = (latestTodos ?? []).map((t: any, i: number) => ({
      id: t.id || `todo-${i}`,
      content: t.content || t.task || t.title || "",
      status: normalizeStatus(t.status ?? "pending"),
    }));
    const items = [...todoItems, ...taskItems];
    const total = items.length;
    const done = items.filter(i => i.status === "done").length;
    const in_progress = items.filter(i => i.status === "in_progress").length;
    const open = total - done - in_progress;

    return {
      taskStats: total > 0 ? { total, done, in_progress, open, items } : null,
    };
  },
});

export const getConversationMessages = query({
  args: {
    conversation_id: v.id("conversations"),
    after_timestamp: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return null;
    }
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }
    if (!(await canOwnerOrTeamAccess(ctx, authUserId, conversation))) {
      return null;
    }

    let messages;
    if (args.after_timestamp) {
      messages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) =>
          q.eq("conversation_id", args.conversation_id).gt("timestamp", args.after_timestamp!)
        )
        .order("asc")
        .collect();
    } else {
      messages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) =>
          q.eq("conversation_id", args.conversation_id)
        )
        .order("asc")
        .collect();
    }

    const { children: childConversations, map: childConversationMap, agentNameEntries } =
      messages.length > 0
        ? await findChildConversations(ctx, args.conversation_id, messages)
        : { children: [], map: {}, agentNameEntries: [] };

    return {
      messages,
      child_conversations: childConversations,
      child_conversation_map: childConversationMap,
      agent_name_entries: agentNameEntries,
      last_timestamp: messages.length > 0 ? messages[messages.length - 1].timestamp : null,
    };
  },
});

export const getMoreMessages = query({
  args: {
    conversation_id: v.id("conversations"),
    cursor: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return null;
    }
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }
    if (!(await canOwnerOrTeamAccess(ctx, authUserId, conversation))) {
      return null;
    }

    const limit = args.limit ?? 100;
    const allMessages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("asc")
      .filter((q) => q.gt(q.field("timestamp"), args.cursor))
      .take(limit + 1);

    const hasMore = allMessages.length > limit;
    const messages = hasMore ? allMessages.slice(0, limit) : allMessages;
    const nextCursor = hasMore ? messages[messages.length - 1].timestamp : null;

    return {
      messages,
      has_more: hasMore,
      next_cursor: nextCursor,
    };
  },
});

export const getOlderMessages = query({
  args: {
    conversation_id: v.id("conversations"),
    before_timestamp: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return null;
    }
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }
    if (!(await canOwnerOrTeamAccess(ctx, authUserId, conversation))) {
      return null;
    }

    const limit = args.limit ?? 100;
    // Fetch messages older than the cursor, in descending order (newest of the older ones first)
    const olderMessages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("desc")
      .filter((q) => q.lt(q.field("timestamp"), args.before_timestamp))
      .take(limit + 1);

    const hasMore = olderMessages.length > limit;
    const resultMessages = hasMore ? olderMessages.slice(0, limit) : olderMessages;
    // Sort ascending for display (oldest first)
    const messages = resultMessages.sort((a, b) => a.timestamp - b.timestamp);
    const oldestTimestamp = messages.length > 0 ? messages[0].timestamp : null;

    return {
      messages,
      has_more: hasMore,
      oldest_timestamp: oldestTimestamp,
    };
  },
});

// The scan loop + the team-merge cursor protocol live in feedPagination.ts
// (pure TS) so their no-skip / always-progress invariants are unit-testable.

export const listConversations = query({
  args: {
    filter: v.union(v.literal("my"), v.literal("team")),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
    include_message_previews: v.optional(v.boolean()),
    memberId: v.optional(v.id("users")),
    activeTeamId: v.optional(v.id("teams")),
    subagentFilter: v.optional(v.union(v.literal("main"), v.literal("subagent"))),
    directoryFilter: v.optional(v.string()),
    timeFilter: v.optional(v.union(v.literal("long"), v.literal("active"))),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return { conversations: [], nextCursor: null };
    }
    const user = await ctx.db.get(userId);
    if (!user) {
      return { conversations: [], nextCursor: null };
    }

    const limit = Math.min(args.limit ?? 20, 1000);
    const includeMessagePreviews = args.include_message_previews ?? false;
    const cursorTimestamp = args.cursor ? parseInt(args.cursor, 10) : null;

    const effectiveTeamId = args.filter === "team" ? (args.activeTeamId || user.active_team_id) : undefined;

    const teamUsers = args.filter === "team" && effectiveTeamId
      ? await ctx.db
          .query("users")
          .withIndex("by_team_id", (q) => q.eq("team_id", effectiveTeamId))
          .collect()
      : [];

    const feedFilter = args.filter === "team" && effectiveTeamId
      ? await createTeamFeedFilter(ctx, effectiveTeamId)
      : null;

    const additionalUsers = await Promise.all(
      (feedFilter?.memberships ?? [])
        .filter(m => !teamUsers.some(u => u._id.toString() === m.user_id.toString()))
        .map(m => ctx.db.get(m.user_id))
    );
    const allTeamUsers = [...teamUsers, ...additionalUsers.filter((u): u is NonNullable<typeof u> => u !== null)];
    const teamUserMap = new Map(allTeamUsers.map(u => [u._id.toString(), u]));

    const normalizeToRoot = (path: string): string => {
      const parts = path.split('/');
      const srcIndex = parts.findIndex(p => p === 'src' || p === 'projects' || p === 'repos' || p === 'code');
      if (srcIndex >= 0 && srcIndex < parts.length - 1) {
        return parts.slice(0, srcIndex + 2).join('/');
      }
      return path;
    };
    const deriveGitRoot = (c: { git_root?: string; project_path?: string }): string | null => {
      const rawPath = c.git_root || c.project_path;
      if (!rawPath) return null;
      return normalizeToRoot(rawPath);
    };

    const now = Date.now();
    const fiveMinutesAgo = now - 5 * 60 * 1000;

    const liveConvIds = await liveConversationIdSet(ctx, userId, { now });

    const needsBatchScan = !!(args.subagentFilter || args.directoryFilter || args.timeFilter);

    const matchesFilters = (c: any): boolean => {
      if (args.subagentFilter) {
        const isSub = !!(c.parent_conversation_id && !c.parent_message_uuid);
        if (args.subagentFilter === "subagent" && !isSub) return false;
        if (args.subagentFilter === "main" && isSub) return false;
      }
      if (args.directoryFilter) {
        const root = deriveGitRoot(c);
        if (!root) return false;
        const filterName = args.directoryFilter.split('/').filter(Boolean).pop();
        const rootParts = root.split('/').filter(Boolean);
        if (!filterName || !rootParts.includes(filterName)) return false;
      }
      if (args.timeFilter === "active") {
        const isActive = c.status === "active" && (c.updated_at > fiveMinutesAgo || liveConvIds.has(c._id.toString()));
        if (!isActive) return false;
      }
      if (args.timeFilter === "long") {
        if ((c.updated_at - c.started_at) < 20 * 60 * 1000) return false;
      }
      return true;
    };

    let conversations;
    // Set only by the team-merge path, which owns its own cursor protocol.
    let teamMergeNextCursor: string | null | undefined;
    // Examination floors of scans that stopped before exhausting their index
    // (read budget / per-member quota). The page cursor must never dip below an
    // unfinished scan's floor — rows in the unexamined gap would be skipped
    // forever (re-examining is safe, the client dedups; skipping is not) — and
    // a short page must not report end-of-history while a floor remains.
    const scanFloors: number[] = [];
    if (args.filter === "my") {
      if (needsBatchScan) {
        const scan = await batchScanConversations({
          fetchPage: (cursor, take) =>
            ctx.db
              .query("conversations")
              .withIndex("by_user_updated", (q) =>
                cursor
                  ? q.eq("user_id", userId).lt("updated_at", cursor)
                  : q.eq("user_id", userId)
              )
              .order("desc")
              .take(take),
          startCursor: cursorTimestamp,
          want: limit + 1,
          accept: matchesFilters,
          batchSize: Math.min(limit * 3, 50),
        });
        conversations = scan.rows;
        if (!scan.exhausted && scan.oldestSeen != null) scanFloors.push(scan.oldestSeen);
      } else {
        const query = ctx.db
          .query("conversations")
          .withIndex("by_user_updated", (q) =>
            cursorTimestamp
              ? q.eq("user_id", userId).lt("updated_at", cursorTimestamp)
              : q.eq("user_id", userId)
          )
          .order("desc");
        conversations = await query.take(limit + 1);
      }
    } else if (args.memberId) {
      // Filter by specific team member - use index for efficient pagination
      const targetMember = teamUserMap.get(args.memberId.toString());
      if (!targetMember) {
        return { conversations: [], nextCursor: null };
      }
      const visibility = feedFilter!.getVisibility(args.memberId.toString());
      if (visibility === "hidden") {
        return { conversations: [], nextCursor: null };
      }

      // One scan covers both the filtered and unfiltered cases: visibility
      // alone can drop rows, so even without extra filters a single take()
      // could return a short page mid-history.
      const scan = await batchScanConversations({
        fetchPage: (cursor, take) =>
          ctx.db
            .query("conversations")
            .withIndex("by_team_user_updated", (q) =>
              cursor
                ? q.eq("team_id", effectiveTeamId!).eq("user_id", args.memberId!).lt("updated_at", cursor)
                : q.eq("team_id", effectiveTeamId!).eq("user_id", args.memberId!)
            )
            .order("desc")
            .take(take),
        startCursor: cursorTimestamp,
        want: limit + 1,
        accept: (c) => feedFilter!.isVisible(c) && matchesFilters(c),
        batchSize: Math.min(limit * 3, 50),
      });
      conversations = scan.rows;
      if (!scan.exhausted && scan.oldestSeen != null) scanFloors.push(scan.oldestSeen);
    } else {
      // Query recent conversations from each visible team member and merge.
      // Pagination uses a composite per-member cursor (see feedPagination.ts):
      // each member resumes below what THEY already returned, so pages never
      // re-serve rows the client has, and one member's filtered-out band
      // (e.g. a swarm of subagent sessions) can't stall everyone else.
      const visibleMembers = (feedFilter?.memberships ?? []).filter(m => {
        const visibility = (m as any).visibility || "summary";
        return visibility !== "hidden";
      });

      const maxTotalReads = 100;
      const perMemberFetch = Math.max(3, Math.min(
        Math.ceil((limit + 1) * 2 / Math.max(visibleMembers.length, 1)),
        Math.floor(maxTotalReads / Math.max(visibleMembers.length, 1))
      ));
      const perMemberLimit = Math.max(3, Math.ceil((limit + 1) / Math.max(visibleMembers.length, 1)));

      const page = await paginateTeamFeed({
        memberIds: visibleMembers.map((m) => m.user_id.toString()),
        cursor: args.cursor ?? null,
        limit,
        fetchPage: (memberId, cursor, take) =>
          ctx.db
            .query("conversations")
            .withIndex("by_team_user_updated", (q) =>
              cursor
                ? q.eq("team_id", effectiveTeamId!).eq("user_id", memberId as Id<"users">).lt("updated_at", cursor)
                : q.eq("team_id", effectiveTeamId!).eq("user_id", memberId as Id<"users">)
            )
            .order("desc")
            .take(take),
        accept: (c) => feedFilter!.isVisible(c) && matchesFilters(c),
        perMemberFetch,
        perMemberWant: perMemberLimit,
        maxBatches: 4,
      });
      conversations = page.rows;
      teamMergeNextCursor = page.nextCursor;
    }

    // The team merge computes its own composite continuation; the single-scan
    // paths ("my", memberId) continue from the page's last row, but never below
    // an unfinished scan's floor (those rows were never examined), and a short
    // page with a remaining floor is NOT end-of-history — null means the scan
    // truly ran its index dry.
    const hasMore = teamMergeNextCursor !== undefined ? teamMergeNextCursor != null : conversations.length > limit;
    const resultConversations = teamMergeNextCursor === undefined && hasMore ? conversations.slice(0, limit) : conversations;
    let nextCursor: string | null;
    if (teamMergeNextCursor !== undefined) {
      nextCursor = teamMergeNextCursor;
    } else {
      const pageCursor = hasMore ? resultConversations[resultConversations.length - 1].updated_at : null;
      const continuation = pageCursor != null ? [...scanFloors, pageCursor] : scanFloors;
      nextCursor = continuation.length > 0 ? String(Math.max(...continuation)) : null;
    }

    const conversationsWithUsers = await Promise.all(
      resultConversations.map(async (c) => {
        const conversationUser =
          c.user_id.toString() === userId.toString()
            ? user
            : teamUserMap.get(c.user_id.toString()) || await ctx.db.get(c.user_id);

        const visibilityMode = resolveVisibilityMode(
          c.team_visibility,
          feedFilter?.getVisibility(c.user_id.toString()),
          args.filter === "team"
        );
        let authorName = (conversationUser as any)?.name || (conversationUser as any)?.email?.split("@")[0] || "Unknown";
        let authorAvatar = (conversationUser as any)?.image || (conversationUser as any)?.github_avatar_url || null;
        // An anchor renders under its bot identity even on the host's own row.
        const acting = await resolveActingAuthor(ctx, c);
        if (acting) { authorName = acting.name; authorAvatar = acting.avatar; }
        const projectName = (c.project_path || c.git_root)?.split("/").pop() || "unknown project";
        const durationMs = c.updated_at - c.started_at;
        const isActive = c.status === "active" && (c.updated_at > fiveMinutesAgo || liveConvIds.has(c._id.toString()));
        const title = c.title || "New Session";

        if (visibilityMode === "minimal") {
          return {
            _id: c._id,
            user_id: c.user_id,
            visibility_mode: visibilityMode,
            author_name: authorName,
            author_avatar: authorAvatar,
            acting_user_id: c.acting_user_id ?? null,
            is_anchor: !!c.anchor_id,
            anchor_id: c.anchor_id ?? null,
            is_own: c.user_id.toString() === userId.toString(),
            is_active: isActive,
            updated_at: c.updated_at,
            started_at: c.started_at,
            duration_ms: durationMs,
            message_count: c.message_count,
            activity_summary: `1 agent in ${projectName}`,
            project_path: c.project_path || null,
            git_root: c.git_root || null,
            active_plan_id: c.active_plan_id || null,
            worktree_name: c.worktree_name || null,
            worktree_branch: c.worktree_branch || null,
          };
        }

        if (visibilityMode === "summary") {
          return {
            _id: c._id,
            user_id: c.user_id,
            visibility_mode: visibilityMode,
            title,
            subtitle: c.subtitle || null,
            author_name: authorName,
            author_avatar: authorAvatar,
            acting_user_id: c.acting_user_id ?? null,
            is_anchor: !!c.anchor_id,
            anchor_id: c.anchor_id ?? null,
            is_own: c.user_id.toString() === userId.toString(),
            is_active: isActive,
            updated_at: c.updated_at,
            started_at: c.started_at,
            duration_ms: durationMs,
            message_count: c.message_count,
            project_path: c.project_path || null,
            git_root: c.git_root || null,
            tool_names: [],
            subagent_types: [],
            active_plan_id: c.active_plan_id || null,
            worktree_name: c.worktree_name || null,
            worktree_branch: c.worktree_branch || null,
          };
        }

        if (!includeMessagePreviews) {
          const fullTitle = c.title || "New Session";
          return {
            _id: c._id,
            user_id: c.user_id,
            visibility_mode: visibilityMode,
            title: fullTitle,
            subtitle: (visibilityMode === "full" || visibilityMode === "detailed") ? (c.subtitle || null) : null,
            // Row thumbnail (see schema.image_preview_url) — full/detailed
            // visibility only, so restricted teammates don't leak image URLs.
            image_preview_url: (visibilityMode === "full" || visibilityMode === "detailed") ? (c.image_preview_url ?? null) : null,
            first_user_message: null,
            first_assistant_message: null,
            message_alternates: [],
            tool_names: [],
            subagent_types: [],
            agent_type: c.agent_type,
            model: c.model || null,
            slug: visibilityMode === "full" ? (c.slug || null) : null,
            started_at: c.started_at,
            updated_at: c.updated_at,
            duration_ms: durationMs,
            message_count: c.message_count,
            ai_message_count: 0,
            tool_call_count: 0,
            is_active: isActive,
            author_name: authorName,
            author_avatar: authorAvatar,
            acting_user_id: c.acting_user_id ?? null,
            is_anchor: !!c.anchor_id,
            anchor_id: c.anchor_id ?? null,
            is_own: c.user_id.toString() === userId.toString(),
            parent_conversation_id: c.parent_conversation_id || null,
            parent_message_uuid: c.parent_message_uuid || null,
            is_subagent: !!(c.is_subagent || (c.parent_conversation_id && !c.parent_message_uuid)),
            is_workflow_sub: c.is_workflow_sub || false,
            workflow_run_id: c.workflow_run_id || null,
            parent_title: null,
            latest_todos: undefined,
            project_path: c.project_path || null,
            git_root: c.git_root || null,
            git_branch: c.git_branch || null,
            git_remote_url: c.git_remote_url || null,
            is_favorite: c.is_favorite || false,
            profile_pinned_at: c.profile_pinned_at,
            fork_count: c.fork_count || 0,
            forked_from: c.forked_from || null,
            is_private: c.is_private,
            team_visibility: c.team_visibility || null,
            auto_shared: c.auto_shared || false,
            active_plan_id: c.active_plan_id || null,
            worktree_name: c.worktree_name || null,
            worktree_branch: c.worktree_branch || null,
          };
        }

        // Only fetch first few messages for previews (keep reads minimal to stay under 16MB limit)
        const msgLimit = 3;
        const messages = await ctx.db
          .query("messages")
          .withIndex("by_conversation_id", (q) =>
            q.eq("conversation_id", c._id)
          )
          .order("asc")
          .take(msgLimit);

        let toolCallCount = 0;
        const toolNames: string[] = [];
        const subagentTypes: string[] = [];
        let aiMessageCount = 0;
        const messageAlternates: Array<{ role: "user" | "assistant"; content: string }> = [];
        let latestTodos: { todos: any[]; timestamp: number } | undefined;

        for (const msg of messages) {
          if (msg.tool_calls) {
            toolCallCount += msg.tool_calls.length;
            for (const tc of msg.tool_calls) {
              if (toolNames.length < 5 && !toolNames.includes(tc.name)) {
                toolNames.push(tc.name);
              }
              if (tc.name === "Task" && tc.input) {
                try {
                  const input = JSON.parse(tc.input);
                  if (input.subagent_type && !subagentTypes.includes(input.subagent_type)) {
                    subagentTypes.push(input.subagent_type);
                  }
                } catch {}
              }
              if (tc.name === "TodoWrite" && tc.input) {
                try {
                  const input = JSON.parse(tc.input);
                  if (input.todos) {
                    if (!latestTodos || msg.timestamp > latestTodos.timestamp) {
                      latestTodos = {
                        todos: input.todos,
                        timestamp: msg.timestamp,
                      };
                    }
                  }
                } catch {}
              }
            }
          }
          if (msg.role === "user") {
            const text = msg.content?.trim();
            // isImportNotice: context-only import banner must not become the
            // preview / first_user_message / fallback title.
            if (text && !isImportNotice(text)) {
              const truncated = text.length > 120 ? text.slice(0, 120) + "..." : text;
              messageAlternates.push({ role: "user", content: truncated });
            }
          }
          if (msg.role === "assistant") {
            aiMessageCount++;
            let text = msg.content?.trim();
            if (!text && msg.thinking) {
              text = msg.thinking.trim();
            }
            if (!text && msg.tool_calls && msg.tool_calls.length > 0) {
              const toolNames = msg.tool_calls.map(tc => tc.name).join(", ");
              text = `[Using: ${toolNames}]`;
            }
            if (text) {
              const truncated = text.length > 120 ? text.slice(0, 120) + "..." : text;
              messageAlternates.push({ role: "assistant", content: truncated });
            }
          }
        }

        const firstUserMessage = messageAlternates.find(m => m.role === "user")?.content || "";
        const firstAssistantMessage = messageAlternates.find(m => m.role === "assistant")?.content || "";

        const fullTitle = c.title || firstUserMessage || "New Session";

        // spawned_by (visible child → its lead) joins the same parent
        // resolution so the "sub of"/"spawned by" row and title come free.
        let parentConversationId: string | null =
          c.parent_conversation_id || c.spawned_by_conversation_id || null;
        let parentTitle: string | null = null;
        if (!parentConversationId && c.parent_message_uuid) {
          const parentMsg = await ctx.db
            .query("messages")
            .withIndex("by_message_uuid", (q) => q.eq("message_uuid", c.parent_message_uuid))
            .first();
          if (parentMsg) {
            parentConversationId = parentMsg.conversation_id;
          }
        }
        if (parentConversationId) {
          const parentConv = await ctx.db.get(parentConversationId as Id<"conversations">);
          if (parentConv) {
            parentTitle = parentConv.title || "New Session";
          }
        }

        return {
          _id: c._id,
          user_id: c.user_id,
          visibility_mode: visibilityMode,
          title: fullTitle,
          subtitle: (visibilityMode === "full" || visibilityMode === "detailed") ? (c.subtitle || null) : null,
          first_user_message: visibilityMode === "full" ? firstUserMessage : null,
          first_assistant_message: visibilityMode === "full" ? firstAssistantMessage : null,
          message_alternates: visibilityMode === "full" ? messageAlternates : [],
          tool_names: toolNames,
          subagent_types: subagentTypes,
          agent_type: c.agent_type,
          model: c.model || null,
          slug: visibilityMode === "full" ? (c.slug || null) : null,
          started_at: c.started_at,
          updated_at: c.updated_at,
          duration_ms: durationMs,
          message_count: c.message_count,
          ai_message_count: aiMessageCount,
          tool_call_count: toolCallCount,
          is_active: isActive,
          author_name: authorName,
          author_avatar: authorAvatar,
          is_own: c.user_id.toString() === userId.toString(),
          parent_conversation_id: visibilityMode === "full" ? parentConversationId : null,
          spawned_by_conversation_id: visibilityMode === "full" ? (c.spawned_by_conversation_id || null) : null,
          parent_message_uuid: c.parent_message_uuid || null,
          is_subagent: !!(c.is_subagent || (c.parent_conversation_id && !c.parent_message_uuid)),
          is_workflow_sub: c.is_workflow_sub || false,
          workflow_run_id: c.workflow_run_id || null,
          parent_title: visibilityMode === "full" ? parentTitle : null,
          latest_todos: visibilityMode === "full" ? latestTodos : undefined,
          project_path: c.project_path || null,
          git_root: c.git_root || null,
          git_branch: c.git_branch || null,
          git_remote_url: c.git_remote_url || null,
          is_favorite: c.is_favorite || false,
          profile_pinned_at: c.profile_pinned_at,
          fork_count: c.fork_count || 0,
          forked_from: c.forked_from || null,
          is_private: c.is_private,
          team_visibility: c.team_visibility || null,
          auto_shared: c.auto_shared || false,
          active_plan_id: c.active_plan_id || null,
          worktree_name: c.worktree_name || null,
          worktree_branch: c.worktree_branch || null,
        };
      })
    );

    const sortedConvs = conversationsWithUsers.sort((a, b) => (b as { updated_at: number }).updated_at - (a as { updated_at: number }).updated_at);

    const planIds = new Set<string>();
    for (const c of sortedConvs) {
      const pid = (c as any).active_plan_id;
      if (pid) planIds.add(pid.toString());
    }
    const planCache = new Map<string, { _id: string; short_id: string; title: string; status: string }>();
    for (const pid of planIds) {
      const p = await ctx.db.get(pid as any);
      if (p) planCache.set(pid, { _id: (p as any)._id, short_id: (p as any).short_id, title: (p as any).title, status: (p as any).status });
    }
    const enriched = sortedConvs.map((c: any) => ({
      ...c,
      active_plan: c.active_plan_id ? planCache.get(c.active_plan_id.toString()) || null : null,
    }));

    return {
      conversations: enriched,
      nextCursor,
      hasSubagents: true,
    };
  },
});

export const generateShareLink = mutation({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized: must be logged in");
    }
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }
    const isOwner = conversation.user_id.toString() === authUserId.toString();
    if (!isOwner) {
      throw new Error("Unauthorized: can only share your own conversations");
    }
    if (conversation.share_token) {
      return conversation.share_token;
    }
    const shareToken = generateShareToken();
    await ctx.db.patch(args.conversation_id, {
      share_token: shareToken,
    });
    return shareToken;
  },
});

// Pin a session to the owner's PUBLIC profile. This is the consent act that
// makes a session world-visible, so it also guarantees a share_token — the
// profile card and the /share guest viewer both key off that token. Pinning a
// session that was private/team-only does NOT change is_private; it grants
// anonymous read of *this one session* via its share link, nothing more.
export const pinToProfile = mutation({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) throw new Error("Unauthorized: must be logged in");
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) throw new Error("Conversation not found");
    if (conversation.user_id.toString() !== authUserId.toString())
      throw new Error("Unauthorized: can only pin your own conversations");

    const patch: { profile_pinned_at: number; share_token?: string } = {
      profile_pinned_at: Date.now(),
    };
    if (!conversation.share_token) patch.share_token = generateShareToken();
    await ctx.db.patch(args.conversation_id, patch);
    return { pinned: true, share_token: conversation.share_token ?? patch.share_token };
  },
});

// Remove a session from the public profile. Leaves the share_token intact — the
// owner may have circulated that link elsewhere; un-pinning only delists it from
// the profile (profilePublicSessionVisible then drops it).
export const unpinFromProfile = mutation({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) throw new Error("Unauthorized: must be logged in");
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) throw new Error("Conversation not found");
    if (conversation.user_id.toString() !== authUserId.toString())
      throw new Error("Unauthorized: can only unpin your own conversations");
    await ctx.db.patch(args.conversation_id, { profile_pinned_at: undefined });
    return { pinned: false };
  },
});

export const getSharedConversation = query({
  args: {
    share_token: v.string(),
  },
  handler: async (ctx, args) => {
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_share_token", (q) => q.eq("share_token", args.share_token))
      .collect();

    if (conversations.length === 0) {
      return null;
    }

    const conversation = conversations[0];

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", conversation._id)
      )
      .collect();

    const sortedMessages = messages.sort((a, b) => a.timestamp - b.timestamp);
    const user = await ctx.db.get(conversation.user_id);

    let firstUserMessage = "";
    for (const msg of sortedMessages) {
      const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
      if (msg.role === "user" && !hasToolResults) {
        const text = msg.content?.trim();
        if (text) {
          firstUserMessage = text.slice(0, 120);
          if (text.length > 120) firstUserMessage += "...";
          break;
        }
      }
    }

    const title = conversation.title
      || firstUserMessage
      || (conversation.slug ? formatSlugAsTitle(conversation.slug) : null)
      || "New Session";

    return sanitizeConvexObjectKeys({
      ...conversationForAccess(conversation, "shared"),
      title,
      messages: sortedMessages,
      user: user ? { name: user.name, email: user.email } : null,
      fork_count: conversation.fork_count,
      forked_from: conversation.forked_from,
    });
  },
});

// A signed-in viewer presenting a share link trades the token for a durable
// per-user redemption row. From then on every id-keyed query (the whole inbox
// surface) resolves them to "shared" through checkConversationAccess without
// carrying the token — and rotating the token invalidates the redemption,
// because access requires the stored token to still match. Anonymous guests
// don't redeem; they present the token on each query instead.
export const redeemShareToken = mutation({
  args: { share_token: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_share_token", (q) => q.eq("share_token", args.share_token))
      .first();
    if (!conversation) return null;
    const existing = await ctx.db
      .query("share_redemptions")
      .withIndex("by_conversation_user", (q) =>
        q.eq("conversation_id", conversation._id).eq("user_id", userId)
      )
      .first();
    if (existing) {
      if (existing.token !== args.share_token) {
        await ctx.db.patch(existing._id, { token: args.share_token, created_at: Date.now() });
      }
    } else {
      await ctx.db.insert("share_redemptions", {
        conversation_id: conversation._id,
        user_id: userId,
        token: args.share_token,
        created_at: Date.now(),
      });
    }
    return { conversation_id: conversation._id };
  },
});

export const getSharedConversationMeta = query({
  args: {
    share_token: v.string(),
  },
  handler: async (ctx, args) => {
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_share_token", (q) => q.eq("share_token", args.share_token))
      .collect();

    if (conversations.length === 0) return null;

    const conversation = conversations[0];
    const user = await ctx.db.get(conversation.user_id);

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", conversation._id)
      )
      .order("asc")
      .take(10);

    let firstUserMessage = "";
    for (const msg of messages) {
      const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
      if (msg.role === "user" && !hasToolResults) {
        const text = msg.content?.trim();
        if (text) {
          firstUserMessage = text.slice(0, 200);
          if (text.length > 200) firstUserMessage += "...";
          break;
        }
      }
    }

    const title = conversation.title
      || firstUserMessage
      || (conversation.slug ? formatSlugAsTitle(conversation.slug) : null)
      || "Coding Session";

    // idle_summary is the purpose-built one-liner (same preference as the
    // session card's sessionCardSummary); subtitle is a multi-bullet block, so
    // only its first bullet fits a link preview.
    const description = conversation.idle_summary?.trim()
      || conversation.subtitle?.split("\n").find((l) => l.trim())?.trim().replace(/^[-*]\s+/, "")
      || (conversation.title ? firstUserMessage : null)
      || `${conversation.message_count || 0} messages${user?.name ? ` by ${user.name}` : ""}${conversation.project_path ? ` in ${conversation.project_path.split("/").pop()}` : ""}`;

    return {
      title,
      description,
      author: user?.name || null,
      message_count: conversation.message_count || 0,
      // The web server 302s /share/<token> straight to /conversation/<id>
      // (skipping a full app boot whose only job was this same lookup).
      conversation_id: conversation._id,
    };
  },
});

export const getConversationPublic = query({
  args: {
    conversation_id: v.id("conversations"),
    limit: v.optional(v.number()),
    before_timestamp: v.optional(v.number()),
    share_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return { access_level: "not_found" as const, conversation: null };
    }

    const authUserId = await getAuthUserId(ctx);
    const accessLevel = await checkConversationAccess(ctx, authUserId, conversation, args.share_token);

    if (accessLevel === "denied") {
      return { access_level: "denied" as const, conversation: null };
    }

    const limit = args.limit ?? 100;
    let messagesQuery = ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id)
      );

    if (args.before_timestamp !== undefined) {
      messagesQuery = messagesQuery.filter((q) =>
        q.lt(q.field("timestamp"), args.before_timestamp!)
      );
    }

    const messages = await messagesQuery
      .order("desc")
      .take(limit + 1);

    const hasMore = messages.length > limit;
    const resultMessages = hasMore ? messages.slice(0, limit) : messages;
    const sortedMessages = resultMessages.sort((a, b) => a.timestamp - b.timestamp);
    const oldestTimestamp = sortedMessages.length > 0 ? sortedMessages[0].timestamp : null;

    const user = await ctx.db.get(conversation.user_id);

    let firstUserMessage = "";
    for (const msg of sortedMessages) {
      const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
      if (msg.role === "user" && !hasToolResults) {
        const text = msg.content?.trim();
        if (text) {
          firstUserMessage = text.slice(0, 120);
          if (text.length > 120) firstUserMessage += "...";
          break;
        }
      }
    }

    const title = conversation.title
      || firstUserMessage
      || (conversation.slug ? formatSlugAsTitle(conversation.slug) : null)
      || "New Session";

    let parentConversationId: string | null = conversation.parent_conversation_id || null;
    if (!parentConversationId && conversation.parent_message_uuid) {
      const parentMsg = await ctx.db
        .query("messages")
        .withIndex("by_message_uuid", (q) => q.eq("message_uuid", conversation.parent_message_uuid))
        .first();
      if (parentMsg) {
        parentConversationId = parentMsg.conversation_id;
      }
    }

    return sanitizeConvexObjectKeys({
      access_level: accessLevel,
      conversation: {
        ...conversationForAccess(conversation, accessLevel),
        title,
        messages: sortedMessages,
        user: user ? { name: user.name, email: user.email, avatar_url: user.image || user.github_avatar_url || null } : null,
        has_more_above: hasMore,
        oldest_timestamp: oldestTimestamp,
        fork_count: conversation.fork_count,
        forked_from: conversation.forked_from,
        parent_conversation_id: parentConversationId,
      },
    });
  },
});

// The command palette's row set. Split from the query wrapper (like
// performListActiveSessions) so the projection is testable without auth.
export async function performListRecentSessions(ctx: { db: QueryCtx["db"] }, userId: Id<"users">) {
  const user = await ctx.db.get(userId);
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const own = await ctx.db
    .query("conversations")
    .withIndex("by_user_updated", (q) =>
      q.eq("user_id", userId).gte("updated_at", thirtyDaysAgo)
    )
    .order("desc")
    .filter((q) =>
      q.and(
        q.neq(q.field("is_subagent"), true),
        q.or(
          q.eq(q.field("status"), "active"),
          q.eq(q.field("status"), "completed")
        )
      )
    )
    .take(100);

  type ConvRow = typeof own[number];
  const isSessionRow = (c: ConvRow) =>
    c.is_subagent !== true && (c.status === "active" || c.status === "completed");

  const byId = new Map<string, { conv: ConvRow; isOwn: boolean }>();
  for (const c of own) byId.set(c._id.toString(), { conv: c, isOwn: true });

  // Merge in team-visible sessions so teammates' work shows in the palette too.
  const effectiveTeamId = user?.active_team_id;
  const authorById = new Map<string, { name: string; avatar: string | null }>();
  if (effectiveTeamId) {
    const { visibleMembers, rows } = await collectTeammateConversationsSince(
      ctx, effectiveTeamId, userId, thirtyDaysAgo, () => 10,
    );
    const memberUsers = await Promise.all(visibleMembers.map((m) => ctx.db.get(m.user_id)));
    for (const u of memberUsers) {
      if (u) authorById.set(u._id.toString(), {
        name: (u as any).name || (u as any).email?.split("@")[0] || "Unknown",
        avatar: (u as any).image || (u as any).github_avatar_url || null,
      });
    }
    for (const c of rows.filter(isSessionRow)) {
      const id = c._id.toString();
      if (!byId.has(id)) byId.set(id, { conv: c, isOwn: false });
    }
  }

  return Array.from(byId.values())
    .sort((a, b) => b.conv.updated_at - a.conv.updated_at)
    .slice(0, 100)
    .map(({ conv: c, isOwn }) => {
      const author = isOwn ? null : authorById.get(c.user_id.toString());
      return {
        _id: c._id,
        session_id: c.session_id,
        title: c.title,
        subtitle: c.subtitle,
        idle_summary: c.idle_summary,
        updated_at: c.updated_at,
        project_path: c.project_path,
        git_root: c.git_root,
        agent_type: c.agent_type,
        message_count: c.message_count,
        // The command palette builds its list from two sources: favorites
        // carry whole store rows (so the marker arrives), while recents come
        // from THIS projection. Omitting it left inbox_killed_at permanently
        // undefined on half the rows, so killed-awareness silently could not
        // work there. The conversation doc is already in hand — no extra read.
        // Stash/dismiss/pin ride along for the same reason: a palette-opened
        // session is injected into the client's sessions cache, and a row
        // seeded without its triage state renders as an active needs-input
        // card at boot (ct-42666).
        ...inboxVisibilityFields(c),
        isOwn,
        authorName: author?.name ?? null,
        authorAvatar: author?.avatar ?? null,
      };
    });
}

export const listRecentSessions = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return performListRecentSessions(ctx, userId);
  },
});

export const searchConversations = query({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
    userOnly: v.optional(v.boolean()),
    activeTeamId: v.optional(v.id("teams")),
    mineOnly: v.optional(v.boolean()),
    since: v.optional(v.number()),
    sort: v.optional(v.union(v.literal("recent"), v.literal("relevance"))),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }
    const user = await ctx.db.get(userId);
    if (!user) {
      return [];
    }

    const scope = await loadConversationSearchScope(ctx, userId, user, args);

    const searchTerm = args.query.trim();
    if (!searchTerm || searchTerm.length < 2) {
      return [];
    }

    const limit = args.limit ?? 20;
    const userOnly = args.userOnly ?? false;
    const terms = parseSearchTerms(searchTerm);
    const { pool: searchResults, tier: contentTier } = await fetchMessageSearchPool(ctx, terms, {
      userId,
      teamIds: scope.effectiveTeamIds,
    });

    // Group messages by conversation (keep messages matching ANY term for context)
    const conversationMessages = new Map<string, typeof searchResults>();
    for (const msg of searchResults) {
      if (userOnly && msg.role !== "user") {
        continue;
      }
      if (!contentMatchesAnyTerm(msg.content || "", terms)) {
        continue;
      }
      const convId = msg.conversation_id.toString();
      if (!conversationMessages.has(convId)) {
        conversationMessages.set(convId, []);
      }
      conversationMessages.get(convId)!.push(msg);
    }

    // Filter to conversations where ALL terms appear (across any messages)
    const conversationMatches = new Map<string, typeof searchResults>();
    for (const [convId, messages] of conversationMessages) {
      if (conversationMatchesAllTerms(messages, terms)) {
        conversationMatches.set(convId, messages);
      }
    }

    const titleConvs = new Map<string, Doc<"conversations">>();
    if (!userOnly) {
      for (const [convId, conv] of await fetchTitleFieldHits(ctx, terms)) {
        if (conversationMatches.has(convId)) continue;
        titleConvs.set(convId, conv);
      }
    }

    const results: Array<{
      conversationId: string;
      title: string;
      matchCount: number;
      matches: Array<{
        messageId: string;
        content: string;
        role: string;
        timestamp: number;
      }>;
      updatedAt: number;
      authorName: string;
      authorAvatar: string | null;
      isOwn: boolean;
      messageCount: number;
      proximityScore: number;
      titleMatch: boolean;
      projectPath: string | null;
      agentType: string | null;
    }> = [];

    // Hydrate conversation docs for message matches in parallel (was a serial
    // await-in-loop, the dominant source of latency on common queries).
    const matchEntries = [...conversationMatches.values()];
    const matchConvs = await Promise.all(
      matchEntries.map((messages) => ctx.db.get(messages[0].conversation_id))
    );
    const candidates: Array<{ conv: Doc<"conversations">; messages: typeof searchResults }> = [];
    matchEntries.forEach((messages, i) => {
      const conv = matchConvs[i];
      if (conv) candidates.push({ conv, messages });
    });
    for (const conv of titleConvs.values()) {
      candidates.push({ conv, messages: [] });
    }

    // Visibility filter is synchronous (no DB) — drop non-visible candidates first.
    const visible = candidates.filter(({ conv }) => scope.isVisible(conv));

    // Time-range filter applies before totals so the counts reflect what's
    // actually browsable under the current filters.
    const scoped = args.since
      ? visible.filter((c) => c.conv.updated_at >= args.since!)
      : visible;

    // Score once up front — the relevance sort and the per-result payload share it.
    const scored = scoped.map((c) => ({
      ...c,
      proximityScore: calculateProximityScore(c.messages, terms),
    }));
    if (args.sort === "relevance") {
      scored.sort((a, b) =>
        b.proximityScore - a.proximityScore ||
        b.messages.length - a.messages.length ||
        b.conv.updated_at - a.conv.updated_at);
    } else {
      scored.sort((a, b) => b.conv.updated_at - a.conv.updated_at);
    }
    const totalMatches = scored.reduce((sum, c) => sum + c.messages.length, 0);
    const totalSessions = scored.length;
    const top = scored.slice(0, limit);

    const firstMsgByConv = await resolveFirstMessageTitles(ctx, top.map((c) => c.conv));

    for (const { conv, messages, proximityScore } of top) {
      const isOwn = conv.user_id.toString() === userId.toString();
      const conversationUser = scope.userById.get(conv.user_id.toString());
      const firstUserMessage = firstMsgByConv.get(conv._id.toString()) || "";

      const title = conv.title
        || firstUserMessage
        || (conv.slug ? formatSlugAsTitle(conv.slug) : null)
        || "New Session";

      results.push({
        conversationId: conv._id,
        title,
        matchCount: messages.length,
        matches: messages.slice(0, 5).map((m) => {
          const content = m.content || "";
          const lowerContent = content.toLowerCase();
          let bestIdx = -1;
          for (const term of terms.all) {
            const idx = lowerContent.indexOf(term);
            if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
              bestIdx = idx;
            }
          }
          const start = Math.max(0, bestIdx > -1 ? bestIdx - 80 : 0);
          const end = Math.min(content.length, bestIdx > -1 ? bestIdx + 220 : 300);
          let snippet = content.slice(start, end);
          if (start > 0) snippet = "..." + snippet;
          if (end < content.length) snippet = snippet + "...";
          return {
            messageId: m._id,
            content: snippet,
            role: m.role,
            timestamp: m.timestamp,
          };
        }),
        updatedAt: conv.updated_at,
        authorName: conversationUser?.name || "Unknown",
        authorAvatar: (conversationUser as any)?.image || (conversationUser as any)?.github_avatar_url || null,
        isOwn,
        messageCount: conv.message_count || 0,
        proximityScore,
        titleMatch: messages.length === 0,
        projectPath: conv.project_path || null,
        agentType: conv.agent_type || null,
      });
    }

    return {
      results,
      totalMatches,
      totalSessions,
      // Which pool served content matches ("recent" mirror vs "deep" full
      // index) and the mirror's coverage, so UI copy about time filters
      // beyond the window stays truthful (see searchMirror.ts).
      contentTier,
      contentWindowDays: CONTENT_WINDOW_DAYS,
    };
  },
});

// The cheap, reliable half of global search: only the conversation-level
// search indexes (title/subtitle/idle_summary), never the messages full-text
// index. Common tokens can blow the read budget on the message search (see
// the fetchMessageSearchPool NOTE) and kill searchConversations wholesale —
// clients call this alongside it, render these rows immediately, and merge in
// message matches if/when the full search returns (dedup by conversationId,
// message rows win). Result rows are shaped exactly like searchConversations
// results so the merge is a plain concat. userOnly callers skip this query:
// title matches aren't user-authored messages.
export const searchConversationTitles = query({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
    activeTeamId: v.optional(v.id("teams")),
    mineOnly: v.optional(v.boolean()),
    since: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const empty = { results: [], totalMatches: 0, totalSessions: 0 };
    const userId = await getAuthUserId(ctx);
    if (!userId) return empty;
    const user = await ctx.db.get(userId);
    if (!user) return empty;

    const searchTerm = args.query.trim();
    if (!searchTerm || searchTerm.length < 2) return empty;

    const terms = parseSearchTerms(searchTerm);
    if (terms.all.length === 0) return empty;
    const scope = await loadConversationSearchScope(ctx, userId, user, args);
    const hits = await fetchTitleFieldHits(ctx, terms);

    const visible = [...hits.values()].filter((conv) => scope.isVisible(conv));
    const scoped = args.since
      ? visible.filter((conv) => conv.updated_at >= args.since!)
      : visible;
    scoped.sort((a, b) => b.updated_at - a.updated_at);
    const top = scoped.slice(0, args.limit ?? 20);
    const firstMsgByConv = await resolveFirstMessageTitles(ctx, top);

    const results = top.map((conv) => {
      const conversationUser = scope.userById.get(conv.user_id.toString());
      const title = conv.title
        || firstMsgByConv.get(conv._id.toString())
        || (conv.slug ? formatSlugAsTitle(conv.slug) : null)
        || "New Session";
      return {
        conversationId: conv._id as string,
        title,
        matchCount: 0,
        matches: [] as Array<{
          messageId: string;
          content: string;
          role: string;
          timestamp: number;
        }>,
        updatedAt: conv.updated_at,
        authorName: conversationUser?.name || "Unknown",
        authorAvatar: (conversationUser as any)?.image || (conversationUser as any)?.github_avatar_url || null,
        isOwn: conv.user_id.toString() === userId.toString(),
        messageCount: conv.message_count || 0,
        proximityScore: 0,
        titleMatch: true,
        projectPath: conv.project_path || null,
        agentType: conv.agent_type || null,
      };
    });

    return { results, totalMatches: 0, totalSessions: results.length };
  },
});

export const updateSlug = mutation({
  args: {
    conversation_id: v.id("conversations"),
    slug: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized");
    }
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }
    if (conversation.user_id.toString() !== authUserId.toString()) {
      throw new Error("Unauthorized: can only update your own conversations");
    }
    await ctx.db.patch(args.conversation_id, {
      slug: args.slug,
    });
  },
});

export const setPrivacy = mutation({
  args: {
    conversation_id: v.id("conversations"),
    is_private: v.boolean(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized: must be logged in");
    }
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }
    const isOwner = conversation.user_id.toString() === authUserId.toString();
    if (!isOwner) {
      throw new Error("Unauthorized: can only change privacy of your own conversations");
    }

    // Sharing must guarantee a team_id (buildShareUpdate); locking forces the
    // private visibility marker. Never let is_private:false and team_id diverge.
    const updates = args.is_private
      ? { is_private: true as const, team_visibility: "private" as const }
      : await buildShareUpdate(ctx, conversation, authUserId);

    // Patches the conversation AND rewrites linked work items' stored access
    // key (tasks/plans/docs follow the session's visibility).
    await patchConversationVisibility(ctx, conversation, updates);
    // Access inputs changed without a comment write: move the comment view
    // head so viewers who regain access can re-materialize (matrix SRV-02).
    await advanceCommentsAccessRevision(ctx, conversation);
  },
});

export const setTeamVisibility = mutation({
  args: {
    conversation_id: v.id("conversations"),
    team_visibility: v.union(v.literal("summary"), v.literal("full"), v.null()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized: must be logged in");
    }
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }
    const isOwner = conversation.user_id.toString() === authUserId.toString();
    if (!isOwner) {
      throw new Error("Unauthorized: can only change visibility of your own conversations");
    }

    // Setting any team visibility shares the conversation, so guarantee a
    // team_id alongside it (else it's shared-with-nobody).
    const updates = await buildShareUpdate(ctx, conversation, authUserId);
    await patchConversationVisibility(ctx, conversation, {
      ...updates,
      team_visibility: args.team_visibility ?? undefined,
    });
    await advanceCommentsAccessRevision(ctx, conversation);
  },
});

export const setPrivacyBySessionId = mutation({
  args: {
    session_id: v.string(),
    is_private: v.boolean(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }

    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .filter((q) => q.eq(q.field("user_id"), authUserId))
      .first();

    if (!conversation) {
      throw new Error(`Conversation not found with session_id: ${args.session_id}`);
    }

    // Same contract as setPrivacy: sharing must guarantee a team_id
    // (buildShareUpdate), locking forces the private visibility marker. A raw
    // is_private flip here was the one share path that skipped buildShareUpdate
    // and could mint a "shared with nobody" row (non-private, teamless).
    const updates = args.is_private
      ? { is_private: true as const, team_visibility: "private" as const }
      : await buildShareUpdate(ctx, conversation, authUserId);
    await patchConversationVisibility(ctx, conversation, updates);
    await advanceCommentsAccessRevision(ctx, conversation);

    if (args.api_token) {
      await ctx.db.patch(authUserId, {
        daemon_last_seen: Date.now(),
      });
    }
  },
});

export const makeAllPrivate = mutation({
  args: {},
  handler: async (ctx) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized: must be logged in");
    }

    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
      .filter((q) => q.neq(q.field("is_private"), true))
      .collect();

    let updated = 0;
    for (const conv of conversations) {
      await patchConversationVisibility(ctx, conv, { is_private: true });
      updated++;
    }

    return { updated, total: conversations.length };
  },
});

export const makeAllPrivateAdmin = internalMutation({
  args: {
    user_id: v.id("users"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = args.limit ?? 100;
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_private", (q) =>
        q.eq("user_id", args.user_id).eq("is_private", false)
      )
      .take(batchSize);

    let updated = 0;
    for (const conv of conversations) {
      await patchConversationVisibility(ctx, conv, { is_private: true });
      updated++;
    }

    return { updated, hasMore: conversations.length === batchSize };
  },
});

export const backfillShortIds = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = args.limit ?? 100;
    // Use cursor-based pagination to avoid full table scan
    const result = await ctx.db
      .query("conversations")
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize });

    let updated = 0;
    for (const conv of result.page) {
      if (!conv.short_id) {
        await ctx.db.patch(conv._id, {
          short_id: conv._id.toString().slice(0, 7),
        });
        updated++;
      }
    }

    return {
      updated,
      cursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

export const backfillTeamIds = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = args.limit ?? 100;

    // Get all users with team_id or active_team_id to build a lookup map
    const allUsers = await ctx.db
      .query("users")
      .collect();

    const userTeamMap = new Map<string, Id<"teams">>();
    for (const user of allUsers) {
      const teamId = (user as any).active_team_id || user.team_id;
      if (teamId) {
        userTeamMap.set(user._id.toString(), teamId);
      }
    }

    // Paginate through conversations missing team_id
    const result = await ctx.db
      .query("conversations")
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize });

    let updated = 0;
    for (const conv of result.page) {
      if (conv.team_id) continue;
      const userTeamId = userTeamMap.get(conv.user_id.toString());
      if (userTeamId) {
        await ctx.db.patch(conv._id, { team_id: userTeamId });
        updated++;
      }
    }

    return {
      updated,
      cursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

export const diagnoseTeamIds = internalQuery({
  args: {
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Get users with teams (lightweight query)
    const usersWithTeams = await ctx.db
      .query("users")
      .filter((q) => q.neq(q.field("team_id"), undefined))
      .collect();

    const userTeamMap = new Map<string, string>();
    for (const user of usersWithTeams) {
      if (user.team_id) {
        userTeamMap.set(user._id.toString(), user.team_id.toString());
      }
    }

    // Paginate through conversations
    const result = await ctx.db
      .query("conversations")
      .paginate({ cursor: args.cursor ?? null, numItems: 500 });

    let withTeamId = 0;
    let withoutTeamId = 0;
    let userHasTeamButConvDoesnt = 0;
    let mismatch = 0;

    for (const conv of result.page) {
      const convTeamId = conv.team_id?.toString();
      const userTeamId = userTeamMap.get(conv.user_id.toString());

      if (convTeamId) {
        withTeamId++;
      } else {
        withoutTeamId++;
      }

      if (userTeamId && !convTeamId) {
        userHasTeamButConvDoesnt++;
      }

      if (userTeamId && convTeamId && userTeamId !== convTeamId) {
        mismatch++;
      }
    }

    return {
      pageConversations: result.page.length,
      withTeamId,
      withoutTeamId,
      userHasTeamButConvDoesnt,
      mismatch,
      usersWithTeams: usersWithTeams.length,
      cursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

export const backfillUserTeamIds = internalMutation({
  args: { userId: v.string(), teamId: v.string() },
  handler: async (ctx, args) => {
    const userId = args.userId as any;
    const teamId = args.teamId as any;
    let updated = 0;
    let alreadyHad = 0;
    let cursor: string | null = null;
    do {
      const result = await ctx.db
        .query("conversations")
        .withIndex("by_user_updated", (q) => q.eq("user_id", userId))
        .paginate({ cursor: cursor ?? null, numItems: 100 });
      for (const conv of result.page) {
        if (conv.team_id) {
          alreadyHad++;
          continue;
        }
        await ctx.db.patch(conv._id, { team_id: teamId });
        updated++;
      }
      cursor = result.continueCursor;
      if (result.isDone) break;
    } while (true);
    return { updated, alreadyHad };
  },
});

export const getConversationBySessionId = query({
  args: {
    session_id: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return null;
    }

    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .filter((q) => q.eq(q.field("user_id"), authUserId))
      .first();

    return conversation ? { _id: conversation._id } : null;
  },
});

// Single resolver for /conversation/[id] links.
// Accepts any string: Convex document _id, session_id, or UUID.
// Returns the access level and resolved Convex _id so the frontend
// doesn't need to guess which ID format was used.
// The lookup behind /conversation/<id>: accepts a full Convex id, a Claude
// session UUID, a tombstoned (restored) id, or a 7-char short id — the form
// entity pills fall back to before webGet resolves, and the form `cast link`
// mints. Exported for tests.
export async function resolveConversationForViewer(
  ctx: any,
  id: string,
  authUserId: Id<"users"> | null,
  presentedShareToken?: string | null,
): Promise<{ access_level: "not_found" | "denied" | "owner" | "team" | "shared"; conversation_id: string | null }> {
  let conversation = null;

  // Try as Convex document ID
  const convId = ctx.db.normalizeId("conversations", id);
  if (convId) {
    conversation = await ctx.db.get(convId);
  }

  // Try as session_id
  if (!conversation) {
    conversation = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q: any) => q.eq("session_id", id))
      .first();
  }

  // Tombstone forwarding: a kill/restart that restored a deleted
  // conversation stamped its replacement with the dead id — heal stale
  // links/cards by resolving to the replacement (newest if ever several).
  if (!conversation) {
    const restored = await ctx.db
      .query("conversations")
      .withIndex("by_restored_from", (q: any) => q.eq("restored_from_conversation_id", id))
      .collect();
    conversation = restored.reduce(
      (a: any, b: any) => ((b.updated_at ?? 0) > (a?.updated_at ?? 0) ? b : a),
      null,
    );
  }

  // Short id: ranked resolution (own > accessible > newest) because short ids
  // collide across users. The predicate mirrors the final access check so a
  // colliding inaccessible row can't shadow an accessible one; when nothing is
  // accessible the resolver still returns a candidate, so the caller reports
  // "denied" rather than "not_found".
  if (!conversation && !convId) {
    conversation = await resolveConversationRefRanked(
      ctx,
      id.toLowerCase(),
      authUserId ?? "",
      async (c) => (await checkConversationAccess(ctx, authUserId, c, presentedShareToken)) !== "denied",
    );
  }

  if (!conversation) {
    return { access_level: "not_found" as const, conversation_id: null };
  }

  const accessLevel = await checkConversationAccess(ctx, authUserId, conversation, presentedShareToken);

  if (accessLevel === "denied") {
    return { access_level: "denied" as const, conversation_id: null };
  }

  return {
    access_level: accessLevel,
    conversation_id: conversation._id.toString(),
  };
}

export const resolveConversation = query({
  args: { id: v.string(), share_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    return resolveConversationForViewer(ctx, args.id, authUserId, args.share_token);
  },
});

export const getSessionLinks = mutation({
  args: {
    session_id: v.string(),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      return { error: "Unauthorized" };
    }

    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .filter((q) => q.eq(q.field("user_id"), authUserId))
      .first();

    if (!conversation) {
      return { error: "Session not found" };
    }

    let shareToken = conversation.share_token;
    if (!shareToken) {
      shareToken = generateShareToken();
      await ctx.db.patch(conversation._id, { share_token: shareToken });
    }

    return {
      conversation_id: conversation._id,
      share_token: shareToken,
      title: conversation.title,
      slug: conversation.slug,
      started_at: conversation.started_at,
    };
  },
});

export const searchForCLI = query({
  args: {
    api_token: v.string(),
    query: v.string(),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
    start_time: v.optional(v.number()),
    end_time: v.optional(v.number()),
    context_before: v.optional(v.number()),
    context_after: v.optional(v.number()),
    project_path: v.optional(v.string()),
    user_only: v.optional(v.boolean()),
    team_id: v.optional(v.id("teams")),
    member_name: v.optional(v.string()),
    mine_only: v.optional(v.boolean()),
    label: v.optional(v.string()),
    titles_only: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      return { error: "Unauthorized" };
    }
    const user = await ctx.db.get(authUserId);
    if (!user) {
      return { error: "User not found" };
    }

    let labelConvIds: Set<string> | null = null;
    if (args.label) {
      const resolved = await resolveLabelConvIds(ctx, authUserId, args.label);
      if ("error" in resolved) return { error: resolved.error };
      labelConvIds = resolved.convIds;
    }

    const userMemberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
      .collect();
    const userTeamIds = userMemberships.map(m => m.team_id);
    if (args.team_id && !userTeamIds.some((id) => String(id) === String(args.team_id))) {
      return { error: "Unauthorized team" };
    }

    let resolvedTeamId: Id<"teams"> | undefined;
    if (args.team_id) {
      resolvedTeamId = args.team_id;
    } else if (args.project_path) {
      const mappings = await ctx.db
        .query("directory_team_mappings")
        .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
        .collect();
      let bestMatch: { teamId: Id<"teams">; pathLength: number } | null = null;
      for (const mapping of mappings) {
        if (args.project_path === mapping.path_prefix || args.project_path.startsWith(mapping.path_prefix + "/")) {
          if (!bestMatch || mapping.path_prefix.length > bestMatch.pathLength) {
            bestMatch = { teamId: mapping.team_id, pathLength: mapping.path_prefix.length };
          }
        }
      }
      resolvedTeamId = bestMatch?.teamId;
    }
    const effectiveTeamIds = resolvedTeamId ? [resolvedTeamId] : userTeamIds;

    type UserDoc = NonNullable<Awaited<ReturnType<typeof ctx.db.get<"users">>>>;
    const allTeamUsers: UserDoc[] = [];
    for (const teamId of effectiveTeamIds) {
      const teamMemberships = await ctx.db
        .query("team_memberships")
        .withIndex("by_team_id", (q) => q.eq("team_id", teamId))
        .collect();
      const memberUsers = await Promise.all(
        teamMemberships.map(m => ctx.db.get(m.user_id))
      );
      allTeamUsers.push(...memberUsers.filter((u): u is UserDoc => u !== null));
    }
    const teamUsers = [...new Map(allTeamUsers.map(u => [u._id.toString(), u])).values()];
    const teamUserIds = new Set(teamUsers.map(u => u._id.toString()));
    const teamUserMap = new Map(teamUsers.map(u => [u._id.toString(), u]));
    const effectiveTeamIdSet = new Set(effectiveTeamIds.map(id => id.toString()));

    const cliFeedFilters = new Map<string, Awaited<ReturnType<typeof createTeamFeedFilter>>>();
    for (const teamId of effectiveTeamIds) {
      cliFeedFilters.set(teamId.toString(), await createTeamFeedFilter(ctx, teamId));
    }

    let filterUserId: string | null = null;
    if (args.mine_only) {
      filterUserId = authUserId.toString();
    } else if (args.member_name) {
      const memberNameLower = args.member_name.toLowerCase();
      const matchingMember = teamUsers.find(u => {
        const name = u.name?.toLowerCase() || "";
        const email = u.email?.toLowerCase() || "";
        return name.includes(memberNameLower) || email.includes(memberNameLower);
      });
      if (!matchingMember) {
        return { error: `No team member found matching "${args.member_name}"` };
      }
      filterUserId = matchingMember._id.toString();
    }

    const searchTerm = args.query.trim();
    if (!searchTerm || searchTerm.length < 2) {
      return { error: "Query must be at least 2 characters" };
    }

    const limit = args.limit ?? 10;
    const offset = args.offset ?? 0;
    const startTime = args.start_time;
    const endTime = args.end_time ?? Date.now();
    const contextBefore = args.context_before ?? 0;
    const contextAfter = args.context_after ?? 0;
    const projectPath = args.project_path;
    const userOnly = args.user_only ?? false;
    const terms = parseSearchTerms(searchTerm);

    // Shared by the message-match path and the titles_only path: every filter
    // that decides whether a conversation is in scope for this caller.
    const isEligibleConv = (conv: any): boolean => {
      const isOwn = conv.user_id.toString() === authUserId.toString();
      if (!isOwn) {
        if (!conv.team_id || !effectiveTeamIdSet.has(conv.team_id.toString())) return false;
        const cliFilter = cliFeedFilters.get(conv.team_id.toString());
        if (!cliFilter || !cliFilter.isVisible(conv)) return false;
        if (!teamUserIds.has(conv.user_id.toString())) return false;
      } else if (resolvedTeamId) {
        // Own sessions: filter by team when team is resolved from directory
        const convTeamId = (conv.team_id ?? conv.active_team_id)?.toString();
        if (!convTeamId || !effectiveTeamIdSet.has(convTeamId)) return false;
      }

      // Filter by specific member (or self via --mine)
      if (filterUserId && conv.user_id.toString() !== filterUserId) return false;

      // Filter to sessions the caller filed under the given label —
      // project-bounded by default (the CLI passes cwd unless -g).
      if (labelConvIds) {
        if (!labelConvIds.has(conv._id.toString())) return false;
        if (projectPath && !(projectOverlaps(projectPath, conv.project_path) || projectOverlaps(projectPath, conv.git_root))) return false;
      }

      if (startTime && conv.updated_at < startTime) return false;
      if (endTime && conv.updated_at > endTime) return false;
      return true;
    };

    // titles_only: the reliable half of search — only the conversation-table
    // indexes (title/subtitle/idle_summary), never the messages full-text
    // index, which blows the read budget on common tokens (see the
    // fetchMessageSearchPool NOTE). The CLI retries with this after a content
    // search dies, so agents get title/summary hits instead of a hard error.
    if (args.titles_only) {
      const hits = await fetchTitleFieldHits(ctx, terms);
      const visibleConvs = [...hits.values()]
        .filter(isEligibleConv)
        .sort((a, b) => b.updated_at - a.updated_at);
      const page = visibleConvs.slice(offset, offset + limit);
      const firstMsgByConv = await resolveFirstMessageTitles(ctx, page);
      const conversations = page.map((conv) => {
        const isOwnConv = conv.user_id.toString() === authUserId.toString();
        const owner = teamUserMap.get(conv.user_id.toString()) || (isOwnConv ? user : null);
        const title = conv.title
          || firstMsgByConv.get(conv._id.toString())
          || (conv.slug ? formatSlugAsTitle(conv.slug) : null)
          || "New Session";
        return {
          id: conv.short_id || conv._id.toString().slice(0, 7),
          title,
          project_path: conv.project_path || null,
          updated_at: new Date(conv.updated_at).toISOString(),
          message_count: conv.message_count || 0,
          proximityScore: 0,
          coverage: 1,
          user: !isOwnConv && owner ? { name: owner.name || null, email: owner.email || null } : undefined,
          ...(conv.recent_files && conv.recent_files.length > 0 ? { recent_files: conv.recent_files } : {}),
          ...((conv as any).worktree_name &&
          (conv as any).worktree_status !== "merged" &&
          (conv as any).worktree_status !== "archived"
            ? { worktree: (conv as any).worktree_name }
            : {}),
          matches: [],
          context: [],
          title_match: true,
        };
      });
      return {
        total_matches: 0,
        conversations,
        search_scope: projectPath || "global",
        titles_only: true,
      };
    }

    const { pool: searchResults } = await fetchMessageSearchPool(ctx, terms, {
      userId: authUserId,
      teamIds: effectiveTeamIds,
    });

    // Group messages by conversation (keep messages matching ANY term for context)
    const conversationMessages = new Map<string, typeof searchResults>();
    for (const msg of searchResults) {
      if (userOnly && msg.role !== "user") continue;
      if (!contentMatchesAnyTerm(msg.content || "", terms)) {
        continue;
      }
      const convId = msg.conversation_id.toString();
      if (!conversationMessages.has(convId)) {
        conversationMessages.set(convId, []);
      }
      conversationMessages.get(convId)!.push(msg);
    }

    // Best-coverage selection: full-coverage conversations first, then partial
    // matches for longer queries, so a natural-language task description degrades
    // to best-match instead of no-match. Quoted phrases stay required.
    const rankedMatches = rankConversationsByCoverage(conversationMessages, terms);

    const results: Array<{
      id: string;
      title: string;
      project_path: string | null;
      updated_at: string;
      message_count: number;
      proximityScore: number;
      coverage: number;
      user?: { name: string | null; email: string | null };
      recent_files?: string[];
      worktree?: string;
      machine?: string;
      matches: Array<{
        line: number;
        role: string;
        content: string;
        timestamp: string;
      }>;
      context: Array<{
        line: number;
        role: string;
        content: string;
      }>;
      title_match?: boolean;
    }> = [];

    // Device labels resolved once per (runner, device) pair across the result set.
    const searchDeviceLabels = new Map<string, string | undefined>();

    let totalMatches = 0;

    // Hydrate candidate conversations in parallel (a serial await per candidate
    // was a major latency source), then apply the sync filters before any
    // further reads. Bounded to the best candidates — coverage order means the
    // tail is the weakest matches anyway. The label filter applies before the
    // bound: it's keyed by conversation id alone, and a small labeled set would
    // otherwise vanish whenever it falls outside the top candidates.
    const lci = labelConvIds;
    const rankedEligible = lci
      ? rankedMatches.filter((r) => lci.has(r.convId))
      : rankedMatches;
    const candidates = rankedEligible.slice(0, Math.max(50, offset + limit * 3));
    const hydratedConvs = await Promise.all(
      candidates.map(({ messages }) => ctx.db.get(messages[0].conversation_id))
    );
    const eligible: Array<{ conv: any; messages: typeof searchResults; coverage: number }> = [];
    candidates.forEach(({ messages, coverage }, i) => {
      const conv = hydratedConvs[i] as any;
      if (!conv) return;
      if (!isEligibleConv(conv)) return;
      eligible.push({ conv, messages, coverage });
    });

    const page = eligible.slice(offset, offset + limit);

    // Title-fallback first messages only for the returned page, in parallel.
    const pageFirstMessages = await Promise.all(
      page.map(({ conv }) =>
        ctx.db
          .query("messages")
          .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
          .order("asc")
          .take(20)
      )
    );

    for (let pageIdx = 0; pageIdx < page.length; pageIdx++) {
      const { conv, messages, coverage } = page[pageIdx];
      const firstMessages = pageFirstMessages[pageIdx];

      let firstUserMessage = "";
      for (const msg of firstMessages) {
        const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
        if (msg.role === "user" && !hasToolResults) {
          const text = msg.content?.trim();
          if (text) {
            firstUserMessage = text.slice(0, 120);
            if (text.length > 120) firstUserMessage += "...";
            break;
          }
        }
      }

      const title = conv.title
        || firstUserMessage
        || (conv.slug ? formatSlugAsTitle(conv.slug) : null)
        || "New Session";

      const matchedMessages = messages.slice(0, 5);
      totalMatches += matchedMessages.length;

      // For CLI search, we estimate line numbers without fetching all messages
      // Line numbers are approximate (based on message order in matches)
      const messageIdToLine = new Map<string, number>();
      matchedMessages.forEach((m, idx) => {
        // Use index + 1 as approximate line number for display
        // Exact line numbers would require fetching all messages which hits read limits
        messageIdToLine.set(m._id.toString(), idx + 1);
      });

      // Extract snippets around matches (same logic as web search)
      const formattedMatches = matchedMessages.map((m) => {
        const content = m.content || "";
        const lowerContent = content.toLowerCase();

        // Find best position to show snippet around
        let bestIdx = -1;
        for (const term of terms.all) {
          const idx = lowerContent.indexOf(term);
          if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
            bestIdx = idx;
          }
        }

        // Extract ~300 char snippet around match
        const start = Math.max(0, bestIdx > -1 ? bestIdx - 80 : 0);
        const end = Math.min(content.length, bestIdx > -1 ? bestIdx + 220 : 300);
        let snippet = content.slice(start, end);
        if (start > 0) snippet = "..." + snippet;
        if (end < content.length) snippet = snippet + "...";

        return {
          line: messageIdToLine.get(m._id.toString()) || 0,
          role: m.role,
          content: snippet,
          timestamp: new Date(m.timestamp).toISOString(),
          tool_calls_count: m.tool_calls_count,
          tool_results_count: m.tool_results_count,
        };
      });

      // Sort matches by line number (chronological order)
      formattedMatches.sort((a, b) => a.line - b.line);

      const proximityScore = calculateProximityScore(messages, terms);

      const owner = teamUserMap.get(conv.user_id.toString()) || (conv.user_id.toString() === authUserId.toString() ? user : null);
      const isOwnConv = conv.user_id.toString() === authUserId.toString();

      // Location signals, so a search hit says WHERE the session works before
      // anyone attributes edits to it (same fields as the feed card).
      let machineLabel: string | undefined;
      const devId = (conv as any).owner_device_id as string | undefined;
      if (devId) {
        const devKey = `${conv.user_id.toString()}:${devId}`;
        if (!searchDeviceLabels.has(devKey)) {
          const device = await ctx.db
            .query("devices")
            .withIndex("by_user_device", (q: any) => q.eq("user_id", conv.user_id).eq("device_id", devId))
            .first();
          searchDeviceLabels.set(devKey, device?.label);
        }
        machineLabel = searchDeviceLabels.get(devKey) ?? undefined;
      }

      results.push({
        id: conv.short_id || conv._id.toString().slice(0, 7),
        title,
        project_path: conv.project_path || null,
        updated_at: new Date(conv.updated_at).toISOString(),
        message_count: conv.message_count || 0,
        proximityScore,
        coverage,
        user: !isOwnConv && owner ? { name: owner.name || null, email: owner.email || null } : undefined,
        ...(conv.recent_files && conv.recent_files.length > 0 ? { recent_files: conv.recent_files } : {}),
        ...((conv as any).worktree_name &&
        (conv as any).worktree_status !== "merged" &&
        (conv as any).worktree_status !== "archived"
          ? { worktree: (conv as any).worktree_name }
          : {}),
        ...(machineLabel ? { machine: machineLabel } : {}),
        matches: formattedMatches,
        context: [],
      });
    }

    // Sort by term coverage (full matches first), then proximity (lower =
    // better), then recency.
    results.sort((a, b) => {
      if (a.coverage !== b.coverage) {
        return b.coverage - a.coverage;
      }
      if (a.proximityScore !== b.proximityScore) {
        return a.proximityScore - b.proximityScore;
      }
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });

    // A dated window usually points at history the content mirror no longer
    // holds (it only covers the last CONTENT_WINDOW_DAYS days), so a windowed
    // search also sweeps the title/subtitle/summary indexes — those live on
    // the conversations table and reach all time. Title hits rank below every
    // content hit and only fill seats the content page left open.
    let windowTitleRows: typeof results = [];
    const hasTimeWindow = args.start_time !== undefined || args.end_time !== undefined;
    if (hasTimeWindow) {
      const titleHits = await fetchTitleFieldHits(ctx, terms);
      const contentIds = new Set(eligible.map(({ conv }) => conv._id.toString()));
      const titleConvs = [...titleHits.values()]
        .filter((c) => !contentIds.has(c._id.toString()))
        .filter(isEligibleConv)
        .sort((a, b) => b.updated_at - a.updated_at);
      // Content pages consume the offset first; title rows page through once
      // the content matches are exhausted.
      const titleOffset = Math.max(0, offset - eligible.length);
      const fill = Math.max(0, limit - page.length);
      const titlePage = titleConvs.slice(titleOffset, titleOffset + fill);
      const firstMsgByConv = await resolveFirstMessageTitles(ctx, titlePage);
      windowTitleRows = titlePage.map((conv) => {
        const isOwnConv = conv.user_id.toString() === authUserId.toString();
        const owner = teamUserMap.get(conv.user_id.toString()) || (isOwnConv ? user : null);
        const title = conv.title
          || firstMsgByConv.get(conv._id.toString())
          || (conv.slug ? formatSlugAsTitle(conv.slug) : null)
          || "New Session";
        return {
          id: conv.short_id || conv._id.toString().slice(0, 7),
          title,
          project_path: conv.project_path || null,
          updated_at: new Date(conv.updated_at).toISOString(),
          message_count: conv.message_count || 0,
          proximityScore: 0,
          coverage: 0,
          user: !isOwnConv && owner ? { name: owner.name || null, email: owner.email || null } : undefined,
          ...(conv.recent_files && conv.recent_files.length > 0 ? { recent_files: conv.recent_files } : {}),
          ...((conv as any).worktree_name &&
          (conv as any).worktree_status !== "merged" &&
          (conv as any).worktree_status !== "archived"
            ? { worktree: (conv as any).worktree_name }
            : {}),
          matches: [],
          context: [],
          title_match: true,
        };
      });
    }

    const windowPredatesContent =
      args.start_time !== undefined && args.start_time < Date.now() - MIRROR_WINDOW_MS;
    return {
      total_matches: totalMatches,
      conversations: [...results, ...windowTitleRows].slice(0, limit),
      search_scope: projectPath || "global",
      // Tells the CLI to explain that content matches can't reach the
      // requested window, so title hits are the reliable signal there.
      ...(windowPredatesContent ? { content_window_days: CONTENT_WINDOW_DAYS } : {}),
    };
  },
});

// Reactive tail of a conversation's recent messages, for `cast sessions -w
// --messages` via ConvexClient.onUpdate (live push, no polling). Bounded take on
// by_conversation_timestamp so a new message re-runs cheaply and pushes the
// updated tail; the CLI dedupes by message_uuid. api_token authed; resolves a
// short or full conversation id; same team-access check as readConversationMessages.
export const conversationMessagesForCLI = query({
  args: {
    api_token: v.string(),
    conversation_id: v.string(),
    limit: v.optional(v.number()),
    full_content: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserIdReadOnly(ctx, args.api_token);
    if (!authUserId) return { error: "Unauthorized" };

    const conv = await resolveConversationRef(ctx, args.conversation_id, authUserId);
    if (!conv) return { error: "Conversation not found" };

    if (!(await canOwnerOrTeamAccess(ctx, authUserId, conv))) {
      return { error: "Access denied" };
    }

    const limit = Math.min(Math.max(args.limit ?? 30, 1), 100);
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", conv._id))
      .order("desc")
      .take(limit * 2 + 20);
    const tail = recent.filter(isNonEmptyMessage).slice(0, limit).reverse();
    const inputCap = args.full_content ? 100000 : 500;
    const resultCap = args.full_content ? 100000 : 1000;

    return {
      conversation: { id: conv._id, title: conv.title || "New Session", message_count: conv.message_count || 0 },
      messages: tail.map((m: any) => ({
        role: m.role,
        content: m.content || "",
        timestamp: new Date(m.timestamp).toISOString(),
        message_uuid: m.message_uuid || undefined,
        tool_calls: m.tool_calls?.map((tc: any) => ({ id: tc.id, name: tc.name, input: (tc.input || "").slice(0, inputCap) })),
        tool_results: m.tool_results?.map((tr: any) => ({ tool_use_id: tr.tool_use_id, content: (tr.content || "").slice(0, resultCap), is_error: tr.is_error })),
      })),
    };
  },
});

export const readConversationMessages = query({
  args: {
    api_token: v.string(),
    conversation_id: v.string(),
    start_line: v.optional(v.number()),
    end_line: v.optional(v.number()),
    full_content: v.optional(v.boolean()),
    // Anchor the window on a specific message (its Convex _id, as in the web's
    // `#msg-<id>` share links). When set without an explicit range, the result
    // is a window of `context` messages on each side of the anchor.
    around_message_id: v.optional(v.string()),
    context: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserIdReadOnly(ctx, args.api_token);
    if (!authUserId) {
      return { error: "Unauthorized" };
    }
    const user = await ctx.db.get(authUserId);
    if (!user) {
      return { error: "User not found" };
    }

    const conv = await resolveConversationRef(ctx, args.conversation_id, authUserId);
    if (!conv) {
      return { error: "Conversation not found" };
    }

    // Check access - user can see their own conversations, or non-private
    // conversations from team members
    if (!(await canOwnerOrTeamAccess(ctx, authUserId, conv))) {
      return { error: "Access denied" };
    }

    const firstMessages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
      .order("asc")
      .take(10);

    let firstUserMessage = "";
    for (const msg of firstMessages) {
      const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
      if (msg.role === "user" && !hasToolResults) {
        const text = msg.content?.trim();
        if (text) {
          firstUserMessage = text.slice(0, 120);
          if (text.length > 120) firstUserMessage += "...";
          break;
        }
      }
    }

    const title = conv.title
      || firstUserMessage
      || (conv.slug ? formatSlugAsTitle(conv.slug) : null)
      || "New Session";

    // Get all messages and filter out empty ones (streaming artifacts)
    const allMessages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
      .order("asc")
      .collect();

    const nonEmptyMessages = allMessages.filter(isNonEmptyMessage);

    const nonEmptyCount = nonEmptyMessages.length;

    // When anchored to a specific message (e.g. from a #msg-<id> share link),
    // resolve it to a line number so we can center the window on it. The id is
    // the message's Convex _id, matching the web's `msg-<_id>` DOM anchors.
    let targetLine: number | undefined;
    let targetMissing = false;
    if (args.around_message_id) {
      let targetIdx = nonEmptyMessages.findIndex((m) => m._id === args.around_message_id);
      if (targetIdx < 0) {
        // The anchored message may have been filtered out as empty — snap to the
        // nearest visible message so the window still lands in the right place.
        const rawIdx = allMessages.findIndex((m) => m._id === args.around_message_id);
        if (rawIdx >= 0) {
          let before = 0;
          for (let i = 0; i < rawIdx; i++) {
            if (isNonEmptyMessage(allMessages[i])) before++;
          }
          targetIdx = Math.min(before, nonEmptyCount - 1);
        }
      }
      if (targetIdx >= 0) targetLine = targetIdx + 1;
      else targetMissing = true;
    }

    let startLine: number;
    let endLine: number;
    if (targetLine !== undefined && args.start_line === undefined && args.end_line === undefined) {
      // Window of `context` messages on each side of the anchor, clamped to 24 so
      // the anchor always stays inside the 50-message cap enforced below.
      const ctxN = Math.min(24, Math.max(0, args.context ?? 10));
      startLine = Math.max(1, targetLine - ctxN);
      endLine = Math.min(nonEmptyCount, targetLine + ctxN);
    } else {
      startLine = args.start_line ?? 1;
      endLine = args.end_line ?? Math.min(nonEmptyCount, 20);
    }

    const startIdx = Math.max(0, startLine - 1);
    const count = Math.min(endLine - startLine + 1, 50);

    const slicedMessages = nonEmptyMessages.slice(startIdx, startIdx + count);

    const fullContent = args.full_content === true;

    const messages = slicedMessages.map((m, idx) => {
      const truncateToolCalls = (calls: typeof m.tool_calls) => {
        if (!calls) return undefined;
        return calls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          input: fullContent ? tc.input : (tc.input && tc.input.length > 500 ? tc.input.slice(0, 500) + "..." : tc.input),
        }));
      };

      const truncateToolResults = (results: typeof m.tool_results) => {
        if (!results) return undefined;
        return results.map((tr) => ({
          tool_use_id: tr.tool_use_id,
          content: fullContent ? tr.content : (tr.content && tr.content.length > 1000 ? tr.content.slice(0, 1000) + "..." : tr.content),
          is_error: tr.is_error,
        }));
      };

      return {
        // The message's Convex _id — the anchor the web's `#msg-<id>` deep links
        // use, so `cast link` can mint a resolvable permalink to a line that
        // `cast read` just showed.
        id: m._id,
        line: startIdx + idx + 1,
        role: m.role,
        content: m.content || "",
        timestamp: new Date(m.timestamp).toISOString(),
        message_uuid: m.message_uuid || undefined,
        tool_calls: truncateToolCalls(m.tool_calls),
        tool_results: truncateToolResults(m.tool_results),
      };
    });

    return {
      conversation: {
        id: conv._id,
        title,
        agent_type: conv.agent_type || "claude_code",
        project_path: conv.project_path || null,
        message_count: nonEmptyCount,
        updated_at: new Date(conv.updated_at).toISOString(),
      },
      messages,
      // Line of the anchored message (1-based) so callers can highlight it.
      target_line: targetLine,
      target_message_id: targetLine !== undefined ? args.around_message_id : undefined,
      target_missing: targetMissing || undefined,
    };
  },
});

export const exportConversationMessages = query({
  args: {
    api_token: v.string(),
    conversation_id: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserIdReadOnly(ctx, args.api_token);
    if (!authUserId) {
      return { error: "Unauthorized" };
    }
    const user = await ctx.db.get(authUserId);
    if (!user) {
      return { error: "User not found" };
    }

    const conv = await resolveConversationRef(ctx, args.conversation_id, authUserId);
    if (!conv) {
      return { error: "Conversation not found" };
    }

    if (!(await canOwnerOrTeamAccess(ctx, authUserId, conv))) {
      return { error: "Access denied" };
    }

    const allMessages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
      .order("asc")
      .collect();

    const nonEmptyMessages = allMessages.filter(isNonEmptyMessage);

    return {
      conversation: {
        id: conv._id,
        title: conv.title || "New Session",
        session_id: conv.session_id,
        agent_type: conv.agent_type,
        project_path: conv.project_path || null,
        git_root: conv.git_root || null,
        git_remote_url: conv.git_remote_url || null,
        model: conv.model || null,
        message_count: nonEmptyMessages.length,
        started_at: new Date(conv.started_at).toISOString(),
        updated_at: new Date(conv.updated_at).toISOString(),
      },
      messages: nonEmptyMessages.map((m) => ({
        role: m.role,
        content: m.content || "",
        thinking: m.thinking || undefined,
        timestamp: new Date(m.timestamp).toISOString(),
        message_uuid: m.message_uuid || undefined,
        tool_calls: m.tool_calls,
        tool_results: m.tool_results,
        subtype: m.subtype || undefined,
      })),
    };
  },
});

export const exportConversationMessagesPage = query({
  args: {
    api_token: v.string(),
    conversation_id: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserIdReadOnly(ctx, args.api_token);
    if (!authUserId) {
      return { error: "Unauthorized" };
    }
    const user = await ctx.db.get(authUserId);
    if (!user) {
      return { error: "User not found" };
    }

    const conv = await resolveConversationRef(ctx, args.conversation_id, authUserId);
    if (!conv) {
      return { error: "Conversation not found" };
    }

    if (!(await canOwnerOrTeamAccess(ctx, authUserId, conv))) {
      return { error: "Access denied" };
    }

    const pageSize = Math.max(1, Math.min(args.limit ?? 500, 1000));
    const page = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
      .order("asc")
      .paginate({ cursor: args.cursor ?? null, numItems: pageSize });

    const messages = page.page
      .filter(isNonEmptyMessage)
      .map((m) => ({
        role: m.role,
        content: m.content || "",
        thinking: m.thinking || undefined,
        timestamp: new Date(m.timestamp).toISOString(),
        message_uuid: m.message_uuid || undefined,
        tool_calls: m.tool_calls,
        tool_results: m.tool_results,
        subtype: m.subtype || undefined,
      }));

    return {
      conversation: {
        id: conv._id,
        title: conv.title || "New Session",
        session_id: conv.session_id,
        agent_type: conv.agent_type,
        project_path: conv.project_path || null,
        git_root: conv.git_root || null,
        git_remote_url: conv.git_remote_url || null,
        model: conv.model || null,
        message_count: conv.message_count || 0,
        started_at: new Date(conv.started_at).toISOString(),
        updated_at: new Date(conv.updated_at).toISOString(),
      },
      messages,
      next_cursor: page.isDone ? null : page.continueCursor,
      done: page.isDone,
    };
  },
});

export const updateTitle = mutation({
  args: {
    conversation_id: v.id("conversations"),
    title: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }

    // Team WRITE access follows real visibility, not the routing team — a
    // member of a private session's routing team must not rename it.
    if (!(await canOwnerOrTeamAccess(ctx, authUserId, conversation))) {
      throw new Error("Unauthorized: can only update your own conversations");
    }

    if (!conversation.title_is_custom) {
      await ctx.db.patch(args.conversation_id, {
        title: args.title,
      });
    }

    if (args.api_token) {
      await ctx.db.patch(conversation.user_id, {
        daemon_last_seen: Date.now(),
      });
    }
  },
});

export const setAvailableSkills = mutation({
  args: {
    conversation_id: v.optional(v.id("conversations")),
    skills: v.string(),
    project_path: v.optional(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) return;
    const user = await ctx.db.get(authUserId);
    if (!user) return;
    const key = args.project_path || "global";
    // Skills live in user_skills, not on the users doc (see schema note): the
    // users doc is heartbeat-hot and versioning the whole map per patch was the
    // single biggest source of DB bloat. Seed from the side table, falling back
    // to the legacy on-doc field for users who haven't written since the split.
    const skillsRow = await ctx.db
      .query("user_skills")
      .withIndex("by_user", (q) => q.eq("user_id", authUserId))
      .first();
    let skillsMap: Record<string, any> = {};
    const seedJson = skillsRow?.skills_json ?? user.available_skills;
    if (seedJson) {
      try {
        const parsed = JSON.parse(seedJson);
        skillsMap = Array.isArray(parsed) ? { global: parsed } : parsed;
      } catch {}
    }
    skillsMap[key] = JSON.parse(args.skills);
    const skillsJson = JSON.stringify(skillsMap);
    if (skillsRow) {
      await ctx.db.patch(skillsRow._id, { skills_json: skillsJson, updated_at: Date.now() });
    } else {
      await ctx.db.insert("user_skills", { user_id: authUserId, skills_json: skillsJson, updated_at: Date.now() });
    }
    // One-time diet per user: shed the legacy blob so future heartbeat patches
    // stop re-versioning it.
    if (user.available_skills !== undefined) {
      await ctx.db.patch(authUserId, { available_skills: undefined });
    }
    // Deliberately NOT stamped on the conversation doc: nothing reads
    // conversations.available_skills (getConversationWithMeta strips it, the
    // web reads currentUser.available_skills), and at ~10KB per session it was
    // 60% of every inbox scan's bytes. conversation_id stays accepted so older
    // daemons keep working; the legacy field is shed by the doc diet sweep.
  },
});

export const updateProjectPath = mutation({
  args: {
    session_id: v.string(),
    project_path: v.string(),
    git_root: v.optional(v.string()),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed");
    }

    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .filter((q) => q.eq(q.field("user_id"), authUserId))
      .first();

    if (!conversation) {
      return { updated: false };
    }

    if (conversation.project_path === args.project_path && (!args.git_root || conversation.git_root === args.git_root)) {
      return { updated: false };
    }

    const patch: Record<string, any> = { project_path: args.project_path };
    if (args.git_root) {
      patch.git_root = args.git_root;
    }

    // The path is being stamped after creation (pre-warmed/stub conversations
    // are born pathless → private+teamless), so re-resolve team/privacy the
    // way creation would have. Explicit user choices win inside the helper.
    const mappings = await ctx.db
      .query("directory_team_mappings")
      .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
      .collect();
    const restamp = buildPathRestampUpdate(
      conversation,
      mappings,
      args.git_root || args.project_path
    );
    if (restamp) Object.assign(patch, restamp);

    // A restamp can flip visibility (born-blank → team-shared), so linked
    // work items must follow; a plain path patch has nothing to propagate.
    if (restamp) await patchConversationVisibility(ctx, conversation, patch);
    else await ctx.db.patch(conversation._id, patch);

    return { updated: true, id: conversation._id };
  },
});

export const setSkipTitleGeneration = mutation({
  args: {
    conversation_id: v.id("conversations"),
    skip: v.boolean(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication failed: invalid token or session");
    }

    // Team WRITE access follows real visibility, not the routing team — a
    // member of a private session's routing team must not rename it.
    if (!(await canOwnerOrTeamAccess(ctx, authUserId, conversation))) {
      throw new Error("Unauthorized: can only update your own conversations");
    }

    await ctx.db.patch(args.conversation_id, {
      skip_title_generation: args.skip,
    });

    if (args.api_token) {
      await ctx.db.patch(conversation.user_id, {
        daemon_last_seen: Date.now(),
      });
    }
  },
});

export const listPrivateConversations = query({
  args: {
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Unauthorized: valid API token required");
    }

    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
      .filter((q) => q.eq(q.field("is_private"), true))
      .collect();

    const result = await Promise.all(
      conversations.map(async (c) => {
        const messages = await ctx.db
          .query("messages")
          .withIndex("by_conversation_id", (q) => q.eq("conversation_id", c._id))
          .order("asc")
          .take(20);

        let firstUserMessage = "";
        for (const msg of messages) {
          const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
          if (msg.role === "user" && !hasToolResults) {
            const text = msg.content?.trim();
            if (text) {
              firstUserMessage = text.slice(0, 120);
              if (text.length > 120) firstUserMessage += "...";
              break;
            }
          }
        }

        const title = c.title
          || firstUserMessage
          || (c.slug ? formatSlugAsTitle(c.slug) : null)
          || "New Session";

        return {
          conversation_id: c._id,
          session_id: c.session_id,
          title,
          agent_type: c.agent_type,
          started_at: c.started_at,
          updated_at: c.updated_at,
          message_count: c.message_count,
          project_path: c.project_path,
        };
      })
    );

    return result.sort((a, b) => b.updated_at - a.updated_at);
  },
});

export const publishToDirectory = mutation({
  args: {
    conversation_id: v.id("conversations"),
    title: v.string(),
    description: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized: must be logged in");
    }

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    const isOwner = conversation.user_id.toString() === authUserId.toString();
    if (!isOwner) {
      throw new Error("Unauthorized: can only publish your own conversations");
    }

    if (!conversation.share_token) {
      throw new Error("Conversation must be shared before publishing to directory");
    }

    const existingPublic = await ctx.db
      .query("public_conversations")
      .filter((q) => q.eq(q.field("conversation_id"), args.conversation_id))
      .first();

    if (existingPublic) {
      await ctx.db.patch(existingPublic._id, {
        title: args.title,
        description: args.description,
        tags: args.tags,
      });
      return existingPublic._id;
    }

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
      .order("asc")
      .take(10);

    let previewText = "";
    for (const msg of messages) {
      if (msg.role === "user" && msg.content) {
        const text = msg.content.trim();
        if (text) {
          previewText = text.slice(0, 200);
          break;
        }
      }
    }

    if (!previewText) {
      previewText = "No preview available";
    }

    const publicConversationId = await ctx.db.insert("public_conversations", {
      conversation_id: args.conversation_id,
      user_id: conversation.user_id,
      title: args.title,
      description: args.description,
      tags: args.tags,
      preview_text: previewText,
      agent_type: conversation.agent_type,
      message_count: conversation.message_count,
      created_at: Date.now(),
      view_count: 0,
    });

    return publicConversationId;
  },
});

export const listPublicConversations = query({
  args: {
    search: v.optional(v.string()),
    sort: v.optional(v.union(v.literal("recent"), v.literal("popular"))),
    agent_type: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;
    const sort = args.sort ?? "recent";

    let publicConversations = await ctx.db
      .query("public_conversations")
      .collect();

    if (args.agent_type) {
      publicConversations = publicConversations.filter(
        (pc) => pc.agent_type === args.agent_type
      );
    }

    if (args.search && args.search.trim().length > 0) {
      const searchLower = args.search.toLowerCase();
      publicConversations = publicConversations.filter((pc) => {
        const titleMatch = pc.title.toLowerCase().includes(searchLower);
        const descMatch = pc.description?.toLowerCase().includes(searchLower);
        const previewMatch = pc.preview_text.toLowerCase().includes(searchLower);
        return titleMatch || descMatch || previewMatch;
      });
    }

    if (sort === "popular") {
      publicConversations.sort((a, b) => b.view_count - a.view_count);
    } else {
      publicConversations.sort((a, b) => b.created_at - a.created_at);
    }

    const results = await Promise.all(
      publicConversations.slice(0, limit).map(async (pc) => {
        const user = await ctx.db.get(pc.user_id);
        const conversation = await ctx.db.get(pc.conversation_id);

        return {
          _id: pc._id,
          title: pc.title,
          description: pc.description,
          tags: pc.tags,
          preview_text: pc.preview_text,
          agent_type: pc.agent_type,
          message_count: pc.message_count,
          created_at: pc.created_at,
          view_count: pc.view_count,
          author_name: user?.name || user?.email?.split("@")[0] || "Unknown",
          author_avatar: user?.image || user?.github_avatar_url,
          share_token: conversation?.share_token || null,
        };
      })
    );

    return results;
  },
});

// === Chained fork copy ===
//
// A single Convex mutation can write at most ~8192 documents / 16 MB. Large
// conversations would blow past that, so the fork mutations split message
// copying across multiple transactions linked by `scheduler.runAfter(0, ...)`.
//
// The fork target conversation carries the cursor + total + cutoff (see
// schema.ts). The kickoff mutation copies the first batch synchronously
// (so small forks finish in one round-trip), then if more remains schedules
// `_continueFork`, which advances the cursor batch by batch until done.
//
// The per-batch logic lives in forkCopy.ts so it can be unit-tested without
// dragging in Convex's module graph.

// Wraps the Convex MutationCtx in the minimal interface advanceForkCopy needs.
// Keeping this adapter local means forkCopy.ts has no Convex imports and can
// run in plain `bun:test`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeForkCtx(ctx: any): ForkCopyCtx {
  return {
    db: {
      get: (id) => ctx.db.get(id),
      queryMessages: async ({ conversationId, cursorGt, cutoffLte, limit }) => {
        const builder = ctx.db
          .query("messages")
          .withIndex("by_conversation_timestamp", (qq: any) =>
            qq.eq("conversation_id", conversationId as Id<"conversations">)
          )
          .filter((qq: any) =>
            cutoffLte !== undefined
              ? qq.and(qq.gt(qq.field("timestamp"), cursorGt), qq.lte(qq.field("timestamp"), cutoffLte))
              : qq.gt(qq.field("timestamp"), cursorGt)
          );
        return builder.order("asc").take(limit);
      },
      insertMessage: (row) => ctx.db.insert("messages", row),
      insertDaemonCommand: (row) => ctx.db.insert("daemon_commands", row),
      patchConv: (id, patch) => ctx.db.patch(id as Id<"conversations">, patch),
    },
    scheduleContinue: async (forkId) => {
      await ctx.scheduler.runAfter(0, internal.conversations._continueFork, {
        forkId: forkId as Id<"conversations">,
      });
    },
  };
}

export const _continueFork = internalMutation({
  args: { forkId: v.id("conversations") },
  handler: async (ctx, args) => {
    await advanceForkCopy(makeForkCtx(ctx), args.forkId);
  },
});

// A fork continues the same thread of work, so it inherits the FORKER's label
// on the source conversation. Labels are per-user filing (bucket_assignments),
// which makes this naturally correct for foreign sources too: forking someone
// else's session inherits nothing unless you had labeled it yourself. Archived
// labels don't propagate.
async function inheritLabelAssignment(
  ctx: MutationCtx,
  userId: Id<"users">,
  sourceConvId: Id<"conversations">,
  newConvId: Id<"conversations">,
) {
  const sourceAssignment = await ctx.db
    .query("bucket_assignments")
    .withIndex("by_user_conversation", (q: any) =>
      q.eq("user_id", userId).eq("conversation_id", sourceConvId))
    .first();
  if (!sourceAssignment?.bucket_id) return;
  const bucket = await ctx.db.get(sourceAssignment.bucket_id);
  if (!bucket || bucket.archived_at) return;
  await assignConversationToBucketForUser(ctx, userId, newConvId, sourceAssignment.bucket_id);
}

export const forkConversation = mutation({
  args: {
    share_token: v.string(),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized: must be logged in to fork conversations");
    }

    const originalConversations = await ctx.db
      .query("conversations")
      .withIndex("by_share_token", (q) => q.eq("share_token", args.share_token))
      .collect();

    if (originalConversations.length === 0) {
      throw new Error("Conversation not found");
    }

    const original = originalConversations[0];

    // The fork is owned by authUserId, a DIFFERENT user than the original's
    // owner. team_id must be resolved under the FORKER's own directory mappings,
    // not copied from the original — otherwise the fork silently carries the
    // original owner's team, and a later share (buildShareUpdate keeps an
    // existing team_id) publishes it to a team the forker may not belong to.
    const { team_id: forkTeamId } = await resolveCreationPrivacy(
      ctx,
      authUserId,
      original.git_root || original.project_path,
    );

    // Trust the denormalized message_count for display; the actual copy is
    // driven by advanceForkCopy walking the source by timestamp cursor and
    // does not need an exact precomputed total.
    const now = Date.now();
    const newConversationId = await ctx.db.insert("conversations", {
      user_id: authUserId,
      team_id: forkTeamId,
      agent_type: original.agent_type,
      session_id: `forked-${original.session_id}-${crypto.randomUUID()}`,
      slug: original.slug,
      title: original.title,
      subtitle: original.subtitle,
      project_hash: original.project_hash,
      project_path: original.project_path,
      model: original.model,
      started_at: now,
      updated_at: now,
      message_count: 0,
      is_private: true,
      status: "completed",
      forked_from: original._id,
      fork_status: "copying",
      fork_copy_total: original.message_count ?? 0,
      fork_copied: 0,
      fork_copy_cursor: 0,
      // Snapshot the source at fork time — new messages added to the source
      // after this point are NOT pulled into the fork. Without this, batches
      // run across separate transactions could accidentally track the
      // source's ongoing activity.
      fork_cutoff_timestamp: now,
    });
    await ctx.db.patch(newConversationId, {
      short_id: newConversationId.toString().slice(0, 7),
    });

    const currentForkCount = original.fork_count ?? 0;
    await ctx.db.patch(original._id, {
      fork_count: currentForkCount + 1,
    });

    await inheritLabelAssignment(ctx, authUserId, original._id, newConversationId);

    // Copy the first batch synchronously so small forks finish in one RTT.
    // If more remains, advanceForkCopy schedules _continueFork to chain
    // subsequent batches as separate transactions.
    await advanceForkCopy(makeForkCtx(ctx), newConversationId);

    return newConversationId;
  },
});

// opencode forks resolve to a REAL session id via the daemon's serve sidecar
// (POST /session/:id/fork). That needs the parent's real ses_ id to fork from, so
// forkFromMessage passes it down only when this is a same-agent opencode fork whose
// parent already has a resolved ses_ id (not itself an unresolved synthetic fork) and
// the client advertises the forkApi capability. Extracted for unit testing.
//
// The atTip / forkMessageId gate is what keeps a PARTIAL fork honest: opencode's serve
// fork always cuts at a messageID (the message after the fork point) — at tip a full
// fork (no messageID) matches the copy, but a mid-history fork that couldn't resolve
// that messageID must NOT go through the API (it would fork the parent's FULL history
// while the copy shows a truncated one); it falls through to the honest blank spawn.
export function opencodeApiForkEligible(opts: {
  isPlainFork: boolean;
  daemonAgentType: string;
  sourceAgentType?: string;
  sourceSessionId?: string;
  atTip: boolean;
  forkMessageId?: string;
}): boolean {
  const base =
    opts.isPlainFork &&
    opts.daemonAgentType === "opencode" &&
    opts.sourceAgentType === "opencode" &&
    typeof opts.sourceSessionId === "string" &&
    opts.sourceSessionId.startsWith("ses_") &&
    AGENT_CLIENTS.opencode.capabilities.forkApi === true;
  if (!base) return false;
  return opts.atTip || !!opts.forkMessageId;
}

export const forkFromMessage = mutation({
  args: {
    conversation_id: v.string(),
    message_uuid: v.optional(v.string()),
    api_token: v.optional(v.string()),
    session_id: v.optional(v.string()),
    // The branch's seed prompt (cast fork "<direction>"). Used ONLY to title the
    // new row — sibling branches otherwise all read "Fork: <parent title>" and
    // are indistinguishable in the inbox (the direction itself arrives later as
    // a separate seed message).
    direction: v.optional(v.string()),
    target_agent_type: v.optional(v.union(
      v.literal("claude_code"),
      v.literal("codex"),
      v.literal("cursor"),
      v.literal("gemini"),
      v.literal("opencode"),
      v.literal("pi"),
      v.literal("grok")
    )),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) {
      throw new Error("Unauthorized");
    }

    const original = await resolveConversationRef(ctx, args.conversation_id, userId);
    if (!original) {
      throw new Error("Conversation not found");
    }

    if (!(await canOwnerOrTeamAccess(ctx, userId, original))) {
      throw new Error("Access denied");
    }

    // Idempotency on the client-supplied session_id. The fork command rides the
    // dispatch outbox, which is at-least-once: dispatchWithRetry resends the
    // SAME args (session_id included) on any client-side error, and the outbox
    // re-drives on reconnect. Without this guard a delivery that succeeded
    // server-side but lost its response spawns a SECOND full-copy fork under the
    // same session_id — the user works in one and the other is left as an empty
    // "Fork: …" branch. Returning the existing row collapses every redelivery
    // onto one conversation; the indexed read makes Convex's OCC serialize a
    // truly-concurrent pair (the loser retries and finds the winner's insert).
    if (args.session_id) {
      const existing = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id!))
        .filter((q) => q.eq(q.field("user_id"), userId))
        .first();
      if (existing) {
        return {
          conversation_id: existing._id,
          short_id: existing.short_id ?? existing._id.toString().slice(0, 7),
        };
      }
    }

    // Resolve cutoff (for partial forks) without scanning the source. The
    // denormalized message_count on the conversation gives us an upper-bound
    // estimate for display; we don't need an exact total to drive the copy
    // chain (advanceForkCopy walks until the source runs dry). Avoiding a
    // full-source scan here is what keeps the kickoff mutation under
    // Convex's per-transaction read limit for huge conversations.
    const now = Date.now();

    // The fork is a snapshot at this moment in time. Partial forks cap at the
    // fork-point message's timestamp; full / agent-switch forks cap at "now"
    // so messages added to the source after fork-time aren't pulled in by
    // subsequent batches.
    let cutoffTimestamp: number;
    let isPartial = false;
    let atTip = true; // no fork point = snapshot at "now" = the tip
    // opencode's serve fork truncates to the state STRICTLY BEFORE a messageID
    // (verified live), while our copy is INCLUSIVE of the fork point
    // (timestamp <= cutoff). So to make the live opencode session hold exactly the
    // copied messages, it must fork at the message immediately AFTER the fork point.
    // Resolved only for opencode partial forks; undefined at tip (a full fork, no
    // messageID, already matches).
    let opencodeForkMessageId: string | undefined;
    if (args.message_uuid) {
      // Scope the lookup to THIS conversation. Forks copy messages verbatim,
      // preserving message_uuid (forkCopy.ts), so a given uuid exists in the
      // original AND every fork of it — the global by_message_uuid index is
      // non-unique and .first() can return another fork's copy, spuriously
      // failing the conversation match. by_conversation_uuid resolves the
      // message within `original` directly.
      const forkPointMsg = await ctx.db
        .query("messages")
        .withIndex("by_conversation_uuid", (q) =>
          q.eq("conversation_id", original._id).eq("message_uuid", args.message_uuid!))
        .first();
      if (!forkPointMsg) {
        throw new Error("Fork point message not found");
      }
      cutoffTimestamp = forkPointMsg.timestamp;
      isPartial = true;
      // Fork-at-tip: the fork point is the source's newest message, so the
      // fork's history is the source's transcript verbatim — the daemon can
      // copy the local JSONL byte-for-byte (keeping Claude's prompt cache
      // warm) instead of rebuilding from an export.
      const newestMsg = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) =>
          q.eq("conversation_id", original._id))
        .order("desc")
        .first();
      atTip = !!newestMsg && (newestMsg._id === forkPointMsg._id || forkPointMsg.timestamp >= newestMsg.timestamp);
      // The messageID opencode forks at = the first message strictly after the fork
      // point (same timestamp boundary the copy uses, so ties are handled the same
      // way on both sides). For an opencode source only; other agents don't use it.
      if (!atTip && original.agent_type === "opencode") {
        const nextMsg = await ctx.db
          .query("messages")
          .withIndex("by_conversation_timestamp", (q) =>
            q.eq("conversation_id", original._id).gt("timestamp", forkPointMsg.timestamp))
          .order("asc")
          .first();
        opencodeForkMessageId = nextMsg?.message_uuid;
      }
    } else {
      cutoffTimestamp = now;
    }
    // Partial forks: exact total is unknown without a scan, so leave it
    // undefined; the UI shows progress without a denominator in that case.
    // Full forks: trust the denormalized message_count for display.
    const totalToCopy = isPartial ? undefined : (original.message_count ?? 0);

    const isAgentSwitch = !!args.target_agent_type && !args.message_uuid;
    const agentType = args.target_agent_type || original.agent_type;
    const agentLabels: Record<string, string> = { claude_code: "Claude", codex: "Codex", cursor: "Cursor", gemini: "Gemini" };
    const isCrossAgentSwitch = !!args.target_agent_type && args.target_agent_type !== original.agent_type;
    const titlePrefix = isCrossAgentSwitch ? `${agentLabels[args.target_agent_type!] || args.target_agent_type}: ` : "Fork: ";
    const forkSessionId = args.session_id || `forked-${original.session_id}-${crypto.randomUUID()}`;
    // The daemon_command is deferred so it can't race a half-copied fork. It
    // gets inserted by advanceForkCopy when fork_status flips to "complete".
    const daemonAgentType = fromConvexAgentType(agentType);

    // A fork defaults to the same visibility a fresh session in this directory
    // would get: re-resolve from the forker's directory mappings rather than
    // hardcoding private. This keeps a fork consistent with its project's
    // sharing policy (same git_root → same policy), so forking a team-shared
    // session stays team-visible — and forking someone else's session follows
    // YOUR mappings, never inadvertently broadcasting under their settings.
    // Agent-switch forks are pure continuations and inherit the source's exact
    // visibility instead.
    const forkMappings = await ctx.db
      .query("directory_team_mappings")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();
    const { teamId: forkTeamId, isPrivate: forkIsPrivate, autoShared: forkAutoShared } =
      resolveTeamForPath(forkMappings, original.git_root || original.project_path, original.team_id);

    // The fork lives where the parent's transcript lives: route daemon commands
    // to the parent's owner device (it has the JSONL and the checkout). Falls
    // back to project-root routing when the parent has no live owner.
    const ownerTarget = await resolveOwnerDevice(ctx, userId, {
      projectPath: original.project_path,
      gitRoot: original.git_root,
      ownerDeviceId: original.owner_device_id ?? null,
    });
    // Fast path applies when the fork's history is the parent's transcript
    // verbatim AND the same claude binary will resume it — the daemon copies
    // the parent's JSONL instead of waiting for the server copy + rebuild.
    const isPlainFork = !args.target_agent_type || args.target_agent_type === original.agent_type;
    const fastPathEligible = atTip && isPlainFork && daemonAgentType === "claude" &&
      (original.agent_type === "claude_code" || !original.agent_type);
    // opencode forks through its serve sidecar: POST /session/:id/fork mints a
    // REAL, resumable ses_ id from the parent session (a synthetic forked-<id>
    // never resolves in opencode.db — that's the bug this fixes). The daemon needs
    // the parent's real opencode session id to call fork(), so pass it through.
    const isOpencodeApiFork = opencodeApiForkEligible({
      isPlainFork,
      daemonAgentType,
      sourceAgentType: original.agent_type,
      sourceSessionId: original.session_id,
      atTip,
      forkMessageId: opencodeForkMessageId,
    });

    const newConversationId = await ctx.db.insert("conversations", {
      user_id: userId,
      team_id: isAgentSwitch ? original.team_id : forkTeamId,
      agent_type: agentType,
      session_id: forkSessionId,
      slug: original.slug,
      // A direction-seeded branch is titled by what IT will do, not by its
      // parent — otherwise N sibling branches all render as identical
      // "Fork: <parent>" cards. previewText compresses the prompt to one line.
      title: (() => {
        const directionSnippet = previewText(args.direction);
        if (directionSnippet) return `${titlePrefix}${directionSnippet}`;
        return original.title ? `${titlePrefix}${original.title}` : undefined;
      })(),
      subtitle: original.subtitle,
      project_hash: original.project_hash,
      project_path: original.project_path,
      model: isAgentSwitch ? undefined : original.model,
      started_at: now,
      updated_at: now,
      message_count: 0,
      is_private: isAgentSwitch ? original.is_private : forkIsPrivate,
      auto_shared: isAgentSwitch ? original.auto_shared : (forkAutoShared || undefined),
      status: "active",
      forked_from: isAgentSwitch ? undefined : original._id,
      parent_message_uuid: isAgentSwitch ? "agent-switch" : args.message_uuid,
      parent_conversation_id: isAgentSwitch ? original._id : undefined,
      git_commit_hash: original.git_commit_hash,
      git_branch: original.git_branch,
      git_remote_url: original.git_remote_url,
      git_root: original.git_root,
      cli_flags: original.cli_flags,
      worktree_name: original.worktree_name,
      worktree_branch: original.worktree_branch,
      worktree_path: original.worktree_path,
      worktree_status: original.worktree_status,
      fork_status: "copying",
      fork_copy_total: totalToCopy,
      fork_copied: 0,
      fork_copy_cursor: 0,
      fork_cutoff_timestamp: cutoffTimestamp,
      owner_device_id: ownerTarget ?? undefined,
    });

    const forkDaemonArgs = {
      fork: true,
      session_id: forkSessionId,
      agent_type: daemonAgentType,
      conversation_id: newConversationId,
      project_path: original.project_path || original.git_root,
      // Copy-the-JSONL hints. The deferred (post-copy) command may also use
      // them: copy-first is cache-stable even when the rebuild would be safe.
      ...(fastPathEligible ? { fork_fast_path: true, parent_session_id: original.session_id } : {}),
      // opencode API fork: carry the parent's real ses_ id so the daemon can call
      // OpencodeServer.fork(parent) and resume the minted id (see daemon resume_session).
      // fork_message_id (partial forks only) truncates the fork to match the copy.
      ...(isOpencodeApiFork
        ? {
            fork_api: true,
            parent_session_id: original.session_id,
            ...(opencodeForkMessageId ? { fork_message_id: opencodeForkMessageId } : {}),
          }
        : {}),
      _target_device_id: ownerTarget ?? undefined,
    };
    await ctx.db.patch(newConversationId, {
      short_id: newConversationId.toString().slice(0, 7),
      fork_daemon_args: JSON.stringify(forkDaemonArgs),
    });

    // At-tip forks don't need the server-side message copy to start the
    // session — the daemon copies the parent's local JSONL. Emit immediately
    // (strict: no export fallback while the copy is mid-flight) so the tmux
    // session spins up in parallel with the copy. A dedicated command name:
    // pre-fast-path daemons report "Unknown command" and stay inert instead of
    // reconstituting a truncated fork from the half-copied export. The
    // deferred resume_session emitted at copy completion is the safety net
    // (resuming an already-attached session reuses the live tmux pane).
    if (fastPathEligible) {
      await ctx.db.insert("daemon_commands", {
        user_id: userId,
        command: "fork_session",
        args: JSON.stringify({ ...forkDaemonArgs, _target_device_id: undefined, fork_fast_path_strict: true }),
        created_at: now,
        target_device_id: ownerTarget ?? undefined,
      });
    }

    // Agent-switch continuations inherit too — they're the same thread of
    // work under a different agent, exactly like the visibility inheritance
    // above.
    await inheritLabelAssignment(ctx, userId, original._id, newConversationId);

    // Carry the original's git side row (diff + status) over to the fork's.
    const originalGitDiff = await getConvGitDiff(ctx, original._id);
    await setConvGitDiff(
      ctx,
      newConversationId,
      originalGitDiff.git_diff ?? undefined,
      originalGitDiff.git_diff_staged ?? undefined,
      originalGitDiff.git_status ?? original.git_status ?? undefined,
    );

    if (!isAgentSwitch) {
      const currentForkCount = original.fork_count ?? 0;
      await ctx.db.patch(original._id, {
        fork_count: currentForkCount + 1,
      });
    }

    // Copy first batch synchronously so small forks finish in one round-trip;
    // larger ones chain via _continueFork.
    await advanceForkCopy(makeForkCtx(ctx), newConversationId);

    return {
      conversation_id: newConversationId,
      short_id: newConversationId.toString().slice(0, 7),
    };
  },
});

export const getConversationTree = query({
  args: {
    conversation_id: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserIdReadOnly(ctx, args.api_token);
    if (!userId) {
      return { error: "Unauthorized" };
    }

    const conv = await resolveConversationRef(ctx, args.conversation_id, userId);
    if (!conv) {
      return { error: "Conversation not found" };
    }

    if (!(await canOwnerOrTeamAccess(ctx, userId, conv))) {
      return { error: "Access denied" };
    }

    // Walk up to find root
    let root = conv;
    const visited = new Set<string>([root._id.toString()]);
    while (root.forked_from) {
      const parent = await ctx.db.get(root.forked_from);
      if (!parent || visited.has(parent._id.toString())) break;
      visited.add(parent._id.toString());
      root = parent;
    }

    // Recursively build tree from root
    type TreeNode = {
      id: string;
      short_id?: string;
      title: string;
      message_count: number;
      parent_message_uuid?: string;
      started_at: number;
      status: string;
      agent_type?: string;
      is_current: boolean;
      // The prompt that started THIS branch: the first user message after the
      // fork point. Sibling forks share a title, so this is what actually
      // tells them apart in the branch map.
      branch_label?: string;
      // Messages on this branch after the fork point (the branch's own work,
      // excluding history inherited from the parent).
      branch_message_count?: number;
      children: TreeNode[];
    };

    // First real user prompt out of a small message window, tags/whitespace
    // stripped. Slash-command wrappers (<command-message>…) reduce to their
    // inner text, which still reads usefully ("commit and deploy…").
    const firstUserPrompt = (
      msgs: Array<{ role: string; content?: unknown }>,
    ): string | undefined => {
      const clean = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      for (const m of msgs) {
        if (m.role === "user" && typeof m.content === "string") {
          const c = clean(m.content);
          if (c) return c.slice(0, 140);
        }
      }
      for (const m of msgs) {
        if (typeof m.content === "string") {
          const c = clean(m.content);
          if (c) return c.slice(0, 140);
        }
      }
      return undefined;
    };

    // Per-branch summary. For a fork we locate the fork point by its uuid (one
    // indexed lookup), then range-scan ONLY the divergent messages after it —
    // never the history copied down from the parent. For the root (no fork
    // point) we summarize from the top. Bounded by .take so a huge branch costs
    // a constant ~30 reads.
    const summarizeBranch = async (
      node: typeof root,
    ): Promise<{ label?: string; count?: number }> => {
      const hasForkPoint =
        !!node.parent_message_uuid && node.parent_message_uuid !== "agent-switch";
      if (hasForkPoint) {
        const forkPoint = await ctx.db
          .query("messages")
          .withIndex("by_conversation_uuid", (q) =>
            q.eq("conversation_id", node._id).eq("message_uuid", node.parent_message_uuid!),
          )
          .first();
        if (forkPoint) {
          const ts = forkPoint.timestamp;
          const head = await ctx.db
            .query("messages")
            .withIndex("by_conversation_timestamp", (q) =>
              q.eq("conversation_id", node._id).gt("timestamp", ts),
            )
            .order("asc")
            .take(30);
          // The count is message_count minus the inherited history. fork_copied
          // is the count copied down; fall back to the raw count for legacy
          // forks that predate the cursor.
          const count =
            typeof node.fork_copied === "number"
              ? Math.max(0, node.message_count - node.fork_copied)
              : node.message_count;
          return { label: firstUserPrompt(head), count };
        }
      }
      const head = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", node._id))
        .order("asc")
        .take(30);
      return { label: firstUserPrompt(head), count: node.message_count };
    };

    const buildTree = async (node: typeof root): Promise<TreeNode> => {
      const children = await ctx.db
        .query("conversations")
        .withIndex("by_forked_from", (q) => q.eq("forked_from", node._id))
        .collect();

      const [summary, childTrees] = await Promise.all([
        summarizeBranch(node),
        Promise.all(children.map((c) => buildTree(c))),
      ]);

      return {
        id: node._id.toString(),
        short_id: node.short_id,
        title: node.title || "New Session",
        message_count: node.message_count,
        parent_message_uuid: node.parent_message_uuid,
        started_at: node.started_at,
        status: node.status,
        agent_type: node.agent_type,
        is_current: node._id.toString() === conv!._id.toString(),
        branch_label: summary.label,
        branch_message_count: summary.count,
        children: childTrees,
      };
    };

    const tree = await buildTree(root);
    return { tree };
  },
});

export const getForkBranchMessages = query({
  args: {
    conversation_id: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserIdReadOnly(ctx, args.api_token);
    if (!userId) {
      return { error: "Unauthorized" };
    }

    const conv = await resolveConversationRef(ctx, args.conversation_id, userId);
    if (!conv) {
      return { error: "Conversation not found" };
    }

    if (!(await canOwnerOrTeamAccess(ctx, userId, conv))) {
      return { error: "Access denied" };
    }

    const allMessages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", conv!._id)
      )
      .order("asc")
      .collect();

    if (!conv.parent_message_uuid) {
      return { messages: allMessages, fork_point_uuid: null };
    }

    const forkPointIdx = allMessages.findIndex(
      (m) => m.message_uuid === conv!.parent_message_uuid
    );

    if (forkPointIdx === -1) {
      return { messages: allMessages, fork_point_uuid: conv.parent_message_uuid };
    }

    const divergentMessages = allMessages.slice(forkPointIdx + 1);
    return {
      messages: divergentMessages,
      fork_point_uuid: conv.parent_message_uuid,
    };
  },
});

// Lazy backfill for conversations older than the image_preview_url
// denormalization: the web client calls this when it renders a conversation
// whose loaded messages contain images but whose row lacks the preview. The
// URL is recomputed SERVER-side from the conversation's own messages (bounded
// newest-first scan) — a client can trigger the backfill but never supply the
// value. Idempotent and write-once: a set preview short-circuits.
export const backfillImagePreview = mutation({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized");
    }
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }
    if (conversation.user_id.toString() !== authUserId.toString()) {
      throw new Error("Can only backfill your own conversations");
    }
    if (conversation.image_preview_url) return;
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", args.conversation_id))
      .order("desc")
      .take(300);
    for (const msg of recent) {
      const url = await latestImagePreviewUrl(ctx, [msg]);
      if (url) {
        await ctx.db.patch(args.conversation_id, { image_preview_url: url });
        return;
      }
    }
  },
});

export const toggleFavorite = mutation({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized");
    }

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    if (conversation.user_id.toString() !== authUserId.toString()) {
      throw new Error("Can only favorite your own conversations");
    }

    return await toggleFavoriteWithRevision(ctx, conversation);
  },
});

/** Retry-safe desired-state favorite command; never model this as a toggle. */
export const setFavoriteV2 = mutation({
  args: {
    command_id: v.string(),
    conversation_id: v.id("conversations"),
    is_favorite: v.boolean(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    return runLocalCommand(ctx, {
      principalId: userId,
      commandId: args.command_id,
      commandName: "favorites.set/v2",
      arguments: {
        conversationId: args.conversation_id,
        isFavorite: args.is_favorite,
      },
    }, async () => {
      const conversation = await ctx.db.get(args.conversation_id);
      if (!conversation) {
        return {
          status: "rejected" as const,
          code: "MISSING",
          message: "Conversation not found",
        };
      }
      if (String(conversation.user_id) !== String(userId)) {
        return {
          status: "rejected" as const,
          code: "FORBIDDEN",
          message: "Can only favorite your own conversations",
        };
      }
      await setFavoriteWithRevision(ctx, conversation, args.is_favorite, "receipt");
      return {
        status: "acknowledged" as const,
        result: {
          conversationId: conversation._id,
          isFavorite: args.is_favorite,
        },
        // A no-op still advances once for this new command receipt: its
        // optimistic overlay needs positive authoritative coverage to settle.
        coverageViews: [favoriteCoverageForConversation(conversation)],
      };
    });
  },
});

export const setConversationIcon = mutation({
  args: {
    conversation_id: v.id("conversations"),
    icon: v.optional(v.string()),
    icon_color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) throw new Error("Unauthorized");
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) throw new Error("Conversation not found");
    if (conversation.user_id.toString() !== authUserId.toString()) throw new Error("Can only update your own conversations");
    const patch: Record<string, any> = {};
    if (args.icon !== undefined) patch.icon = args.icon;
    if (args.icon_color !== undefined) patch.icon_color = args.icon_color;
    await ctx.db.patch(args.conversation_id, patch);
  },
});

export const listFavorites = query({
  args: {},
  handler: async (ctx) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return [];
    }

    const favorites = await ctx.db
      .query("conversations")
      .withIndex("by_user_favorite", (q) =>
        q.eq("user_id", authUserId).eq("is_favorite", true)
      )
      .collect();

    return favorites
      .sort((a, b) => b.updated_at - a.updated_at)
      .map((conv) => ({
        _id: conv._id,
        title: conv.title,
        session_id: conv.session_id,
        updated_at: conv.updated_at,
        message_count: conv.message_count,
        agent_type: conv.agent_type,
        is_favorite: conv.is_favorite,
      }));
  },
});

/** Complete principal favorite relation; conversation fields live elsewhere. */
export const listFavoritesV2 = query({
  args: {},
  handler: async (ctx) => {
    const identity = { contractId: FAVORITES_VIEW_CONTRACT_ID, viewKey: FAVORITES_VIEW_KEY };
    const userId = await getAuthUserId(ctx);
    if (!userId) return unauthenticatedView(identity);

    const [favorites, viewRevision] = await Promise.all([
      ctx.db
        .query("conversations")
        .withIndex("by_user_favorite", (q) =>
          q.eq("user_id", userId).eq("is_favorite", true))
        .collect(),
      readLocalViewRevision(ctx, userId, identity.contractId, identity.viewKey),
    ]);
    const projected = favorites
      .map(projectFavoriteMembership)
      .sort((left, right) =>
        String(left.conversation_id).localeCompare(String(right.conversation_id)));
    return grantedView(identity, { grantKeys: [FAVORITES_GRANT_KEY], viewRevision }, {
      favorites: projected,
    });
  },
});

// Favorites as FULL inbox session rows — the data source for the Favorites
// top-level view. Deliberately a separate channel from listInboxSessions:
//   • It enriches via enrichInboxSessionRow, so a favorite is byte-identical to
//     an inbox row (same SessionCard, keyboard nav, project chips — no second
//     shape to maintain, no schema drift clobbering rich rows with thin ones).
//   • It is NOT windowed to the last 30 days. A favorite is a kept reference;
//     the one you starred three months ago must still resolve. The index scan
//     walks only this user's favorites, so the unbounded set is naturally small.
//   • The client merges these into the same `sessions` cache but does NOT fold
//     them into liveInboxIds — so an old favorite reaches the shelf without
//     re-entering the active desk as if it were live work. A favorite that is
//     also recently active rides listInboxSessions too and shows in both.
// Mirrors listInboxSessions' include_liveness handling: the live web client
// opts out and gets agent_status/is_idle/... from the sessionsLiveness overlay
// (keyed by id, covers these rows for free) so this query doesn't re-run on
// every heartbeat.
export const listFavoriteSessions = query({
  args: {
    include_liveness: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { sessions: [] };
    const includeLiveness = args.include_liveness !== false;
    const now = Date.now();

    const favorites = await ctx.db
      .query("conversations")
      .withIndex("by_user_favorite", (q) =>
        q.eq("user_id", userId).eq("is_favorite", true)
      )
      .take(500);

    const maps = includeLiveness
      ? await buildUserSessionMaps(ctx, userId, now)
      : EMPTY_INBOX_MAPS;

    const results: any[] = [];
    for (const conv of favorites) {
      if (!shouldShowInInbox(conv)) continue;
      // clusterCutoff 0: favorites are deliberately kept — never gap-hide them.
      const { row } = await enrichInboxSessionRow(ctx, conv, maps, now, false);
      results.push(row);
    }

    sortInboxRows(results);
    if (!includeLiveness) for (const row of results) stripInboxLiveness(row);
    return { sessions: results };
  },
});

export const getMessageFeed = query({
  args: {
    filter: v.union(v.literal("my"), v.literal("team")),
    limit: v.optional(v.number()),
    cursor: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return { messages: [], nextCursor: null };
    }
    const user = await ctx.db.get(userId);
    if (!user) {
      return { messages: [], nextCursor: null };
    }

    const limit = args.limit ?? 30;
    const cursor = args.cursor; // exclusive upper bound on message timestamp

    // --- 1. Candidate conversations ---------------------------------------
    // The feed is driven by the conversations the viewer can see, NOT by a
    // global scan of every message in the system. "my" = the viewer's own
    // conversations; "team" = those plus teammates' team-visible ones. This
    // keeps cost proportional to the viewer's own data. The old query walked
    // the global by_timestamp index in batches of 200 full docs and discarded
    // everything the viewer couldn't see — catastrophic for "my" (where the
    // viewer's messages are sparse among everyone's) and it blew the 100MB
    // read-byte cap, because each message doc carries its tool_results blobs
    // and a 1024-float embedding.
    const CONV_CAP = 500; // viewer's own conversations considered
    const TEAM_MEMBER_CONV_CAP = 50; // recent conversations per teammate

    type ConvDoc = NonNullable<Awaited<ReturnType<typeof ctx.db.get<"conversations">>>>;
    const candidates = new Map<
      string,
      { conv: ConvDoc; isOwn: boolean; authorName: string }
    >();

    const ownAuthor = user.name || user.email?.split("@")[0] || "Unknown";
    const ownConvs = await ctx.db
      .query("conversations")
      .withIndex("by_user_updated", (q) => q.eq("user_id", userId))
      .order("desc")
      .take(CONV_CAP);
    for (const conv of ownConvs) {
      candidates.set(conv._id.toString(), { conv, isOwn: true, authorName: ownAuthor });
    }

    if (args.filter === "team") {
      const memberships = await ctx.db
        .query("team_memberships")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .collect();
      const fetchedMembers = new Set<string>([userId.toString()]);
      for (const membership of memberships) {
        const ff = await createTeamFeedFilter(ctx, membership.team_id);
        for (const member of ff.memberships) {
          const memberId = member.user_id.toString();
          if (fetchedMembers.has(memberId)) continue;
          if ((member.visibility || "summary") === "hidden") continue;
          fetchedMembers.add(memberId);

          const memberUser = await ctx.db.get(member.user_id);
          const memberAuthor =
            memberUser?.name || memberUser?.email?.split("@")[0] || "Unknown";
          const memberConvs = await ctx.db
            .query("conversations")
            .withIndex("by_user_updated", (q) => q.eq("user_id", member.user_id))
            .order("desc")
            .take(TEAM_MEMBER_CONV_CAP);
          for (const conv of memberConvs) {
            if (candidates.has(conv._id.toString())) continue;
            if (!ff.isVisible(conv as any)) continue;
            candidates.set(conv._id.toString(), {
              conv,
              isOwn: false,
              authorName: memberAuthor,
            });
          }
        }
      }
    }

    // --- 2. Merge user-role messages across conversations -----------------
    // Only user-role messages are ever rendered in the feed (the client drops
    // every other role), so we read just those via by_conversation_role_timestamp
    // — never touching the large assistant/tool docs the old query paid to read
    // and throw away. The merge + early-exit lives in messageFeed.ts so it can be
    // unit-tested; here we just supply the candidates and an index-backed fetcher.
    const feedCandidates: FeedCandidate[] = [...candidates.values()].map(
      ({ conv, isOwn, authorName }) => ({
        conversation_id: conv._id,
        updated_at: conv.updated_at,
        title: conv.title || (conv.slug ? formatSlugAsTitle(conv.slug) : "New Session"),
        session_id: conv.session_id,
        isOwn,
        authorName,
      })
    );

    return await mergeUserMessageFeed({
      candidates: feedCandidates,
      cursor,
      limit,
      fetchUserMessages: (conversationId, cur, take) =>
        ctx.db
          .query("messages")
          .withIndex("by_conversation_role_timestamp", (q) => {
            const base = q
              .eq("conversation_id", conversationId as Id<"conversations">)
              .eq("role", "user");
            return cur !== undefined ? base.lt("timestamp", cur) : base;
          })
          .order("desc")
          .take(take),
    });
  },
});

export const clearParentMessageUuid = mutation({
  args: {
    conversation_id: v.id("conversations"),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Unauthorized");
    }
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }
    if (conversation.user_id.toString() !== authUserId.toString()) {
      throw new Error("Can only modify your own conversations");
    }
    await ctx.db.patch(args.conversation_id, {
      parent_message_uuid: undefined,
    });
    return true;
  },
});

export const feedForCLI = query({
  args: {
    // Optional so the WEB can call this too (session auth) — the new-session
    // page previews exactly what the stable-context hook will inject, from the
    // same query with the same params. The CLI always passes a token.
    api_token: v.optional(v.string()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
    start_time: v.optional(v.number()),
    end_time: v.optional(v.number()),
    query: v.optional(v.string()),
    project_path: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    member_name: v.optional(v.string()),
    mine_only: v.optional(v.boolean()),
    live_only: v.optional(v.boolean()),
    state: v.optional(v.string()),
    label: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      return { error: "Unauthorized" };
    }
    const user = await ctx.db.get(authUserId);
    if (!user) {
      return { error: "User not found" };
    }

    const limit = args.limit ?? 10;
    const offset = args.offset ?? 0;
    const projectPath = args.project_path;
    const startTime = args.start_time;
    const endTime = args.end_time ?? Date.now();
    const query = args.query?.trim();

    const userMemberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
      .collect();
    const userTeamIds = userMemberships.map(m => m.team_id);
    if (args.team_id && !userTeamIds.some((id) => String(id) === String(args.team_id))) {
      return { error: "Unauthorized team" };
    }

    let resolvedTeamId: Id<"teams"> | undefined;
    if (args.team_id) {
      resolvedTeamId = args.team_id;
    } else if (args.project_path) {
      const mappings = await ctx.db
        .query("directory_team_mappings")
        .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
        .collect();
      let bestMatch: { teamId: Id<"teams">; pathLength: number } | null = null;
      for (const mapping of mappings) {
        if (args.project_path === mapping.path_prefix || args.project_path.startsWith(mapping.path_prefix + "/")) {
          if (!bestMatch || mapping.path_prefix.length > bestMatch.pathLength) {
            bestMatch = { teamId: mapping.team_id, pathLength: mapping.path_prefix.length };
          }
        }
      }
      resolvedTeamId = bestMatch?.teamId;
    }
    const effectiveTeamIds = resolvedTeamId ? [resolvedTeamId] : userTeamIds;

    type UserDoc = NonNullable<Awaited<ReturnType<typeof ctx.db.get<"users">>>>;
    const allTeamUsers: UserDoc[] = [];
    const cliFeedFilters = new Map<string, Awaited<ReturnType<typeof createTeamFeedFilter>>>();
    for (const teamId of effectiveTeamIds) {
      const ff = await createTeamFeedFilter(ctx, teamId);
      cliFeedFilters.set(teamId.toString(), ff);
      const memberUsers = await Promise.all(
        ff.memberships.map(m => ctx.db.get(m.user_id))
      );
      allTeamUsers.push(...memberUsers.filter((u): u is UserDoc => u !== null));
    }
    const teamUsers = [...new Map(allTeamUsers.map(u => [u._id.toString(), u])).values()];
    const teamUserMap = new Map(teamUsers.map(u => [u._id.toString(), u]));
    const effectiveTeamIdSet = new Set(effectiveTeamIds.map(id => id.toString()));

    let filterUserId: string | null = null;
    if (args.mine_only) {
      filterUserId = authUserId.toString();
    } else if (args.member_name) {
      const memberNameLower = args.member_name.toLowerCase();
      const matchingMember = teamUsers.find(u => {
        const name = u.name?.toLowerCase() || "";
        const email = u.email?.toLowerCase() || "";
        return name.includes(memberNameLower) || email.includes(memberNameLower);
      });
      if (!matchingMember) {
        return { error: `No team member found matching "${args.member_name}"` };
      }
      filterUserId = matchingMember._id.toString();
    }

    // Label filter: the labeled set IS the candidate pool. Labels exist to park
    // old sessions, which the recency-window fetches below would miss, so when a
    // label is given we hydrate its conversations directly instead.
    let labelConvIds: Set<string> | null = null;
    let labeledConvs: NonNullable<Awaited<ReturnType<typeof ctx.db.get<"conversations">>>>[] = [];
    if (args.label) {
      const resolved = await resolveLabelConvIds(ctx, authUserId, args.label);
      if ("error" in resolved) return { error: resolved.error };
      const hydrated = await Promise.all(
        [...resolved.convIds].slice(0, 200).map((id) => ctx.db.get(id as Id<"conversations">))
      );
      labeledConvs = hydrated.filter((c): c is (typeof labeledConvs)[number] => c !== null);
      // Labels are project-bounded by default: the CLI passes cwd unless -g.
      if (args.project_path) {
        const bound = args.project_path;
        labeledConvs = labeledConvs.filter((c) =>
          projectOverlaps(bound, c.project_path) || projectOverlaps(bound, (c as any).git_root)
        );
      }
      labelConvIds = new Set(labeledConvs.map((c) => c._id.toString()));
    }

    let matchingConvIds: Set<string> | null = null;
    let queryMatchedOwnConversations: typeof ownConversations = [];
    let queryMatchedTeamConversations: typeof ownConversations = [];
    if (query && query.length >= 2) {
      // Single combined lookup (see fetchMessageSearchPool), then best-coverage
      // selection instead of a strict all-terms AND.
      const terms = parseSearchTerms(query);
      const { pool: searchResults } = await fetchMessageSearchPool(ctx, terms, {
        userId: authUserId,
        teamIds: effectiveTeamIds,
      });

      // Group messages by conversation, then keep the best-coverage matches
      const conversationMessages = new Map<string, typeof searchResults>();
      for (const msg of searchResults) {
        const convId = msg.conversation_id.toString();
        if (!conversationMessages.has(convId)) {
          conversationMessages.set(convId, []);
        }
        conversationMessages.get(convId)!.push(msg);
      }

      const rankedMatches = rankConversationsByCoverage(conversationMessages, terms);
      matchingConvIds = new Set(rankedMatches.map((r) => r.convId));

      const matchedConvs = await Promise.all(
        Array.from(matchingConvIds).slice(0, 25).map(async (convId) => {
          try {
            return await ctx.db.get(convId as Id<"conversations">);
          } catch {
            return null;
          }
        })
      );
      const validConvs = matchedConvs.filter((c): c is NonNullable<typeof c> => c !== null);

      // Filter own conversations by team when team is resolved
      queryMatchedOwnConversations = validConvs.filter(c => {
        if (c.user_id.toString() !== authUserId.toString()) return false;
        if (resolvedTeamId) {
          const convTeamId = ((c as any).team_id ?? (c as any).active_team_id)?.toString();
          if (!convTeamId || !effectiveTeamIdSet.has(convTeamId)) return false;
        }
        return true;
      });

      const teamUserIdSet = new Set(teamUsers.filter(u => u._id.toString() !== authUserId.toString()).map(u => u._id.toString()));
      queryMatchedTeamConversations = validConvs.filter(c =>
        teamUserIdSet.has(c.user_id.toString()) &&
        c.team_id != null && effectiveTeamIdSet.has(c.team_id.toString()) &&
        (cliFeedFilters.get(c.team_id!.toString())?.isVisible(c) ?? false)
      );
    }

    const fetchLimit = query
      ? Math.min(offset + limit + 20, 100)
      : Math.min(offset + limit + 50, 200);
    // When the caller sets a date window, bound the index range itself. The
    // recency fetches below only see the newest rows per user, so an older
    // window post-filtered against them always came back empty — the range
    // has to ride by_user_updated for old windows to return their own top-N.
    const hasTimeWindow = args.start_time !== undefined || args.end_time !== undefined;
    const boundByWindow = <Q extends { gte: any; lte: any }>(q: Q): Q => {
      let qq: any = q;
      if (args.start_time !== undefined) qq = qq.gte("updated_at", args.start_time);
      if (args.end_time !== undefined) qq = qq.lte("updated_at", args.end_time);
      return qq;
    };
    let ownConversations = labelConvIds
      ? labeledConvs.filter((c) => c.user_id.toString() === authUserId.toString())
      : await ctx.db
          .query("conversations")
          .withIndex("by_user_updated", (q) => boundByWindow(q.eq("user_id", authUserId)))
          .order("desc")
          .take(fetchLimit);

    // Merge in query-matched conversations that might be older
    if (queryMatchedOwnConversations.length > 0) {
      const existingIds = new Set(ownConversations.map(c => c._id.toString()));
      const additionalConvs = queryMatchedOwnConversations.filter(c => !existingIds.has(c._id.toString()));
      ownConversations = [...ownConversations, ...additionalConvs];
    }

    // Include non-private team conversations whose team_id matches effective teams
    let teamConversations: typeof ownConversations = [];
    if (effectiveTeamIds.length > 0 && !args.mine_only) {
      const visibleTeamMembers = teamUsers.filter(u =>
        u._id.toString() !== authUserId.toString() &&
        (u.activity_visibility || "detailed") !== "hidden"
      );

      const visibleMemberIds = new Set(visibleTeamMembers.map(u => u._id.toString()));
      const isVisibleTeamConv = (c: typeof ownConversations[number]) =>
        c.team_id != null && effectiveTeamIdSet.has(c.team_id.toString()) &&
        (cliFeedFilters.get(c.team_id!.toString())?.isVisible(c) ?? false);

      if (labelConvIds) {
        teamConversations = labeledConvs.filter(c =>
          visibleMemberIds.has(c.user_id.toString()) && isVisibleTeamConv(c)
        );
      } else {
        const teamMemberConvos = await Promise.all(
          visibleTeamMembers.map(async (member) => {
            const convos = await ctx.db
              .query("conversations")
              .withIndex("by_user_updated", (q) => boundByWindow(q.eq("user_id", member._id)))
              .order("desc")
              // Recency justifies 10 per member on the hot path; a dated window
              // is a deliberate archaeology query, so give it real coverage.
              .take(hasTimeWindow ? 50 : 10);
            return convos.filter(isVisibleTeamConv);
          })
        );
        teamConversations = teamMemberConvos.flat();
      }

      // Merge in query-matched team conversations that might be older than top-20
      if (queryMatchedTeamConversations.length > 0) {
        const existingTeamIds = new Set(teamConversations.map(c => c._id.toString()));
        const additionalTeam = queryMatchedTeamConversations.filter(c => !existingTeamIds.has(c._id.toString()));
        teamConversations = [...teamConversations, ...additionalTeam];
      }
    }

    const isOwnConversation = (c: typeof ownConversations[number]) => c.user_id.toString() === authUserId.toString();

    // Sessions this user OWNS belong in their feed even in --mine scope (they're
    // run by another account, so the scans above miss them when mine_only skips
    // team conversations entirely). Explicit assignment outranks default team
    // visibility — mirror computeInboxSessions. Reads the canonical owner SET
    // (session_owners), so a SECONDARY owner is included, not just the primary
    // held in the owner_user_id cache.
    const myOwnerRows = args.member_name
      ? []
      : await ctx.db
          .query("session_owners")
          .withIndex("by_user", (q: any) => q.eq("user_id", authUserId))
          .order("desc")
          .take(50);
    const myOwnedIds = new Set<string>(
      myOwnerRows.map((r: any) => r.conversation_id.toString())
    );
    const isOwnedByMe = (c: { _id: { toString(): string } }) =>
      myOwnedIds.has(c._id.toString());

    const ownedConversations: typeof ownConversations = [];
    for (const r of myOwnerRows) {
      let conv: any = null;
      try { conv = await ctx.db.get((r as any).conversation_id); } catch { conv = null; }
      if (!conv || isOwnConversation(conv)) continue;
      ownedConversations.push(conv);
    }

    const candidateById = new Map<string, typeof ownConversations[number]>();
    for (const c of [...ownConversations, ...teamConversations, ...ownedConversations]) {
      candidateById.set(c._id.toString(), c);
    }

    let filteredConversations = [...candidateById.values()]
      .filter((c): c is typeof ownConversations[number] => {
        if (filterUserId && c.user_id.toString() !== filterUserId && !(args.mine_only && isOwnedByMe(c))) return false;
        if (labelConvIds && !labelConvIds.has(c._id.toString())) return false;

        // Team filter: when team is resolved from directory, filter own sessions by team
        if (resolvedTeamId && isOwnConversation(c)) {
          const convTeamId = ((c as any).team_id ?? (c as any).active_team_id)?.toString();
          if (!convTeamId || !effectiveTeamIdSet.has(convTeamId)) return false;
        }
        if (startTime && c.updated_at < startTime) return false;
        if (endTime && c.updated_at > endTime) return false;
        if (matchingConvIds && !matchingConvIds.has(c._id.toString())) {
          // Also match on conversation title/subtitle
          const titleText = [c.title, c.subtitle].filter(Boolean).join(" ").toLowerCase();
          const queryLower = query?.toLowerCase() || "";
          const queryTerms = queryLower.split(/\s+/).filter(w => w.length > 1);
          const titleMatch = queryTerms.length > 0 && queryTerms.every(w => titleText.includes(w));
          if (!titleMatch) return false;
        }
        return true;
      })
      .sort((a, b) => b.updated_at - a.updated_at);

    const MANAGED_STALE_MS = 60 * 1000;
    const now = Date.now();
    const liveStatusMap = new Map<string, string | undefined>();
    const managedMap = new Map<string, any>();
    for (const conv of filteredConversations) {
      const managed = await ctx.db
        .query("managed_sessions")
        .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conv._id))
        .first();
      if (managed) managedMap.set(conv._id.toString(), managed);
      if (managed && (now - managed.last_heartbeat) < MANAGED_STALE_MS) {
        liveStatusMap.set(conv._id.toString(), managed.agent_status);
      }
    }

    // Derive a session's work_state by reusing the exact inbox classifier so the
    // CLI never re-implements the rule. The managed row is already cached above;
    // the only extra DB cost is the awaiting_input read, gated to a live, non-idle
    // session (the sole case that can be parked on an open AskUserQuestion). We
    // run this lazily — see below — so the daemon's stable-context feed (no state
    // filter, limit ~10) never pays it for the whole candidate set.
    const workStateMap = new Map<string, WorkState>();
    // The trust-coerced agent_status per conv, so the displayed `agent_status`
    // field agrees with the bucketed work_state (a stale "working" shows as the
    // coerced "idle", never contradicting a needs_input row).
    const coercedStatusMap = new Map<string, string | undefined>();
    const armedHomesFor = armedTriggerHomeLoader(ctx);
    const classifyConv = async (conv: typeof filteredConversations[number]): Promise<WorkState> => {
      const cached = workStateMap.get(conv._id.toString());
      if (cached) return cached;
      const managed = managedMap.get(conv._id.toString());
      const isLive = liveStatusMap.has(conv._id.toString());
      const armedHomes = await armedHomesFor(conv.user_id);
      // Stop trusting a frozen "active" status once the conversation has gone
      // quiet past the trust TTL — the SAME coercion enrichInboxSessionRow does
      // at its enrichment boundary (see trustedAgentStatus). A live daemon that
      // finished re-asserts its last "working" on every heartbeat; without this
      // the feed pins the session in WORKING forever even though the inbox /
      // `cast monitor` (which read the coerced value) long since moved it to
      // needs-input. This is the one place feedForCLI reads the raw managed
      // status, so it must coerce here too or the two views drift. The
      // heartbeatAlive leg uses the same 90s window as the inbox maps (NOT the
      // stricter 60s liveStatusMap above) so both surfaces coerce identically.
      const heartbeatFresh =
        !!managed?.last_heartbeat && now - managed.last_heartbeat < HEARTBEAT_ALIVE_MS;
      const agentStatus = trustedAgentStatus(
        managed?.agent_status, conv.updated_at, now, heartbeatFresh,
        openTasksVouchForWaiting(managed?.open_tasks_at, managed?.open_tasks?.length ?? 0, now),
      );
      coercedStatusMap.set(conv._id.toString(), agentStatus);
      const daemonAlive = agentStatus === "stopped" ? false : isLive;
      const hasPending = !!(conv as any).has_pending_messages;
      const activity = deriveSessionActivity({
        agentStatus,
        agentStatusUpdatedAt: managed?.agent_status_updated_at,
        lastMessageRole: (conv as any).last_message_role,
        lastMessagePreview: (conv as any).last_message_preview,
        hasPending,
        status: conv.status,
        updatedAt: conv.updated_at,
        daemonAlive,
        now,
      });
      let awaitingInput = false;
      if (!activity.isIdle && (conv.message_count || 0) > 0 && isLive) {
        const lastMsg = await ctx.db
          .query("messages")
          .withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", conv._id))
          .order("desc")
          .first();
        if (lastMsg?.role === "assistant" && lastMsg.tool_calls?.some((tc: any) => tc.name === "AskUserQuestion")) {
          awaitingInput = true;
        }
      }
      const ws = classifyWorkState({
        agentStatus,
        isIdle: activity.isIdle,
        awaitingInput,
        hasPending,
        isUnresponsive: activity.isUnresponsive,
        messageCount: conv.message_count || 0,
        killed: !!conv.inbox_killed_at,
        userDormant: isUserDormant(conv),
        armedTriggerHome: isArmedTriggerHome(conv, armedHomes.standing),
        armedLoopHome: isArmedLoopHome(conv, now),
        armedOnceTriggerHome: isArmedTriggerHome(conv, armedHomes.once),
        settleVerdict: isSettleVerdictCurrent(conv) ? conv.settle_verdict : null,
        declaredStatus: conv.thread_state_status ?? null,
      });
      workStateMap.set(conv._id.toString(), ws);
      return ws;
    };

    if (args.live_only) {
      filteredConversations = filteredConversations.filter(c => liveStatusMap.has(c._id.toString()));
    }

    const stateFilter = normalizeWorkStateFilter(args.state);
    if (stateFilter === "pinned") {
      filteredConversations = filteredConversations.filter(c => !!c.inbox_pinned_at);
    } else if (stateFilter === "live") {
      filteredConversations = filteredConversations.filter(c => liveStatusMap.has(c._id.toString()));
    } else if (stateFilter) {
      // A work_state filter needs every candidate classified before paginating.
      for (const c of filteredConversations) await classifyConv(c);
      filteredConversations = filteredConversations.filter(c => workStateMap.get(c._id.toString()) === stateFilter);
    }

    const allConversations = filteredConversations.slice(offset, offset + Math.min(limit, 100));

    // Classify only the rows we actually return (cached if a state filter above
    // already classified the full set). Keeps the no-filter feed — including the
    // daemon's stable-context build — bounded to ~limit awaiting_input reads.
    for (const conv of allConversations) await classifyConv(conv);

    const results: Array<{
      id: string;
      session_id: string;
      title: string;
      subtitle: string | null;
      project_path: string | null;
      updated_at: string;
      message_count: number;
      agent_type?: string;
      is_live?: boolean;
      agent_status?: string;
      work_state?: WorkState;
      is_pinned?: boolean;
      user?: { name: string | null; email: string | null };
      // Second-party owner (the member responsible for steering), when set.
      owner?: { name: string | null; email: string | null };
      owned_by_me?: boolean;
      preview: Array<{
        line: number;
        role: string;
        content: string;
        tool_calls_count?: number;
        tool_results_count?: number;
      }>;
      // Last few real prose messages — what the session is doing NOW. The head
      // preview alone misrepresents long sessions by their founding prompt.
      tail?: Array<{ line: number; role: string; content: string }>;
      idle_summary?: string;
      recent_files?: string[];
      worktree?: string;
      git_branch?: string;
      machine?: string;
      last_activity_at?: string;
    }> = [];

    // Machine label per unique (runner, device) pair, so a card names the
    // machine a session runs on. A session on another machine cannot be the
    // author of local working-tree edits — without this line agents guess.
    const deviceLabels = new Map<string, string>();
    for (const conv of allConversations) {
      const devId = (conv as any).owner_device_id as string | undefined;
      if (!devId) continue;
      const key = `${conv.user_id.toString()}:${devId}`;
      if (deviceLabels.has(key)) continue;
      const device = await ctx.db
        .query("devices")
        .withIndex("by_user_device", (q: any) => q.eq("user_id", conv.user_id).eq("device_id", devId))
        .first();
      if (device?.label) deviceLabels.set(key, device.label);
    }

    // Only load messages for conversations in the final result set
    for (const conv of allConversations) {
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
        .order("asc")
        .take(6);

      let firstUserMessage = "";
      for (const msg of messages) {
        const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
        if (msg.role === "user" && !hasToolResults) {
          const text = msg.content?.trim();
          if (text) {
            firstUserMessage = text.slice(0, 120);
            if (text.length > 120) firstUserMessage += "...";
            break;
          }
        }
      }

      const title = conv.title
        || firstUserMessage
        || (conv.slug ? formatSlugAsTitle(conv.slug) : null)
        || "New Session";

      const preview: Array<{
        line: number;
        role: string;
        content: string;
        tool_calls_count?: number;
        tool_results_count?: number;
      }> = [];

      let lineNum = 0;
      for (const msg of messages) {
        lineNum++;
        if (msg.role === "user") {
          const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
          if (!hasToolResults && msg.content?.trim()) {
            let content = msg.content.trim();
            if (content.length > 200) content = content.slice(0, 200) + "...";
            preview.push({
              line: lineNum,
              role: "user",
              content,
            });
          }
        } else if (msg.role === "assistant" && preview.length > 0) {
          let content = msg.content?.trim() || "";
          if (!content) continue;
          if (content.length > 60) content = content.slice(0, 60) + "...";
          preview.push({
            line: lineNum,
            role: "assistant",
            content,
            tool_calls_count: msg.tool_calls?.length,
            tool_results_count: msg.tool_results?.length,
          });
          if (preview.length >= 6) break;
        }
      }

      // Activity tail: newest real prose (user text or assistant text), with
      // ordinals that line up with `cast read <id> <line>`. Skipped for rows
      // short enough that the head preview already covers them.
      const headPreview = preview.slice(0, 2);
      const headMaxLine = headPreview.length > 0 ? headPreview[headPreview.length - 1].line : 0;
      const totalMessages = conv.message_count || 0;
      const recentMsgs = await ctx.db
        .query("messages")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
        .order("desc")
        .take(12);
      const lastActivityAt = recentMsgs[0]?.timestamp;
      const tail: Array<{ line: number; role: string; content: string }> = [];
      for (let i = 0; i < recentMsgs.length && tail.length < 2; i++) {
        const msg = recentMsgs[i];
        const line = Math.max(1, totalMessages - i);
        if (line <= headMaxLine) break;
        if (msg.role !== "user" && msg.role !== "assistant") continue;
        if (msg.tool_results && msg.tool_results.length > 0) continue;
        const text = msg.content?.trim();
        if (!text) continue;
        // Collapse whitespace: the tail is a one-line snippet on a card, and
        // raw newlines from long assistant turns would break the card layout.
        const flat = text.replace(/\s+/g, " ");
        tail.unshift({
          line,
          role: msg.role,
          content: flat.length > 200 ? flat.slice(0, 200) + "..." : flat,
        });
      }

      const owner = teamUserMap.get(conv.user_id.toString()) || (conv.user_id.toString() === authUserId.toString() ? user : null);
      const isOwnConv = conv.user_id.toString() === authUserId.toString();

      // Second-party owner display (distinct from `owner` above, which is the
      // RUNNER — historical local name). Owner docs are usually teammates and
      // already loaded; fall back to a direct get for cross-team edge cases.
      const sessionOwnerId = (conv as any).owner_user_id?.toString();
      let sessionOwner: { name: string | null; email: string | null } | undefined;
      if (sessionOwnerId) {
        const ownerDoc =
          teamUserMap.get(sessionOwnerId) ||
          (sessionOwnerId === authUserId.toString() ? user : await ctx.db.get((conv as any).owner_user_id as Id<"users">));
        if (ownerDoc) sessionOwner = { name: ownerDoc.name || null, email: ownerDoc.email || null };
      }

      const convIsLive = liveStatusMap.has(conv._id.toString());
      results.push({
        id: conv._id,
        session_id: conv.session_id,
        title,
        subtitle: conv.subtitle || null,
        project_path: conv.project_path || null,
        updated_at: new Date(conv.updated_at).toISOString(),
        message_count: conv.message_count || 0,
        agent_type: conv.agent_type,
        ...(convIsLive ? { is_live: true, agent_status: coercedStatusMap.get(conv._id.toString()) || undefined } : {}),
        work_state: workStateMap.get(conv._id.toString()) || "idle",
        // A retired row. `cast sessions -w` reads this to emit a kill as a
        // DEPARTURE from the watched set rather than a work-state transition.
        ...(conv.inbox_killed_at ? { is_killed: true } : {}),
        is_pinned: !!conv.inbox_pinned_at,
        user: !isOwnConv && owner ? { name: owner.name || null, email: owner.email || null } : undefined,
        ...(sessionOwner ? { owner: sessionOwner } : {}),
        ...(sessionOwnerId === authUserId.toString() ? { owned_by_me: true } : {}),
        // With a tail present the head shrinks to the goal + first reply; a
        // short row (no tail beyond the head) keeps the old 4-message preview.
        preview: tail.length > 0 ? headPreview : preview.slice(0, 4),
        ...(tail.length > 0 ? { tail } : {}),
        ...(conv.idle_summary ? { idle_summary: conv.idle_summary } : {}),
        ...(conv.recent_files && conv.recent_files.length > 0 ? { recent_files: conv.recent_files } : {}),
        ...((conv as any).worktree_name &&
        (conv as any).worktree_status !== "merged" &&
        (conv as any).worktree_status !== "archived"
          ? { worktree: (conv as any).worktree_name }
          : {}),
        ...(conv.git_branch ? { git_branch: conv.git_branch } : {}),
        ...((conv as any).owner_device_id && deviceLabels.get(`${conv.user_id.toString()}:${(conv as any).owner_device_id}`)
          ? { machine: deviceLabels.get(`${conv.user_id.toString()}:${(conv as any).owner_device_id}`) }
          : {}),
        ...(lastActivityAt ? { last_activity_at: new Date(lastActivityAt).toISOString() } : {}),
      });
    }

    return {
      conversations: results,
      scope: projectPath || "global",
    };
  },
});

export const listProjectHashes = query({
  args: { api_token: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) throw new Error("Not authenticated");

    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
      .take(args.limit || 100);

    const hashes = new Map<string, { count: number; sample_title: string | null }>();
    for (const conv of conversations) {
      const hash = conv.project_hash || "__no_project__";
      const existing = hashes.get(hash);
      if (existing) {
        existing.count++;
      } else {
        hashes.set(hash, { count: 1, sample_title: conv.title || null });
      }
    }

    return Array.from(hashes.entries())
      .map(([hash, data]) => ({ hash, count: data.count, sample_title: data.sample_title }))
      .sort((a, b) => b.count - a.count);
  },
});

export const deleteByProjectHash = mutation({
  args: { project_hash: v.string(), api_token: v.optional(v.string()), conv_id: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) throw new Error("Not authenticated");

    let convId: Id<"conversations"> | null = null;
    if (args.conv_id) {
      // Continuation branch: the id is client-supplied, so prove ownership
      // before deleting anything. Deletion is owner-only — team visibility
      // never grants it.
      const cid = ctx.db.normalizeId("conversations", args.conv_id);
      const conv = cid ? await ctx.db.get(cid) : null;
      if (!conv) return { deleted: 0, hasMore: false, conv_id: null };
      if (conv.user_id.toString() !== authUserId.toString()) {
        throw new Error("Not authorized");
      }
      convId = conv._id;
    } else {
      const convs = await ctx.db
        .query("conversations")
        .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
        .take(100);
      const conv = convs.find(c => c.project_hash === args.project_hash);
      if (!conv) return { deleted: 0, hasMore: false, conv_id: null };
      convId = conv._id;
    }

    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", convId))
      .take(50);

    for (const m of msgs) await ctx.db.delete(m._id);

    const hasMoreMsgs = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", convId))
      .first();

    if (!hasMoreMsgs) {
      await ctx.db.delete(convId);
      return { deleted: 1, hasMore: false, conv_id: null };
    }
    return { deleted: 0, hasMore: true, conv_id: convId };
  },
});

export const getMessageCountsForReconciliation = query({
  args: {
    session_ids: v.array(v.string()),
    // Daemon-side hints: { session_id (local JSONL UUID) → conversation_id it's
    // already bound to }. Necessary because `conversations.session_id` only
    // stores the FIRST UUID a conversation was bound to; resumed sessions get
    // new JSONL UUIDs that never appear on any conversation row, so the
    // by_session_id index returns nothing and the daemon's reconciliation
    // would falsely flag them as `missing_backend` and reset their sync
    // position — the storm fix.
    conversation_id_hints: v.optional(
      v.array(
        v.object({
          session_id: v.string(),
          conversation_id: v.id("conversations"),
        })
      )
    ),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      throw new Error("Authentication required");
    }

    const results: Array<{
      session_id: string;
      conversation_id: string;
      message_count: number;
      updated_at: number;
    }> = [];

    const hintMap = new Map<string, Id<"conversations">>();
    for (const hint of args.conversation_id_hints ?? []) {
      hintMap.set(hint.session_id, hint.conversation_id);
    }

    for (const sessionId of args.session_ids.slice(0, 100)) {
      const hintedConvId = hintMap.get(sessionId);
      const conv = hintedConvId
        ? await ctx.db.get(hintedConvId)
        : await ctx.db
            .query("conversations")
            .withIndex("by_session_id", (q) => q.eq("session_id", sessionId))
            .first();

      if (conv && conv.user_id.toString() === authUserId.toString()) {
        results.push({
          session_id: sessionId,
          conversation_id: conv._id,
          message_count: conv.message_count || 0,
          updated_at: conv.updated_at || conv._creationTime,
        });
      }
    }

    return results;
  },
});

// Teammates' conversations updated after `since`: one bounded, newest-first
// range per visible member on by_team_user_updated (the viewer and hidden
// members are skipped, and the index bound means rows older than `since` are
// never read). Fanning out per member instead of scanning the whole team keeps
// the viewer's OWN rows out of the read set, so a live subscriber never re-runs
// on the viewer's own heartbeats, and it reuses the index the team feed pages
// on. `perMember(memberCount)` caps reads per member so total work is bounded
// regardless of team size.
export async function collectTeammateConversationsSince(
  ctx: Pick<QueryCtx, "db">,
  teamId: Id<"teams">,
  viewerId: Id<"users">,
  since: number,
  perMember: (memberCount: number) => number,
) {
  const feedFilter = await createTeamFeedFilter(ctx, teamId);
  const visibleMembers = feedFilter.memberships.filter((m) =>
    m.user_id.toString() !== viewerId.toString() &&
    (m.visibility || "summary") !== "hidden"
  );
  const take = Math.max(1, perMember(visibleMembers.length));
  const perMemberRows = await Promise.all(
    visibleMembers.map((m) =>
      ctx.db
        .query("conversations")
        .withIndex("by_team_user_updated", (q) =>
          q.eq("team_id", teamId).eq("user_id", m.user_id).gt("updated_at", since)
        )
        .order("desc")
        .take(take)
        .then((rows) => rows.filter((c) => feedFilter.isVisible(c)))
    )
  );
  return { feedFilter, visibleMembers, rows: perMemberRows.flat() };
}

// Total doc reads one unread recount may spend across all teammates. The badge
// is a count, not a list: when a member has more than their share of unread
// rows the number saturates rather than the query scanning further.
export const TEAM_UNREAD_MAX_READS = 100;

// Sidebar "Feed" badge: teammates' feed-visible conversations updated since the
// viewer last opened the feed (markTeamConversationsSeen). A live subscription
// on every connected client, so the read set must stay small: only rows past
// the viewer's read mark are read, and never the viewer's own.
export const getTeamUnreadCount = query({
  args: {
    teamId: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return 0;
    }
    const user = await ctx.db.get(userId);
    if (!user) {
      return 0;
    }

    const effectiveTeamId = args.teamId || user.active_team_id;
    if (!effectiveTeamId) {
      return 0;
    }

    const lastSeen = user.team_conversations_last_seen || 0;
    const { rows } = await collectTeammateConversationsSince(
      ctx, effectiveTeamId, userId, lastSeen,
      (members) => Math.max(3, Math.floor(TEAM_UNREAD_MAX_READS / Math.max(members, 1))),
    );
    return rows.length;
  },
});

// Admin repair primitive: server-side patches that don't bump updated_at are
// invisible to connected clients holding a cached row (the live inbox window
// and the reconcile crawl are both updated_at-keyed). Touching re-enters the
// row into both channels so the change propagates.
export const touchConversation = internalMutation({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.conversation_id, { updated_at: Date.now() });
    return { touched: args.conversation_id };
  },
});

export const markTeamConversationsSeen = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    await ctx.db.patch(userId, {
      team_conversations_last_seen: Date.now(),
    });

    return { success: true };
  },
});

export const backfillConversationTeamIds = internalMutation({
  args: {
    userId: v.optional(v.id("users")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 500;
    let updated = 0;

    // Only the id is needed (mappings index). Reading the full user doc made
    // long scans OCC-fail: users rows are hot (scheduled jobs patch them), so
    // any mutation slow enough to overlap a heartbeat could never commit.
    const userIds = args.userId
      ? [args.userId]
      : (await ctx.db.query("users").take(100)).map((u) => u._id);

    for (const userId of userIds) {
      const mappings = await ctx.db
        .query("directory_team_mappings")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .collect();

      if (mappings.length === 0) continue;

      // Newest first: born-blank strays come from the (recent) pre-warm/stub
      // flows, so a bounded repair should reach them before old history.
      const conversations = await ctx.db
        .query("conversations")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .order("desc")
        .take(limit);

      for (const conv of conversations) {
        // Same guarded semantics as the live restamp paths: positive mapping
        // matches only, explicit user choices (locked private / manual share)
        // untouched. The old inline version cleared team_id on unmatched paths
        // (breaking "shared must have a team") and could re-share a conv the
        // user had locked private.
        const patch = buildPathRestampUpdate(
          conv,
          mappings,
          conv.git_root || conv.project_path
        );
        if (patch) {
          await patchConversationVisibility(ctx, conv, patch);
          updated++;
        }
      }
    }

    return { updated };
  },
});

// Debug function to investigate why a conversation isn't showing in team feed
export const debugConversationVisibility = query({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { error: "Not authenticated" };

    const user = await ctx.db.get(userId);
    if (!user) return { error: "User not found" };

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return { error: "Conversation not found" };

    const convOwner = await ctx.db.get(conversation.user_id);

    // Get the team this conversation belongs to
    const convTeam = conversation.team_id ? await ctx.db.get(conversation.team_id) : null;

    // Get the user's active team
    const userTeamId = user.team_id;
    const userTeam = userTeamId ? await ctx.db.get(userTeamId) : null;

    // Check team membership for conversation owner
    const ownerTeamMembership = convOwner && userTeamId
      ? await ctx.db
          .query("team_memberships")
          .withIndex("by_user_team", (q) => q.eq("user_id", conversation.user_id).eq("team_id", userTeamId))
          .first()
      : null;

    // Check directory mappings for the owner
    const ownerMappings = userTeamId
      ? await ctx.db
          .query("directory_team_mappings")
          .withIndex("by_user_team", (q) => q.eq("user_id", conversation.user_id).eq("team_id", userTeamId))
          .collect()
      : [];

    const projectPath = conversation.git_root || conversation.project_path;
    const isProjectMapped = ownerMappings.some(
      m => projectPath && (projectPath === m.path_prefix || projectPath.startsWith(m.path_prefix + "/"))
    );

    return {
      conversation: {
        _id: conversation._id,
        title: conversation.title,
        team_id: conversation.team_id,
        user_id: conversation.user_id,
        is_private: conversation.is_private,
        project_path: conversation.project_path,
        git_root: conversation.git_root,
      },
      convOwner: convOwner ? {
        _id: convOwner._id,
        name: convOwner.name,
        email: convOwner.email,
        team_id: convOwner.team_id,
      } : null,
      convTeam: convTeam ? { _id: convTeam._id, name: convTeam.name } : null,
      currentUser: {
        _id: user._id,
        team_id: user.team_id,
      },
      userTeam: userTeam ? { _id: userTeam._id, name: userTeam.name } : null,
      checks: {
        teamsMatch: conversation.team_id?.toString() === user.team_id?.toString(),
        ownerInTeam: !!ownerTeamMembership,
        ownerVisibility: ownerTeamMembership?.visibility || "no membership",
        ownerHasMappings: ownerMappings.length > 0,
        projectPath,
        isProjectMapped,
        wouldShowWithPermissiveDefault: ownerMappings.length === 0 || isProjectMapped,
      },
    };
  },
});

export const getConversationMeta = query({
  args: {
    conversation_id: v.id("conversations"),
    share_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return null;
    }

    // OG-unfurl meta. The caller (bot-meta middleware) is unauthenticated, so
    // this resolves to "shared" only when the unfurled URL PRESENTED the share
    // token (?share=) — a bare conversation id reveals nothing, shared link or
    // not, because ids circulate far more freely than links (issue #27).
    // /share/<token> URLs unfurl via getSharedConversationMeta instead. An
    // authed viewer (owner/team) also passes. Mirrors that query's shape (no
    // project_path).
    const viewerId = await getAuthUserId(ctx);
    if ((await checkConversationAccess(ctx, viewerId, conversation, args.share_token)) === "denied") {
      return null;
    }

    const user = await ctx.db.get(conversation.user_id);

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .order("asc")
      .take(10);

    let firstUserMessage = "";
    for (const msg of messages) {
      const hasToolResults = msg.tool_results && msg.tool_results.length > 0;
      if (msg.role === "user" && !hasToolResults) {
        const text = msg.content?.trim();
        if (text) {
          firstUserMessage = text.slice(0, 200);
          if (text.length > 200) firstUserMessage += "...";
          break;
        }
      }
    }

    const title = conversation.title
      || firstUserMessage
      || (conversation.slug ? formatSlugAsTitle(conversation.slug) : null)
      || "Coding Session";

    // idle_summary is the purpose-built one-liner (same preference as the
    // session card's sessionCardSummary); subtitle is a multi-bullet block, so
    // only its first bullet fits a link preview.
    const description = conversation.idle_summary?.trim()
      || conversation.subtitle?.split("\n").find((l) => l.trim())?.trim().replace(/^[-*]\s+/, "")
      || (conversation.title ? firstUserMessage : null)
      || `${conversation.message_count || 0} messages${user?.name ? ` by ${user.name}` : ""}${conversation.project_path ? ` in ${conversation.project_path.split("/").pop()}` : ""}`;

    return {
      title,
      description,
      author: user?.name || null,
      message_count: conversation.message_count || 0,
    };
  },
});

export const getConversationMention = query({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return null;
    // Mention-pill enrichment leaks idle_summary/model/status/project_path.
    // Gate on real access — routing team_id is not a read grant.
    const viewerId = await getAuthUserId(ctx);
    if ((await checkConversationAccess(ctx, viewerId, conversation)) === "denied") {
      return null;
    }
    return {
      _id: conversation._id,
      title: conversation.title || "Session",
      message_count: conversation.message_count || 0,
      project_path: conversation.project_path || null,
      model: conversation.model || null,
      status: conversation.status || null,
      updated_at: conversation.updated_at || conversation._creationTime,
      idle_summary: conversation.idle_summary || null,
      agent_type: conversation.agent_type || null,
    };
  },
});

export const backfillAutoSharedConversations = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    dry_run: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const allMappings = await ctx.db.query("directory_team_mappings")
      .filter((q: any) => q.eq(q.field("auto_share"), true))
      .collect();

    if (allMappings.length === 0) {
      return { scanned: 0, fixed: 0, nextCursor: null, dry_run: !!args.dry_run };
    }

    const mappingsByKey = new Map<string, typeof allMappings>();
    for (const m of allMappings) {
      const key = `${m.user_id}|${m.team_id}`;
      const arr = mappingsByKey.get(key) || [];
      arr.push(m);
      mappingsByKey.set(key, arr);
    }

    const result = await ctx.db.query("conversations")
      .order("desc")
      .paginate({ cursor: args.cursor ?? null, numItems: 20 });

    let fixed = 0;
    for (const conv of result.page) {
      if (!conv.team_id || conv.is_private !== true || !conv.project_path) continue;

      const key = `${conv.user_id}|${conv.team_id}`;
      const userMappings = mappingsByKey.get(key);
      if (!userMappings) continue;

      const matchesMapping = userMappings.some(
        (m) => conv.project_path === m.path_prefix || conv.project_path!.startsWith(m.path_prefix + "/")
      );
      if (!matchesMapping) continue;

      if (!args.dry_run) {
        await patchConversationVisibility(ctx, conv, { is_private: false });
        // Grants teammate access without a comment write (matrix SRV-02).
        await advanceCommentsAccessRevision(ctx, conv);
      }
      fixed++;
    }

    const nextCursor = !result.isDone ? result.continueCursor : null;
    return { scanned: result.page.length, fixed, nextCursor, dry_run: !!args.dry_run };
  },
});

// One-shot repair for conversations stuck "shared with nobody": is_private is
// false but team_id is missing, so every teammate fails the !team_id gate and
// the conversation reads as private. Re-resolves the team via buildShareUpdate
// (directory mapping → owner's active/default team). User-scoped via the
// by_user_private index so it never full-scans. unresolved = owner has no team.
export const backfillSharedTeamlessTeamId = internalMutation({
  args: { user_id: v.id("users"), dry_run: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const shared = await ctx.db
      .query("conversations")
      .withIndex("by_user_private", (q) =>
        q.eq("user_id", args.user_id).eq("is_private", false)
      )
      .collect();
    const broken = shared.filter((c) => !c.team_id);

    let fixed = 0;
    const unresolved: Array<{ _id: string; title?: string; project_path?: string }> = [];
    for (const c of broken) {
      const { team_id } = await buildShareUpdate(ctx, c, args.user_id);
      if (!team_id) {
        unresolved.push({ _id: c._id, title: c.title, project_path: c.project_path });
        continue;
      }
      if (!args.dry_run) await patchConversationVisibility(ctx, c, { team_id });
      fixed++;
    }
    return { broken: broken.length, fixed, unresolved, dry_run: !!args.dry_run };
  },
});

export const revertBackfilledTeamVisibility = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    dry_run: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const result = await ctx.db.query("conversations")
      .order("desc")
      .paginate({ cursor: args.cursor ?? null, numItems: 50 });

    let fixed = 0;
    for (const conv of result.page) {
      if (conv.auto_shared && conv.team_visibility === "full" && conv.is_private === false) {
        if (!args.dry_run) {
          await patchConversationVisibility(ctx, conv, { team_visibility: undefined });
          // Team visibility is an access input (matrix SRV-02).
          await advanceCommentsAccessRevision(ctx, conv);
        }
        fixed++;
      }
    }

    const nextCursor = !result.isDone ? result.continueCursor : null;
    return { scanned: result.page.length, fixed, nextCursor, dry_run: !!args.dry_run };
  },
});

export const setParentConversation = mutation({
  args: {
    conversation_id: v.id("conversations"),
    parent_conversation_id: v.id("conversations"),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || conv.user_id !== userId) throw new Error("Not found");
    if (conv.parent_conversation_id) return;
    const isSubagent = !conv.parent_message_uuid;
    await ctx.db.patch(args.conversation_id, {
      parent_conversation_id: args.parent_conversation_id,
      is_subagent: isSubagent || undefined,
    });
  },
});

export const backfillIsSubagent = mutation({
  args: {
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");
    const batchSize = args.limit ?? 200;
    const result = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .paginate({ numItems: batchSize, cursor: args.cursor ?? null });

    let patched = 0;
    for (const conv of result.page) {
      if (conv.is_subagent !== undefined) continue;
      if (conv.parent_conversation_id && !conv.parent_message_uuid) {
        await ctx.db.patch(conv._id, { is_subagent: true });
        patched++;
      }
    }
    const nextCursor = !result.isDone ? result.continueCursor : null;
    return { scanned: result.page.length, patched, nextCursor };
  },
});

export const backfillParentConversationIds = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batchSize = args.limit ?? 50;
    const result = await ctx.db.query("conversations")
      .order("desc")
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize });

    let updated = 0;
    for (const conv of result.page) {
      if (conv.parent_message_uuid && !conv.parent_conversation_id) {
        const parentMsg = await ctx.db
          .query("messages")
          .withIndex("by_message_uuid", (q) => q.eq("message_uuid", conv.parent_message_uuid!))
          .first();
        if (parentMsg) {
          await ctx.db.patch(conv._id, {
            parent_conversation_id: parentMsg.conversation_id,
          });
          updated++;
        }
      }
    }

    return {
      updated,
      nextCursor: !result.isDone ? result.continueCursor : null,
      isDone: result.isDone,
    };
  },
});

export const getConversationsBySessionIds = query({
  args: {
    api_token: v.string(),
    session_ids: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) return { error: "Unauthorized" };

    const results: Array<{
      conversation_id: string;
      session_id: string;
      title: string;
      subtitle: string | null;
      message_count: number;
      updated_at: string;
      preview: string | null;
      agent_type: string | null;
      project_path: string | null;
    }> = [];

    for (const sessionId of args.session_ids.slice(0, 100)) {
      const conv = await findConversationBySessionReference(ctx as any, sessionId, authUserId);
      if (!conv) continue;

      let preview: string | null = null;
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
        .take(3);
      const firstUser = msgs.find((m) => m.role === "user" && m.content);
      if (firstUser) {
        preview = typeof firstUser.content === "string"
          ? firstUser.content.slice(0, 200)
          : null;
      }

      const title = conv.title || (preview ? preview.slice(0, 80) : "New Session");

      results.push({
        conversation_id: conv._id.toString(),
        session_id: sessionId,
        title,
        subtitle: conv.subtitle || null,
        message_count: conv.message_count ?? 0,
        updated_at: conv.updated_at
          ? new Date(conv.updated_at).toISOString()
          : new Date(conv._creationTime).toISOString(),
        preview,
        agent_type: conv.agent_type || null,
        project_path: conv.project_path || null,
      });
    }

    return { conversations: results };
  },
});

// ---- Shared inbox-session builders --------------------------------------
// Used by BOTH listInboxSessions (the live, windowed subscription) and
// listInboxSessionsPaginated (the additive completeness-floor crawl). Extracted
// so the two queries emit BYTE-IDENTICAL enriched rows — schema drift between
// the live channel and the crawl would clobber rich rows with thin ones when the
// store overlays by id (sessions sync is isDelta). See inbox_no_authoritative_sessions_floor.
// How far back a session's last activity (updated_at), or its dismiss/stash
// stamp, may be and still be PROACTIVELY pulled into the inbox. ONE source:
// the shared recency horizon the replica's selection (inWorkingSet) applies,
// so the scan and the selection can never disagree at the horizon. This is a
// fetch bound only: the client deliberately never prunes — its sessions cache
// is isDelta (never-prune), so anything already cached, or opened on demand
// via click/search (injectSession), stays. Pinned sessions keep their own
// window and are unaffected.
const INBOX_SESSION_WINDOW_MS = WORKING_SET_RECENCY_MS;
const INBOX_DISMISSED_WINDOW_MS = WORKING_SET_RECENCY_MS;

// Bounds on the team-mode ("team scope") candidate scan. The board pulls each
// teammate's recent team-visible sessions; caps keep a single recompute within
// the isolate's read budget even for a large team. Teams are small in practice,
// so these are generous — a per-member overflow just means the oldest of that
// member's recent sessions wait for the client's paginated crawl (not built yet
// for team scope; acceptable for the recency-windowed board).
const TEAM_INBOX_MEMBER_CAP = 50;
const TEAM_INBOX_PER_MEMBER_CAP = 60;
// Row caps of the five personal windows. Each window reads cap + 1 so overflow
// costs one row and names itself in `truncated` (sync-convergence C2). Single
// source: the shared caps the replica's selection also applies (C4).
const INBOX_WINDOW_CAP = INBOX_WINDOW_CAPS.recent;
// Pinned rows are a deliberate, bounded set (INBOX_PINNED_CAP, inboxProjection.ts):
// the window reads newest-first so the newest pins win, and the pin writers
// refuse past the cap so the limit is enforced where the user can see it.
// Pinned rows past the newest N skip the per-row children scan in non-show-all
// base executions (children are not counted; this was the read that hit the
// system-operation limit on the census).
const INBOX_PINNED_CHILDREN_SCAN = 20;

type InboxSessionMaps = {
  agentStatusMap: Map<string, AgentStatus>;
  agentStatusUpdatedAtMap: Map<string, number>;
  tmuxSessionMap: Map<string, string>;
  permissionModeMap: Map<string, string>;
  agentStartedAtMap: Map<string, number>;
  // The daemon's last verified open-task report per conversation (see
  // shared/contracts/openTasks): the "↳ Background …" rows the inbox draws
  // without messages, and what vouches for a "waiting" status past the decay.
  openTasksMap: Map<string, { tasks: any[]; at: number }>;
  liveConvIds: Set<string>;
  userDaemonAlive: boolean;
  // The time terms behind liveConvIds / userDaemonAlive, kept so the projection
  // can re-evaluate liveness at a later instant (bucket_stale_at) without a
  // read: newest heartbeat per conversation, and newest across the user's rows.
  lastHeartbeatMap: Map<string, number>;
  latestHeartbeat: number | undefined;
};

// A daemon whose newest heartbeat is inside this window is "alive" for the
// fallback that keeps a quiet, statusless row connected (see daemonAlive below).
const USER_DAEMON_ALIVE_MS = 6 * 60 * 1000;
// …and only rows updated inside this window ride that fallback.
const CONV_DAEMON_ALIVE_MS = 10 * 60 * 1000;

function heartbeatAliveAt(maps: Pick<InboxSessionMaps, "lastHeartbeatMap">, cid: string, now: number): boolean {
  const hb = maps.lastHeartbeatMap.get(cid);
  return hb !== undefined && now - hb < HEARTBEAT_ALIVE_MS;
}

function userDaemonAliveAt(maps: Pick<InboxSessionMaps, "latestHeartbeat">, now: number): boolean {
  return maps.latestHeartbeat !== undefined && now - maps.latestHeartbeat < USER_DAEMON_ALIVE_MS;
}

function noteHeartbeat(maps: Pick<InboxSessionMaps, "lastHeartbeatMap" | "liveConvIds">, cid: string, lastHeartbeat: number | undefined, now: number): void {
  if (typeof lastHeartbeat !== "number") return;
  const prev = maps.lastHeartbeatMap.get(cid);
  if (prev === undefined || lastHeartbeat > prev) maps.lastHeartbeatMap.set(cid, lastHeartbeat);
  if (heartbeatAliveAt(maps, cid, now)) maps.liveConvIds.add(cid);
}

// Whether the daemon's open-task report vouches for a "waiting" on this
// conversation right now (fresh, non-empty) — the fifth trustedAgentStatus arg.
function verifiedWaitingFor(maps: Pick<InboxSessionMaps, "openTasksMap">, cid: string, now: number): boolean {
  const rep = maps.openTasksMap.get(cid);
  return openTasksVouchForWaiting(rep?.at, rep?.tasks.length ?? 0, now);
}

// Build the per-user managed-session maps once, then look up by conversation id.
async function buildUserSessionMaps(
  ctx: any,
  userId: Id<"users">,
  now: number,
): Promise<InboxSessionMaps> {
  const managedSessions = await ctx.db
    .query("managed_sessions")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();

  const liveConvIds = new Set<string>();
  const lastHeartbeatMap = new Map<string, number>();
  let latestHeartbeat: number | undefined;
  for (const s of managedSessions) {
    if (typeof s.last_heartbeat === "number" && (latestHeartbeat === undefined || s.last_heartbeat > latestHeartbeat)) {
      latestHeartbeat = s.last_heartbeat;
    }
    if (s.conversation_id) noteHeartbeat({ lastHeartbeatMap, liveConvIds }, s.conversation_id.toString(), s.last_heartbeat, now);
  }

  const agentStatusMap = new Map<string, any>();
  const agentStatusUpdatedAtMap = new Map<string, number>();
  const tmuxSessionMap = new Map<string, string>();
  const permissionModeMap = new Map<string, string>();
  const agentStartedAtMap = new Map<string, number>();
  const openTasksMap = new Map<string, { tasks: any[]; at: number }>();
  for (const s of managedSessions) {
    if (!s.conversation_id) continue;
    const cid = s.conversation_id.toString();
    if (s.tmux_session) tmuxSessionMap.set(cid, s.tmux_session);
    if (s.permission_mode) permissionModeMap.set(cid, s.permission_mode);
    // Above the agent_status guard on purpose: a session whose status hasn't
    // been reported yet still has a process generation, and that is exactly
    // what decides whether its standing watches are real.
    if (s.agent_started_at !== undefined) agentStartedAtMap.set(cid, s.agent_started_at);
    if (s.open_tasks !== undefined && s.open_tasks_at !== undefined) openTasksMap.set(cid, { tasks: s.open_tasks, at: s.open_tasks_at });
    if (!s.agent_status) continue;
    if (s.agent_status_updated_at !== undefined) agentStatusUpdatedAtMap.set(cid, s.agent_status_updated_at);
    // Raw status. The heartbeat-staleness coercion lives in trustedAgentStatus
    // (consumers pass liveConvIds membership as heartbeatAlive) so it can weigh
    // the conversation's own activity — a lapsed heartbeat on a session that is
    // actively syncing messages must not read as dead.
    agentStatusMap.set(cid, s.agent_status);
  }

  const userDaemonAlive = userDaemonAliveAt({ latestHeartbeat }, now);

  return { agentStatusMap, agentStatusUpdatedAtMap, tmuxSessionMap, permissionModeMap, agentStartedAtMap, openTasksMap, liveConvIds, userDaemonAlive, lastHeartbeatMap, latestHeartbeat };
}

// Empty maps for the liveness-excluded path: computeInboxSessions({includeLiveness:false})
// skips the managed_sessions read entirely (that read is what makes the inbox query
// re-run on every heartbeat). The per-row liveness then computes from nothing and is
// stripped below — the live values ride the separate `sessionsLiveness` overlay instead.
const EMPTY_INBOX_MAPS: InboxSessionMaps = {
  agentStatusMap: new Map(),
  agentStatusUpdatedAtMap: new Map(),
  tmuxSessionMap: new Map(),
  permissionModeMap: new Map(),
  agentStartedAtMap: new Map(),
  openTasksMap: new Map(),
  liveConvIds: new Set(),
  userDaemonAlive: false,
  lastHeartbeatMap: new Map(),
  latestHeartbeat: undefined,
};

// Liveness for second-party-owned rows: their managed_sessions belong to the
// RUNNING account, which buildUserSessionMaps (scoped to the viewer's user_id)
// never sees. Fetch per conversation — owned foreign rows are sparse — and
// merge with the exact same status-trust rules. Deliberately leaves
// userDaemonAlive untouched: that flag describes the viewer's own daemon.
async function mergeForeignConversationLiveness(
  ctx: any,
  maps: InboxSessionMaps,
  convs: any[],
  now: number,
): Promise<void> {
  const managedRows = await Promise.all(convs.map((conv: any) => ctx.db
    .query("managed_sessions")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conv._id))
    .first()));
  for (let i = 0; i < convs.length; i++) {
    const conv = convs[i];
    const cid = conv._id.toString();
    const managed = managedRows[i];
    if (!managed) continue;
    noteHeartbeat(maps, cid, managed.last_heartbeat, now);
    if (managed.tmux_session) maps.tmuxSessionMap.set(cid, managed.tmux_session);
    if (managed.permission_mode) maps.permissionModeMap.set(cid, managed.permission_mode);
    if (managed.agent_started_at !== undefined) maps.agentStartedAtMap.set(cid, managed.agent_started_at);
    if (managed.open_tasks !== undefined && managed.open_tasks_at !== undefined) maps.openTasksMap.set(cid, { tasks: managed.open_tasks, at: managed.open_tasks_at });
    if (!managed.agent_status) continue;
    if (managed.agent_status_updated_at !== undefined) {
      maps.agentStatusUpdatedAtMap.set(cid, managed.agent_status_updated_at);
    }
    // Raw status — same contract as buildUserSessionMaps: trustedAgentStatus
    // applies the heartbeat coercion with conversation context.
    maps.agentStatusMap.set(cid, managed.agent_status);
  }
}

// The heartbeat-derived fields that move to the sessionsLiveness overlay. Stripped from
// the base rows when liveness is excluded so the client can't read a stale value before
// the overlay merges (it overlays these back, keyed by id, via syncOverlay).
//
// DERIVED from the shared INBOX_FACT_FIELDS constant (sync-convergence C1):
// the overlay owns exactly those fields, the strip list here and the client's
// preserve list both re-derive from it, and a signature test pins the split.
// The two fast fields change on every streamed message; a client that opts in
// (`fast_fields_in_overlay`) gets them from the overlay instead, so a streaming
// session no longer changes the list result and Convex stops re-pushing the
// whole ~1.7MB list on every token.
export const INBOX_FAST_FIELDS = ["message_count", "updated_at"] as const;
export const INBOX_LIVENESS_FIELDS = INBOX_FACT_FIELDS.filter(
  (f) => !(INBOX_FAST_FIELDS as readonly string[]).includes(f),
);
function stripInboxLiveness(row: any, fastFieldsToo = false): void {
  for (const f of INBOX_LIVENESS_FIELDS) row[f] = null;
  if (fastFieldsToo) for (const f of INBOX_FAST_FIELDS) row[f] = null;
}

// Enrich one conversation into the inbox session row, including the AskUserQuestion
// scrape, idle/grace classification, and plan/task/workflow context. `clusterCutoff`
// of 0 disables the stale-cluster hide (the crawl passes 0 — completeness wins).
// Debug-only cost knobs for the temporary timing harness (debugTmp.ts): each
// flag skips one class of per-row reads so their cost can be measured from
// outside (Date.now() is frozen inside a query). Production callers pass none.
export type InboxEnrichSkip = {
  children?: boolean;
  auq?: boolean;
  refs?: boolean;
};

// A db.get memoized on the PROMISE for one recompute: rows enrich concurrently,
// and two rows asking for the same plan, task, workflow run or user must share
// one read — every duplicate counts against the system-operation budget.
export function makeMemoGet(ctx: any): (id: any) => Promise<any> {
  const cache = new Map<string, Promise<any>>();
  return (id: any) => {
    const key = id.toString();
    let hit = cache.get(key);
    if (!hit) {
      hit = Promise.resolve(ctx.db.get(id)).catch(() => null);
      cache.set(key, hit);
    }
    return hit;
  };
}

async function enrichInboxSessionRow(
  ctx: any,
  conv: any,
  maps: InboxSessionMaps,
  now: number,
  // The row's fold flag (belowFoldFor over the caller's scan; false on the
  // paths that never fold — favorites, the completeness crawl, byIds).
  hidden: boolean,
  skip?: InboxEnrichSkip,
  getDoc: (id: any) => Promise<any> = (id) => ctx.db.get(id),
): Promise<{ row: any; subagentChildren: any[]; dismissed: boolean; stashed: boolean; hidden: boolean }> {
  let hasPending = !!conv.has_pending_messages;
  let lastMsgRole = conv.last_message_role;
  let lastUserMessage = conv.last_message_preview || null;

  // Fallback for un-backfilled conversations: single query to get last message
  if (!lastMsgRole && conv.message_count > 0) {
    const lastMsg = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q: any) =>
        q.eq("conversation_id", conv._id)
      )
      .order("desc")
      .first();
    if (lastMsg) {
      lastMsgRole = lastMsg.role;
      if (lastMsg.role === "user" && lastMsg.content?.trim()) {
        lastUserMessage = lastMsg.content
          .replace(/\[Image[:\s][^\]]*\]/gi, "")
          .replace(/<image\b[^>]*\/?>\s*(?:<\/image>)?/gi, "")
          .trim()
          .slice(0, 200);
      }
    }
  }

  const pinned = !!conv.inbox_pinned_at;
  const dismissed = !!conv.inbox_dismissed_at;
  const stashed = !!conv.inbox_stashed_at;

  // Stop trusting a frozen "active" status once the conversation has gone quiet
  // past the trust TTL — otherwise a daemon re-asserting a stale "working" over
  // content-free heartbeats pins the session in WORKING forever. Coerced here, at
  // the single enrichment boundary, so is_idle / the row's agent_status / the CLI
  // classifier all see the same trustworthy value.
  const agentStatus = trustedAgentStatus(
    maps.agentStatusMap.get(conv._id.toString()),
    conv.updated_at,
    now,
    maps.liveConvIds.has(conv._id.toString()),
    verifiedWaitingFor(maps, conv._id.toString(), now),
  );
  // Don't let userDaemonAlive resurrect sessions we know are stopped
  const daemonAlive = agentStatus === "stopped"
    ? false
    : maps.liveConvIds.has(conv._id.toString()) ||
      (userDaemonAliveAt(maps, now) && (now - conv.updated_at) < CONV_DAEMON_ALIVE_MS);

  // Even when the agent reports idle, recent activity (assistant just
  // finished streaming), pending messages, or a trailing user message all
  // mean work is in flight — don't flag as idle yet. The grace is measured
  // from the agent's status-change time, not conv.updated_at, so a syncing
  // message backlog can't hold a finished agent in "working". See
  // deriveSessionActivity / isSessionIdle.
  const activity = deriveSessionActivity({
    agentStatus,
    agentStatusUpdatedAt: maps.agentStatusUpdatedAtMap.get(conv._id.toString()),
    lastMessageRole: lastMsgRole,
    lastMessagePreview: lastUserMessage,
    hasPending,
    status: conv.status,
    updatedAt: conv.updated_at,
    daemonAlive,
    now,
  });
  let isIdle = activity.isIdle;
  const isUnresponsive = activity.isUnresponsive;

  // An open AskUserQuestion poll is the agent blocking on the user — it
  // belongs in "needs input", never "working". The daemon's agent_status is
  // raced (it sends permission_blocked once, then a later "working" signal
  // overwrites it while the poll is still open), so we derive the fact from
  // the authoritative data: the chronologically-latest message is the
  // assistant's AskUserQuestion tool_use (an answer would be a later-timestamped
  // tool_result, so if the poll is still last, it's unanswered).
  //
  // Gate only on the working bucket (!isIdle) to keep this off the idle path.
  // Do NOT pre-filter on conv.last_message_role — that field reflects sync
  // batch order, which can disagree with timestamp order (Claude writes the
  // poll's tool_use line out of order relative to surrounding entries), so it
  // would miss exactly the blocked sessions we care about. The order("desc")
  // read below is authoritative.
  let awaitingInput = false;
  if (!skip?.auq && !isIdle && conv.message_count > 0) {
    const lastMsg = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q: any) =>
        q.eq("conversation_id", conv._id)
      )
      .order("desc")
      .first();
    if (lastMsg?.role === "assistant" && lastMsg.tool_calls?.some((tc: any) => tc.name === "AskUserQuestion")) {
      awaitingInput = true;
      isIdle = true; // blocked on the user, not actively working
    }
  }

  const deferred = conv.inbox_deferred_at && conv.inbox_deferred_at >= conv.updated_at;

  let implementationSession: { _id: string; title?: string } | undefined;
  const subagentChildren: any[] = [];
  // Parked (dismissed/stashed) rows skip the children scan entirely: every
  // caller discards their subagent children (a parked parent's children never
  // render), and the "producing child keeps parent working" refinement is
  // deliberately never applied to parked rows — same rule as
  // enrichLivenessFields, whose overlay value wins on the web client anyway.
  // This scan was one indexed query per shown row, and parked rows are the
  // bulk of a heavy account's window (483 of 547 on the census that hit
  // "too many system operations"). Their implementation-session pointer is
  // re-resolved from the candidate pool by computeInboxSessions.
  if (!skip?.children && !dismissed && !stashed && conv.message_count > 0) {
    // Newest-first: a workflow orchestrator can have dozens of finished
    // children (jx70xxy stood at 72 across four runs); ascending order fills
    // the cap with the oldest wave and never reaches the agents running NOW,
    // so the parent read "idle" while six workers were producing.
    const children = await ctx.db
      .query("conversations")
      .withIndex("by_parent_conversation_id", (q: any) =>
        q.eq("parent_conversation_id", conv._id)
      )
      .order("desc")
      .take(20);
    const implChild = children.find(
      (c: any) => c.parent_message_uuid === "plan-handoff" && !c.is_subagent
    );
    if (implChild) {
      implementationSession = { _id: implChild._id.toString(), title: implChild.title };
    }
    // Keep an idle parent in "working" only while a subagent child is genuinely
    // PRODUCING, not merely alive (see subagentKeepsParentWorking). A forked
    // subagent that finished but whose daemon keeps heartbeating used to pin its
    // parent in "working" forever. We pass the child's agent_status already
    // coerced for heartbeat staleness, the same coercion the parent gets below.
    if (isIdle && children.some((c: any) => {
      const cid = c._id.toString();
      return subagentKeepsParentWorking({
        isSubagent: !!c.is_subagent,
        convStatus: c.status,
        updatedAt: c.updated_at,
        isLive: maps.liveConvIds.has(cid),
        agentStatus: trustedAgentStatus(maps.agentStatusMap.get(cid), c.updated_at, now, maps.liveConvIds.has(cid)),
        now,
      });
    })) {
      isIdle = false;
    }
    for (const c of children) {
      if ((c.is_subagent || (c.parent_conversation_id && !c.parent_message_uuid)) && c.message_count > 0) {
        subagentChildren.push(c);
      }
    }
  }

  let active_plan: { _id: string; short_id: string; title: string; status: string } | undefined;
  if (!skip?.refs && conv.active_plan_id) {
    const p = await getDoc(conv.active_plan_id);
    if (p) active_plan = { _id: p._id, short_id: p.short_id, title: p.title, status: p.status };
  }

  let active_task: { _id: string; short_id: string; title: string; status: string } | undefined;
  if (!skip?.refs && conv.active_task_id) {
    const t = await getDoc(conv.active_task_id);
    if (t) active_task = { _id: t._id, short_id: t.short_id, title: t.title, status: t.status };
  }

  // The card's workflow bar renders from these scalars alone (the run doc is
  // already in hand — zero extra reads): identity, progress, and the latest
  // running agent's "what it's doing" line.
  let workflow_run_status: string | null = null;
  let workflow_run_name: string | null = null;
  let workflow_run_agents_done: number | null = null;
  let workflow_run_agents_total: number | null = null;
  let workflow_run_activity: string | null = null;
  let workflow_run_started_at: number | null = null;
  if (!skip?.refs && conv.workflow_run_id) {
    const run = await getDoc(conv.workflow_run_id);
    if (run) {
      workflow_run_status = run.status;
      workflow_run_name = run.workflow_name ?? null;
      const nodes = run.node_statuses ?? [];
      workflow_run_agents_total = run.agent_count ?? (nodes.length || null);
      workflow_run_agents_done = nodes.filter((n: any) => n.status === "completed").length;
      const runningNode = [...nodes].reverse().find((n: any) => n.status === "running");
      workflow_run_activity = runningNode?.activity || runningNode?.label || null;
      workflow_run_started_at = run.created_at ?? null;
    }
  }

  // Anchor identity: a personal anchor's bot isn't in the team roster, so the
  // client can't resolve it — stamp the bot's name/avatar here (self-guarded:
  // returns null for ordinary rows) so the sidebar shows the bot chip.
  const acting = skip?.refs ? null : await resolveActingAuthor(ctx, conv, getDoc);

  // Open teammate-comment threads (message, code-line, or global anchors) so
  // the card can surface "someone flagged this" without the conversation being
  // open. Read off the denormalized signal comments.refreshCommentSignal
  // maintains on the row — no per-row comments collect on this hot path.
  const open_comment_threads = conv.unresolved_comment_count ?? 0;

  const row = {
    _id: conv._id,
    session_id: conv.session_id,
    title: conv.title,
    subtitle: conv.subtitle,
    updated_at: conv.updated_at,
    started_at: conv.started_at,
    project_path: conv.project_path,
    git_root: conv.git_root,
    git_branch: conv.git_branch,
    agent_type: conv.agent_type,
    model: conv.model ?? null,
    effort: conv.effort ?? null,
    message_count: conv.message_count,
    transcript_revision: conv.transcript_revision ?? 0,
    idle_summary: conv.idle_summary,
    // The agent's pinned "where this stands" line; the card shows its headline
    // in place of the generated summary. msg_count rides along so the card can
    // say how far the thread has moved since the agent wrote it.
    thread_state: conv.thread_state ?? null,
    thread_state_at: conv.thread_state_at ?? null,
    thread_state_msg_count: conv.thread_state_msg_count ?? null,
    thread_state_status: conv.thread_state_status ?? null,
    is_idle: isIdle,
    awaiting_input: awaitingInput,
    is_unresponsive: isUnresponsive,
    is_connected: !!daemonAlive,
    has_pending: hasPending,
    is_deferred: !!deferred,
    // The user's park gesture, current per isUserDormant, and the settle
    // classifier's verdict, current per isSettleVerdictCurrent — the client's
    // sessionRestState reads these next to agent_status to place a settled row
    // in Needs Input / Done / Dormant exactly as classifyWorkState does.
    is_dormant: isUserDormant(conv),
    inbox_dormant_at: conv.inbox_dormant_at ?? null,
    settle_verdict: isSettleVerdictCurrent(conv) ? (conv.settle_verdict ?? null) : null,
    is_pinned: pinned,
    inbox_pinned_at: conv.inbox_pinned_at ?? null,
    inbox_dismissed_at: conv.inbox_dismissed_at ?? null,
    inbox_stashed_at: conv.inbox_stashed_at ?? null,
    inbox_stash_hidden: conv.inbox_stash_hidden ?? null,
    // The retired marker: classifyWorkState uses it to keep a killed row out of
    // the Working bucket no matter what stale flags it still carries.
    inbox_killed_at: conv.inbox_killed_at ?? null,
    agent_status: agentStatus,
    tmux_session: maps.tmuxSessionMap.get(conv._id.toString()) ?? null,
    permission_mode: maps.permissionModeMap.get(conv._id.toString()) ?? null,
    agent_started_at: maps.agentStartedAtMap.get(conv._id.toString()) ?? null,
    open_tasks: maps.openTasksMap.get(conv._id.toString())?.tasks ?? null,
    open_tasks_at: maps.openTasksMap.get(conv._id.toString())?.at ?? null,
    last_user_message: lastUserMessage,
    // Newest image in the conversation (see schema) — the inbox row thumbnail.
    // Presence doubles as "this session has images".
    image_preview_url: conv.image_preview_url ?? null,
    open_comment_threads,
    // Who spoke last in the open threads and what they said — the chip's
    // "Alice: typo in step 2" without any per-row query. author_id is a users
    // id string or "agent"; the client mutes the chip when it's the viewer.
    last_comment_author: conv.last_comment_author ?? null,
    last_comment_author_id: conv.last_comment_author_id ?? null,
    last_comment_excerpt: conv.last_comment_excerpt ?? null,
    last_comment_at: conv.last_comment_at ?? null,
    session_error: conv.session_error,
    // True when the latest turn is an unresolved Claude Code auth/API-error
    // banner ("Please run /login · API Error: 401 …", "You've hit your session
    // limit · resets 11:30pm"). The CLI got signed out, rejected, or
    // rate-limited mid-turn and the session is parked waiting on the user (or
    // the limit reset). Cleared automatically once a real turn supersedes the
    // banner (see messages.ts / apiErrorBatchAction). The kind ("auth" |
    // "limit" | "error") picks the session-pill label.
    pending_api_error: conv.pending_api_error === true,
    pending_api_error_kind: conv.pending_api_error_kind ?? null,
    pending_api_error_at: conv.pending_api_error_at ?? null,
    implementation_session: implementationSession,
    active_plan,
    active_task,
    worktree_name: conv.worktree_name,
    worktree_branch: conv.worktree_branch,
    workflow_run_id: conv.workflow_run_id || null,
    is_workflow_primary: conv.is_workflow_primary || false,
    workflow_run_status,
    workflow_run_name,
    workflow_run_agents_done,
    workflow_run_agents_total,
    workflow_run_activity,
    workflow_run_started_at,
    // Schedule that spawned this conversation as a run (see schema) — lets the
    // sidebar badge and the schedule strip attribute ANY run, not just the
    // latest one webList can resolve from last_run_session_uuid.
    agent_task_id: conv.agent_task_id?.toString() || null,
    // Denormalized armed inject-trigger state (see schema) — the classifier's
    // structural dormancy input, read off the row instead of agent_tasks.
    armed_trigger_kind: conv.armed_trigger_kind ?? null,
    // Harness /loop state (see loopState.ts) — an armed self-wakeup makes this
    // session a standing machine intent, so the trigger set can row it like an
    // armed trigger. Stopped loops are a server-side tombstone only.
    loop_state: conv.loop_state && conv.loop_state.status !== "stopped" ? conv.loop_state : null,
    forked_from: conv.forked_from?.toString() || null,
    // Parent-link fields so a session emitted via THIS top-level scan self-identifies
    // as a subagent and nests under its parent (a subagent active in the last 30d is
    // pulled in here too — recentConversations has no subagent filter). Without them
    // it renders as a loose flat card. See subagentLinkFields (ct-37439).
    ...subagentLinkFields(conv),
    // Visible-child pointer + agent-team identity (see schema): links a
    // teammate/spawned session to its parent WITHOUT the subagent
    // nesting/hiding that parent_conversation_id implies.
    spawned_by_conversation_id: conv.spawned_by_conversation_id?.toString() || null,
    agent_team_name: conv.agent_team_name ?? null,
    agent_name: conv.agent_name ?? null,
    parent_message_uuid: conv.parent_message_uuid || null,
    icon: conv.icon,
    icon_color: conv.icon_color,
    team_id: conv.team_id ?? null,
    is_private: conv.is_private ?? false,
    owner_device_id: (conv as any).owner_device_id ?? null,
    // Second-party owner (the member responsible for steering; see schema).
    // author/owner display names are stamped by computeInboxSessions, which
    // caches the user docs across rows.
    owner_user_id: (conv as any).owner_user_id?.toString() ?? null,
    user_id: conv.user_id,
    acting_user_id: (conv as any).acting_user_id ?? null,
    is_anchor: !!(conv as any).anchor_id,
    anchor_id: (conv as any).anchor_id ?? null,
    author_name: acting ? acting.name : undefined,
    author_avatar: acting ? acting.avatar : undefined,
    // Carried through so the client can filter the same session cache into the
    // Favorites view (a kept, long-term set) without a second row shape. The
    // favorites query below force-loads these regardless of the recency window.
    is_favorite: !!conv.is_favorite,
  };

  return { row, subagentChildren, dismissed, stashed, hidden };
}

// Build a subagent child row (lighter — children carry no AUQ/plan context).
function buildSubagentChildRow(child: any, maps: InboxSessionMaps, now: number, parentId: Id<"conversations">) {
  const childDaemon = maps.liveConvIds.has(child._id.toString());
  const childAgentStatus = trustedAgentStatus(
    maps.agentStatusMap.get(child._id.toString()),
    child.updated_at,
    now,
    childDaemon,
    verifiedWaitingFor(maps, child._id.toString(), now),
  );
  const childRecentlyUpdated = (now - child.updated_at) < 45 * 1000;
  const childHasPending = !!child.has_pending_messages;
  const childAgentIdle = childAgentStatus ? !ACTIVE_AGENT_STATUSES.has(childAgentStatus) : false;
  const childIsIdle = childAgentStatus
    ? childAgentIdle && !childHasPending
    : childDaemon
      ? !childHasPending && !childRecentlyUpdated
      : !childRecentlyUpdated;
  return {
    _id: child._id,
    session_id: child.session_id,
    title: child.title,
    subtitle: child.subtitle,
    updated_at: child.updated_at,
    started_at: child.started_at,
    project_path: child.project_path,
    git_root: child.git_root,
    git_branch: child.git_branch,
    agent_type: child.agent_type,
    model: child.model ?? null,
    message_count: child.message_count,
    transcript_revision: child.transcript_revision ?? 0,
    idle_summary: child.idle_summary,
    thread_state: child.thread_state ?? null,
    thread_state_at: child.thread_state_at ?? null,
    thread_state_msg_count: child.thread_state_msg_count ?? null,
    thread_state_status: child.thread_state_status ?? null,
    is_idle: childIsIdle,
    awaiting_input: false,
    is_unresponsive: false,
    is_connected: !!childDaemon,
    has_pending: !!child.has_pending_messages,
    is_deferred: false,
    is_pinned: false,
    inbox_pinned_at: null,
    inbox_dismissed_at: child.inbox_dismissed_at ?? null,
    inbox_stashed_at: child.inbox_stashed_at ?? null,
    inbox_stash_hidden: child.inbox_stash_hidden ?? null,
    inbox_killed_at: child.inbox_killed_at ?? null,
    agent_status: childAgentStatus,
    tmux_session: maps.tmuxSessionMap.get(child._id.toString()) ?? null,
    permission_mode: maps.permissionModeMap.get(child._id.toString()) ?? null,
    agent_started_at: maps.agentStartedAtMap.get(child._id.toString()) ?? null,
    open_tasks: maps.openTasksMap.get(child._id.toString())?.tasks ?? null,
    open_tasks_at: maps.openTasksMap.get(child._id.toString())?.at ?? null,
    last_user_message: null,
    session_error: child.session_error,
    pending_api_error: child.pending_api_error === true,
    pending_api_error_kind: child.pending_api_error_kind ?? null,
    pending_api_error_at: child.pending_api_error_at ?? null,
    // Same parent-link fields as the top-level scan (subagentLinkFields), so the
    // two emission paths stay byte-consistent when the client dedups by _id. This
    // path is for confirmed children, so is_subagent is forced true (covers the
    // parent_message_uuid-less child that has no is_subagent flag of its own).
    ...subagentLinkFields({ is_subagent: true, parent_conversation_id: parentId }),
    spawned_by_conversation_id: child.spawned_by_conversation_id?.toString() || null,
    agent_team_name: child.agent_team_name ?? null,
    agent_name: child.agent_name ?? null,
    worktree_name: child.worktree_name,
    worktree_branch: child.worktree_branch,
    workflow_run_id: null,
    is_workflow_primary: false,
    workflow_run_status: null,
    workflow_run_name: null,
    workflow_run_agents_done: null,
    workflow_run_agents_total: null,
    workflow_run_activity: null,
    workflow_run_started_at: null,
    icon: child.icon,
    icon_color: child.icon_color,
    team_id: child.team_id ?? null,
    is_private: child.is_private ?? false,
    user_id: child.user_id,
  };
}

// Stable inbox ordering shared by the live query (the crawl leaves ordering to
// the client, which re-sorts via sortSessions anyway).
function sortInboxRows(results: any[]) {
  results.sort((a, b) => {
    if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
    const aNew = a.message_count === 0;
    const bNew = b.message_count === 0;
    if (aNew !== bNew) return aNew ? -1 : 1;
    if (a.is_idle !== b.is_idle) return a.is_idle ? -1 : 1;
    if (a.is_deferred !== b.is_deferred) return a.is_deferred ? 1 : -1;
    if (a.is_idle) return a.updated_at - b.updated_at;
    return b.started_at - a.started_at;
  });
}

// The live, windowed inbox computation. Extracted from the query handler so a
// test harness can drive it with an explicit userId (the query is auth-gated and
// can't be invoked via `npx convex run`).
// Shared inbox-conversation scan: the recent/pinned/dismissed/stashed/owned windows,
// explicit-extra hydration, per-user liveness maps, foreign-run liveness merge, and the
// stale-cluster cutoff. Extracted so the full inbox enrichment (computeInboxSessions)
// and the lightweight liveness overlay (computeSessionsLiveness) scan the SAME candidate
// set the same way — they only differ in what they enrich per row.
export async function scanInboxConversations(
  ctx: any,
  userId: Id<"users">,
  now: number,
  opts: { includeLiveness: boolean; extraConvIds?: string[]; teamScope?: Id<"teams"> },
): Promise<{
  conversations: any[];
  maps: InboxSessionMaps;
  // Rows that reached the candidate set by a deliberate act rather than by
  // recency: a label's filed extras, and sessions ASSIGNED to this user but run
  // by another account. Both are exempt from the cluster cutoff (they are old
  // by design — a parked label, a decision handed over days ago) and excluded
  // from the gap analysis so their age can't bridge a gap that should hide the
  // caller's own cruft.
  deliberateIds: Set<string>;
  clusterCutoff: number;
  // The shared selection's members and its fold set (computeFold, riders
  // included): a member's fold flag is read from here, never from the cut.
  selectionIds: ReadonlySet<string>;
  belowFold: ReadonlySet<string>;
  // Conversations in this user's owner set — drives the owned_by_me flag during
  // enrichment without a per-row session_owners lookup.
  ownedByMeIds: Set<string>;
  // My owner ROWS by conversation id — enrichment stamps assigned_ping off the
  // unacknowledged handoffs (added by someone else, seen_at unset).
  myOwnerRowById: Map<string, any>;
  // Every cap that fired, by name. Never silent (sync-convergence C2).
  truncated: Set<InboxTruncation>;
  // Pinned rows past the newest INBOX_PINNED_CHILDREN_SCAN, in pin order.
  pinnedOverflowIds: Set<string>;
}> {
  const dismissedCutoff = now - INBOX_DISMISSED_WINDOW_MS;
  const sessionWindowCutoff = now - INBOX_SESSION_WINDOW_MS;
  const truncated = new Set<InboxTruncation>();

  // Recent window is bounded by both the row cap AND the 30d activity window:
  // the index range stops the scan at the cutoff so old sessions are never read.
  // Pinned/dismissed have their own (separate) queries below and stay exempt.
  //
  // Subagent rows are excluded AT THE INDEX for every window. shouldShowInInbox
  // drops them anyway, but a busy account has more subagents than sessions in
  // its windows (320 of 621 candidates on one census — dismiss/stash cascade
  // to children, so the hide windows were mostly subagents), so reading them
  // cost more than the rows that survive, and they crowded real sessions out of
  // the 200-row caps. is_subagent is written as both `false` and absent, so a
  // top-level window is the union of two index ranges, merged newest-first.
  // Each range reads cap + 1 so a full window is distinguishable from an
  // overflowing one at the cost of one row.
  const topLevelWindow = (
    rangeFor: (isSubagent: false | undefined) => Promise<any[]>,
    sortKey: string,
    kind: InboxTruncation,
  ) => Promise.all([rangeFor(undefined), rangeFor(false)])
    .then(([a, b]: [any[], any[]]) => {
      const merged = [...a, ...b].sort((x, y) => y[sortKey] - x[sortKey]);
      if (merged.length > INBOX_WINDOW_CAP) truncated.add(kind);
      return merged.slice(0, INBOX_WINDOW_CAP);
    });

  const recentConversationsQ = topLevelWindow((isSubagent) => ctx.db
    .query("conversations")
    .withIndex("by_user_subagent_updated", (q: any) =>
      q.eq("user_id", userId).eq("is_subagent", isSubagent).gte("updated_at", sessionWindowCutoff)
    )
    .order("desc")
    .filter((q: any) => q.or(
      q.eq(q.field("status"), "active"),
      q.eq(q.field("status"), "completed")
    ))
    .take(INBOX_WINDOW_CAP + 1), "updated_at", "recent");

  // Newest pins first, so overflow drops the oldest pin, never a fresh one.
  const pinnedConversationsQ = ctx.db
    .query("conversations")
    .withIndex("by_user_pinned", (q: any) =>
      q.eq("user_id", userId).gt("inbox_pinned_at", 0)
    )
    .order("desc")
    .take(INBOX_PINNED_CAP + 1)
    .then((rows: any[]) => {
      if (rows.length > INBOX_PINNED_CAP) truncated.add("pinned");
      return rows.slice(0, INBOX_PINNED_CAP);
    });

  // Killed rows are excluded at the index for the same reason: a kill stamps
  // inbox_dismissed_at alongside inbox_killed_at (applyHideTransition), so the
  // dismissed window was mostly retired rows the filter throws away. A pinned
  // killed row still shows, and the pinned window below covers it.
  const dismissedConversationsQ = topLevelWindow((isSubagent) => ctx.db
    .query("conversations")
    .withIndex("by_user_live_dismissed", (q: any) =>
      q.eq("user_id", userId).eq("is_subagent", isSubagent).eq("inbox_killed_at", undefined).gte("inbox_dismissed_at", dismissedCutoff)
    )
    .order("desc")
    .take(INBOX_WINDOW_CAP + 1), "inbox_dismissed_at", "dismissed");

  // Stashed (set aside, agent still alive) mirror the dismissed window so the
  // Stashed bucket is populated even for rows older than the recent window.
  const stashedConversationsQ = topLevelWindow((isSubagent) => ctx.db
    .query("conversations")
    .withIndex("by_user_live_stashed", (q: any) =>
      q.eq("user_id", userId).eq("is_subagent", isSubagent).eq("inbox_killed_at", undefined).gte("inbox_stashed_at", dismissedCutoff)
    )
    .order("desc")
    .take(INBOX_WINDOW_CAP + 1), "inbox_stashed_at", "stashed");

  // Sessions this user OWNS — run by another member's account (e.g. Mr Bot) but
  // assigned to them — surface in the OWNER's inbox alongside their own.
  // Explicit assignment outranks default team visibility: routing a session into
  // someone's inbox is a deliberate act by someone who already had access.
  //
  // Reads the canonical owner SET (session_owners), NOT the denormalized
  // owner_user_id cache: a session may have several owners and the cache only
  // holds the primary, so a secondary owner's inbox would otherwise miss it.
  // Owner rows are keyed by user alone (no denormalized updated_at — that would
  // make every conversation heartbeat fan out and patch all of its owner rows),
  // so hydrate here and apply the same recency/status window as the main scan.
  const ownerRowsQ = ctx.db
    .query("session_owners")
    .withIndex("by_user", (q: any) => q.eq("user_id", userId))
    .order("desc")
    .take(INBOX_WINDOW_CAP + 1)
    .then((rows: any[]) => {
      if (rows.length > INBOX_WINDOW_CAP) truncated.add("owned");
      return rows.slice(0, INBOX_WINDOW_CAP);
    });
  // The five window scans are independent — issue them in ONE batched round
  // trip. This scan backs the heartbeat-hot sessionsLiveness/listInboxSessions
  // queries, whose latency was almost entirely sequential await depth (each
  // await is a db round trip; under load the sum crossed the system-op
  // timeout: "Your request timed out performing too many system operations").
  const [recentConversations, pinnedConversations, dismissedConversations, stashedConversations, ownerRows] =
    await Promise.all([recentConversationsQ, pinnedConversationsQ, dismissedConversationsQ, stashedConversationsQ, ownerRowsQ]);
  const ownedByMeIds = new Set<string>(
    ownerRows.map((r: any) => r.conversation_id.toString())
  );
  const myOwnerRowById = new Map<string, any>(
    ownerRows.map((r: any) => [r.conversation_id.toString(), r])
  );

  const byId = new Map<string, any>();
  for (const c of recentConversations) byId.set(c._id.toString(), c);
  for (const c of pinnedConversations) byId.set(c._id.toString(), c);
  const pinnedOverflowIds = new Set<string>(
    pinnedConversations.slice(INBOX_PINNED_CHILDREN_SCAN).map((c: any) => c._id.toString()),
  );
  for (const c of dismissedConversations) byId.set(c._id.toString(), c);
  for (const c of stashedConversations) byId.set(c._id.toString(), c);

  // Hydrate only the owned conversations the window scans above didn't already
  // fetch (an owned session of my OWN is usually in the recent window — the get
  // would be a wasted read on a query that re-runs every heartbeat).
  const ownerRowsToHydrate = ownerRows.filter((r: any) => !byId.has(r.conversation_id.toString()));
  const ownerHydrated = await Promise.all(
    ownerRowsToHydrate.map((r: any) => Promise.resolve(ctx.db.get(r.conversation_id)).catch(() => null))
  );
  for (const conv of ownerHydrated) {
    if (!conv) continue;
    if ((conv.updated_at ?? 0) < sessionWindowCutoff) continue;
    if (conv.status !== "active" && conv.status !== "completed") continue;
    byId.set(conv._id.toString(), conv);
  }

  // TEAM SCOPE (inbox "team mode"): fold every teammate's team-visible session
  // into the candidate set, on top of the caller's own sessions above — so the
  // team board is a SUPERSET of the personal inbox. Visibility uses the exact
  // same rule as the team feed and search (createTeamFeedFilter), so the two can
  // never disagree about what's shared. Only the recent window is scanned per
  // member (active/completed, not their personally dismissed/stashed rows — that
  // is the teammate's own triage, not this board's). The caller's own rows are
  // skipped here; they were already gathered by the by_user scans above (which
  // also cover the caller's PRIVATE sessions, correctly visible to themselves).
  if (opts.teamScope) {
    const teamFilter = await createTeamFeedFilter(ctx, opts.teamScope);
    const otherMemberIds = teamFilter.memberships
      .map((m) => m.user_id)
      .filter((id) => id.toString() !== userId.toString());
    if (otherMemberIds.length > TEAM_INBOX_MEMBER_CAP) truncated.add("members");
    const memberIds = otherMemberIds.slice(0, TEAM_INBOX_MEMBER_CAP);
    const memberScans = await Promise.all(memberIds.map((memberId) => ctx.db
      .query("conversations")
      .withIndex("by_team_user_updated", (q: any) =>
        q.eq("team_id", opts.teamScope).eq("user_id", memberId).gte("updated_at", sessionWindowCutoff)
      )
      .order("desc")
      .filter((q: any) => q.or(
        q.eq(q.field("status"), "active"),
        q.eq(q.field("status"), "completed")
      ))
      .take(TEAM_INBOX_PER_MEMBER_CAP + 1)));
    for (const memberScan of memberScans) {
      if (memberScan.length > TEAM_INBOX_PER_MEMBER_CAP) truncated.add("member_rows");
      const memberRecent = memberScan.slice(0, TEAM_INBOX_PER_MEMBER_CAP);
      for (const c of memberRecent) {
        if (byId.has(c._id.toString())) continue;
        if (c.inbox_dismissed_at || c.inbox_stashed_at) continue; // teammate's own triage
        if (!teamFilter.isVisible(c)) continue;
        byId.set(c._id.toString(), c);
      }
    }
  }

  // Hydrate explicitly-requested conversations the windows above missed.
  // Own or owned-by-me sessions only (the inbox is "mine"); cap mirrors the
  // window size.
  const extraIds = new Set(opts.extraConvIds ?? []);
  let extraBudget = 200;
  for (const idStr of extraIds) {
    if (byId.has(idStr) || extraBudget <= 0) continue;
    let conv: any = null;
    try { conv = await ctx.db.get(idStr as Id<"conversations">); } catch { conv = null; }
    if (!conv) continue;
    if (conv.user_id.toString() !== userId.toString()) {
      // Not the runner — admit only if they're an owner. ownedByMeIds covers the
      // rows the owner scan already saw; the lookup catches one filed past its
      // cap. Record it so enrichment stamps owned_by_me.
      const owned =
        ownedByMeIds.has(idStr) || (await isSessionOwner(ctx, conv._id, userId));
      if (!owned) continue;
      ownedByMeIds.add(idStr);
    }
    if (conv.status !== "active" && conv.status !== "completed") continue;
    byId.set(idStr, conv);
    extraBudget--;
  }
  const conversations = Array.from(byId.values());

  const deliberateIds = new Set<string>(extraIds);
  for (const c of conversations) {
    const idStr = c._id.toString();
    if (ownedByMeIds.has(idStr) && c.user_id.toString() !== userId.toString()) {
      deliberateIds.add(idStr);
    }
  }

  const maps = opts.includeLiveness
    ? await buildUserSessionMaps(ctx, userId, now)
    : EMPTY_INBOX_MAPS;

  // buildUserSessionMaps only covers managed_sessions belonging to THIS user;
  // an owned foreign-run session's daemon rows belong to the running account,
  // so merge its liveness per-conversation or the row would always classify as
  // dead/idle even while the runner's agent is actively working.
  const foreignConvs = conversations.filter((c) => c.user_id.toString() !== userId.toString());
  if (opts.includeLiveness && foreignConvs.length > 0) {
    await mergeForeignConversationLiveness(ctx, maps, foreignConvs, now);
  }

  // The fold cutoff comes from the SHARED selection + fold (sync-convergence
  // C4): selectWorkingSet over the caller's own and owned rows (teammate rows
  // are outside the personal selection — team scope is outside the compare),
  // then computeFold's 12h gap cut over the recent-only members. Pinned,
  // dismissed, stashed and owned rows are deliberate and neither fold nor
  // bridge a gap; deliberately-filed rows (label extras, sessions assigned to
  // me) are outside the selection and fold-exempt on every channel — which is
  // what makes inboxForCLI's cutoff identical to the overlay's even when the
  // CLI hydrates extras the overlay never sees. A window the selection
  // overflows names itself in `truncated` like the scan's own caps.
  const uidStr = userId.toString();
  const selectionInput: any[] = [];
  for (const c of conversations) {
    const idStr = c._id.toString();
    if (c.user_id.toString() !== uidStr && !ownedByMeIds.has(idStr)) continue;
    selectionInput.push(ownedByMeIds.has(idStr) ? { ...c, owned_by_me: true } : c);
  }
  const selection = selectWorkingSet(selectionInput, now);
  for (const kind of selection.truncated) truncated.add(kind);
  const { cutoff: clusterCutoff, belowFold } = computeFold(selection.members);

  return {
    conversations, maps, deliberateIds, clusterCutoff, selectionIds: new Set(selection.members.keys()), belowFold,
    ownedByMeIds, myOwnerRowById, truncated, pinnedOverflowIds,
  };
}

// The per-row fold flag over a scan: a selection member reads the shared fold
// set (so a teammate folds with its lead — computeFold's ride), and a row
// outside the selection (a team row, a filed extra, an assigned session) reads
// the per-row cut, 0 for the deliberate ones. Pure over the doc and the scan
// so the base list, the liveness overlay and the CLI agree byte for byte.
export function belowFoldFor(
  scan: { selectionIds: ReadonlySet<string>; belowFold: ReadonlySet<string>; deliberateIds: ReadonlySet<string>; ownedByMeIds: ReadonlySet<string>; clusterCutoff: number },
  conv: { _id: { toString(): string } | string; updated_at: number; has_pending_messages?: boolean | null; inbox_pinned_at?: number | null; inbox_dismissed_at?: number | null; inbox_stashed_at?: number | null },
): boolean {
  const cid = conv._id.toString();
  if (scan.selectionIds.has(cid)) return scan.belowFold.has(cid);
  return isBelowFoldAt(conv as any, scan.deliberateIds.has(cid) || scan.ownedByMeIds.has(cid) ? 0 : scan.clusterCutoff);
}

// `truncated` as the payload carries it: the fixed alphabet's order, so two
// executions that hit the same caps serialize identically.
function truncatedList(truncated: Set<InboxTruncation>): InboxTruncation[] {
  return INBOX_TRUNCATION_KINDS.filter((k) => truncated.has(k));
}

export async function computeInboxSessions(
  ctx: any,
  userId: Id<"users">,
  opts: {
    show_all?: boolean;
    includeLiveness?: boolean;
    fastFieldsInOverlay?: boolean;
    // Explicitly-requested conversations (a label's filed set) hydrated into the
    // candidate pool regardless of the recency window — labels exist to park old
    // sessions. Deliberately filed, so also exempt from cluster-hiding.
    extraConvIds?: string[];
    // Inbox "team mode": also fold in every teammate's team-visible session from
    // this team (superset of the personal inbox). See scanInboxConversations.
    teamScope?: Id<"teams">;
    // Stamp every top-level row with the inbox projection (bucket, work_state,
    // asking, below_fold) through the shared placement function. Only the CLI
    // inbox opts in: the web base list must never carry a bucket (the overlay
    // owns it — sync-convergence C1). Requires includeLiveness.
    projection?: boolean;
    // Debug-only (timing harness) — see InboxEnrichSkip.
    _skip?: InboxEnrichSkip;
  },
): Promise<{ sessions: any[]; hidden_count: number; truncated: InboxTruncation[] }> {
  // Liveness (agent_status/is_idle/...) is heartbeat-derived and is the reason this
  // query re-runs ~every second. The live web subscription opts OUT (includeLiveness:
  // false) and gets those fields from the lightweight `sessionsLiveness` overlay; all
  // other callers (inboxForCLI, listInboxSessionsPaginated) default to true and are
  // unchanged. Default MUST stay true — inboxForCLI classifies work-state from it.
  const includeLiveness = opts.includeLiveness !== false;
  // The AUQ probe (one last-message read per non-idle row) exists to compute
  // awaiting_input / is_idle — fields stripInboxLiveness nulls when liveness is
  // excluded, so on that path the read is pure waste. The web's live
  // subscription gets those fields from the sessionsLiveness overlay instead.
  const enrichSkip: InboxEnrichSkip | undefined = includeLiveness
    ? opts._skip
    : { ...(opts._skip ?? {}), auq: true };
  // The projection clock: every window bound, the cluster cut and every
  // liveness threshold compare against the minute, so two executions inside
  // one minute over the same data are byte identical (sync-convergence C2).
  const now = inboxEpoch(Date.now());
  const scan = await scanInboxConversations(ctx, userId, now, {
    includeLiveness,
    extraConvIds: opts.extraConvIds,
    teamScope: opts.teamScope,
  });
  const { conversations, maps, ownedByMeIds, myOwnerRowById, truncated, pinnedOverflowIds } = scan;

  let hiddenCount = 0;
  const results: any[] = [];
  // Parked rows skip the per-row children scan (see enrichInboxSessionRow), so
  // their implementation-session pointer resolves from the candidate pool
  // instead — a recently active plan-handoff child is already in the recent
  // window, zero extra reads. Newest child wins, matching the scan's order.
  const implHandoffByParent = new Map<string, any>();
  for (const c of conversations) {
    if (c.parent_conversation_id && c.parent_message_uuid === "plan-handoff" && !c.is_subagent) {
      const pid = c.parent_conversation_id.toString();
      const prev = implHandoffByParent.get(pid);
      if (!prev || (c.started_at ?? 0) > (prev.started_at ?? 0)) implHandoffByParent.set(pid, c);
    }
  }
  // One memoized get for every per-row reference (plan/task/workflow run, the
  // acting bot, run-by / owner users): rows share these ids heavily, and each
  // duplicate read counts against the same system-operation budget.
  const getDoc = makeMemoGet(ctx);
  // Rows are independent — enrich them concurrently (sequential per-row awaits
  // made this heartbeat-hot path slow enough to time out under load; see
  // computeSessionsLiveness). Assembly below stays in candidate order.
  const shownConvs = conversations.filter((conv) => shouldShowInInbox(conv));
  const enrichedRows = await Promise.all(shownConvs.map(async (conv) => {
    // Deliberately-filed rows (label extras, sessions assigned to me by another
    // account) never cluster-hide: an assignment routes a session into my inbox
    // on purpose, and it stays there until I dismiss it — otherwise a decision
    // handed over on Friday is silently gone by Monday while `cast sessions`
    // with explicit ids still lists it as needs input. Owned rows are a
    // deliberate window in the shared selection (C4), so they are fold-exempt
    // for the same reason.
    // Pinned rows past the newest INBOX_PINNED_CHILDREN_SCAN skip the children
    // scan unless the caller asked for everything: children are never counted,
    // and the scan was the read that hit the system-operation limit.
    const rowSkip = !opts.show_all && pinnedOverflowIds.has(conv._id.toString())
      ? { ...(enrichSkip ?? {}), children: true }
      : enrichSkip;
    const { row, subagentChildren, dismissed, stashed, hidden } = await enrichInboxSessionRow(ctx, conv, maps, now, belowFoldFor(scan, conv), rowSkip, getDoc);
    if ((dismissed || stashed) && !row.implementation_session) {
      const impl = implHandoffByParent.get(conv._id.toString());
      if (impl) row.implementation_session = { _id: impl._id.toString(), title: impl.title };
    }
    if (conv.user_id.toString() !== userId.toString()) {
      const author = await getDoc(conv.user_id);
      row.author_name = author?.name ?? author?.email ?? null;
      row.author_email = author?.email ?? null;
    }
    // owned_by_me reflects membership in the session's owner SET (any owner, not
    // just the cached primary) — precomputed by the scan, so no per-row lookup.
    // owner_name/email stay the PRIMARY owner's: the list row shows a single
    // chip, and the full owner set is fetched on demand by the session panel.
    row.owned_by_me = ownedByMeIds.has(conv._id.toString());
    // Unacknowledged handoff: someone ELSE added me as an owner and I haven't
    // acked it. Stamped on the row so the sidebar can render it prominently;
    // ackSessionAssignment (or the in-conversation banner) clears it.
    const myRow = myOwnerRowById.get(conv._id.toString());
    if (myRow && !myRow.seen_at && myRow.added_by?.toString() !== userId.toString()) {
      const byDoc = await getDoc(myRow.added_by);
      row.assigned_ping = {
        by_name: byDoc?.name ?? byDoc?.email ?? "A teammate",
        note: myRow.note ?? null,
        at: myRow.added_at,
      };
    }
    if (conv.owner_user_id) {
      const ownerDoc = await getDoc(conv.owner_user_id);
      row.owner_name = ownerDoc?.name ?? null;
      row.owner_email = ownerDoc?.email ?? null;
    }
    return { conv, row, subagentChildren, dismissed, stashed, hidden };
  }));
  if (opts.projection && includeLiveness) {
    // The same placement the liveness overlay stamps (computeSessionsLiveness):
    // one classifier, one alphabet. The asking inputs come from the candidate
    // pool plus the children the per-row scans already read.
    const childrenByParent = groupPoolChildren(conversations);
    for (const r of enrichedRows) {
      if (r.subagentChildren.length === 0) continue;
      const pid = r.conv._id.toString();
      const seen = new Set((childrenByParent.get(pid) ?? []).map((c: any) => c._id.toString()));
      const merged = [...(childrenByParent.get(pid) ?? [])];
      for (const c of r.subagentChildren) if (!seen.has(c._id.toString())) merged.push(c);
      childrenByParent.set(pid, merged);
    }
    // Decisions FIRST: a parent already asking through a pending `cast decide`
    // never spends child message probes (see buildAskingParents).
    const pendingDecisionIds = await loadPendingDecisionConvIds(ctx, userId);
    const { asking: askingParents } = await buildAskingParents(ctx, childrenByParent, maps, now, pendingDecisionIds);
    for (const r of enrichedRows) {
      const cid = r.conv._id.toString();
      const asking = ownAsk(r.row, r.conv) || pendingDecisionIds.has(cid) || askingParents.has(cid);
      const placement = placeConversationRow(r.conv, r.row, asking, r.row.last_user_message, now);
      r.row.bucket = placement.bucket;
      r.row.work_state = placement.work_state;
      r.row.asking = asking;
      r.row.below_fold = r.hidden;
    }
    // A teammate rides its lead's bucket here too (the shared
    // rideLeadPlacements), so `cast sessions` files the team where the
    // overlay and the web do.
    const byId = new Map(enrichedRows.map((r) => [r.conv._id.toString(), r]));
    rideLeadPlacements(new Map(enrichedRows.map((r) => [r.conv._id.toString(), r.row as { bucket: InboxBucket }])), (id) => byId.get(id)?.conv);
  }
  for (const r of enrichedRows) {
    if (r.hidden) {
      hiddenCount++;
      if (!opts.show_all) continue;
    }
    results.push(r.row);
    // Don't surface subagents under a dismissed/stashed parent — they used to be
    // invisible (parent was excluded from the idle query entirely) and
    // exposing them now would make active buckets pick them up as orphans.
    if (r.dismissed || r.stashed) continue;
    for (const child of r.subagentChildren) {
      results.push(buildSubagentChildRow(child, maps, now, r.conv._id));
    }
  }

  sortInboxRows(results);
  if (!includeLiveness) for (const row of results) stripInboxLiveness(row, opts.fastFieldsInOverlay === true);
  return { sessions: results, hidden_count: hiddenCount, truncated: truncatedList(truncated) };
}

export const listInboxSessions = query({
  args: {
    show_all: v.optional(v.boolean()),
    // Live subscription opts out of heartbeat-derived liveness (it rides the
    // separate `sessionsLiveness` overlay) so heartbeats stop re-pushing the whole
    // inbox. Defaults to true so older / un-redeployed clients that read liveness
    // straight off this query keep working unchanged.
    include_liveness: v.optional(v.boolean()),
    // Opt-in: omit message_count/updated_at from rows (they ride sessionsLiveness).
    fast_fields_in_overlay: v.optional(v.boolean()),
    // Ignored cache-buster: lets the recovery poll force a real round-trip
    // instead of being served the live subscription's stalled cache. See the
    // matching `_probe` arg on users.getCurrentUser.
    _probe: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { sessions: [], hidden_count: 0, truncated: [] };
    return computeInboxSessions(ctx, userId, {
      show_all: args.show_all,
      includeLiveness: args.include_liveness,
      fastFieldsInOverlay: args.fast_fields_in_overlay,
    });
  },
});

// Resolve which team the inbox "team mode" scopes to, membership-gated. A client
// may pass any activeTeamId, so this is a real access check, not a hint: the
// caller must actually belong to the team or nothing is returned. Falls back to
// the user's active/default team when no explicit team is passed.
async function resolveInboxTeamScope(
  ctx: any,
  userId: Id<"users">,
  activeTeamId?: Id<"teams">,
): Promise<Id<"teams"> | null> {
  const user = await ctx.db.get(userId);
  const teamId = activeTeamId ?? user?.active_team_id ?? user?.team_id;
  if (!teamId) return null;
  if (!(await isTeamMember(ctx, userId, teamId))) return null;
  return teamId as Id<"teams">;
}

// Inbox "team mode": the same fully-enriched inbox rows as listInboxSessions, but
// the candidate set is the whole team's team-visible sessions (superset of the
// caller's own). Membership-gated via resolveInboxTeamScope. Mirrors the
// personal query's liveness split — the live subscription passes
// include_liveness:false and rides teamSessionsLiveness — so team mode is as
// heartbeat-cheap as the personal inbox.
export const listTeamInboxSessions = query({
  args: {
    activeTeamId: v.optional(v.id("teams")),
    show_all: v.optional(v.boolean()),
    include_liveness: v.optional(v.boolean()),
    _probe: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { sessions: [], hidden_count: 0, truncated: [], team_id: null };
    const teamScope = await resolveInboxTeamScope(ctx, userId, args.activeTeamId);
    if (!teamScope) return { sessions: [], hidden_count: 0, truncated: [], team_id: null };
    const result = await computeInboxSessions(ctx, userId, {
      show_all: args.show_all,
      includeLiveness: args.include_liveness,
      teamScope,
    });
    return { ...result, team_id: teamScope.toString() };
  },
});

// The heartbeat-derived fields the sessionsLiveness overlay ships — the exact set the
// full row (enrichInboxSessionRow) exposes and the web client merges via syncOverlay.
type LivenessFields = {
  agent_status: any;
  is_idle: boolean;
  is_unresponsive: boolean;
  awaiting_input: boolean;
  is_connected: boolean;
  tmux_session: string | null;
  permission_mode: string | null;
  // Start of the agent process currently behind this conversation. Rides the
  // overlay rather than the base row because it changes on restart, exactly
  // when the rest of the liveness picture does.
  agent_started_at: number | null;
  // The daemon's verified open background work (shared/contracts/openTasks) —
  // overlay-borne for the same reason: it changes when the session parks or
  // wakes, and the inbox draws its "↳ Background …" rows from it.
  open_tasks: any[] | null;
  open_tasks_at: number | null;
  // Fast fields (see INBOX_FAST_FIELDS): exact values for clients whose base
  // list omits them.
  message_count: number;
  updated_at: number;
  // Whether the newest user turn permits a structural park (machine-delivered
  // or absent — dormancy.lastTurnAllowsPark). Overlay-borne so the replica can
  // run the armed-trigger/loop park rule without the message body the server's
  // probe covered (sync-convergence C1).
  last_turn_allows_park: boolean;
};

// The projection stamps (sync-convergence C1/C3): the row's placement, its
// classifier verdict, the asking flag behind the questions bucket, the fold
// flag, and the time flip — computed once here, rendered everywhere.
export type InboxProjectionRowFields = {
  bucket: InboxBucket;
  work_state: WorkState;
  asking: boolean;
  below_fold: boolean;
  bucket_stale_at: number | null;
  stale_bucket: InboxBucket | null;
};

export type InboxLivenessRow = LivenessFields & InboxProjectionRowFields;

// A row in the overlay map: a projection MEMBER carries facts + stamps
// (InboxLivenessRow); a live probed CHILD carries facts only — no bucket key —
// so replicas can compute parent rollups from replicated child facts (C1).
export type InboxOverlayRow = LivenessFields & Partial<InboxProjectionRowFields>;

// The projection fields, by name: what the paginated / byIds / base channels
// must never carry (the overlay owns them), and what a client strips from
// every incoming sessions row before its merge. The list itself lives in the
// shared module (sync-convergence C1) so the client's strip list is the same
// constant; re-exported for existing importers.
export { INBOX_PROJECTION_FIELDS } from "@codecast/shared/contracts";

// Convex env kill switch for the digest compare (sync-convergence C8): with
// `npx convex env set INBOX_DIGEST_DISABLED 1` every overlay payload carries
// set_digest null and every deployed client skips compare and heal.
export function inboxDigestDisabled(): boolean {
  try {
    return process.env.INBOX_DIGEST_DISABLED === "1";
  } catch {
    return false;
  }
}

// Foreign-run parents (a session run by another account but in my inbox) are
// the one blind spot of the pool-derived child sets — their children never
// appear in my scans — so the newest N of them keep a per-parent children scan.
const FOREIGN_SCAN_BUDGET = 40;

// The child whose liveness we can answer from the maps. Own children carry a
// heartbeat in lastHeartbeatMap (buildUserSessionMaps); a child the maps never
// saw falls back to the liveConvIds set computed at the epoch, which is what
// hand-built maps in tests supply.
function isLiveAt(maps: Pick<InboxSessionMaps, "liveConvIds"> & Partial<Pick<InboxSessionMaps, "lastHeartbeatMap">>, cid: string, now: number): boolean {
  if (maps.lastHeartbeatMap?.has(cid)) return heartbeatAliveAt(maps as Pick<InboxSessionMaps, "lastHeartbeatMap">, cid, now);
  return maps.liveConvIds.has(cid);
}

// Does this child keep its parent in "working" at instant `now`? Pure over the
// child doc and the maps; see subagentKeepsParentWorking for the two proofs.
function childKeepsParentWorking(
  c: any,
  maps: Pick<InboxSessionMaps, "liveConvIds" | "agentStatusMap"> & Partial<Pick<InboxSessionMaps, "lastHeartbeatMap">>,
  now: number,
): boolean {
  const cid = c._id.toString();
  const live = isLiveAt(maps, cid, now);
  return subagentKeepsParentWorking({
    isSubagent: !!c.is_subagent,
    convStatus: c.status,
    updatedAt: c.updated_at,
    isLive: live,
    agentStatus: trustedAgentStatus(maps.agentStatusMap.get(cid), c.updated_at, now, live),
    now,
  });
}

// Children in the candidate pool, grouped by the parent their state rolls up
// to (the shared rollupParentIdOf rule — the replica's asking derivation
// groups by the same one): subagents and orphans, which are never members
// themselves, and agent-team teammates, whose asks surface on the lead. A plan
// handoff with its own inbox row is its own projection member and speaks for
// itself.
export function groupPoolChildren(pool: any[]): Map<string, any[]> {
  const byParent = new Map<string, any[]>();
  for (const c of pool) {
    const pid = rollupParentIdOf(c);
    if (!pid) continue;
    const list = byParent.get(pid);
    if (list) list.push(c);
    else byParent.set(pid, [c]);
  }
  return byParent;
}

// The parents that a producing subagent child should keep in "working", derived ONCE
// per recompute instead of a per-parent by_parent_conversation_id scan for every idle
// row (~one indexed query per row — the op-count blowout behind "too many system
// operations" timeouts on this heartbeat-hot path). The derivation is sound because
// subagentKeepsParentWorking accepts only two proofs, and both pools are already in
// hand: a child that synced output within the last 5 minutes sits at the top of the
// recent window scan, and a live child with an active agent status is in
// maps.liveConvIds (its doc hydrated by hydrateLivePool when the window missed it —
// bounded by the count of actually-live daemons). Pure over its inputs so it's
// unit-testable.
export function deriveProducingParents(
  pool: any[],
  maps: Pick<InboxSessionMaps, "liveConvIds" | "agentStatusMap"> & Partial<Pick<InboxSessionMaps, "lastHeartbeatMap">>,
  now: number,
): Set<string> {
  const parents = new Set<string>();
  for (const c of pool) {
    if (!c.parent_conversation_id) continue;
    if (childKeepsParentWorking(c, maps, now)) parents.add(c.parent_conversation_id.toString());
  }
  return parents;
}

// The candidate pool plus every live conversation the windows missed (a live
// child of a parent outside the window still keeps that parent working).
// The candidate pool the child rollups read: the scan's rows, every LIVE
// conversation (a producing child keeps its parent working), and every row
// holding a pending `cast decide` (a spawned worker's decision lifts its
// parent whether or not the worker is still live).
async function hydrateLivePool(ctx: any, conversations: any[], maps: InboxSessionMaps, extraIds: Iterable<string> = []): Promise<any[]> {
  const seen = new Set<string>(conversations.map((c: any) => c._id.toString()));
  const pool = [...conversations];
  const missingLiveIds = [...new Set([...maps.liveConvIds, ...extraIds])].filter((cid) => !seen.has(cid));
  const hydratedLive = await Promise.all(
    missingLiveIds.map((cid) => Promise.resolve(ctx.db.get(cid as Id<"conversations">)).catch(() => null))
  );
  for (const c of hydratedLive) if (c) pool.push(c);
  return pool;
}

// Newest message of a conversation — the one authoritative read behind both the
// un-backfilled last-role fallback and the AskUserQuestion probe.
async function newestMessage(ctx: any, convId: Id<"conversations">): Promise<any | null> {
  return ctx.db
    .query("messages")
    .withIndex("by_conversation_timestamp", (q: any) => q.eq("conversation_id", convId))
    .order("desc")
    .first();
}

// An open AskUserQuestion poll: the chronologically latest message is the
// assistant's AskUserQuestion tool_use (an answer would be a later-timestamped
// tool_result, so if the poll is still last, it's unanswered).
function isOpenAskUserQuestion(msg: any): boolean {
  return !!msg && msg.role === "assistant" && !!msg.tool_calls?.some((tc: any) => tc.name === "AskUserQuestion");
}

// Pending `cast decide` questions for the user: one indexed read per overlay
// execution (written only on post and answer, so it re-executes rarely).
export async function loadPendingDecisionConvIds(ctx: any, userId: Id<"users">): Promise<Set<string>> {
  const rows = await ctx.db
    .query("session_decisions")
    .withIndex("by_user_status", (q: any) => q.eq("user_id", userId).eq("status", "pending"))
    .collect();
  return new Set<string>(rows.map((r: any) => r.conversation_id.toString()));
}

// The child AUQ probe answers, cached across executions by (child id,
// message_count): a heartbeat re-execution over an unchanged fleet pays zero
// newest-message reads for its children. Sound because message_count moves on
// every message insert (an AUQ answer is a new tool_result message), and the
// child's conversation doc is in the subscription's read set through the pool
// scan — so a change re-executes with a fresh key. Bounded; cleared wholesale
// at the cap rather than tracking recency.
const CHILD_AUQ_PROBE_CACHE_MAX = 4096;
const childAuqProbeCache = new Map<string, boolean>();
export function _resetChildAuqProbeCacheForTests(): void {
  childAuqProbeCache.clear();
}

// Parents with a child that is asking: a child whose trusted status is
// permission_blocked (from the maps), or a child with an open AskUserQuestion —
// the same probe as the parent's own, run only for children with a non-idle
// trusted status and content, so it is bounded by live children.
//
// Read discipline (pinned by the overlay read-budget test): set membership is
// checked BEFORE a probe is enqueued — a parent already asking through a
// pending `cast decide` (alreadyAsking) or a sibling's permission block never
// spends a message read — and cache hits answer without one.
export async function buildAskingParents(
  ctx: any,
  childrenByParent: Map<string, any[]>,
  maps: Pick<InboxSessionMaps, "liveConvIds" | "agentStatusMap" | "openTasksMap"> & Partial<Pick<InboxSessionMaps, "lastHeartbeatMap">>,
  now: number,
  alreadyAsking?: ReadonlySet<string>,
): Promise<{ asking: Set<string>; probedAuqOpen: Map<string, boolean> }> {
  const asking = new Set<string>();
  const probedAuqOpen = new Map<string, boolean>();
  const probes: Array<{ pid: string; cid: string; convId: Id<"conversations">; key: string }> = [];
  for (const [pid, children] of childrenByParent) {
    if (alreadyAsking?.has(pid)) { asking.add(pid); continue; }
    for (const c of children) {
      const cid = c._id.toString();
      if (c.inbox_killed_at) continue;
      // A child's own pending `cast decide` (a spawned subagent worker posts
      // on ITS session) lifts the parent exactly as its open prompt does.
      if (alreadyAsking?.has(cid)) { asking.add(pid); break; }
      if ((c.message_count ?? 0) === 0) continue;
      const status = trustedAgentStatus(
        maps.agentStatusMap.get(cid), c.updated_at, now, isLiveAt(maps, cid, now), verifiedWaitingFor(maps, cid, now),
      );
      if (status === "permission_blocked") { asking.add(pid); break; }
      if (status !== undefined && status !== "idle") {
        const key = `${cid}:${c.message_count ?? 0}`;
        const hit = childAuqProbeCache.get(key);
        if (hit !== undefined) {
          probedAuqOpen.set(cid, hit);
          if (hit) { asking.add(pid); break; }
        } else {
          probes.push({ pid, cid, convId: c._id, key });
        }
      }
    }
  }
  // `undefined` marks a probe skipped because its parent resolved first — a
  // skipped probe is never cached (its answer was never read).
  const results = await Promise.all(probes.map((p) => asking.has(p.pid) ? undefined : newestMessage(ctx, p.convId)));
  probes.forEach((p, i) => {
    const msg = results[i];
    if (msg === undefined) return;
    const open = isOpenAskUserQuestion(msg);
    if (childAuqProbeCache.size >= CHILD_AUQ_PROBE_CACHE_MAX) childAuqProbeCache.clear();
    childAuqProbeCache.set(p.key, open);
    probedAuqOpen.set(p.cid, open);
    if (open) asking.add(p.pid);
  });
  return { asking, probedAuqOpen };
}

// A row's own ask: an open AskUserQuestion poll or a permission prompt. An
// infrastructure park is not a decision: a row whose newest turn is an
// unresolved login / limit / dropped-connection banner (BLOCKED_BANNER_KINDS)
// is blocked on plumbing, and files needs_input through the pendingApiError
// arm — the same exception the web decision queue applies
// (lib/decisionQueue sessionHasOpenQuestion), so both sides share one rule.
export function ownAsk(
  lv: { awaiting_input?: boolean | null; agent_status?: string | null },
  conv?: { pending_api_error_kind?: string | null },
): boolean {
  if (conv?.pending_api_error_kind && BLOCKED_BANNER_KINDS.has(conv.pending_api_error_kind)) return false;
  return !!lv.awaiting_input || lv.agent_status === "permission_blocked";
}

// The one placement call for a conversation, from the doc plus its
// liveness-shaped fields (the overlay's derived values or the enriched row's —
// same names, same meaning). Both the overlay and inboxForCLI go through here.
export function placeConversationRow(
  conv: any,
  lv: { agent_status?: string | null; is_idle?: boolean | null; awaiting_input?: boolean | null; is_unresponsive?: boolean | null },
  asking: boolean,
  lastUserMessage: string | null | undefined,
  now: number,
): InboxPlacement {
  // Delegates to the SHARED row adapter (placeProjectableRow) so the server and
  // every replica build the identical InboxPlacementInput from the identical
  // fields — a placement rule cannot exist on one side only (C3). The probed
  // lastUserMessage overrides the row's own preview (it covers the
  // un-backfilled fallback), and the loop park is time-dependent, so the
  // caller's clock rides through: the time-flip machinery re-runs this at
  // future instants and rowTimeDeadlines carries the loop's expiry boundary.
  return placeProjectableRow(
    {
      ...conv,
      agent_status: lv.agent_status ?? null,
      is_idle: lv.is_idle ?? null,
      awaiting_input: lv.awaiting_input ?? null,
      is_unresponsive: lv.is_unresponsive ?? null,
      last_message_preview: lastUserMessage ?? null,
      last_user_message: null,
      last_turn_allows_park: undefined,
    },
    asking,
    now,
  );
}

// Everything one liveness row needs that costs a read, gathered once per row at
// the epoch. The derivation over it (deriveLivenessAt) is pure in `now`, which
// is what lets the time flip re-run it at a later instant with zero reads.
type LivenessRowReads = {
  lastMsgRole: string | undefined;
  lastUserMessage: string | null;
  // The AskUserQuestion probe's answer. Gated on the working bucket (!isIdle at
  // the epoch) exactly as enrichInboxSessionRow gates it; a row idle at the
  // epoch is idle at every later instant (isIdle is monotone in time), so the
  // gate never re-opens and the answer stays valid for the flip.
  auqOpen: boolean;
};

// Lightweight twin of enrichInboxSessionRow's derivations, pure over the reads:
// trustedAgentStatus / deriveSessionActivity / the AUQ answer /
// subagentKeepsParentWorking, so the overlay never drifts from the bundled row.
function deriveLivenessAt(
  conv: any,
  maps: InboxSessionMaps,
  reads: LivenessRowReads,
  producing: (now: number) => boolean,
  now: number,
): LivenessFields {
  const cid = conv._id.toString();
  const hasPending = !!conv.has_pending_messages;
  const live = isLiveAt(maps, cid, now);
  const agentStatus = trustedAgentStatus(maps.agentStatusMap.get(cid), conv.updated_at, now, live, verifiedWaitingFor(maps, cid, now));
  const daemonAlive = agentStatus === "stopped"
    ? false
    : live || (userDaemonAliveAt(maps, now) && (now - conv.updated_at) < CONV_DAEMON_ALIVE_MS);

  const activity = deriveSessionActivity({
    agentStatus,
    agentStatusUpdatedAt: maps.agentStatusUpdatedAtMap.get(cid),
    lastMessageRole: reads.lastMsgRole,
    lastMessagePreview: reads.lastUserMessage,
    hasPending,
    status: conv.status,
    updatedAt: conv.updated_at,
    daemonAlive,
    now,
  });
  let isIdle = activity.isIdle;
  const isUnresponsive = activity.isUnresponsive;

  // An open AskUserQuestion poll is the agent blocking on the user — it belongs in
  // "needs input", never "working". Same !isIdle gate as enrichInboxSessionRow.
  let awaitingInput = false;
  if (!isIdle && conv.message_count > 0 && reads.auqOpen) {
    awaitingInput = true;
    isIdle = true; // blocked on the user, not actively working
  }

  // Keep an idle parent in "working" only while a subagent child is genuinely
  // PRODUCING (see subagentKeepsParentWorking). Never for dismissed/stashed rows.
  if (isIdle && !conv.inbox_dismissed_at && !conv.inbox_stashed_at && conv.message_count > 0 && producing(now)) {
    isIdle = false;
  }

  return {
    // Every fact is EXPLICIT, null when there is none (C1: facts have one
    // writer). Convex drops an undefined key from the payload, and a replica
    // that merges only the keys it receives then keeps the previous
    // execution's value forever — a "stopped" from the day the daemon died
    // outlived the managed row and filed a declared-done session under Needs
    // Input on every replica while this stamp said done (prod, 2026-09-01).
    agent_status: agentStatus ?? null,
    is_idle: isIdle,
    is_unresponsive: isUnresponsive,
    awaiting_input: awaitingInput,
    is_connected: !!daemonAlive,
    tmux_session: maps.tmuxSessionMap.get(cid) ?? null,
    permission_mode: maps.permissionModeMap.get(cid) ?? null,
    agent_started_at: maps.agentStartedAtMap.get(cid) ?? null,
    open_tasks: maps.openTasksMap.get(cid)?.tasks ?? null,
    open_tasks_at: maps.openTasksMap.get(cid)?.at ?? null,
    message_count: conv.message_count ?? 0,
    updated_at: conv.updated_at,
    // reads.lastUserMessage is the row's preview with the probed fallback for
    // un-backfilled rows — exactly the input the park rule needs (C1).
    last_turn_allows_park: rowLastTurnAllowsPark({ last_message_preview: reads.lastUserMessage }),
  };
}

// The reads for one row: the un-backfilled last-role fallback and the AUQ
// probe are the same newest-message read, so a row pays it at most once.
async function readLivenessRowInputs(ctx: any, conv: any, maps: InboxSessionMaps, now: number): Promise<LivenessRowReads> {
  let lastMsgRole: string | undefined = conv.last_message_role;
  let lastUserMessage: string | null = conv.last_message_preview || null;
  let lastMsg: any = undefined; // undefined = not read yet
  if (!lastMsgRole && conv.message_count > 0) {
    lastMsg = await newestMessage(ctx, conv._id);
    if (lastMsg) {
      lastMsgRole = lastMsg.role;
      if (lastMsg.role === "user" && lastMsg.content?.trim()) {
        lastUserMessage = lastMsg.content
          .replace(/\[Image[:\s][^\]]*\]/gi, "")
          .replace(/<image\b[^>]*\/?>\s*(?:<\/image>)?/gi, "")
          .trim()
          .slice(0, 200);
      }
    }
  }
  const reads: LivenessRowReads = { lastMsgRole, lastUserMessage, auqOpen: false };
  const base = deriveLivenessAt(conv, maps, reads, () => false, now);
  if (!base.is_idle && conv.message_count > 0) {
    if (lastMsg === undefined) lastMsg = await newestMessage(ctx, conv._id);
    reads.auqOpen = isOpenAskUserQuestion(lastMsg);
  }
  return reads;
}

// Every instant at which one of this row's time terms crosses its threshold
// (sync-convergence C2): the idle grace, the heartbeat window, the trust TTL,
// the daemon-alive windows, the open-task freshness, and each child's
// producing grace and status decay. computeBucketStale re-places the row at
// each and keeps the first that moves it.
function rowTimeDeadlines(conv: any, maps: InboxSessionMaps, cid: string, children: any[]): Array<number | null> {
  const hb = maps.lastHeartbeatMap.get(cid);
  const openTasksAt = maps.openTasksMap.get(cid)?.at;
  const statusAt = maps.agentStatusUpdatedAtMap.get(cid);
  const deadlines: Array<number | null> = [
    conv.updated_at + AGENT_IDLE_GRACE_MS,
    conv.updated_at + HEARTBEAT_ALIVE_MS,
    conv.updated_at + STATUS_TRUST_TTL_MS,
    conv.updated_at + CONV_DAEMON_ALIVE_MS,
    statusAt !== undefined ? statusAt + AGENT_IDLE_GRACE_MS : null,
    hb !== undefined ? hb + HEARTBEAT_ALIVE_MS : null,
    maps.latestHeartbeat !== undefined ? maps.latestHeartbeat + USER_DAEMON_ALIVE_MS : null,
    openTasksAt !== undefined ? openTasksAt + OPEN_TASKS_FRESH_MS : null,
    // An armed /loop parks the row (isArmedLoopHome) until its wakeup goes
    // overdue past the grace — that passing must un-park the bucket.
    conv.loop_state?.status === "armed" ? conv.loop_state.wakeup_at + LOOP_OVERDUE_GRACE_MS : null,
  ];
  for (const c of children) {
    const chb = maps.lastHeartbeatMap.get(c._id.toString());
    deadlines.push(
      c.updated_at + SUBAGENT_PRODUCING_GRACE_MS,
      c.updated_at + STATUS_TRUST_TTL_MS,
      c.updated_at + HEARTBEAT_ALIVE_MS,
      chb !== undefined ? chb + HEARTBEAT_ALIVE_MS : null,
    );
  }
  return deadlines;
}

// Build the {convId: liveness + projection stamps} overlay for the user's inbox
// window, plus the projection envelope (sync-convergence C1). Reuses the shared
// scan (so the candidate set matches computeInboxSessions exactly) but enriches
// each row through the lightweight deriveLivenessAt — NOT the full
// enrichInboxSessionRow — so a heartbeat recompute never runs the
// plan/task/workflow gets, the acting-author resolution, or a children scan for
// every row. Covers dismissed/stashed rows, but NOT every row a client might
// hold: shouldShowInInbox drops killed rows and subagent rows, and the scan
// window drops rows older than the recency cap — a client-held copy of any of
// those keeps its last-synced liveness forever (the client store never prunes
// and persists to IndexedDB). The client compensates with isLivenessStale
// (@codecast/shared/contracts). syncOverlay ignores ids it doesn't have.
//
// Reads per execution: the scan, the live-pool hydration, one session_decisions
// read, at most one newest-message read per row (fallback + AUQ probe share
// it), the child AUQ probes (bounded by live children), and the priority-ordered
// foreign children scans (bounded by FOREIGN_SCAN_BUDGET). Stamping the
// projection adds none.
export async function computeSessionsLiveness(
  ctx: any,
  userId: Id<"users">,
  teamScope?: Id<"teams">,
): Promise<{ liveness: Record<string, InboxOverlayRow>; projection: InboxProjection }> {
  // The epoch is the payload's ONLY clock: no raw Date.now() may reach the
  // result, so two executions inside one minute are byte identical (C2).
  const now = inboxEpoch(Date.now());
  const scan = await scanInboxConversations(ctx, userId, now, { includeLiveness: true, teamScope });
  const { conversations, maps, truncated } = scan;
  // Decisions FIRST: a parent already asking through a pending `cast decide`
  // never spends child message probes (see buildAskingParents), and a child
  // holding one joins the pool so its parent is lifted.
  const pendingDecisionIds = await loadPendingDecisionConvIds(ctx, userId);
  const pool = await hydrateLivePool(ctx, conversations, maps, pendingDecisionIds);
  const childrenByParent = groupPoolChildren(pool);
  const { asking: askingParents, probedAuqOpen } = await buildAskingParents(ctx, childrenByParent, maps, now, pendingDecisionIds);
  const uid = userId.toString();
  const shownConvs = conversations.filter((conv) => shouldShowInInbox(conv));

  // Phase 1 — the per-row reads, concurrently (one await depth, not one per row).
  const reads = await Promise.all(shownConvs.map((conv) => readLivenessRowInputs(ctx, conv, maps, now)));

  const producingFor = (cid: string) => (t: number) =>
    (childrenByParent.get(cid) ?? []).some((c: any) => childKeepsParentWorking(c, maps, t));

  // Phase 2 — foreign-run parents whose children are invisible to the pool:
  // the budget goes to the most recently updated idle ones, and overflow is
  // flagged rather than dropped by iteration order.
  const foreignCandidates: Array<{ conv: any; i: number }> = [];
  shownConvs.forEach((conv, i) => {
    if (conv.user_id.toString() === uid) return;
    if (conv.inbox_dismissed_at || conv.inbox_stashed_at || !(conv.message_count > 0)) return;
    const cid = conv._id.toString();
    const base = deriveLivenessAt(conv, maps, reads[i], () => false, now);
    if (base.is_idle && !producingFor(cid)(now)) foreignCandidates.push({ conv, i });
  });
  foreignCandidates.sort((a, b) => b.conv.updated_at - a.conv.updated_at);
  if (foreignCandidates.length > FOREIGN_SCAN_BUDGET) truncated.add("foreign_scan");
  const scanTargets = foreignCandidates.slice(0, FOREIGN_SCAN_BUDGET);
  const scannedChildren = await Promise.all(scanTargets.map(({ conv }) => ctx.db
    .query("conversations")
    .withIndex("by_parent_conversation_id", (q: any) => q.eq("parent_conversation_id", conv._id))
    .order("desc")
    .take(20)));
  scanTargets.forEach(({ conv }, k) => {
    const cid = conv._id.toString();
    const known = new Set((childrenByParent.get(cid) ?? []).map((c: any) => c._id.toString()));
    const merged = [...(childrenByParent.get(cid) ?? [])];
    for (const c of scannedChildren[k]) if (!known.has(c._id.toString())) merged.push(c);
    childrenByParent.set(cid, merged);
  });

  // Phase 3 — derive, place, stamp. Pure from here on.
  const liveness: Record<string, InboxOverlayRow> = {};
  const tally = { shown: emptyInboxTally(), folded: emptyInboxTally() };
  const entries: Array<[string, InboxBucket, boolean]> = [];
  shownConvs.forEach((conv, i) => {
    const cid = conv._id.toString();
    const producing = producingFor(cid);
    const askingFor = (lv: LivenessFields) => ownAsk(lv, conv) || pendingDecisionIds.has(cid) || askingParents.has(cid);
    const placeAt = (t: number): InboxPlacement => {
      const lvAt = deriveLivenessAt(conv, maps, reads[i], producing, t);
      return placeConversationRow(conv, lvAt, askingFor(lvAt), reads[i].lastUserMessage, t);
    };
    const lv = deriveLivenessAt(conv, maps, reads[i], producing, now);
    const asking = askingFor(lv);
    const placement = placeConversationRow(conv, lv, asking, reads[i].lastUserMessage, now);
    const stale = computeBucketStale(
      { deadlines: rowTimeDeadlines(conv, maps, cid, childrenByParent.get(cid) ?? []), placeAt, current: placement.bucket },
      now,
    );
    liveness[cid] = {
      ...lv,
      bucket: placement.bucket,
      work_state: placement.work_state,
      asking,
      below_fold: belowFoldFor(scan, conv),
      bucket_stale_at: stale.bucket_stale_at,
      stale_bucket: stale.stale_bucket,
    };
  });
  // Every shown row stamped on its own facts; then a teammate rides its
  // lead's bucket and time flip (the shared rideLeadPlacements — the fold rode
  // inside computeFold). The tally and the digest read the FINAL stamps.
  const convById = new Map(shownConvs.map((conv) => [conv._id.toString(), conv]));
  const stamped = new Map(shownConvs.map((conv) => [conv._id.toString(), liveness[conv._id.toString()] as InboxOverlayRow & { bucket: InboxBucket; below_fold: boolean }]));
  rideLeadPlacements(stamped, (id) => convById.get(id), (rider, lead) => {
    rider.bucket_stale_at = lead.bucket_stale_at;
    rider.stale_bucket = lead.stale_bucket;
  });
  for (const [cid, row] of stamped) {
    if (row.bucket !== "hidden") (row.below_fold ? tally.folded : tally.shown)[row.bucket]++;
    entries.push([cid, row.bucket, row.below_fold]);
  }

  // FACT-ONLY child rows (no bucket key): the live children the pool probes —
  // a non-idle trusted status with content — of shown parents, so a replica
  // can compute parent rollups (producing grace, asking) from replicated child
  // facts instead of message bodies (C1). Never members: no stamps, no tally,
  // no digest entry. The AUQ answer comes from this execution's probes or the
  // (child id, message_count) cache, so a warm and a cold execution over the
  // same data emit the same row.
  const shownIds = new Set(shownConvs.map((c) => c._id.toString()));
  for (const [pid, children] of childrenByParent) {
    if (!shownIds.has(pid)) continue;
    for (const c of children) {
      const cid = c._id.toString();
      if (liveness[cid] || (c.message_count ?? 0) === 0) continue;
      const status = trustedAgentStatus(
        maps.agentStatusMap.get(cid), c.updated_at, now, isLiveAt(maps, cid, now), verifiedWaitingFor(maps, cid, now),
      );
      if (status === undefined || status === "idle") continue;
      const auqOpen = probedAuqOpen.get(cid)
        ?? childAuqProbeCache.get(`${cid}:${c.message_count ?? 0}`)
        ?? false;
      const childReads: LivenessRowReads = {
        lastMsgRole: c.last_message_role,
        lastUserMessage: c.last_message_preview || null,
        auqOpen,
      };
      liveness[cid] = deriveLivenessAt(c, maps, childReads, () => false, now);
    }
  }

  const projection: InboxProjection = {
    v: INBOX_PROJECTION_VERSION,
    epoch: now,
    user_id: uid,
    scope: teamScope ? "team" : "mine",
    team_id: teamScope ? teamScope.toString() : null,
    tally,
    set_digest: inboxDigestDisabled() ? null : digestProjection(entries),
    truncated: truncatedList(truncated),
  };
  return { liveness, projection };
}

// Heartbeat-derived liveness for the user's inbox sessions, keyed by conversation id —
// the small, high-churn overlay that pairs with listInboxSessions({include_liveness:
// false}). This is the only inbox query that re-runs on every heartbeat, so it computes
// ONLY the liveness fields plus the projection stamps (computeSessionsLiveness) instead
// of the full inbox enrichment — the values are still identical to the bundled path
// because both derive them the same way. Ships a tiny map the client merges via
// syncOverlay, plus the projection envelope (sync-convergence C1).
export const sessionsLiveness = query({
  args: {
    show_all: v.optional(v.boolean()),
    _probe: v.optional(v.number()),
  },
  handler: async (ctx, _args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { liveness: {} };
    return computeSessionsLiveness(ctx, userId);
  },
});

// Team-mode twin of sessionsLiveness: the same tiny heartbeat overlay, but over
// the team-scoped candidate set (so teammate rows on the board refresh their
// live status without the full team list re-pushing every heartbeat). Membership
// gated. Mounted by the client only while team mode is active.
export const teamSessionsLiveness = query({
  args: {
    activeTeamId: v.optional(v.id("teams")),
    _probe: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { liveness: {} };
    const teamScope = await resolveInboxTeamScope(ctx, userId, args.activeTeamId);
    if (!teamScope) return { liveness: {} };
    return computeSessionsLiveness(ctx, userId, teamScope);
  },
});

// The `cast sessions` tally + row filter, split out of inboxForCLI as a PURE
// function over already-enriched rows. This logic has been wrong twice — a
// killed row double-counted under a comment denying it, then `-a` zeroing the
// retirement figures while listing the rows — and both times a test would have
// caught it, so it gets a seam rather than living inside a db-heavy query.
export function tallyInboxRows(
  sessions: any[],
  opts: {
    showAll?: boolean;
    stateFilter?: string | null;
    labelByConv: Map<string, string>;
    /**
     * Conversation ids the caller named explicitly (`cast sessions <id>`).
     * Subagent rows are hidden from the top-level monitor, but a row you ask
     * for by id must answer — it is the wait signal an orchestrator watches
     * for a `cast spawn --subagent` worker.
     */
    requestedIds?: Set<string>;
  },
) {
  const counts = { working: 0, needs_input: 0, done: 0, dormant: 0, idle: 0, pinned: 0, live: 0, stashed: 0, dismissed: 0, killed: 0, below_fold: 0, total: 0 };
  const rows: Array<{
    id: string;
    session_id: string;
    title: string;
    project_path: string | null;
    updated_at: string;
    ts: number;
    message_count: number;
    agent_type?: string;
    agent_status?: string;
    work_state: WorkState;
    // The projection placement (shared placeInboxRow) and the fold flag, next
    // to the verdict the CLI has always tallied.
    bucket: InboxBucket;
    below_fold: boolean;
    is_killed: boolean;
    is_pinned: boolean;
    is_live: boolean;
    is_unresponsive: boolean;
    awaiting_input: boolean;
    idle_summary: string | null;
    thread_state: string | null;
    thread_state_status: string | null;
    last_user_message: string | null;
    label: string | null;
    active_plan: { short_id: string; title: string } | null;
    active_task: { short_id: string; title: string } | null;
    // Second-party ownership: run_by = the member whose account runs the
    // session when that isn't the caller; owner = the assigned owner if any.
    run_by: string | null;
    owner: { name: string | null; email: string | null } | null;
    owned_by_me: boolean;
  }> = [];

  // A subagent row can arrive twice — the top-level recency scan and its
  // parent's child enumeration both emit it (the web dedups by _id; this
  // tally must too, or a requested subagent lists and counts double).
  const seenSubagents = new Set<string>();
  for (const s of sessions) {
    // Keep the monitor to top-level sessions — unless this row was named.
    if (s.is_subagent) {
      const id = s._id.toString();
      if (!opts.requestedIds?.has(id) || seenSubagents.has(id)) continue;
      seenSubagents.add(id);
    }
    // The three retirement states are TALLIES, not buckets — the same shape as
    // `pinned` and `live`, and deliberately NOT mutually exclusive with the
    // work-state counts. A rendered row lands in both its work_state figure
    // and its retirement figure (a pinned killed session is counted in `idle`,
    // `pinned`, `killed` and `total`); a collapsed row appears only in its
    // retirement figure. Counting is therefore unconditional — gating it on
    // !show_all left every figure at 0 under `-a` while the rows were listed,
    // which made `stashed` useless for its whole purpose (how many agents are
    // still running). See classifyRetirement for why killed outranks the rest.
    //
    // Only the COLLAPSE is conditional. A killed row renders through: it only
    // reaches here while pinned (shouldShowInInbox drops killed-and-unpinned),
    // and pinning is how you hold onto a killed row — swallowing it was the
    // CLI overriding a decision the server already made. Stashed and dismissed
    // keep collapsing, mirroring the web's separate parked group, so
    // already-triaged sessions don't inflate the active buckets; `-a` lists them.
    const retired = classifyRetirement(s);
    if (retired) counts[retired]++;
    if (retired && retired !== "killed" && !opts.showAll) continue;
    // The verdict is STAMPED upstream (computeInboxSessions with `projection`
    // runs the shared placeInboxRow); this tally never classifies — one
    // classifier, one alphabet (sync-convergence C3).
    const work_state: WorkState = s.work_state;
    const bucket: InboxBucket = s.bucket;
    if (!work_state || !bucket) throw new Error(`tallyInboxRows: row ${s._id} is not stamped with a projection`);
    const is_live = !!s.is_connected;

    counts.total++;
    counts[work_state]++;
    if (s.is_pinned) counts.pinned++;
    if (is_live) counts.live++;
    if (s.below_fold) counts.below_fold++;
    const rowLabel = opts.labelByConv.get(s._id.toString()) ?? null;

    if (opts.stateFilter === "pinned" && !s.is_pinned) continue;
    if (opts.stateFilter === "live" && !is_live) continue;
    if (opts.stateFilter && opts.stateFilter !== "pinned" && opts.stateFilter !== "live" && work_state !== opts.stateFilter) continue;

    rows.push({
      id: s._id,
      session_id: s.session_id,
      title: s.title || s.last_user_message || "New Session",
      project_path: s.project_path || null,
      updated_at: new Date(s.updated_at).toISOString(),
      ts: s.updated_at,
      message_count: s.message_count || 0,
      agent_type: s.agent_type,
      agent_status: s.agent_status,
      work_state,
      bucket,
      below_fold: !!s.below_fold,
      // A retired row (still listed while pinned, or under --all). The watch
      // stream reads it to emit a kill as a departure, not a transition.
      is_killed: !!s.inbox_killed_at,
      is_pinned: !!s.is_pinned,
      is_live,
      is_unresponsive: !!s.is_unresponsive,
      awaiting_input: !!s.awaiting_input,
      idle_summary: s.idle_summary || null,
      // The agent's own pinned state beats the generated blurb when both exist:
      // one is what the agent says is true now, the other is a description.
      thread_state: s.thread_state || null,
      thread_state_status: s.thread_state_status || null,
      last_user_message: s.last_user_message || null,
      label: rowLabel,
      active_plan: s.active_plan ? { short_id: s.active_plan.short_id, title: s.active_plan.title } : null,
      active_task: s.active_task ? { short_id: s.active_task.short_id, title: s.active_task.title } : null,
      run_by: s.author_name ?? null,
      owner: s.owner_user_id ? { name: s.owner_name ?? null, email: s.owner_email ?? null } : null,
      owned_by_me: !!s.owned_by_me,
    });
  }
  return { counts, rows };
}

// CLI-facing inbox: the same fully-enriched, per-user session set the web inbox
// renders (computeInboxSessions), collapsed to a single `work_state` per row via
// the shared classifier and sorted most-actionable-first. Powers `cast monitor`
// and `cast feed`'s precise `--state` view. api_token authed (CLI has no cookie).
export const inboxForCLI = query({
  args: {
    api_token: v.string(),
    show_all: v.optional(v.boolean()),
    state: v.optional(v.string()),
    limit: v.optional(v.number()),
    label: v.optional(v.string()),
    project_path: v.optional(v.string()),
    // Explicit session refs from `cast sessions <id> …` (short id, session UUID,
    // or conversation id). Resolved own-only; the rows are hydrated past the
    // recency window and a subagent row among them is listed instead of hidden.
    session_ids: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return { error: "Unauthorized" };

    const requestedIds = new Set<string>();
    for (const ref of args.session_ids ?? []) {
      const conv = await findConversationByAnyRef(ctx, ref, userId);
      if (conv) requestedIds.add(conv._id.toString());
    }

    // Labels (buckets) are the user's personal filing, fetched BEFORE the inbox
    // so a --label query can hydrate its full filed set below. One fetch serves
    // the --label filter, the per-row label stamp, and the labels summary the
    // CLI renders for --labels / --by-label.
    const allBuckets = await ctx.db
      .query("inbox_buckets")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();
    const activeBuckets = allBuckets
      .filter((b) => !b.archived_at)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name));
    const assignments = await ctx.db
      .query("bucket_assignments")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();
    const bucketNameById = new Map(activeBuckets.map((b) => [b._id.toString(), b.name]));
    const labelByConv = new Map<string, string>();
    for (const a of assignments) {
      const name = a.bucket_id ? bucketNameById.get(a.bucket_id.toString()) : undefined;
      if (name) labelByConv.set(a.conversation_id.toString(), name);
    }

    // --label: resolve the filed conversation ids up front. Labels exist to park
    // old sessions, which the inbox's recency window misses — so the filed set is
    // hydrated INTO the inbox (extraConvIds) instead of merely filtering it, the
    // same policy as feedForCLI's resolveLabelConvIds path. Same-named buckets
    // merge into one label, so collect every matching bucket id.
    let labelConvIds: Set<string> | null = null;
    if (args.label) {
      const matched = matchBucketByName(activeBuckets, args.label);
      if ("error" in matched) return { error: matched.error };
      const matchedBucketIds = new Set(
        activeBuckets.filter((b) => b.name === matched.name).map((b) => b._id.toString())
      );
      labelConvIds = new Set(
        assignments
          .filter((a) => a.bucket_id && matchedBucketIds.has(a.bucket_id.toString()))
          .map((a) => a.conversation_id.toString())
      );
    }

    const extraConvIds = [...(labelConvIds ?? []), ...requestedIds];
    let { sessions, hidden_count } = await computeInboxSessions(ctx, userId, {
      show_all: !!args.show_all,
      extraConvIds: extraConvIds.length ? extraConvIds : undefined,
      projection: true,
    });

    // Project bounding (label views): scope the inbox to one project so labels
    // and their counts reflect the caller's cwd, not their whole filing cabinet.
    // Overlap in either direction — a cwd deeper inside the repo still claims
    // the repo's sessions, and a session created in a subdir still counts.
    if (args.project_path) {
      const bound = args.project_path;
      sessions = sessions.filter((s) => projectOverlaps(bound, s.project_path) || projectOverlaps(bound, s.git_root));
    }

    if (labelConvIds) {
      // Counts below reflect the label scope, like show_all narrows the whole view.
      const lci = labelConvIds;
      sessions = sessions.filter((s) => lci.has(s._id.toString()));
    }
    const stateFilter = normalizeWorkStateFilter(args.state);
    const ORDER: Record<WorkState, number> = { needs_input: 0, done: 1, working: 2, dormant: 3, idle: 4 };

    const { counts, rows } = tallyInboxRows(sessions, {
      showAll: args.show_all,
      stateFilter,
      labelByConv,
      requestedIds,
    });
    // Rows under the cluster cut: listed (and tallied above) under -a, omitted
    // otherwise — either way the figure is the same fold count.
    if (!args.show_all) counts.below_fold = hidden_count;

    // Most-actionable first: pinned, then needs_input → done → working → dormant → idle, recent first.
    rows.sort((a, b) => {
      if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
      if (ORDER[a.work_state] !== ORDER[b.work_state]) return ORDER[a.work_state] - ORDER[b.work_state];
      return b.ts - a.ts;
    });

    const limit = args.limit ?? 200;

    // All active labels with counts from the user's FILING (assignments), not
    // the recency-windowed rows — labels mostly hold parked sessions the window
    // misses. Same-named buckets merge into one entry. In a project-bounded
    // view, count only conversations filed in this project (hydrating the few
    // not already in the inbox window, capped) and drop zero-count labels —
    // they're other projects' filing.
    const nameToConvIds = new Map<string, Set<string>>();
    for (const a of assignments) {
      const name = a.bucket_id ? bucketNameById.get(a.bucket_id.toString()) : undefined;
      if (!name) continue;
      if (!nameToConvIds.has(name)) nameToConvIds.set(name, new Set());
      nameToConvIds.get(name)!.add(a.conversation_id.toString());
    }
    let inBound: ((id: string) => Promise<boolean>) | null = null;
    if (args.project_path) {
      const bound = args.project_path;
      const pathById = new Map<string, { project_path?: string | null; git_root?: string | null } | null>();
      for (const s of sessions) pathById.set(s._id.toString(), { project_path: s.project_path, git_root: s.git_root });
      let hydrationBudget = 500;
      inBound = async (id: string) => {
        if (!pathById.has(id)) {
          if (hydrationBudget-- <= 0) return false;
          let conv: any = null;
          try { conv = await ctx.db.get(id as Id<"conversations">); } catch { conv = null; }
          pathById.set(
            id,
            conv && conv.user_id.toString() === userId.toString()
              ? { project_path: conv.project_path, git_root: conv.git_root }
              : null,
          );
        }
        const p = pathById.get(id);
        return !!p && (projectOverlaps(bound, p.project_path) || projectOverlaps(bound, p.git_root));
      };
    }
    const labels: Array<{ name: string; count: number }> = [];
    const seenLabelNames = new Set<string>();
    for (const b of activeBuckets) {
      if (seenLabelNames.has(b.name)) continue;
      seenLabelNames.add(b.name);
      const ids = nameToConvIds.get(b.name) ?? new Set<string>();
      let count = 0;
      for (const id of ids) {
        if (!inBound || (await inBound(id))) count++;
      }
      if (args.project_path && count === 0) continue;
      labels.push({ name: b.name, count });
    }

    return { sessions: rows.slice(0, limit), counts, hidden_count, labels, scope: "mine" };
  },
});

// COMPLETENESS FLOOR: page through EVERY owned, non-dismissed active/completed
// conversation that belongs in the inbox — not just the live channel's 200-row
// recent window. Driven by the client's reconcile crawl (runReconcileCrawl,
// additive/never-prune), this guarantees an idle, owned, non-dismissed session
// is present even when it was never cached on this device AND the live
// subscription was stale (the cross-device + saturation gap). One-shot paginated
// query — bypasses the stalled live subscription. Returns the SAME enriched rows
// as listInboxSessions so the store overlays them without schema drift.
// `since` (optional) restricts to conversations updated at/after a watermark for
// cheap incremental top-ups after the first full backfill.
export const listInboxSessionsPaginated = query({
  args: {
    paginationOpts: paginationOptsValidator,
    since: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { page: [], isDone: true, continueCursor: "" };
    return collectInboxSessionsPaginated(ctx, userId, args);
  },
});

// Auth-free body of listInboxSessionsPaginated, exported for tests.
export async function collectInboxSessionsPaginated(
  ctx: any,
  userId: Id<"users">,
  args: { paginationOpts: any; since?: number },
) {
  // Liveness is the overlay's job (sync-convergence C1): the completeness
  // crawl carries bodies only, so the maps are the empty set and every
  // liveness field is stripped below, exactly as getInboxSessionsByIds does.
  // No managed_sessions read on this path.
  const now = inboxEpoch(Date.now());
  const maps = EMPTY_INBOX_MAPS;

  // Owned conversations, most-recent first. Active OR completed (matches the
  // live recent window's status filter). `since` trims to changed rows for
  // incremental crawls. Dismissed are filtered in the LOOP (not the query) via
  // the canonical `!conv.inbox_dismissed_at` truthiness check — a query-level
  // `eq(field, undefined)` would wrongly drop sessions whose dismissal was
  // cleared to null/0 rather than removed. Dismissed are excluded because they
  // accumulate locally via their own keepWhere path; re-surfacing them here
  // would fight that design. Cluster-cutoff is disabled (clusterCutoff=0):
  // completeness is the whole point of the floor.
  // The lower bound is the caller's watermark ONLY — it must be STABLE across
  // every page of one crawl, or each page's continuation cursor belongs to a
  // different query and Convex throws InvalidCursor. The 30d activity window is
  // therefore applied client-side (the client seeds `since = now - 30d` on the
  // first backfill); never fold a wall-clock value into the index range here.
  const q = ctx.db
    .query("conversations")
    .withIndex("by_user_updated", (qb: any) =>
      args.since !== undefined
        ? qb.eq("user_id", userId).gte("updated_at", args.since)
        : qb.eq("user_id", userId)
    )
    .order("desc")
    .filter((qb: any) =>
      qb.or(qb.eq(qb.field("status"), "active"), qb.eq(qb.field("status"), "completed"))
    );

  const result = await q.paginate(args.paginationOpts);

  const getDoc = makeMemoGet(ctx);
  const rows: any[] = [];
  for (const conv of result.page) {
    if (conv.inbox_dismissed_at || conv.inbox_stashed_at) continue; // dismissed/stashed: own accumulation path
    if (!shouldShowInInbox(conv)) continue;
    const { row, subagentChildren } = await enrichInboxSessionRow(ctx, conv, maps, now, false, { auq: true }, getDoc);
    stripInboxLiveness(row);
    rows.push(row);
    for (const child of subagentChildren) {
      const childRow = buildSubagentChildRow(child, maps, now, conv._id);
      stripInboxLiveness(childRow);
      rows.push(childRow);
    }
  }

  return { page: rows, isDone: result.isDone, continueCursor: result.continueCursor };
}

// Durable cross-device dismiss reconcile. Returns ONLY {_id, inbox_dismissed_at}
// for the caller's conversations dismissed within the live window — NO per-session
// enrichment, so it's cheap to page even on a saturation-prone backend. This is the
// backstop the live `listInboxSessions` subscription lacks: that channel only
// reaches a CONNECTED client, and the session crawl (`listInboxSessionsPaginated`)
// can't carry a dismiss at all — it's keyed on `updated_at` (a dismiss never moves
// it) and skips dismissed rows outright. This query is keyed on the
// `by_user_dismissed` index (inbox_dismissed_at — the field a dismiss DOES move),
// so a device that was offline at dismiss time heals on its next reconcile.
// The client overlays the result via applyDismissedReconcile (SET on reported,
// CLEAR on no-longer-reported = un-dismissed elsewhere). Window mirrors the live
// query's INBOX_DISMISSED_WINDOW_MS — keep them in sync.
// Shared handler for the dismissed/stashed lite crawls. The window lower bound
// MUST be a STABLE value supplied by the caller — it becomes the index range
// bound, and a wall-clock value recomputed per page (Date.now() in the handler)
// shifts the range between pages, so each continuation cursor belongs to a
// different query and Convex throws InvalidCursor on page 2. That capped this
// crawl at its FIRST page (~500 rows) — a heavy account's older dismisses then
// never reconciled, so dismissed sessions resurfaced on other tabs/devices. The
// client seeds `since = now - 30d` once per crawl (mirrors
// listInboxSessionsPaginated). Never fold Date.now() into the range here. The
// fallback is only for a single un-paginated probe call.
async function listHiddenSessionsLite(
  ctx: any,
  args: { paginationOpts: any; since?: number },
  index: "by_user_dismissed" | "by_user_stashed",
  field: "inbox_dismissed_at" | "inbox_stashed_at",
) {
  const userId = await getAuthUserId(ctx);
  if (!userId) return { page: [], isDone: true, continueCursor: "" };
  return collectHiddenSessionsLite(ctx, userId, args, index, field);
}

// Auth-free body, exported for tests (perform* convention).
export async function collectHiddenSessionsLite(
  ctx: any,
  userId: any,
  args: { paginationOpts: any; since?: number },
  index: "by_user_dismissed" | "by_user_stashed",
  field: "inbox_dismissed_at" | "inbox_stashed_at",
) {
  const cutoff = args.since ?? Date.now() - INBOX_DISMISSED_WINDOW_MS;
  const result = await ctx.db
    .query("conversations")
    .withIndex(index, (q: any) => q.eq("user_id", userId).gte(field, cutoff))
    .order("desc")
    .paginate(args.paginationOpts);
  const page = result.page.map((c: any) => ({
    _id: c._id,
    [field]: c[field] ?? null,
  }));
  // Sessions ASSIGNED to this user (session_owners) but run by another account
  // live outside the by_user index above, yet the client's reconcile CLEAR pass
  // arbitrates them like any cached row — if their hide is missing from this
  // set, every complete crawl un-hides them ("dismiss doesn't stick"). Append
  // the owner-set's hidden rows on the final page: outside the paginated index
  // scan, so cursors stay untouched, and present in the whole-set the CLEAR
  // gate checks. Bounded by the same 200-owner cap as the inbox scan.
  if (result.isDone) {
    const ownerRows = await ctx.db
      .query("session_owners")
      .withIndex("by_user", (q: any) => q.eq("user_id", userId))
      .take(200);
    const seen = new Set(page.map((r: any) => r._id.toString()));
    for (const r of ownerRows) {
      const idStr = r.conversation_id.toString();
      if (seen.has(idStr)) continue;
      let conv: any = null;
      try { conv = await ctx.db.get(r.conversation_id); } catch { conv = null; }
      if (!conv || conv.user_id.toString() === userId.toString()) continue;
      const at = conv[field];
      if (!at || at < cutoff) continue;
      page.push({ _id: conv._id, [field]: at });
    }
  }
  return { page, isDone: result.isDone, continueCursor: result.continueCursor };
}

export const listDismissedSessionsLite = query({
  args: {
    paginationOpts: paginationOptsValidator,
    since: v.optional(v.number()),
  },
  handler: (ctx, args) =>
    listHiddenSessionsLite(ctx, args, "by_user_dismissed", "inbox_dismissed_at"),
});

// Stashed twin of the dismissed reconcile — same contract, keyed on
// inbox_stashed_at via by_user_stashed.
export const listStashedSessionsLite = query({
  args: {
    paginationOpts: paginationOptsValidator,
    since: v.optional(v.number()),
  },
  handler: (ctx, args) =>
    listHiddenSessionsLite(ctx, args, "by_user_stashed", "inbox_stashed_at"),
});

// Which of these conversation ids still exist as the caller's own? Powers the
// inbox ghost sweep: the client's never-prune sessions cache verifies before
// dropping blank rows the empty-conversation GC (cleanup.gcEmptyConversations)
// may have hard-deleted server-side. Verify-then-prune keeps the sweep safe —
// a blank row the GC skipped (live terminal, parked draft) reports back as
// existing and stays cached.
export const existingConversationIds = query({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const out: string[] = [];
    for (const raw of args.ids.slice(0, 200)) {
      const id = ctx.db.normalizeId("conversations", raw);
      if (!id) continue;
      const conv = await ctx.db.get(id);
      if (!conv) continue;
      // Vouch for rows the caller runs OR owns (assigned sessions) — reading a
      // live assigned session as "gone" would ghost-prune it with a sticky
      // exclude, permanently blinding this client to it.
      if (
        conv.user_id.toString() === userId.toString() ||
        (await isSessionOwner(ctx, id, userId))
      ) out.push(raw);
    }
    return out;
  },
});

// Change-feed batch fetch: current inbox-row state for a set of conversation ids
// the user OWNS (the inbox is owner-only). Returns rows in the EXACT shape of the
// listInboxSessions base payload (include_liveness:false — liveness stripped so
// the sessionsLiveness overlay keeps owning it), so the client merges them through
// the same syncTable("sessions") path. Reuses enrichInboxSessionRow — no
// presentation filter, so a dismissed/stashed session comes back WITH its flag
// (the client re-buckets it). Ids that are gone or foreign are simply omitted;
// callers prune ids the response omits (authorized absence). Consumers: the
// sync-log applier (syncLog.ts / web useSyncChangeFeed.ts) and, for deployed
// old bundles, changeFeed.ts.
export const getInboxSessionsByIds = query({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { sessions: [] };
    return collectInboxSessionsByIds(ctx, userId, args.ids);
  },
});

// Auth-free body of getInboxSessionsByIds, exported for tests.
export async function collectInboxSessionsByIds(ctx: any, userId: Id<"users">, ids: string[]) {
  const now = inboxEpoch(Date.now());
  const sessions: any[] = [];
  for (const raw of ids.slice(0, 300)) {
    const id = ctx.db.normalizeId("conversations", raw);
    if (!id) continue;
    const conv = await ctx.db.get(id);
    if (!conv) continue;
    // The runner, or an owner (session_owners) — the same admission the scan's
    // owned window applies, so a replica can heal an assigned row it missed.
    // The owner seat is stamped so the client's foreign-row rule keeps it.
    const owned = conv.user_id.toString() !== userId.toString();
    if (owned && !(await isSessionOwner(ctx, conv._id, userId))) continue;
    if (conv.status !== "active" && conv.status !== "completed") continue;
    const { row } = await enrichInboxSessionRow(ctx, conv, EMPTY_INBOX_MAPS, now, false, { auq: true });
    if (owned) row.owned_by_me = true;
    stripInboxLiveness(row);
    sessions.push(row);
  }
  return { sessions };
}

export const setSessionError = mutation({
  args: {
    conversation_id: v.string(),
    error: v.optional(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");
    const convId = ctx.db.normalizeId("conversations", args.conversation_id);
    if (!convId) return;
    const conv = await ctx.db.get(convId);
    if (!conv || conv.user_id !== userId) return;
    // A "couldn't start / no local checkout" error is impossible if the session
    // is actually running. Reject stale error writes (device-agnostic, so it holds
    // even for un-upgraded daemons) when a live managed session exists — that's a
    // second machine lacking the checkout racing the one that already started it.
    // Clearing the error (error=undefined) always passes through.
    if (args.error) {
      const managed = await ctx.db
        .query("managed_sessions")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", convId))
        .collect();
      const now = Date.now();
      if (managed.some((s) => now - s.last_heartbeat < 2 * 60 * 1000)) return;
    }
    await ctx.db.patch(convId, {
      session_error: args.error,
    });
  },
});

export const markSessionCompleted = mutation({
  args: {
    conversation_id: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");
    const convId = ctx.db.normalizeId("conversations", args.conversation_id);
    if (!convId) return;
    const conv = await ctx.db.get(convId);
    if (!conv || conv.user_id !== userId) return;
    // Anchors never auto-complete. This guard covers every reaping path that
    // routes through markSessionCompleted (the daemon watchdog, the SessionEnd
    // hook, daemon kill teardown). The direct-patch kill paths carry their own
    // matching `persistent` guard (killSession + dispatch dismiss→kill). So a
    // standing member that goes dormant is never flipped to "completed"; it is
    // retired only by decommissionAnchor, which clears `persistent` first.
    if (conv.persistent) return;
    if (conv.status === "active") {
      if (conv.has_pending_messages) {
        return;
      }
      const pendingMsg = await ctx.db
        .query("pending_messages")
        .withIndex("by_conversation_status", (q: any) =>
          q.eq("conversation_id", convId).eq("status", "pending")
        )
        .first();
      if (pendingMsg) {
        return;
      }
      await ctx.db.patch(convId, { status: "completed" });
    }
  },
});

export const markSessionActive = mutation({
  args: {
    conversation_id: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");
    const convId = ctx.db.normalizeId("conversations", args.conversation_id);
    if (!convId) return;
    const conv = await ctx.db.get(convId);
    if (!conv || conv.user_id !== userId) return;
    if (conv.status === "completed") {
      await ctx.db.patch(convId, { status: "active" });
    }
  },
});

// The daemon's read of a conversation's LIFECYCLE state (api_token auth, so it
// works from the CLI/daemon where there's no session cookie). It gates its reap
// on this: a session the user killed or stashed must not be brought back by the
// daemon's own recovery paths, and no existing daemon-facing query exposes the
// hide stamps (devices.resolveConversationBySession returns status only).
// Returns null for a missing conversation or one the caller doesn't run —
// same silent-null convention as its siblings, and the daemon treats null (or
// an undeployed query) as "no lifecycle opinion" and falls back.
//
// Addressable by conversation_id OR session_id (exactly one), because the daemon
// often knows only the session it is about to reap or resurrect — and the
// session route MUST resolve the newest twin, not the oldest (see below).
export const getConversationLifecycle = query({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.optional(v.id("conversations")),
    session_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) return null;
    // Exactly one selector: neither is nothing to look up, and both could
    // disagree — refusing to guess is the same discipline
    // deleteConversationBySessionId applies to twins. Null, not a throw, so a
    // malformed call reads as "no opinion" like every other miss here.
    if (!!args.conversation_id === !!args.session_id) return null;

    let conv = args.conversation_id ? await ctx.db.get(args.conversation_id) : null;
    if (!conv && args.session_id) {
      // NEWEST twin, never .first(): .first() is creation order, so it returns
      // the OLDEST row bound to a session_id — the ct-36973 foot-gun that once
      // made cleanup delete a live original instead of its doppelgänger. Here it
      // would hand the daemon a dead twin's killed/stashed stamps for a session
      // that is very much alive, and the reap gate would refuse to bring the
      // live one back. Same newest-by-updated_at reduction resolveRestartTarget
      // uses, and foreign twins are filtered out before the pick, so another
      // user's row can neither be selected nor leak.
      const twins = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id!))
        .collect();
      const owned = twins.filter((t) => t.user_id === userId);
      conv = owned.length > 0
        ? owned.reduce((a, b) => ((b.updated_at ?? 0) > (a.updated_at ?? 0) ? b : a))
        : null;
    }
    if (!conv || conv.user_id !== userId) return null;
    return {
      status: conv.status,
      inbox_killed_at: conv.inbox_killed_at ?? null,
      inbox_stashed_at: conv.inbox_stashed_at ?? null,
      inbox_dismissed_at: conv.inbox_dismissed_at ?? null,
      inbox_pinned_at: conv.inbox_pinned_at ?? null,
    };
  },
});

export const dismissFromInbox = mutation({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || conv.user_id !== userId) throw new Error("Not found");
    await ctx.db.patch(args.conversation_id, {
      inbox_dismissed_at: Date.now(),
    });
  },
});

/**
 * Bring a hidden card back to the inbox and rearm what its kill canceled.
 * Shared by `cast undismiss` (whose whole job this is) and `cast restart`
 * (which would otherwise revive an agent nobody can see).
 *
 * inbox_killed_at clears too, or the restore can't do what it advertises: a
 * killed row is hidden by shouldShowInInbox on that flag alone, so clearing
 * only the hide stamps left it invisible and `cast kill`'s own "cast undismiss
 * <id> to resurface" hint was a false promise. (It used to work by accident —
 * the web's pin gesture wiped the flag through the patch rail, which is exactly
 * the hole the dispatch guard sealed.)
 *
 * `status` deliberately stays: this resurfaces the CARD, it does not restart
 * the agent — that's what enqueueKillAndResume is for.
 */
async function resurfaceHiddenSession(
  ctx: MutationCtx,
  conv: Doc<"conversations">,
  userId: Id<"users">,
): Promise<{ wasHidden: boolean; rearmed: number }> {
  const wasHidden = !!(conv.inbox_dismissed_at || conv.inbox_stashed_at || conv.inbox_killed_at);
  if (!wasHidden) return { wasHidden: false, rearmed: 0 };

  await ctx.db.patch(conv._id, {
    inbox_dismissed_at: undefined,
    inbox_stashed_at: undefined,
    inbox_killed_at: undefined,
  });
  // The un-kill mirror (same as the web restore path in dispatch): bring back
  // the schedules the kill canceled, stamped tasks only. Scan the runner's,
  // plus the caller's when a second-party owner is restoring.
  let rearmed = 0;
  if (conv.inbox_dismissed_at) {
    rearmed = await reactivateTasksCanceledOnKill(ctx, conv.user_id, conv._id);
    if (conv.user_id.toString() !== userId.toString()) {
      rearmed += await reactivateTasksCanceledOnKill(ctx, userId, conv._id);
    }
  }
  return { wasHidden, rearmed };
}

// Agent-facing inbox visibility (cast dismiss / undismiss / kill via
// /cli/sessions/*). Field semantics are IDENTICAL to the web inbox gestures and
// run the same hide-transition side effects (applyHideTransition):
//   dismiss   — stash: hide from the active inbox, agent keeps running
//               (Stashed bucket). An EMPTY pre-warm gets reaped instead.
//               `hidden` = "stash and hide": the stash survives trigger wakes
//               (see isStashHidden); a plain stash pops back on the next one.
//   kill      — retire: sets inbox_dismissed_at, which tears the agent down,
//               marks the session completed (unless persistent), and cancels
//               schedules bound to it (Killed bucket).
//   undismiss — restore: clears both hide flags; a killed session comes back
//               as a restartable card (mirrors the web restoreSession).
// Access: the runner or the second-party owner — the same rule as killSession
// and the dispatch triage path.
export const cliSetSessionVisibility = mutation({
  args: {
    session: v.string(),
    action: v.union(v.literal("dismiss"), v.literal("kill"), v.literal("undismiss")),
    hidden: v.optional(v.boolean()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = args.api_token
      ? await getAuthenticatedUserId(ctx, args.api_token)
      : await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const conv = await findConversationByAnyRefWhere(ctx, args.session, (c) =>
      c.user_id?.toString() === userId.toString() ||
      c.owner_user_id?.toString() === userId.toString()
    );
    if (!conv) {
      throw new Error(
        `No session found for "${args.session}" (you can only manage sessions you run or own)`
      );
    }
    const shortId = conv.short_id ?? conv._id.toString().slice(0, 7);

    if (args.action === "undismiss") {
      const { wasHidden, rearmed } = await resurfaceHiddenSession(ctx, conv, userId);
      return { ok: true as const, short_id: shortId, action: args.action, was_hidden: wasHidden, rearmed_schedules: rearmed };
    }

    const wasHidden = !!conv.inbox_dismissed_at;
    // Every stash write sets inbox_stash_hidden (true or cleared): the flag is
    // only honored while the stamp is set, so a re-stash never inherits an
    // earlier gesture's mode.
    const patch =
      args.action === "kill"
        ? { inbox_dismissed_at: Date.now() }
        : { inbox_stashed_at: Date.now(), inbox_stash_hidden: args.hidden ? true : undefined };
    await ctx.db.patch(conv._id, patch);
    // `conv` is the pre-patch row — applyHideTransition gates on the transition.
    // The nested group (Task subagents + agent-team teammates) comes down with
    // the card via its built-in cascade — see cascadeHideToNestedChildren.
    // `cast kill` is an EXPLICIT kill gesture, so it forces teardown even on an
    // already-dismissed session (whose worker a daemon bug may have revived) —
    // a re-asserted quiet dismiss still doesn't.
    const { action: outcome, canceledSchedules, canceledMessages, cascaded, teardownEnqueued } =
      await applyHideTransition(ctx, conv, patch, { forceKill: args.action === "kill" });
    return {
      ok: true as const,
      short_id: shortId,
      action: args.action,
      outcome,
      was_hidden: wasHidden,
      teardown_enqueued: teardownEnqueued,
      canceled_schedules: canceledSchedules,
      canceled_messages: canceledMessages,
      cascaded_children: cascaded,
    };
  },
});

/**
 * Resolve a session the caller may command, for the CLI's session-scoped verbs
 * (`cast resume`, `cast restart`). Accepts any ref the user can type — short
 * id, conversation id, agent session id. Access is the runner or the
 * second-party owner, the same rule as cliSetSessionVisibility and killSession.
 * `verb` only shapes the error, which quotes back what the user actually typed.
 */
async function resolveCommandableSession(
  ctx: MutationCtx,
  userId: Id<"users">,
  session: string,
  verb: string,
): Promise<Doc<"conversations">> {
  const conv = await findConversationByAnyRefWhere(ctx, session, (c) =>
    c.user_id?.toString() === userId.toString() ||
    c.owner_user_id?.toString() === userId.toString()
  );
  if (!conv) {
    throw new Error(
      `No session found for "${session}" (you can only ${verb} sessions you run or own)`
    );
  }
  if (!conv.session_id) {
    const shortId = conv.short_id ?? conv._id.toString().slice(0, 7);
    throw new Error(`Session ${shortId} has no agent transcript yet — nothing to ${verb}`);
  }
  return conv;
}

/**
 * What the CLI needs to follow a resume/restart to its pane: the agent's
 * session_id (which the daemon stamps on the pane as @codecast_session_id) and
 * the device that will host it, so `--tmux` can tell "coming up here" apart
 * from "coming up on another machine, don't wait for it".
 */
function sessionCommandResult(conv: Doc<"conversations">) {
  return {
    ok: true as const,
    short_id: conv.short_id ?? conv._id.toString().slice(0, 7),
    title: conv.title ?? null,
    session_id: conv.session_id!,
    conversation_id: conv._id,
    agent_type: fromConvexAgentType(conv.agent_type),
    project_path: conv.project_path ?? conv.git_root ?? null,
    device_id: (conv as any).owner_device_id ?? null,
  };
}

// Agent-facing resume (cast resume <session> --tmux via /cli/sessions/resume) —
// the same backend as the web's Resume button. Asks the session's daemon to
// bring the agent up in a managed pane, WITHOUT killing anything: a session
// already alive keeps its pane and its running turn (the daemon reuses a
// healthy pane, see enqueueResumeSession), so this is safe to call on a live
// session just to find out where it lives.
//
// That is the whole difference from cliRestartSession below, and it is why
// `--tmux` belongs here: attaching to a session should never cost you the turn
// it was in the middle of.
export const cliResumeSession = mutation({
  args: {
    session: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = args.api_token
      ? await getAuthenticatedUserId(ctx, args.api_token)
      : await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const conv = await resolveCommandableSession(ctx, userId, args.session, "resume");
    // A pane nobody can see is the same problem here as on restart: the card
    // comes back to the inbox before its agent does.
    const { wasHidden, rearmed } = await resurfaceHiddenSession(ctx, conv, userId);
    const { deduplicated } = await enqueueResumeSession(ctx, conv);
    // Re-queue stranded messages so the resume actually delivers them — the
    // same reason users.resumeSession does it.
    await resetConversationPendingMessages(ctx, conv._id);

    return {
      ...sessionCommandResult(conv),
      deduplicated,
      was_hidden: wasHidden,
      rearmed_schedules: rearmed,
    };
  },
});

// Agent-facing restart (cast restart <session> via /cli/sessions/restart) — the
// pair to `cast kill <session>`, and the same backend as the web header's
// "Restart session": kill the agent, then resume it through the daemon's resume
// ladder (resume the local transcript → repair from the server copy →
// reconstitute → start fresh). `repair: true` is the web's escalation rung, which
// forces the rebuild from the server copy even when a plain resume would appear
// to succeed — for a stale or corrupt local transcript.
//
// Unlike cliResumeSession this DISCARDS the running agent, so it is the wrong
// verb for merely attaching to a session.
export const cliRestartSession = mutation({
  args: {
    session: v.string(),
    repair: v.optional(v.boolean()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = args.api_token
      ? await getAuthenticatedUserId(ctx, args.api_token)
      : await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const conv = await resolveCommandableSession(ctx, userId, args.session, "restart");
    const { wasHidden, rearmed } = await resurfaceHiddenSession(ctx, conv, userId);
    const { deduplicated } = await enqueueKillAndResume(ctx, conv.user_id, conv, {
      forceReconstitute: !!args.repair,
    });

    return {
      ...sessionCommandResult(conv),
      repaired: !!args.repair,
      deduplicated: !!deduplicated,
      was_hidden: wasHidden,
      rearmed_schedules: rearmed,
    };
  },
});

// Agent-facing rename (cast rename via /cli/sessions/rename). Stamps the same
// title_is_custom flag as the web Rename control, so the auto-titlers
// (titleGeneration, idleSummary, cleanup) never overwrite it. Access: anyone
// with owner-or-team visibility (checkConversationAccess) — a title is shared
// metadata like a message, so the bar matches `cast send`, not run-or-own.
// Share-link viewers ("shared") stay read-only.
export const cliRenameSession = mutation({
  args: {
    session: v.string(),
    title: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = args.api_token
      ? await getAuthenticatedUserId(ctx, args.api_token)
      : await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const title = args.title.trim();
    if (!title) throw new Error("Title cannot be empty");

    const conv = await findConversationByAnyRefWhere(ctx, args.session, async (c) => {
      const access = await checkConversationAccess(ctx, userId, c);
      return access === "owner" || access === "team";
    });
    if (!conv) {
      throw new Error(
        `No session found for "${args.session}" (you can rename your own sessions and sessions shared with your team)`
      );
    }
    const shortId = conv.short_id ?? conv._id.toString().slice(0, 7);
    const previous = conv.title ?? null;
    await ctx.db.patch(conv._id, { title, title_is_custom: true });
    return { ok: true as const, short_id: shortId, title, previous_title: previous };
  },
});

// The pinned thread state (cast state via /cli/sessions/state). The agent writes
// its own standing "where does this stand?" line here and rewrites it as the
// work moves; the human reads it pinned above the composer and truncated on the
// inbox card, instead of reading back through the thread.
//
// Empty text is a CLEAR, so `cast state ""` and `cast state clear` land on the
// same path. We stamp message_count alongside the text because that gap — not
// the clock — is what tells the reader how far the thread has moved since the
// agent last vouched for this (see shared/contracts/threadState).
// The CLI writes it over /cli/sessions/state/set; the web's clear control goes
// through the store's generic patchConversation rail instead, so the panel
// disappears on click without waiting for a round-trip.
// Access: the runner or the second-party owner — same rule as cliRenameSession.
export const setThreadState = mutation({
  args: {
    session: v.string(),
    text: v.optional(v.string()),
    // "working" | "blocked" | "done" (loose spellings accepted). Absent on
    // writes from older CLIs — those default to "working", the overwhelmingly
    // common truth for a state written mid-session.
    status: v.optional(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = args.api_token
      ? await getAuthenticatedUserId(ctx, args.api_token)
      : await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const conv = await findConversationByAnyRefWhere(ctx, args.session, (c) =>
      c.user_id?.toString() === userId.toString() ||
      c.owner_user_id?.toString() === userId.toString()
    );
    if (!conv) {
      throw new Error(
        `No session found for "${args.session}" (you can only set state on sessions you run or own)`
      );
    }

    const shortId = conv.short_id ?? conv._id.toString().slice(0, 7);
    const previous = conv.thread_state ?? null;
    const text = normalizeThreadState(args.text ?? "");

    if (!text) {
      await ctx.db.patch(conv._id, {
        thread_state: undefined,
        thread_state_at: undefined,
        thread_state_msg_count: undefined,
        thread_state_status: undefined,
      });
      return { ok: true as const, short_id: shortId, cleared: true as const, state: null, previous_state: previous };
    }

    const at = Date.now();
    const status = parseThreadStateStatus(args.status) ?? "working";
    await ctx.db.patch(conv._id, {
      thread_state: text,
      thread_state_at: at,
      thread_state_msg_count: conv.message_count ?? 0,
      thread_state_status: status,
    });
    // A `blocked` declaration from a HIDDEN session is a claim on the user's
    // eyes — the same claim `cast trigger complete --needs-attention` makes,
    // cleared the same way (agentTasks.completeTaskRun). If the session is
    // still stashed when the agent declares blocked, nobody is watching by
    // definition (a human send un-stashes at enqueue), so the machine woke it
    // and the human must now be shown. `done` / `dormant` / `working` never
    // resurface anything: stash fails quiet except for asks. Killed rows are
    // exempt — kill tore the agent down; a straggling write must not resurrect.
    let resurfaced = false;
    if (status === "blocked" && (conv.inbox_stashed_at || conv.inbox_dismissed_at) && !conv.inbox_killed_at) {
      await ctx.db.patch(conv._id, {
        inbox_stashed_at: undefined,
        inbox_dismissed_at: undefined,
      });
      resurfaced = true;
    }
    return { ok: true as const, short_id: shortId, cleared: false as const, state: text, status, previous_state: previous, at, resurfaced };
  },
});

// Read side of the same field (cast state / cast state show <session>). Same
// access rule as the write: a session you run or own.
export const getThreadState = query({
  args: {
    session: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = args.api_token
      ? await getAuthenticatedUserId(ctx, args.api_token)
      : await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const conv = await findConversationByAnyRefWhere(ctx, args.session, (c) =>
      c.user_id?.toString() === userId.toString() ||
      c.owner_user_id?.toString() === userId.toString()
    );
    if (!conv) {
      throw new Error(
        `No session found for "${args.session}" (you can only read state on sessions you run or own)`
      );
    }
    return {
      ok: true as const,
      short_id: conv.short_id ?? conv._id.toString().slice(0, 7),
      title: conv.title ?? null,
      state: conv.thread_state ?? null,
      status: conv.thread_state_status ?? null,
      at: conv.thread_state_at ?? null,
      msg_count_at_write: conv.thread_state_msg_count ?? null,
      message_count: conv.message_count ?? 0,
      // The session's filing, for the daemon's trigger scheduler: a machine
      // wake into a stashed session tells the agent nobody is watching (see
      // taskScheduler's inject preamble). "stashed" | "killed" | null.
      visibility: conv.inbox_killed_at ? ("killed" as const)
        : conv.inbox_stashed_at ? ("stashed" as const)
        : null,
    };
  },
});

// Bulk-dismiss the caller's sessions whose last activity (updated_at) is older
// than `older_than_days` (default 30). Clears the accumulated working set without
// deleting anything — dismissed rows stay searchable and accessible. FIRE-ONCE:
// the heavy work is handed to a self-draining background job, NOT looped from the
// client. A client-side loop of dozens of write-mutations is fragile on a
// saturation-prone deployment (one flaky call surfaced a scary error toast); a
// single scheduled drainer can't fail the user's click and drains durably on the
// server's own clock. The client has already dismissed locally (optimistic), so
// this only needs to make it stick server-side / cross-device.
export const dismissStaleInboxSessions = mutation({
  args: {
    older_than_days: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const cutoff = Date.now() - (args.older_than_days ?? 30) * 24 * 60 * 60 * 1000;
    await ctx.scheduler.runAfter(0, internal.conversations.drainStaleDismiss, {
      userId,
      cutoff,
      cursor: null,
      attempt: 0,
    });
    return { scheduled: true };
  },
});

// Self-draining background dismiss. Dismisses one bounded page of the caller's
// >cutoff-old sessions (skipping pinned + already-dismissed) and reschedules
// itself with the next cursor until the whole backlog is cleared. Range-scans
// only the OLD region (by_user_updated, lt cutoff). EVERYTHING stale but pinned
// is dismissed — including subagents/orphans, because a dismissed parent promotes
// its old subagent children to the top level and they'd refill the inbox. A
// thrown page (transient backend hiccup) rolls back untouched and retries the
// SAME cursor with backoff up to a cap; work is idempotent (dismissed rows are
// skipped), so retries never double-count and a give-up only loses cross-device
// completeness, never the local clear the user already saw.
export const drainStaleDismiss = internalMutation({
  args: {
    userId: v.id("users"),
    cutoff: v.number(),
    cursor: v.union(v.string(), v.null()),
    attempt: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    try {
      const result = await ctx.db
        .query("conversations")
        .withIndex("by_user_updated", (q) =>
          q.eq("user_id", args.userId).lt("updated_at", args.cutoff)
        )
        .paginate({ cursor: args.cursor, numItems: 100 });

      for (const conv of result.page) {
        if (conv.inbox_dismissed_at) continue;
        if (conv.inbox_pinned_at) continue;
        await ctx.db.patch(conv._id, { inbox_dismissed_at: now });
      }

      if (!result.isDone) {
        await ctx.scheduler.runAfter(150, internal.conversations.drainStaleDismiss, {
          userId: args.userId,
          cutoff: args.cutoff,
          cursor: result.continueCursor,
          attempt: 0,
        });
      }
    } catch {
      const attempt = args.attempt + 1;
      if (attempt <= 6) {
        await ctx.scheduler.runAfter(2000 * attempt, internal.conversations.drainStaleDismiss, {
          userId: args.userId,
          cutoff: args.cutoff,
          cursor: args.cursor,
          attempt,
        });
      }
    }
  },
});

const PATCHABLE_FIELDS = new Set([
  "inbox_dismissed_at",
  "inbox_deferred_at",
  "inbox_dormant_at",
  "inbox_pinned_at",
  "draft_message",
  "project_path",
  "git_root",
  "agent_type",
]);

export const patchConversation = mutation({
  args: {
    id: v.id("conversations"),
    fields: v.any(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const conv = await ctx.db.get(args.id);
    if (!conv || conv.user_id !== userId) throw new Error("Not found");

    const patch: Record<string, any> = {};
    for (const [key, value] of Object.entries(args.fields as Record<string, any>)) {
      if (!PATCHABLE_FIELDS.has(key)) continue;
      patch[key] = value === null ? undefined : value;
    }
    if (await pinCapExceeded(ctx, userId, conv, patch)) throw new Error(PIN_CAP_ERROR);
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.id, patch);
    }
  },
});

// Repairs conversations whose updated_at was wrongly bumped to Date.now() by
// addMessages during a sync_mode=all historical backfill (months-old JSONLs
// re-uploaded with current timestamps, polluting the inbox active panel).
//
// For each conversation owned by the caller, looks up the actual latest
// message timestamp. If updated_at is more than 1 hour ahead of that real
// timestamp, rewinds it to the real timestamp. Additionally, if the real
// last message is older than 7 days and the session isn't already dismissed,
// sets inbox_dismissed_at=now so historical sessions stop appearing in the
// active panel.
//
// Paginated by user — caller passes cursor until isDone=true.
export const healHistoricalUpdatedAt = mutation({
  args: {
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
    dismiss_older_than_days: v.optional(v.number()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) throw new Error("Authentication required");

    const batchSize = args.limit ?? 100;
    const dismissCutoffMs = (args.dismiss_older_than_days ?? 7) * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const result = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize });

    let rewound = 0;
    let dismissed = 0;
    for (const conv of result.page) {
      const lastMsg = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) =>
          q.eq("conversation_id", conv._id)
        )
        .order("desc")
        .first();

      const realLastTs = lastMsg?.timestamp ?? conv.started_at;
      const patch: Record<string, unknown> = {};

      if (conv.updated_at > realLastTs + 60 * 60 * 1000) {
        patch.updated_at = realLastTs;
        rewound++;
      }

      if (
        !conv.inbox_dismissed_at &&
        now - realLastTs > dismissCutoffMs
      ) {
        patch.inbox_dismissed_at = now;
        dismissed++;
      }

      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(conv._id, patch);
      }
    }

    return {
      rewound,
      dismissed,
      scanned: result.page.length,
      cursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

export const reconfigureSession = mutation({
  args: {
    conversation_id: v.id("conversations"),
    agent_type: v.optional(v.union(
      v.literal("claude_code"),
      v.literal("codex"),
      v.literal("cursor"),
      v.literal("gemini"),
      v.literal("opencode"),
      v.literal("pi"),
      v.literal("grok")
    )),
    project_path: v.optional(v.string()),
    git_root: v.optional(v.string()),
    isolated: v.optional(v.boolean()),
    // The machine picked on the new-session page. Routing honours it while it's
    // online and otherwise falls back, so ownership follows the resolved route
    // (stamped by enqueueStartSession) rather than the request.
    target_device_id: v.optional(v.string()),
    // Launch model/effort for the (blank) session — option keys from the
    // shared contract. "default" clears the stamp and omits the flag. Launch
    // flags leave no transcript echo, so the stamp here is the only record
    // until the first assistant turn confirms.
    model: v.optional(v.string()),
    effort: v.optional(v.string()),
    // A parked create can land with an earlier stable-context selection than
    // the still-local stub. Rekey reconciliation relaunches the blank session
    // through this mutation with the latest values before its first message.
    stable_mode: v.optional(v.string()),
    stable_exclude: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || conv.user_id !== userId) throw new Error("Not found");
    if ((conv.message_count ?? 0) > 0) throw new Error("Cannot reconfigure session with messages");

    const patch: Record<string, any> = { updated_at: Date.now() };
    if (args.agent_type) patch.agent_type = args.agent_type;
    // An agent flip invalidates the previous agent's model/effort stamps
    // (claude-opus on a codex session is nonsense; effort scales differ too).
    // An explicit model/effort in the same call re-stamps below.
    if (args.agent_type && args.agent_type !== conv.agent_type) {
      patch.model = undefined;
      patch.effort = undefined;
    }
    const reconfAgent = args.agent_type || conv.agent_type || "claude_code";
    const launchCfg = AGENT_MODEL_CONFIG[modelAgentKey(reconfAgent)];
    const launchModelOpt = args.model ? launchCfg?.models.find((m) => m.key === args.model) : undefined;
    if (args.model !== undefined) {
      if (!launchModelOpt) throw new Error(`Unknown model: ${args.model}`);
      patch.model = launchModelOpt.cliAlias
        ? (modelAgentKey(reconfAgent) === "claude" ? `claude-${launchModelOpt.key}` : launchModelOpt.key)
        : undefined;
    }
    if (args.effort !== undefined) {
      // "default" clears the pin: no stamp, no --effort flag — the agent's own
      // saved default wins (mirrors model "default").
      if (args.effort === "default") {
        patch.effort = undefined;
      } else {
        if (!launchCfg?.efforts.includes(args.effort)) throw new Error(`Unknown effort: ${args.effort}`);
        patch.effort = args.effort;
      }
    }
    if (args.project_path !== undefined) {
      patch.project_path = args.project_path;
      patch.git_root = args.git_root ?? args.project_path;
      const mappings = await ctx.db
        .query("directory_team_mappings")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .collect();
      const { teamId, isPrivate, autoShared } = resolveTeamForPath(mappings, args.project_path, undefined);
      if (teamId) patch.team_id = teamId;
      patch.is_private = isPrivate;
      patch.auto_shared = autoShared || undefined;
    }

    await ctx.db.patch(args.conversation_id, patch);
    // A project-path change re-resolves team/privacy; if the access inputs
    // actually moved, advance the comment view head (matrix SRV-02). Guarded
    // because reconfigure runs on every relaunch with unchanged access.
    if (args.project_path !== undefined &&
      (patch.is_private !== conv.is_private ||
        (patch.team_id !== undefined && patch.team_id !== conv.team_id))) {
      await advanceCommentsAccessRevision(ctx, conv);
    }

    // start_session is now idempotent on the daemon: it kills any tmux with the
    // deterministic name `cc-<agent>-<convId-suffix>` and respawns it. One
    // command, last-write-wins, no two-step kill+start race.
    const updated = { ...conv, ...patch };
    const daemonAgentType = fromConvexAgentType(updated.agent_type);
    // Re-derive the launch payload from the (possibly just-patched) stamps so
    // an agent flip alone re-launches with the conversation's chosen model.
    const stampedModelKey = (() => {
      if (args.model !== undefined) return launchModelOpt?.cliAlias ? launchModelOpt.key : undefined;
      const m = updated.model as string | undefined;
      if (!m) return undefined;
      const key = modelAgentKey(daemonAgentType === "codex" ? "codex" : "claude_code") === "claude" && m.startsWith("claude-") ? m.slice("claude-".length) : m;
      return launchCfg?.models.some((o) => o.key === key && o.cliAlias) ? key : undefined;
    })();
    await enqueueStartSession(ctx, userId, {
      conversationId: args.conversation_id,
      agentType: daemonAgentType,
      projectPath: updated.project_path || updated.git_root,
      gitRoot: updated.git_root,
      sessionId: updated.session_id,
      isolated: args.isolated,
      targetDeviceId: args.target_device_id ?? null,
      ...(stampedModelKey ? { model: stampedModelKey } : {}),
      ...(updated.effort && launchCfg?.efforts.includes(updated.effort) ? { effort: updated.effort } : {}),
      ...(args.stable_mode ? { stableMode: args.stable_mode } : {}),
      ...(args.stable_exclude?.length ? { stableExclude: args.stable_exclude } : {}),
    });
  },
});

const switchAgentType = v.union(
  v.literal("claude_code"),
  v.literal("codex"),
  v.literal("cursor"),
  v.literal("gemini"),
  v.literal("opencode"),
  v.literal("pi"),
  v.literal("grok"),
);

// Stay on THIS conversation: patch agent/model, drop a transcript divider, and
// (when the live process has to change) kill+reconstitute as the new agent.
// Forking is a different verb — forkFromMessage with target_agent_type.
export const switchSessionAgent = mutation({
  args: {
    conversation_id: v.optional(v.id("conversations")),
    session: v.optional(v.string()),
    agent_type: v.optional(switchAgentType),
    model: v.optional(v.string()),
    effort: v.optional(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = args.api_token
      ? await getAuthenticatedUserId(ctx, args.api_token)
      : await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    let conv: Doc<"conversations"> | null = null;
    if (args.conversation_id) {
      conv = await ctx.db.get(args.conversation_id);
      if (conv && conv.user_id !== userId && conv.owner_user_id !== userId) {
        throw new Error("Not authorized");
      }
    } else if (args.session) {
      conv = await resolveCommandableSession(ctx, userId, args.session, "switch");
    } else {
      throw new Error("conversation_id or session required");
    }
    if (!conv) throw new Error("Not found");

    const prevAgent = conv.agent_type || "claude_code";
    const nextAgent = args.agent_type || prevAgent;
    const agentChanged = !!args.agent_type && args.agent_type !== prevAgent;
    if (!agentChanged && args.model === undefined && args.effort === undefined) {
      throw new Error("Nothing to switch");
    }

    const patch: Record<string, any> = { updated_at: Date.now() };
    if (agentChanged) {
      patch.agent_type = args.agent_type;
      patch.model = undefined;
      patch.effort = undefined;
    }
    const launchCfg = AGENT_MODEL_CONFIG[modelAgentKey(nextAgent)];
    const launchModelOpt = args.model ? findModelOption(nextAgent, args.model) : undefined;
    if (args.model !== undefined) {
      if (args.model !== "default" && !launchModelOpt) throw new Error(`Unknown model: ${args.model}`);
      patch.model = args.model === "default" || !launchModelOpt?.cliAlias
        ? undefined
        : (modelAgentKey(nextAgent) === "claude" ? `claude-${launchModelOpt.key}` : launchModelOpt.key);
    }
    if (args.effort !== undefined) {
      if (args.effort === "default") {
        patch.effort = undefined;
      } else {
        if (!launchCfg?.efforts.includes(args.effort)) throw new Error(`Unknown effort: ${args.effort}`);
        patch.effort = args.effort;
      }
    }

    await ctx.db.patch(conv._id, patch);
    const updated = { ...conv, ...patch } as Doc<"conversations">;
    const blank = (conv.message_count ?? 0) === 0;
    const midSession = launchCfg?.midSession === true;
    const reconstitutes = !blank && (agentChanged || !midSession);

    if (blank) {
      const daemonAgentType = fromConvexAgentType(nextAgent);
      const stampedModelKey = args.model !== undefined
        ? (launchModelOpt?.cliAlias ? launchModelOpt.key : undefined)
        : undefined;
      await enqueueStartSession(ctx, conv.user_id, {
        conversationId: conv._id,
        agentType: daemonAgentType,
        projectPath: updated.project_path || updated.git_root,
        gitRoot: updated.git_root,
        sessionId: updated.session_id,
        ...(stampedModelKey ? { model: stampedModelKey } : {}),
        ...(updated.effort && launchCfg?.efforts.includes(updated.effort) ? { effort: updated.effort } : {}),
      });
      return { ...sessionCommandResult(updated), switched: true, blank: true, reconstituted: false };
    }

    if (reconstitutes) {
      const notice = formatAgentSwitchNotice({
        toAgent: nextAgent,
        fromAgent: prevAgent,
        toModel: args.model ?? (agentChanged ? undefined : conv.model),
        fromModel: agentChanged ? conv.model : (args.model !== undefined ? conv.model : undefined),
      });
      await ctx.db.insert("messages", {
        conversation_id: conv._id,
        role: "user",
        content: notice,
        subtype: "agent_switch",
        message_uuid: crypto.randomUUID(),
        timestamp: Date.now(),
      });
      await ctx.db.patch(conv._id, {
        message_count: (conv.message_count ?? 0) + 1,
        last_message_role: "user",
        updated_at: Date.now(),
      });
      if (!updated.session_id) throw new Error("No session to switch");
      await enqueueKillAndResume(ctx, conv.user_id, updated, {
        forceReconstitute: true,
        switchAgent: true,
      });
      return { ...sessionCommandResult(updated), switched: true, reconstituted: true };
    }

    // Same-provider live rail: stamp the row, then inject `/model` / `/effort`
    // so the running agent applies it. The slash echo is the divider.
    const liveCommands: string[] = [];
    if (args.model !== undefined) {
      const alias = args.model === "default" ? "default" : launchModelOpt?.cliAlias;
      if (alias) liveCommands.push(`/model ${alias}`);
    }
    if (args.effort !== undefined && args.effort !== "default") {
      liveCommands.push(`/effort ${args.effort}`);
    }
    for (const content of liveCommands) {
      await enqueuePendingMessage(ctx, updated, userId, {
        content,
        client_id: `switch-${crypto.randomUUID()}`,
      });
    }
    return {
      ...sessionCommandResult(updated),
      switched: true,
      reconstituted: false,
      live_commands: liveCommands,
    };
  },
});

export const linkSessions = mutation({
  args: {
    parent_conversation_id: v.id("conversations"),
    child_conversation_id: v.id("conversations"),
    subagent_description: v.optional(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = args.api_token
      ? await getAuthenticatedUserId(ctx, args.api_token)
      : await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const parent = await ctx.db.get(args.parent_conversation_id);
    if (!parent || parent.user_id !== userId) throw new Error("Parent not found");

    const child = await ctx.db.get(args.child_conversation_id);
    if (!child || child.user_id !== userId) throw new Error("Child not found");

    if (child.parent_conversation_id) return;

    await ctx.db.patch(args.child_conversation_id, {
      parent_conversation_id: args.parent_conversation_id,
      is_subagent: true,
      inbox_dismissed_at: Date.now(),
      ...(args.subagent_description && !child.subagent_description
        ? { subagent_description: args.subagent_description }
        : {}),
    });
  },
});

// Link a VISIBLE child to the session that spawned it (agent-team teammate →
// its lead). Unlike linkSessions this neither marks the child a subagent nor
// dismisses it — the child stays a first-class inbox card; the pointer only
// powers the "Parent" click-through and teammate-name resolution. Also stamps
// both sides with the agent-team identity: the child's teamName/agentName come
// from its JSONL stamps, and the lead (whose transcript is never stamped) gets
// agent_name "team-lead" so siblings can resolve it by name.
export const linkSpawnedBy = mutation({
  args: {
    parent_conversation_id: v.id("conversations"),
    child_conversation_id: v.id("conversations"),
    agent_team_name: v.optional(v.string()),
    agent_name: v.optional(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = args.api_token
      ? await getAuthenticatedUserId(ctx, args.api_token)
      : await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const parent = await ctx.db.get(args.parent_conversation_id);
    if (!parent || parent.user_id !== userId) throw new Error("Parent not found");

    const child = await ctx.db.get(args.child_conversation_id);
    if (!child || child.user_id !== userId) throw new Error("Child not found");

    if (!child.spawned_by_conversation_id) {
      await ctx.db.patch(args.child_conversation_id, {
        spawned_by_conversation_id: args.parent_conversation_id,
        ...(args.agent_team_name && !child.agent_team_name
          ? { agent_team_name: args.agent_team_name }
          : {}),
        ...(args.agent_name && !child.agent_name ? { agent_name: args.agent_name } : {}),
      });
    }

    if (args.agent_team_name && !parent.agent_team_name) {
      await ctx.db.patch(args.parent_conversation_id, {
        agent_team_name: args.agent_team_name,
        ...(parent.agent_name ? {} : { agent_name: "team-lead" }),
      });
    }
  },
});

export const linkSessionsInternal = internalMutation({
  args: {
    parent_conversation_id: v.id("conversations"),
    child_conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const child = await ctx.db.get(args.child_conversation_id);
    if (!child) throw new Error("Child not found");
    await ctx.db.patch(args.child_conversation_id, {
      parent_conversation_id: args.parent_conversation_id,
      is_subagent: true,
      inbox_dismissed_at: Date.now(),
    });
  },
});

export const linkPlanHandoff = mutation({
  args: {
    parent_conversation_id: v.id("conversations"),
    child_conversation_id: v.id("conversations"),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = args.api_token
      ? await getAuthenticatedUserId(ctx, args.api_token)
      : await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const child = await ctx.db.get(args.child_conversation_id);
    if (!child || child.user_id !== userId) throw new Error("Child not found");

    if (child.parent_message_uuid === "plan-handoff") return;

    await ctx.db.patch(args.child_conversation_id, {
      parent_conversation_id: args.parent_conversation_id,
      parent_message_uuid: "plan-handoff",
    });
  },
});

export const adminLookupConversation = mutation({
  args: {
    conversation_id: v.optional(v.id("conversations")),
    session_id: v.optional(v.string()),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");
    let conv;
    if (args.conversation_id) {
      conv = await ctx.db.get(args.conversation_id);
      if (conv && conv.user_id.toString() !== userId.toString()) conv = null;
    } else if (args.session_id) {
      conv = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q: any) => q.eq("session_id", args.session_id))
        .filter((q: any) => q.eq(q.field("user_id"), userId))
        .first();
    }
    if (!conv) return null;
    return {
      _id: conv._id,
      session_id: conv.session_id,
      title: conv.title,
      parent_conversation_id: conv.parent_conversation_id,
      parent_message_uuid: conv.parent_message_uuid,
      is_subagent: conv.is_subagent,
      inbox_dismissed_at: conv.inbox_dismissed_at,
      project_path: conv.project_path,
      created_at: conv._creationTime,
    };
  },
});

export const adminFindChildren = mutation({
  args: {
    parent_conversation_id: v.id("conversations"),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");
    const children = await ctx.db
      .query("conversations")
      .withIndex("by_parent_conversation_id", (q) =>
        q.eq("parent_conversation_id", args.parent_conversation_id)
      )
      .collect();
    // Scope to the caller's own children, matching adminLookupConversation. The
    // sibling was correctly user-scoped; this one dropped it and listed any
    // parent's children.
    return children
      .filter((c) => c.user_id.toString() === userId.toString())
      .map((c) => ({
        _id: c._id,
        session_id: c.session_id,
        title: c.title,
        is_subagent: c.is_subagent,
        parent_conversation_id: c.parent_conversation_id,
      }));
  },
});

export const adminLinkChildrenBySessionId = mutation({
  args: {
    parent_session_id: v.string(),
    child_session_ids: v.array(v.string()),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");

    const parent = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.parent_session_id))
      .filter((q) => q.eq(q.field("user_id"), userId))
      .first();
    if (!parent) throw new Error("Parent not found");

    const results: Array<{session_id: string; status: string; conversation_id?: string}> = [];
    for (const childSessionId of args.child_session_ids) {
      const child = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", childSessionId))
        .filter((q) => q.eq(q.field("user_id"), userId))
        .first();
      if (!child) {
        results.push({ session_id: childSessionId, status: "not_found" });
        continue;
      }
      if (child.parent_conversation_id === parent._id) {
        results.push({ session_id: childSessionId, status: "already_linked", conversation_id: child._id });
        continue;
      }
      await ctx.db.patch(child._id, {
        parent_conversation_id: parent._id,
        is_subagent: true,
        inbox_dismissed_at: Date.now(),
      });
      results.push({ session_id: childSessionId, status: "linked", conversation_id: child._id });
    }
    return { parent_id: parent._id, parent_session_id: parent.session_id, results };
  },
});

export const adminUnlinkSession = mutation({
  args: {
    session_id: v.string(),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .filter((q) => q.eq(q.field("user_id"), userId))
      .first();
    if (!conv) throw new Error("Not found");
    await ctx.db.patch(conv._id, {
      parent_conversation_id: undefined,
      is_subagent: undefined,
      inbox_dismissed_at: undefined,
    });
    return { unlinked: conv._id };
  },
});

export const updateSessionId = mutation({
  args: {
    conversation_id: v.id("conversations"),
    session_id: v.string(),
    // When the daemon links a real local session to a pre-created stub
    // (e.g. a web-started conversation), the stub's project_path/git_root were
    // a guess made before the session existed. Reconcile them to the actual
    // session cwd in the same patch so the displayed project can never diverge
    // from where the session is really running.
    project_path: v.optional(v.string()),
    git_root: v.optional(v.string()),
    api_token: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Unauthorized");

    const conv = await ctx.db.get(args.conversation_id);
    if (!conv || conv.user_id.toString() !== userId.toString()) {
      throw new Error("Not found");
    }

    const patch: Record<string, any> = { session_id: args.session_id };
    if (args.project_path) patch.project_path = args.project_path;
    if (args.git_root) patch.git_root = args.git_root;

    // Stubs are created before their real path exists, so their team/privacy
    // resolved against nothing (→ private, teamless). Re-resolve against the
    // reconciled path; explicit user choices win inside the helper.
    const stampedPath = args.git_root || args.project_path;
    if (stampedPath) {
      const mappings = await ctx.db
        .query("directory_team_mappings")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .collect();
      const restamp = buildPathRestampUpdate(conv, mappings, stampedPath);
      if (restamp) Object.assign(patch, restamp);
    }

    // A restamp can flip visibility, so linked work items must follow.
    if (patch.is_private !== undefined || patch.team_id !== undefined || patch.auto_shared !== undefined || patch.team_visibility !== undefined) {
      await patchConversationVisibility(ctx, conv, patch);
    } else {
      await ctx.db.patch(args.conversation_id, patch);
    }
    // A stable-context record posted under the REAL agent session id before
    // this rebind (web-started sessions briefly carry the client stub id)
    // is waiting in the spool — attach it now.
    await consumeStableContextSpool(ctx, userId, args.session_id, args.conversation_id);
    return { updated: true };
  },
});

/**
 * Attach a spooled stable-context record (parked by recordStableContext when
 * no conversation carried the session id yet) to its now-known conversation.
 * Doesn't clobber an existing record — the direct recordStableContext patch is
 * fresher. Also lazily prunes this user's stale spool rows so the transient
 * table can't grow unbounded.
 */
export async function consumeStableContextSpool(
  ctx: { db: any },
  userId: Id<"users">,
  sessionId: string,
  conversationId: Id<"conversations">,
): Promise<void> {
  const spooled = await ctx.db
    .query("stable_context_spool")
    .withIndex("by_session_id", (q: any) => q.eq("session_id", sessionId))
    .filter((q: any) => q.eq(q.field("user_id"), userId))
    .first();
  if (spooled) {
    const conv = await ctx.db.get(conversationId);
    // Don't clobber an existing record (side row, or a legacy on-doc value not
    // yet swept) — the direct recordStableContext write is fresher.
    if (conv && !conv.stable_context && !(await getConvStableContext(ctx, conversationId))) {
      await setConvStableContext(ctx, conversationId, spooled.data);
    }
    await ctx.db.delete(spooled._id);
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const stale = await ctx.db
    .query("stable_context_spool")
    .withIndex("by_user_created", (q: any) => q.eq("user_id", userId).lt("created_at", cutoff))
    .take(20);
  for (const row of stale) {
    if (row.created_at < cutoff) await ctx.db.delete(row._id);
  }
}

/**
 * Record the stable-context feed injected into a session at start (called by
 * `cast stable-context` — the SessionStart hook — and the daemon's Codex
 * launch). `data` is a StableContextData JSON string, rendered by the web as
 * cards at the top of the conversation. Keyed by conversation_id when the
 * daemon exported it into the session env; else by agent session id, spooled
 * until the conversation registers (createConversation / updateSessionId).
 */
export const recordStableContext = mutation({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.optional(v.string()),
    session_id: v.optional(v.string()),
    data: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Unauthorized");
    // Sanity-cap: the record is a trimmed feed snapshot, never a transcript.
    if (args.data.length > 64_000) throw new Error("stable_context too large");

    if (args.conversation_id) {
      let conv = null;
      try {
        conv = await ctx.db.get(args.conversation_id as Id<"conversations">);
      } catch {}
      if (conv && conv.user_id.toString() === userId.toString()) {
        await setConvStableContext(ctx, conv._id, args.data);
        return { recorded: "conversation" };
      }
    }

    if (args.session_id) {
      const conv = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id!))
        .filter((q) => q.eq(q.field("user_id"), userId))
        .first();
      if (conv) {
        await setConvStableContext(ctx, conv._id, args.data);
        return { recorded: "conversation" };
      }
      // No conversation yet (hook fired before the daemon registered the
      // transcript) — park it; the registration paths consume the spool.
      const existing = await ctx.db
        .query("stable_context_spool")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id!))
        .filter((q) => q.eq(q.field("user_id"), userId))
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, { data: args.data, created_at: Date.now() });
      } else {
        await ctx.db.insert("stable_context_spool", {
          user_id: userId,
          session_id: args.session_id,
          data: args.data,
          created_at: Date.now(),
        });
      }
      return { recorded: "spool" };
    }

    return { recorded: "none" };
  },
});

export const listDismissedSessions = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const now = Date.now();
    const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
    const cutoff = now - WINDOW_MS;

    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_dismissed", (q) =>
        q.eq("user_id", userId).gte("inbox_dismissed_at", cutoff)
      )
      .order("desc")
      .take(200);

    const results = [];

    for (const conv of conversations) {
      if (!shouldShowInInbox(conv)) continue;

      const isDismissedCompleted = conv.status === "completed";

      let implementationSession: { _id: string; title?: string } | undefined;
      if (isDismissedCompleted) {
        const children = await ctx.db
          .query("conversations")
          .withIndex("by_parent_conversation_id", (q) =>
            q.eq("parent_conversation_id", conv._id)
          )
          .take(5);
        const implChild = children.find(
          (c) => c.parent_message_uuid === "plan-handoff" && !c.is_subagent
        );
        if (implChild) {
          implementationSession = { _id: implChild._id.toString(), title: implChild.title };
        }
      }

      results.push({
        _id: conv._id,
        session_id: conv.session_id,
        title: conv.title,
        subtitle: conv.subtitle,
        updated_at: conv.updated_at,
        project_path: conv.project_path,
        git_root: conv.git_root,
        git_branch: conv.git_branch,
        agent_type: conv.agent_type,
        message_count: conv.message_count,
        idle_summary: conv.idle_summary,
        is_idle: true,
        has_pending: false,
        implementation_session: implementationSession,
        worktree_name: conv.worktree_name,
        worktree_branch: conv.worktree_branch,
        icon: conv.icon,
        icon_color: conv.icon_color,
        dismissed_at: conv.inbox_dismissed_at,
      });
    }

    results.sort((a, b) => (b.dismissed_at || b.updated_at) - (a.dismissed_at || a.updated_at));
    return results;
  },
});


export const backfillLastUserMessageAt = internalMutation({
  args: { user_id: v.optional(v.id("users")) },
  handler: async (ctx, args) => {
    if (!args.user_id) return { patched: 0 };
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    const convs = await ctx.db
      .query("conversations")
      .withIndex("by_user_updated", (q) =>
        q.eq("user_id", args.user_id!).gte("updated_at", cutoff)
      )
      .collect();

    let maxUserMsgAt = 0;
    let patched = 0;
    for (const conv of convs) {
      if (!conv.last_user_message_at) {
        const lastUserMsg = await ctx.db
          .query("messages")
          .withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", conv._id))
          .filter((q) => q.eq(q.field("role"), "user"))
          .order("desc")
          .first();
        if (lastUserMsg) {
          await ctx.db.patch(conv._id, { last_user_message_at: lastUserMsg.timestamp });
          maxUserMsgAt = Math.max(maxUserMsgAt, lastUserMsg.timestamp);
          patched++;
        }
      } else {
        maxUserMsgAt = Math.max(maxUserMsgAt, conv.last_user_message_at);
      }
    }

    if (maxUserMsgAt > 0) {
      const user = await ctx.db.get(args.user_id);
      if (user && (!user.last_message_sent_at || user.last_message_sent_at < maxUserMsgAt)) {
        const patch: Record<string, unknown> = { last_message_sent_at: maxUserMsgAt };
        if (user.last_message_sent_at) {
          patch.prev_message_sent_at = user.last_message_sent_at;
          const GAP_THRESHOLD_MS = 2 * 60 * 60 * 1000;
          if (maxUserMsgAt - user.last_message_sent_at > GAP_THRESHOLD_MS) {
            patch.work_cluster_started_at = maxUserMsgAt;
          }
        }
        await ctx.db.patch(args.user_id, patch);
      }
    }

    return { patched, maxUserMsgAt: maxUserMsgAt > 0 ? new Date(maxUserMsgAt).toISOString() : "none" };
  },
});

export const backfillDenormalizedFields = internalMutation({
  args: { user_id: v.optional(v.id("users")) },
  handler: async (ctx, args) => {
    if (!args.user_id) return { patched: 0 };
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    const convs = await ctx.db
      .query("conversations")
      .withIndex("by_user_updated", (q) =>
        q.eq("user_id", args.user_id!).gte("updated_at", cutoff)
      )
      .collect();

    let patched = 0;
    for (const conv of convs) {
      if (conv.last_message_role && conv.last_message_preview !== undefined) continue;

      const patch: Record<string, unknown> = {};

      const lastMsg = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", conv._id))
        .order("desc")
        .first();
      if (lastMsg) {
        patch.last_message_role = lastMsg.role;
      }

      const lastUserMsg = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", conv._id))
        .order("desc")
        .filter((q) => q.and(
          q.eq(q.field("role"), "user"),
          q.neq(q.field("content"), undefined),
          q.neq(q.field("content"), ""),
        ))
        .first();
      if (lastUserMsg?.content?.trim()) {
        patch.last_message_preview = lastUserMsg.content
          .replace(/\[Image[:\s][^\]]*\]/gi, "")
          .replace(/<image\b[^>]*\/?>\s*(?:<\/image>)?/gi, "")
          .trim()
          .slice(0, 200);
      }

      const pendingMsg = await ctx.db
        .query("pending_messages")
        .withIndex("by_conversation_status", (q) =>
          q.eq("conversation_id", conv._id).eq("status", "pending")
        )
        .first();
      patch.has_pending_messages = !!pendingMsg;

      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(conv._id, patch);
        patched++;
      }
    }
    return { patched };
  },
});

// requireSessionCommandTarget lives in daemonCommandUtils (shared with
// users.resumeSession and the dispatch resume handler); re-exported for callers
// and tests that reach it through this module.
export { requireSessionCommandTarget };

export const sendEscapeToSession = mutation({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const conv = await requireSessionCommandTarget(ctx, userId, args.conversation_id);

    await ctx.db.insert("daemon_commands", {
      user_id: conv.user_id,
      command: "escape",
      args: JSON.stringify({ conversation_id: args.conversation_id }),
      created_at: Date.now(),
    });
  },
});

export const sendKeysToSession = mutation({
  args: {
    conversation_id: v.id("conversations"),
    keys: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const conv = await requireSessionCommandTarget(ctx, userId, args.conversation_id);

    await ctx.db.insert("daemon_commands", {
      user_id: conv.user_id,
      command: "send_keys",
      args: JSON.stringify({ conversation_id: args.conversation_id, keys: args.keys }),
      created_at: Date.now(),
    });
  },
});

export const rewindSession = mutation({
  args: {
    conversation_id: v.id("conversations"),
    steps_back: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const conv = await requireSessionCommandTarget(ctx, userId, args.conversation_id);

    await ctx.db.insert("daemon_commands", {
      user_id: conv.user_id,
      command: "rewind",
      args: JSON.stringify({ conversation_id: args.conversation_id, steps_back: args.steps_back }),
      created_at: Date.now(),
    });
  },
});

// ---------------------------------------------------------------------------
// Kill / restart recovery.
//
// The conversation id a client acts on can be a GHOST: the row was deleted
// server-side (GC sweeps, cleanup mutations) while the client's never-prune
// cache keeps rendering it. The underlying agent session is still real — its
// JSONL transcript (and sometimes tmux) lives on the daemon's machine — so
// "kill & restart" must keep working. Recovery resolves a live target row for
// the session instead of dead-ending: prefer the newest live twin bound to the
// same session_id (the daemon's local conversation cache usually already syncs
// there), else recreate a minimal row for the daemon to bind to. The context
// fields (session_id/project_path/agent_type/title) ride in from the client's
// cached copy, because for a deleted row the server knows nothing.
// ---------------------------------------------------------------------------

const RESTART_GHOST_ARGS = {
  session_id: v.optional(v.string()),
  project_path: v.optional(v.string()),
  agent_type: v.optional(v.string()),
  title: v.optional(v.string()),
};

type RestartGhostContext = {
  session_id?: string;
  project_path?: string;
  agent_type?: string;
  title?: string;
};

export async function resolveRestartTarget(
  ctx: MutationCtx,
  userId: Id<"users">,
  conversationId: Id<"conversations">,
  ghost: RestartGhostContext,
) {
  const conv = await ctx.db.get(conversationId);
  if (conv) {
    // The runner, or the session's second-party owner — same rule as dispatch
    // sendMessage/resumeSession. An owned session (Mr-Bot-run, assigned to this
    // user) restarts from the owner's inbox exactly like their own; the daemon
    // commands are routed to the runner by the callers.
    if (conv.user_id !== userId && conv.owner_user_id !== userId) throw new Error("Not authorized");
    // An explicit Restart IS the sanctioned revival — the same gesture class as
    // a human send, so it gets the send path's wake-up rules
    // (enqueuePendingMessage): clear the kill/hide stamps and re-activate, in
    // the SAME transaction that enqueues the resume. Without this the daemon
    // received "restart me" for a row still reading as killed and its hide gate
    // refused to bring it back. The ghost-recovery path below already did this
    // for the twin it restores; the existing row was the gap. Patch only what's
    // actually set, so an ordinary restart of a live session writes nothing.
    // Read the pre-patch state first: the re-arm below is decided on what the
    // row looked like when the user hit Restart, not on what the patch left.
    const wasRetired = !!(conv.inbox_dismissed_at || conv.inbox_killed_at);
    const revive: Record<string, any> = {};
    if (conv.status === "completed") revive.status = "active" as const;
    if (conv.inbox_killed_at) revive.inbox_killed_at = undefined;
    if (conv.inbox_dismissed_at) revive.inbox_dismissed_at = undefined;
    if (conv.inbox_stashed_at) revive.inbox_stashed_at = undefined;
    if (Object.keys(revive).length > 0) {
      await ctx.db.patch(conv._id, revive);
      // A revival is a revival: undismiss re-arms the schedules the kill
      // canceled (reactivateTasksCanceledOnKill), so Restart must too — without
      // this, `cast undismiss X` brings a session's standing loops back but
      // Restart leaves them dead forever, which is the more common gesture.
      // Same two scans as the kill that canceled them: the RUNNER's schedules,
      // plus the caller's when a second-party owner is restarting.
      if (wasRetired) {
        await reactivateTasksCanceledOnKill(ctx, conv.user_id, conv._id);
        if (conv.user_id.toString() !== userId.toString()) {
          await reactivateTasksCanceledOnKill(ctx, userId, conv._id);
        }
      }
      return { conv: (await ctx.db.get(conv._id))!, restored: false };
    }
    return { conv, restored: false };
  }
  let sessionId = ghost.session_id;
  if (!sessionId) {
    // A prior restore already tombstoned this dead id onto its replacement —
    // recover the session binding from there (covers old clients that send no
    // ghost context, for any ghost that has been restored once before).
    const prior = await ctx.db
      .query("conversations")
      .withIndex("by_restored_from", (q) => q.eq("restored_from_conversation_id", conversationId.toString()))
      .collect();
    const priorTarget = prior
      .filter((t) => t.user_id === userId)
      .reduce((a: any, b: any) => ((b.updated_at ?? 0) > (a?.updated_at ?? 0) ? b : a), null);
    sessionId = priorTarget?.session_id;
  }
  if (!sessionId) {
    // Old clients send no ghost context. The daemon's heartbeat rows can
    // outlive the conversation row — recover the session from there.
    const managed = await ctx.db
      .query("managed_sessions")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conversationId))
      .collect();
    const newest = managed
      .filter((m) => m.user_id === userId)
      .reduce((a: any, b: any) => ((b.last_heartbeat ?? 0) > (a?.last_heartbeat ?? 0) ? b : a), null);
    sessionId = newest?.session_id;
  }
  if (!sessionId) {
    // Deleted row and no recoverable session — nothing to bind a daemon
    // command to. Distinct error so the UI can say what actually happened.
    throw new Error("conversation_deleted");
  }
  // Live twin: pick the NEWEST row for this session. Never .first() — that's
  // creation order, which resolves to the oldest twin (the foot-gun that made
  // cleanup delete a live original instead of its doppelgänger; ct-36973).
  const twins = await ctx.db
    .query("conversations")
    .withIndex("by_session_id", (q) => q.eq("session_id", sessionId!))
    .collect();
  const owned = twins.filter((t) => t.user_id === userId);
  if (owned.length > 0) {
    const twin = owned.reduce((a, b) => ((b.updated_at ?? 0) > (a.updated_at ?? 0) ? b : a));
    // Restarting is an explicit "bring this back" — resurface it in the inbox,
    // and tombstone the dead id so stale links resolve here from now on.
    await ctx.db.patch(twin._id, {
      status: "active",
      inbox_dismissed_at: undefined,
      inbox_killed_at: undefined,
      restored_from_conversation_id: conversationId.toString(),
      updated_at: Date.now(),
    });
    return { conv: (await ctx.db.get(twin._id))!, restored: true };
  }
  // No surviving row anywhere: recreate a minimal one (same in-file creation
  // idiom as createQuickSession — team/privacy resolution + short_id).
  const now = Date.now();
  const mappings = await ctx.db
    .query("directory_team_mappings")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .collect();
  const { teamId, isPrivate, autoShared } = resolveTeamForPath(mappings, ghost.project_path, undefined);
  const agentType = toConvexAgentType(fromConvexAgentType(ghost.agent_type));
  const newId = await ctx.db.insert("conversations", {
    user_id: userId,
    team_id: teamId,
    agent_type: agentType,
    session_id: sessionId,
    title: ghost.title,
    project_path: ghost.project_path,
    started_at: now,
    updated_at: now,
    message_count: 0,
    is_private: isPrivate,
    auto_shared: autoShared || undefined,
    status: "active",
    restored_from_conversation_id: conversationId.toString(),
  });
  await ctx.db.patch(newId, { short_id: newId.toString().slice(0, 7) });
  return { conv: (await ctx.db.get(newId))!, restored: true };
}

// Enqueue the kill→resume daemon command pair for a conversation, deduped
// against an already-pending resume. Shared by restartSession (gentle resume
// ladder on the daemon) and repairSession (force reconstitution from DB).
export async function enqueueKillAndResume(
  ctx: MutationCtx,
  userId: Id<"users">,
  conv: { _id: Id<"conversations">; session_id?: string; project_path?: string; git_root?: string; agent_type?: string },
  opts: { forceReconstitute?: boolean; switchAgent?: boolean } = {},
) {
  const now = Date.now();
  const pendingCommands = await ctx.db
    .query("daemon_commands")
    .withIndex("by_user_pending", (q) => q.eq("user_id", userId).eq("executed_at", undefined))
    .collect();

  if (hasRecentPendingDaemonCommand(pendingCommands as any, {
    conversationId: conv._id.toString(),
    command: "resume_session",
    now,
  })) {
    await resetConversationPendingMessages(ctx, conv._id);
    return { deduplicated: true };
  }

  await ctx.db.insert("daemon_commands", {
    user_id: userId,
    command: "kill_session",
    args: JSON.stringify({ conversation_id: conv._id, session_id: conv.session_id }),
    created_at: now,
  });

  await ctx.db.insert("daemon_commands", {
    user_id: userId,
    command: "resume_session",
    args: JSON.stringify({
      session_id: conv.session_id,
      conversation_id: conv._id,
      project_path: conv.project_path ?? conv.git_root,
      agent_type: fromConvexAgentType(conv.agent_type),
      ...(opts.forceReconstitute ? { force_reconstitute: true } : {}),
      ...(opts.switchAgent ? { switch_agent: true, force_reconstitute: true } : {}),
    }),
    created_at: now + 1,
  });

  await resetConversationPendingMessages(ctx, conv._id);
  return { deduplicated: false };
}

export const killSession = mutation({
  args: {
    conversation_id: v.id("conversations"),
    mark_completed: v.optional(v.boolean()),
    session_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const conv = await ctx.db.get(args.conversation_id);
    // The runner, or the session's second-party owner — same rule as
    // restartSession/dispatch.sendMessage. An owned session kills from the
    // owner's inbox exactly like their own.
    if (conv && conv.user_id !== userId && conv.owner_user_id !== userId) throw new Error("Not authorized");

    // Enqueue even when the row is gone: the daemon tears backends down from the
    // conversation id alone (derived tmux names, local caches) plus the cached
    // session_id the client passes along. Address the command to the RUNNER's
    // daemon (conv.user_id) — an owner's kill must reach the machine actually
    // running the session; ghost rows fall back to the caller.
    await ctx.db.insert("daemon_commands", {
      user_id: conv?.user_id ?? userId,
      command: "kill_session",
      args: JSON.stringify({
        conversation_id: args.conversation_id,
        session_id: args.session_id ?? conv?.session_id,
      }),
      created_at: Date.now(),
    });

    let canceledSchedules = 0;
    let canceledMessages = 0;
    if (conv) {
      // First-kill time, preserved across re-kills (same rule as
      // applyHideTransition): a repeat kill re-runs teardown, it doesn't
      // rewrite when the session was retired.
      const patch: Record<string, any> = conv.inbox_killed_at ? {} : { inbox_killed_at: Date.now() };
      // A persistent anchor session never auto-completes — a dismiss/kill gesture
      // on its pinned card puts it to sleep, it isn't retired. Only an explicit
      // decommissionAnchor (which clears `persistent` first) may complete it.
      if (args.mark_completed && !conv.persistent) {
        patch.status = "completed";
      }
      await ctx.db.patch(args.conversation_id, patch);
      // Kill must stick: cancel any armed schedule that injects into this
      // conversation, or its next fire would resurrect the session the user
      // just killed (see cancelTasksBoundToConversation). Scan the RUNNER's
      // schedules (theirs are the ones bound to their session), plus the
      // caller's when a second-party owner is killing.
      // Both sweeps are RETIREMENT effects, so a persistent anchor is exempt
      // from both — killing an anchor is dormancy, not death. Same guard as
      // applyHideTransition: the two kill surfaces must agree about anchors, or
      // the web button and `cast kill` leave the same session in different
      // states (its queue survives one and not the other).
      if (!conv.persistent) {
        canceledSchedules = await cancelTasksBoundToConversation(ctx, conv.user_id, args.conversation_id);
        if (conv.user_id !== userId) {
          canceledSchedules += await cancelTasksBoundToConversation(ctx, userId, args.conversation_id);
        }
        // Kill is terminal for messages already queued too — same reason the
        // schedules die: a retained message that lands later revives the session
        // the user just killed. Only the pre-kill queue; a later send re-enqueues.
        canceledMessages = await cancelQueuedMessagesOnKill(ctx, args.conversation_id);
      }
      // Take the nested group (Task subagents + agent-team teammates) down
      // with the card. The web store also sweeps optimistically for its own
      // gesture; this server twin covers every other caller. Forced, like the
      // unconditional enqueue above: this mutation IS an explicit kill gesture,
      // so an already-hidden child whose worker came back gets torn down again
      // rather than skipped — the group comes down as one unit.
      await cascadeHideToNestedChildren(ctx, conv, { inbox_dismissed_at: Date.now() }, { forceKill: true });
    }
    return { existed: !!conv, canceled_schedules: canceledSchedules, canceled_messages: canceledMessages };
  },
});

export const restartSession = mutation({
  args: {
    conversation_id: v.id("conversations"),
    ...RESTART_GHOST_ARGS,
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const { conv, restored } = await resolveRestartTarget(ctx, userId, args.conversation_id, args);
    if (!conv.session_id) throw new Error("No session to restart");

    // Daemon commands are polled by the RUNNER's daemon — for a second-party
    // owner restarting a session run by another account, address the commands
    // to the runner, not the caller (same routing as dispatch.resumeSession).
    await enqueueKillAndResume(ctx, conv.user_id, conv);
    return { conversation_id: conv._id, restored };
  },
});

export const repairSession = mutation({
  args: {
    conversation_id: v.id("conversations"),
    ...RESTART_GHOST_ARGS,
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const { conv, restored } = await resolveRestartTarget(ctx, userId, args.conversation_id, args);
    if (!conv.session_id) throw new Error("No session to repair");

    // Runner-routed for the same reason as restartSession above.
    await enqueueKillAndResume(ctx, conv.user_id, conv, { forceReconstitute: true });
    return { conversation_id: conv._id, restored };
  },
});

// Live progress of a kill/restart for the footer: the daemon stamps each
// command row with executed_at + result/error, so the client can show the real
// ladder ("stopping" → "resuming" → resumed/reconstituted/started fresh/failed)
// instead of an indefinite spinner. Scoped to one conversation, last few only.
export const getRestartProgress = query({
  args: { conversation_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    // Restart commands are stamped with the RUNNER's user_id (see
    // enqueueKillAndResume callers) — a second-party owner watching a restart
    // must scan the runner's rows. Anyone else keeps scanning their own (and
    // sees nothing for a conversation they can't command).
    let scanUserId = userId;
    const convId = ctx.db.normalizeId("conversations", args.conversation_id);
    if (convId) {
      const conv = await ctx.db.get(convId);
      if (conv && conv.owner_user_id === userId && conv.user_id !== userId) scanUserId = conv.user_id;
    }

    const pending = await ctx.db
      .query("daemon_commands")
      .withIndex("by_user_pending", (q) => q.eq("user_id", scanUserId).eq("executed_at", undefined))
      .collect();
    const executed = await ctx.db
      .query("daemon_commands")
      .withIndex("by_user_pending", (q) => q.eq("user_id", scanUserId).gt("executed_at", 0))
      .order("desc")
      .take(50);

    return [...pending, ...executed]
      .filter((c) =>
        // move_to_device rides along so device moves ("Run here" / "Move to
        // remote Mac") can narrate the transfer with the same rows; restart
        // consumers filter by command name and ignore it.
        (c.command === "kill_session" || c.command === "resume_session" || c.command === "move_to_device") &&
        extractDaemonCommandConversationId(c.args) === args.conversation_id,
      )
      .sort((a, b) => a.created_at - b.created_at)
      .slice(-6)
      .map((c) => ({
        command: c.command,
        created_at: c.created_at,
        executed_at: c.executed_at ?? null,
        result: c.result ?? null,
        error: c.error ?? null,
      }));
  },
});

export const switchSessionProject = mutation({
  args: {
    conversation_id: v.id("conversations"),
    project_path: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Both the kill and the relaunch are routed under the runner's account —
    // the session stays on the machine that runs it, whichever party asked
    // for the switch (paths are that machine's).
    const conv = await requireSessionCommandTarget(ctx, userId, args.conversation_id);

    const now = Date.now();

    await ctx.db.insert("daemon_commands", {
      user_id: conv.user_id,
      command: "kill_session",
      args: JSON.stringify({ conversation_id: args.conversation_id }),
      created_at: now,
    });

    await ctx.db.patch(args.conversation_id, {
      project_path: args.project_path,
      git_root: args.project_path,
    });

    const daemonAgentType = fromConvexAgentType(conv.agent_type);
    await enqueueStartSession(ctx, conv.user_id, {
      conversationId: args.conversation_id,
      agentType: daemonAgentType,
      projectPath: args.project_path,
      gitRoot: args.project_path,
      createdAt: now + 1,
    });
  },
});

// Scan cap for the user-prompt navigation list. The user-role index range is
// dominated by tool results (they sync as user-role rows), so a monster agent
// session holds thousands of docs here — an unbounded collect blew Convex's
// system-operation budget ("too many system operations") on every reactive
// re-run, and this query is live-subscribed by every open conversation view.
// Newest-first take keeps the recent prompts (the ones rewind/fork navigation
// actually targets); prompts older than the scanned window drop off on
// outlier sessions. Removing this cap re-introduces the timeout.
export const NAV_USER_MESSAGES_SCAN_LIMIT = 2000;

export async function collectNavigableUserMessages(
  db: { query: (table: "messages") => any },
  conversationId: Id<"conversations">,
) {
  const userMsgs = await db.query("messages")
    .withIndex("by_conversation_role_timestamp", (q: any) =>
      q.eq("conversation_id", conversationId).eq("role", "user"))
    .order("desc").take(NAV_USER_MESSAGES_SCAN_LIMIT);
  return filterUserMessages(userMsgs);
}

export const getUserMessages = query({
  args: { conversation_id: v.id("conversations"), share_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv) return [];
    // Same admission as listMessages: owner, team, or share link. The message
    // browser must serve every viewer the transcript itself serves — including
    // unauthenticated visitors presenting a public share token.
    if ((await checkConversationAccess(ctx, userId, conv, args.share_token)) === "denied") return [];
    return collectNavigableUserMessages(ctx.db, args.conversation_id);
  },
});
