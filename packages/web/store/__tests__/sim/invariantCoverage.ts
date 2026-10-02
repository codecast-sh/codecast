// The invariant catalog's coverage guard (docs/architecture/multiplayer-sim-harness.md,
// section 3.7): every classified store key is compared by some rule in
// sim/invariants.ts or excused here with the reason.
import { REPLICATION_CLASSIFICATION } from "../../clientSyncRegistry";
import { INVARIANTS } from "./invariants";

/**
 * Classified store keys no invariant compares against the server, each with
 * why. A key here is still compared host against follower by INV-followers
 * when it is shared.
 */
export const NOT_COMPARED: Readonly<Record<string, string>> = {
  conversations: "the message page's meta twin, fed only by a conversation page the sim does not open",
  capabilityBindings: "fed by useSyncCapabilityState, a bespoke hook the sim does not mount",
  capabilityState: "fed by useSyncCapabilityState, a bespoke hook the sim does not mount",
  sessionDecisions: "fed by useSyncSessionDecisions; decisions reach the inbox through the liveness stamps INV-sessions-mine compares",
  buckets: "fed by useSyncBuckets, a bespoke hook the sim does not mount",
  bucketAssignments: "fed by useSyncBuckets, a bespoke hook the sim does not mount",
  comments: "fed by the conversation comment and thread hooks, which the sim does not mount",
  chatChannels: "fed by useChatSync's channel list, which the sim does not mount; the lines are compared by INV-chat",
  chatReads: "per-viewer read marks fed by useChatSync, which the sim does not mount",
  chatSlackLinks: "Slack bridge state, outside the sim",
  threadInbox: "fed by useThreadsSync, a bespoke hook the sim does not mount",
  chatRail: "a client fold over chat rows, derived at read time",
  notifications: "fed by the notification bell component, which the sim does not mount",
  clientState: "UI preferences the window's boot sets; replicated, compared host against follower",
  _lastViewedAt: "client-only visit clock, no server truth",
  _seenUpToAt: "client-only read divider, no server truth",
  _seenMessageCount: "client-only unread baseline, no server truth",
  teams: "fed by useSyncTeams, which the sim does not mount; membership is checked through cursors and workspace rows",
  teamMembers: "roster cache with no feeder the sim mounts",
  teamUnreadCount: "a sidebar badge fed by a component the sim does not mount",
  docProjectPaths: "client-side path index with no server truth",
  favorites: "fed by a sidebar component the sim does not mount",
  bookmarks: "fed by useSyncInboxSessions' bookmark query, which the sim does not mount",
  currentUser: "set by the window's boot from the world, not fed by a query the sim mounts",
  drafts: "local composer text, no server truth",
  reviewComments: "local inline review notes, no server truth",
  blockedReviveRequestedAt: "a TTL overlay the store expires lazily at the next revive; a stale entry is inert, and the placement it gates is compared by INV-sessions-mine",
  lastFocusedConversationId: "local focus, no server truth",
  recentVisits: "local history, no server truth",
  recentProjects: "local history, no server truth",
  recentProjectsByDevice: "local history, no server truth",
  collapsedSections: "local UI state, no server truth",
  sidebarNavExpanded: "local UI state, no server truth",
  feedConversations: "the activity feed page, which the sim does not open",
  feedHasMore: "the activity feed page, which the sim does not open",
  feedCursors: "the activity feed page, which the sim does not open",
  tabs: "local tab layout, no server truth",
  activeTabId: "local tab layout, no server truth",
  sidePanelSessionId: "local panel state, no server truth",
};

/**
 * Every classified key that no invariant compares and NOT_COMPARED does not
 * excuse, and every NOT_COMPARED entry naming a key that no longer exists.
 * Empty when the catalog covers the classification.
 */
export function coverageGaps(
  classification: Readonly<Record<string, "shared" | "local">> = REPLICATION_CLASSIFICATION,
  notCompared: Readonly<Record<string, string>> = NOT_COMPARED,
): string[] {
  const covered = new Set(INVARIANTS.flatMap((inv) => inv.keys));
  const gaps: string[] = [];
  for (const [key, cls] of Object.entries(classification)) {
    if (covered.has(key) || key in notCompared) continue;
    gaps.push(`store key "${key}" (${cls}) is compared by no invariant and is not in NOT_COMPARED. Add it to an invariant's keys in sim/invariants.ts, or to NOT_COMPARED with the reason it is not compared.`);
  }
  for (const key of Object.keys(notCompared)) {
    if (!(key in classification)) gaps.push(`NOT_COMPARED names "${key}", which REPLICATION_CLASSIFICATION no longer has. Remove it.`);
    else if (covered.has(key)) gaps.push(`NOT_COMPARED names "${key}", which an invariant compares. Remove it from NOT_COMPARED.`);
  }
  return gaps;
}
