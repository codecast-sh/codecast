// Stand-in for store/inboxStore in the migration-panel preview: only the
// slice the panel and the device chips read, over the fixture world.
import { create } from "zustand";
import { devices, liveStatus } from "./fixtures";

const sessions: Record<string, any> = Object.fromEntries(
  Object.entries(liveStatus).map(([id, agent_status]) => [id, { _id: id, agent_status }]),
);

const buckets: Record<string, any> = {
  b1: { _id: "b1", name: "rollout", sort_order: 1 },
  b2: { _id: "b2", name: "platform", sort_order: 2 },
  b3: { _id: "b3", name: "later", sort_order: 3 },
};

export const useInboxStore = create<any>(() => ({
  sessions,
  conversations: {},
  buckets,
  bucketAssignments: {},
  assignSessionToBucket: (id: string, bucketId: string | null) => console.log("assignSessionToBucket", id, bucketId),
  openPalette: (opts: unknown) => console.log("openPalette", opts),
  machineRoster: devices,
  machineRosterLive: true,
  movingSessions: {},
  resolveLiveSessionId: (id: string) => id,
  setMachineRoster: () => {},
  getConvexId: (id: string) => id,
  openSettingsModal: (section?: string) => console.log("openSettingsModal", section),
}));

export const isConvexId = (s: string) => /^[a-z0-9]{32}$/.test(s);

export const sortLabels = (b: Record<string, any>) => Object.values(b ?? {}).sort((x: any, y: any) => (x.sort_order ?? 0) - (y.sort_order ?? 0));
export const findProjectPathByName = () => null;
export const resolveComposeProjectPath = () => null;

// Value exports the preview's transitive imports name but never call.
export const useTrackedStore: any = () => null;

// Every other value export of the real store, so any transitive import resolves.
export const BLANK_SESSION_REUSE_WINDOW_MS: any = () => null;
export const INBOX_PAYLOAD_FRESH_MS: any = () => null;
export const MAX_IN_MEMORY_CONVERSATIONS: any = () => null;
export const PENDING_SEND_ECHO_CAP_MS: any = () => null;
export const PENDING_SEND_PRUNE_GRACE_MS: any = () => null;
export const SESSIONS_PRESERVE_FIELDS: any = () => null;
export const SESSIONS_STRIP_FIELDS: any = () => null;
export const STAMPED_UI_KEYS: any = () => null;
export const SessionCreatePendingError: any = () => null;
export const TRIAGE_STAMP_KEYS: any = () => null;
export const __resetHeldOverlayFactsForTests: any = () => null;
export const __resetInboxPlacementCacheForTests: any = () => null;
export const awaitTrackedSessionCreateResult: any = () => null;
export const bridgeUserId: any = () => null;
export const bucketProjectPath: any = () => null;
export const chipBucketFilters: any = () => null;
export const chipMatchesSession: any = () => null;
export const chipProjectFilters: any = () => null;
export const classifySession: any = () => null;
export const clearProtectedInboxMemory: any = () => null;
export const computeChipCounts: any = () => null;
export const computeInboxMembership: any = () => null;
export const computeInboxVisible: any = () => null;
export const computeManualSortKey: any = () => null;
export const computeNewDividerIndex: any = () => null;
export const computeReorderUpdates: any = () => null;
export const computeVisualOrder: any = () => null;
export const convBucketMap: any = () => null;
export const dropLatchedFeedHasMore: any = () => null;
export const ensureHydrated: any = () => null;
export const evictInactiveMessages: any = () => null;
export const favoritesVisualOrder: any = () => null;
export const feedPagePersistence: any = () => null;
export const filterInboxScope: any = () => null;
export const filterInboxScopeFromState: any = () => null;
export const findReusableBlankSession: any = () => null;
export const flatViewComparator: any = () => null;
export const flatViewSessions: any = () => null;
export const getProjectName: any = () => null;
export const getSessionRenderKey: any = () => null;
export const groupSessionsByPlan: any = () => null;
export const groupSessionsForLabelView: any = () => null;
export const hasSyncRegistryEntry: any = () => null;
export const hydrateMergeValue: any = () => null;
export const isAgentActive: any = () => null;
export const isForeignRow: any = () => null;
export const isFork: any = () => null;
export const isInterruptControlMessage: any = () => null;
export const isSessionDismissed: any = () => null;
export const isSessionEffectivelyIdle: any = () => null;
export const isSessionHardBlocked: any = () => null;
export const isSessionHidden: any = () => null;
export const isSessionKilled: any = () => null;
export const isSessionStashed: any = () => null;
export const isSub: any = () => null;
export const mergeStampedBagLww: any = () => null;
export const orchestrationGroupLabelOf: any = () => null;
export const partitionWorkingSet: any = () => null;
export const passesFilterTerms: any = () => null;
export const pendingRowSendArgs: any = () => null;
export const pendingSendConsumed: any = () => null;
export const pendingSendWakeSig: any = () => null;
export const placeInboxRows: any = () => null;
export const placementDecisionsSig: any = () => null;
export const projectReplicaInbox: any = () => null;
export const reconcilePendingSendForSession: any = () => null;
export const renderInboxEpoch: any = () => null;
export const resolveInboxHome: any = () => null;
export const resolveInboxViewMode: any = () => null;
export const resolveShowOld: any = () => null;
export const resolveTrackedStoreSnapshot: any = () => null;
export const seedLiveInboxIdsFromCache: any = () => null;
export const seedTeamInboxIdsFromCache: any = () => null;
export const selectCommentRailOpen: any = () => null;
export const selectFavoriteSessions: any = () => null;
export const selectNavCollapsed: any = () => null;
export const selectSessionRailOpen: any = () => null;
export const selectSessionRailUserClosed: any = () => null;
export const sessionRowFromSummary: any = () => null;
export const sessionStructuralSig: any = () => null;
export const sessionsWakeSig: any = () => null;
export const showsBlockedBadge: any = () => null;
export const sortSessions: any = () => null;
export const stampedTabPath: any = () => null;
export const store: any = () => null;
export const syncLogScopeMetaKey: any = () => null;
export const toggleFilterTerm: any = () => null;
export const unionHydrate: any = () => null;
export const verdictOfWorkState: any = () => null;
export const visualOrderSessions: any = () => null;
export const visualOrderViewSig: any = () => null;
export const worktreeKeyOf: any = () => null;
