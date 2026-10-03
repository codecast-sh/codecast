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
  clearDraftFinal: DRAFT,
  answerDecision: never("send: an answered decision has already been read by the agent that asked"),
  resolvePermission: never("send: the agent acts on an approved or denied tool call the moment it lands"),
  respondToGate: never("send: a gate answer resumes the run and posts into its session"),

  // Local echoes of sends (sync creators a component calls)
  addOptimisticMessage: LOCAL_ECHO,
  markOptimisticAsFailed: LOCAL_ECHO,
  removeOptimisticMessage: LOCAL_ECHO,
  resolvePendingUploads: LOCAL_ECHO,
  stampPendingDispatchContent: LOCAL_ECHO,
  setQueuedMessagesFor: LOCAL_ECHO,
  takeQueuedMessage: LOCAL_ECHO,
  resolveSessionQuestion: LOCAL_ECHO,
  confirmSessionCommand: LOCAL_ECHO,

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
  createSession: CREATE,
  createStackWith: CREATE,
  createTask: CREATE,
  dispatchCreateChatChannel: CREATE,
  dispatchCreateTeam: CREATE,
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
  deleteComment: DELETE,
  deleteSavedView: DELETE,
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
  setOpsGroupStatus: never("triage: resolve, ignore and reopen sit on the same status control"),
  grantOpsAction: never("permission: a grant changes what agents may do; revoke it explicitly"),
  revokeOpsAction: never("permission: a revoke changes what agents may do; grant it again explicitly"),
  updateChatSlackLink: SETTINGS,
  persistClientTips: SETTINGS,
  updateClientUI: SETTINGS,
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
  setObjectShareLink: SHARING,
  setShareLink: SHARING,
  setTeamMembershipVisibility: SHARING,

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
