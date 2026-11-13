// Whose data each client store key holds, kept beside the registry
// (store/clientSyncRegistry.ts) to hold that file under its size.
import type { ClientSyncStoreKey } from "./clientSyncRegistry";

// WHOSE DATA EACH KEY HOLDS. The store is one cache across every workspace the
// viewer has opened, persisted to disk, so a key's scope decides how a surface
// may read it:
//   "workspace": rows (or a snapshot) belong to one workspace and carry its
//     access key. Enumerate only through useWorkspaceCollection; a singleton
//     reads through its named workspace-checked selector.
//   "team": belongs to one team, routed by team id. Read only through the
//     named selector that compares it with the active team.
//   "viewer": the viewer's own, or deliberately spans the viewer's teams.
//   "entity": rows filed under one object (a task, a PR, a doc), read by that
//     object's id; the object's own scope already admitted the reader.
// Every key MUST be classified: `satisfies` makes a missing one a compile
// error. lib/__tests__/workspaceEnumeration.guard.test.ts fails a raw read of
// a "workspace"/"team" key outside its selectors, and
// store/__tests__/workspaceScopeReaders.test.ts seeds two workspaces and
// fails when a selector returns the inactive one's rows.
export type DataScope = "workspace" | "team" | "viewer" | "entity";
export const DATA_SCOPE = {
  repoBrowse: "entity",
  repoBrowseAccess: "entity",
  settingsData: "viewer",
  // The inbox spans every workspace by design; inbox_scope and the team id
  // set (teamInboxIds, keyed by team) gate which rows a board shows.
  sessions: "viewer",
  conversations: "viewer",
  tasks: "workspace",
  capabilityBindings: "viewer",
  capabilityState: "viewer",
  teamKitItems: "workspace",
  harnessChanges: "viewer",
  docs: "workspace",
  docDetails: "entity",
  orgTemplateInstances: "entity",
  // Every account in the pools of every team the viewer is in, each row naming its team.
  accountPool: "viewer",
  // The viewer's queue across workspaces; the team views' rows carry
  // team_workspace / line_workspace and their readers filter on it.
  sessionDecisions: "viewer",
  sessionGoals: "entity",
  decisionStacks: "viewer",
  weeklyCards: "viewer",
  handledDecisions: "viewer",
  decisionDetails: "entity",
  decisionThreads: "entity",
  decisionComments: "entity",
  sideAnswers: "entity",
  shipTargets: "entity",
  taskEvidence: "entity",
  projectExpectations: "entity",
  expectationsOverview: "workspace",
  trialCards: "workspace",
  trialProjects: "workspace",
  trialRuns: "workspace",
  trialSpend: "entity",
  lineStages: "entity",
  lineDispatch: "entity",
  lineReviews: "entity",
  savedViews: "viewer",
  mods: "viewer",
  modState: "viewer",
  modObjects: "workspace",
  plans: "workspace",
  projects: "workspace",
  initiatives: "workspace",
  initiativeUpdates: "entity",
  buckets: "viewer",
  bucketAssignments: "viewer",
  comments: "entity",
  // Team chat. Every read goes through store/chatSlice.ts, which scopes by
  // channel and the channel's team (community rooms span teams by design).
  chatChannels: "team",
  chatMessages: "team",
  chatReactions: "team",
  chatReads: "team",
  chatSlackLinks: "team",
  chatSlackPeople: "team",
  chatAuthors: "entity",
  sessionReads: "viewer",
  chatRail: "viewer",
  // The Threads inbox spans every workspace the viewer is in, by design.
  threadInbox: "viewer",
  threadUnread: "viewer",
  threadUnreadByWorkspace: "viewer",
  pageThreads: "viewer",
  agentTasks: "viewer",
  foreignTriggers: "entity",
  agentDefinitions: "workspace",
  secrets: "workspace",
  secretHistory: "entity",
  agentChains: "workspace",
  issueSyncSources: "workspace",
  agentTaskRuns: "entity",
  workflows: "workspace",
  workflowRuns: "workspace",
  signals: "workspace",
  lineLabels: "workspace",
  stationInputs: "entity",
  lineOccurrences: "entity",
  lineCards: "entity",
  lineDeploys: "workspace",
  deployTargets: "workspace",
  teamDeploys: "workspace",
  liveFlows: "workspace",
  sessionFlows: "workspace",
  flowMaps: "workspace",
  lineTimeline: "workspace",
  sessionIndex: "viewer",
  lineTries: "entity",
  lineGraphVersions: "entity",
  lineGraphEditability: "entity",
  opsSources: "workspace",
  opsGroups: "workspace",
  opsSamples: "entity",
  opsEvents: "workspace",
  opsReplays: "workspace",
  opsReplayTallies: "entity",
  opsReplayTimelines: "entity",
  opsWatches: "workspace",
  opsWatchSeries: "entity",
  opsApps: "entity",
  opsCiRuns: "entity",
  opsAppCalls: "entity",
  liveElements: "entity",
  liveHeads: "entity",
  livePresence: "entity",
  liveVersions: "entity",
  dataResults: "entity",
  dataSources: "entity",
  // Published pages: the viewer's own plus teammates' shareable ones, each by slug.
  artifacts: "viewer",
  pageEmbeds: "entity",
  conversationPages: "entity",
  // Anchors and roles span the viewer's personal workspace and every team by
  // design: a face or anchor chip reads its own row whichever team is active.
  anchorSpaces: "viewer",
  anchors: "viewer",
  viewerRoles: "viewer",
  sessionThreads: "viewer",
  wallet: "viewer",
  // One snapshot for one workspace, stamped with it: read through windowOrgTree.
  orgTree: "workspace",
  // One snapshot for one workspace, stamped held_for: read through windowOrgHealth.
  orgHealth: "workspace",
  // Rows carry their workspace; RoleOffer reads them through inWorkspace.
  orgProposals: "workspace",
  orgProposalChanges: "entity",
  orgLog: "workspace",
  orgLogRows: "entity",
  commits: "entity",
  // Pull requests span teams by product design (a PR is read by repo and
  // number wherever the viewer can see it).
  pullRequests: "viewer",
  codeComments: "entity",
  quoteDrafts: "entity",
  projectUpdates: "entity",
  // Team git activity plus per-entity windows into one overlay. The team feed
  // reads it only through ActivityFeed's active-team filter.
  externalEvents: "team",
  teamPrompts: "team",
  changeStories: "team",
  changeEditions: "team",
  changeLive: "team",
  changeWorks: "team",
  changeStorySessions: "entity",
  sessionCommands: "entity",
  managedSessions: "viewer",
  machineResources: "viewer",
  migrationCandidates: "viewer",
  migrationBatches: "viewer",
  moveRehearsals: "viewer",
  sessionMetricsAggregate: "viewer",
  pendingPermissions: "entity",
  permissionRules: "viewer",
  guestSuggestions: "entity",
  pendingMessageStatus: "entity",
  messageFeed: "workspace",
  mySends: "viewer",
  mySendSearch: "viewer",
  mySendText: "entity",
  machineRoster: "viewer",
  // Team machines on every team the viewer is in, each row naming its team.
  teamMachines: "viewer",
  notifications: "viewer",
  // Calls and live rooms span teams by product design: a huddle, a knock or a
  // recording is the viewer's wherever it started.
  callRooms: "viewer",
  roomKnocks: "viewer",
  guestsWaiting: "viewer",
  guestLinks: "entity",
  callRecordings: "entity",
  callRecordingCalls: "entity",
  callFrameShares: "entity",
  callList: "viewer",
  callDetails: "entity",
  clientState: "viewer",
  lastFocusedConversationId: "viewer",
  liveInboxIdList: "viewer",
  // Keyed by its team_id: read through teamInboxIdsOf.
  teamInboxIdSnapshot: "team",
  _lastViewedAt: "viewer",
  recentVisits: "viewer",
  _seenUpToAt: "viewer",
  _seenMessageCount: "viewer",
  pendingMessages: "viewer",
  blockedReviveRequestedAt: "viewer",
  pending: "viewer",
  drafts: "viewer",
  queuedMessages: "viewer",
  reviewComments: "viewer",
  recentProjects: "viewer",
  recentProjectsByDevice: "viewer",
  collapsedSections: "viewer",
  // The teams the viewer belongs to.
  teams: "viewer",
  // One team's roster, each row stamped roster_team: read through teamMembersOf.
  teamMembers: "team",
  feedConversations: "viewer",
  feedHasMore: "viewer",
  feedCursors: "viewer",
  syncMeta: "viewer",
  docProjectPaths: "viewer",
  favorites: "viewer",
  bookmarks: "viewer",
  tabs: "viewer",
  activeTabId: "viewer",
  sidePanelSessionId: "viewer",
  currentUser: "viewer",
  userSkills: "viewer",
} as const satisfies Record<ClientSyncStoreKey, DataScope>;

/** Store slots outside the registry (in memory only) that hold one team's or
 *  one workspace's data, under the same read rule. */
export const EPHEMERAL_SLOT_SCOPE = {
  // The team board's id set, keyed by teamInboxIdSnapshot.team_id: read through teamInboxIdsOf.
  teamInboxIds: "team",
} as const satisfies Record<string, DataScope>;

/** Keys whose scope is "workspace" or "team": read only through their selectors. */
export const SCOPED_READ_KEYS: readonly string[] = [
  ...Object.entries(DATA_SCOPE).filter(([, s]) => s === "workspace" || s === "team").map(([k]) => k),
  ...Object.keys(EPHEMERAL_SLOT_SCOPE),
];
