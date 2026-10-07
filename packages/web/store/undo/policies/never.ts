// Creators that are never undoable, each with the reason. Navigation and
// layout have their own way back (Back, the tab strip, the layout itself);
// sends and creates reach other people or mint server rows an undo cannot
// take back without a server verb (docs/architecture/undo-history.md §14);
// read state, settings and machine controls are not edits to anyone's work.
import type { UndoPolicy } from "../policy";

const never = (reason: string) => ({ never: reason }) as const;

const NAVIGATION = never("navigation: moving the view is not an edit, and Back owns the way back");
const LAYOUT = never("layout: panes, tabs and sizes change in place and are put back the same way");
const VIEW_STATE = never("view state: filters, selection and paging are how the window looks, not data");
const SEND = never("send: it reached other people or an agent, and a sent message cannot be recalled");
const CREATE = never("create: mints a server row; undoing it needs a delete-by-client-key verb (follow-up)");
const DELETE = never("delete: the server keeps no soft-deleted copy to bring back (follow-up)");
const READ_STATE = never("read state: marking seen or unread is not an edit to anyone's work");
const SETTINGS = never("settings: a preference the person sets and resets in the same control");
const MACHINE = never("machine control: it acts on a running agent or host, which an undo cannot rewind");
const SHARING = never("sharing: links and membership visibility change who can see something; set them back explicitly");
const INTERNAL = never("internal: engine or sync plumbing, never a user gesture");
const DRAFT = never("draft: unsent text or a pick on an unsent session, changed back in the same field");
const LOCAL_ECHO = never("local echo: the store's copy of a send or an answer, which the server's reply settles");

export const NEVER_UNDO_POLICY: UndoPolicy = {
  // Navigation
  clearCurrentConversation: NAVIGATION,
  injectSession: NAVIGATION,
  navigateToSession: NAVIGATION,
  requestNavigate: NAVIGATION,
  setCurrentConversation: NAVIGATION,
  setCurrentSession: NAVIGATION,
  setViewingDismissedId: NAVIGATION,
  selectPanelSession: NAVIGATION,
  switchTab: NAVIGATION,
  touchMru: NAVIGATION,
  requestAccountSwitch: NAVIGATION,

  // Layout
  openTab: LAYOUT,
  closeTab: LAYOUT,
  updateTab: LAYOUT,
  saveCurrentTabState: LAYOUT,
  openSidePanel: LAYOUT,
  closeSidePanel: LAYOUT,
  clearSidePanelSession: LAYOUT,
  toggleSidePanel: LAYOUT,
  stageCloseLeaf: LAYOUT,
  stageExpandLeaf: LAYOUT,
  stageFocusLeaf: LAYOUT,
  stageInsertLeaf: LAYOUT,
  stageMoveLeaf: LAYOUT,
  stageSetLeafPath: LAYOUT,
  stageSetSizes: LAYOUT,
  wsHide: LAYOUT,
  wsSetPresentation: LAYOUT,
  wsSetSize: LAYOUT,
  wsShow: LAYOUT,
  wsToggle: LAYOUT,
  applyWorkbench: LAYOUT,
  setNavCollapsed: LAYOUT,
  toggleCollapsedSection: LAYOUT,
  updateClientLayout: LAYOUT,
  dismissBrowserPaneOffer: LAYOUT,

  // View state
  setActiveBucketFilter: VIEW_STATE,
  setActiveProjectFilter: VIEW_STATE,
  toggleBucketFilterTerm: VIEW_STATE,
  toggleProjectFilterTerm: VIEW_STATE,
  clearSelection: VIEW_STATE,
  initPagination: VIEW_STATE,
  setPagination: VIEW_STATE,
  setOrgFocusChangeId: VIEW_STATE,
  setFeedCursor: VIEW_STATE,
  setFeedHasMore: VIEW_STATE,

  // Sends and agent turns
  sendMessage: SEND,
  dispatchChatSend: SEND,
  addComment: SEND,
  addTaskComment: SEND,
  addPageComment: SEND,
  askAgentInThread: SEND,
  postInitiativeUpdate: SEND,
  shareChatMessageToSlack: SEND,
  retryPendingMessage: SEND,
  cancelPendingMessage: never("send: withdrawing a queued message is itself the way back from sending it"),
  queueMessage: never("send: a queued message is taken back with its own remove button in the shared queue"),
  releaseQueued: never("send: what was released goes into the session, like any send"),
  reorderQueued: never("shared: the queue belongs to everyone in the session; moving it back is another move"),
  mergeQueued: never("shared: a merged message is one turn others may already have seen; remove it from the queue instead"),
  clearDraftFinal: DRAFT,
  answerDecision: never("send: an answered decision has already been read by the agent that asked"),
  adoptDecision: LOCAL_ECHO,
  discussDecision: SEND,
  startShip: never("send: Ship starts a session that commits, pushes and opens a pull request; stopping it is the way back"),
  resolvePermission: never("send: the agent acts on an approved or denied tool call the moment it lands"),
  respondToGate: never("send: a gate answer resumes the run and posts into its session"),

  // Local echoes of sends (sync creators a component calls)
  addOptimisticMessage: LOCAL_ECHO,
  markOptimisticAsFailed: LOCAL_ECHO,
  markOptimisticAsRetrying: LOCAL_ECHO,
  removeOptimisticMessage: LOCAL_ECHO,
  resolvePendingUploads: LOCAL_ECHO,
  stampPendingDispatchContent: LOCAL_ECHO,
  setQueuedMessagesFor: LOCAL_ECHO,
  takeQueuedMessage: LOCAL_ECHO,
  resolveSessionQuestion: LOCAL_ECHO,
  confirmSessionCommand: LOCAL_ECHO,
  dismissSessionCommand: LOCAL_ECHO,

  // Drafts
  setDraft: DRAFT,
  clearDraft: DRAFT,
  setSessionHasDraft: DRAFT,
  addReviewComment: DRAFT,
  commitReviewComment: DRAFT,
  removeReviewComment: DRAFT,
  clearReviewComments: DRAFT,
  setSessionTargetDevice: DRAFT,
  setStableContextPrefs: DRAFT,

  // Creates
  createBucket: CREATE,
  createDoc: CREATE,
  createInitiative: CREATE,
  createPlan: CREATE,
  createProject: CREATE,
  createSavedView: CREATE,
  createModObject: CREATE,
  createSession: CREATE,
  createStackWith: CREATE,
  createTask: CREATE,
  dispatchCreateChatChannel: CREATE,
  dispatchCreateTeam: CREATE,
  assignTaskToAgent: MACHINE,
  setPrShepherd: MACHINE,
  dispatchOpenDm: CREATE,
  ensurePlanDoc: CREATE,
  promoteDocToPlan: CREATE,
  publishToDirectory: CREATE,
  addIssueSyncSource: CREATE,
  createOpsSource: CREATE,
  rotateOpsSourceKey: never("key rotation: the old ingest key stops working at once and cannot be restored"),
  upsertAgentDefinition: CREATE,
  upsertAgentChain: CREATE,

  // Deletes
  deleteCallRecording: DELETE,
  admitGuestKnock: never("door: letting a stranger into a call is not taken back by an undo; remove them"),
  denyGuestKnock: never("door: the guest was told no; they can ask again"),
  removeCallGuest: never("door: the guest was put out of the call; they can be let in again"),
  deleteCodeComment: DELETE,
  postProjectUpdate: SEND,
  commentProjectUpdate: SEND,
  deleteProjectUpdate: DELETE,
  deleteComment: DELETE,
  deleteSavedView: DELETE,
  setModEnabled: SETTINGS,
  deleteSession: DELETE,
  deleteTrigger: DELETE,
  dispatchChatDelete: DELETE,
  dispatchDeleteTeam: DELETE,
  removeAgentChain: DELETE,
  removeAgentDefinition: DELETE,
  removeFromStack: never("delete: re-adding to a stack needs an addToStack server verb (follow-up)"),
  removeIssueSyncSource: DELETE,
  removeOpsSource: DELETE,
  removeMachines: DELETE,
  markSessionsDismissed: never(
    "bulk dismiss: the server half dismisses every session older than 30 days by age, not the ids shown, and has no restore verb (follow-up)",
  ),
  unlinkChatSlack: DELETE,
  removeLineWorkflow: DELETE,

  // Read state
  markAllNotificationsRead: READ_STATE,
  markAllThreadsRead: READ_STATE,
  markChannelRead: READ_STATE,
  markNotificationRead: READ_STATE,
  markThreadRead: READ_STATE,
  dismissThread: READ_STATE,
  writeSessionAck: READ_STATE,
  writeSessionUnread: READ_STATE,
  updateClientDismissed: READ_STATE,
  markSessionSeen: READ_STATE,
  clearAssignedPing: READ_STATE,
  markBlockedAcknowledged: never("banner: \"never restart this\" answers the blocked banner; the row's restart control asks again"),
  toggleChatReaction: never("reaction: the same click takes it back, and it notifies the author"),

  // Settings
  setAgentDefaultParams: SETTINGS,
  setAgentPermissionModes: SETTINGS,
  setCapabilityBinding: SETTINGS,
  setChannelNotifyLevel: SETTINGS,
  setChatSlackMember: SETTINGS,
  setCloudSessionMode: SETTINGS,
  setCloudSessionSync: SETTINGS,
  adoptTimezone: never("internal: fills an unset timezone from the browser once, never a gesture"),
  setCloudSharedCheckout: SETTINGS,
  setDefaultModel: SETTINGS,
  setDeviceShares: SETTINGS,
  setDeviceSnippet: SETTINGS,
  setIsolatedWorktreeMode: SETTINGS,
  setLocalMirror: SETTINGS,
  setMyStatus: SETTINGS,
  updateMyProfile: SETTINGS,
  setPinnedAgents: SETTINGS,
  setRoomLocked: SETTINGS,
  setRoomRecording: SETTINGS,
  setRoomTranscribeOff: SETTINGS,
  setTeamFeature: SETTINGS,
  setWalkiePref: SETTINGS,
  snoozeWalkie: SETTINGS,
  updateNotificationSettings: SETTINGS,
  updateIssueSyncSource: SETTINGS,
  setOpsSourceStatus: SETTINGS,
  startOpsReplayImport: MACHINE,
  stopOpsReplayImport: MACHINE,
  stopHostedTurn: MACHINE,
  loadOpsWatchHistory: MACHINE,
  setOpsGroupStatus: never("triage: resolve, ignore and reopen sit on the same status control"),
  grantOpsAction: never("permission: a grant changes what agents may do; revoke it explicitly"),
  revokeOpsAction: never("permission: a revoke changes what agents may do; grant it again explicitly"),
  updateChatSlackLink: SETTINGS,
  persistClientTips: SETTINGS,
  setActiveTeamPointer: never("navigation: switching workspace moves the view, it changes no work"),

  // Machine and agent control
  convCommand: MACHINE,
  cloudHostAction: MACHINE,
  restartSession: MACHINE,
  hibernateSession: MACHINE,
  moveSessionToDevice: MACHINE,
  markKilling: MACHINE,
  startResourceOffload: MACHINE,
  cancelResourceOffload: MACHINE,
  markBlockedReviveRequested: MACHINE,
  clearBlockedReviveRequested: MACHINE,

  // Sharing
  setCallShareVideo: SHARING,
  deleteCallFrameShare: SHARING,
  setObjectShareLink: SHARING,
  setShareLink: SHARING,
  setTeamMembershipVisibility: SHARING,

  // The project's line.toml, written on the checkout's machine by the daemon
  editLineProfile: never("machine control: the daemon rewrites the project's line.toml on its host, and the field is set back in the same settings control"),
  fileLineCause: CREATE,
  startLineCause: never("machine control: it starts a run on a machine; cancelling the run is the way back"),
  resumeLineRun: never("machine control: it restarts a run's runner on its machine; the run itself is the way back"),
  removeTaskStub: never("internal: takes back a create the server refused, which never landed"),

  // A project's expectations (LM5): every change is a version judges grade against
  editExpectations: never("send: a line or a retirement becomes a proposal a person reads, and an applied one is a version judges grade against; a later retirement takes a line back"),
  resolveExpectationProposal: never("send: it answers the proposal's card, and an applied version is what judges grade against from then on"),

  // Internal
  applyUndoPatches: never("internal: the undo replay itself"),
  restoreArchivedDoc: never("internal: the server half of undoing a doc archive"),
  flushResolvedSessionFields: INTERNAL,
  recordSyncMeta: INTERNAL,
  seedSession: INTERNAL,
  preloadForkSessions: INTERNAL,
  pruneGhostSessions: INTERNAL,
  markServerDeleted: INTERNAL,
  dropOrgIntent: INTERNAL,
};
