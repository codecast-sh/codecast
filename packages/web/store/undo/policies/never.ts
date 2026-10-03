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
  clearDraftFinal: never("draft: the composer owns its own text undo"),
  answerDecision: never("send: an answered decision has already been read by the agent that asked"),

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
  upsertAgentDefinition: CREATE,
  upsertAgentChain: CREATE,

  // Deletes
  deleteCallRecording: DELETE,
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
  removeMachines: DELETE,
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
  toggleChatReaction: never("reaction: the same click takes it back, and it notifies the author"),

  // Settings
  setAgentDefaultParams: SETTINGS,
  setAgentPermissionModes: SETTINGS,
  setCapabilityBinding: SETTINGS,
  setChannelNotifyLevel: SETTINGS,
  setChatSlackMember: SETTINGS,
  setCloudSessionMode: SETTINGS,
  setCloudSessionSync: SETTINGS,
  setCloudSharedCheckout: SETTINGS,
  setDefaultModel: SETTINGS,
  setDeviceShares: SETTINGS,
  setIsolatedWorktreeMode: SETTINGS,
  setLocalMirror: SETTINGS,
  setMyStatus: SETTINGS,
  setPinnedAgents: SETTINGS,
  setRoomLocked: SETTINGS,
  setRoomRecording: SETTINGS,
  setRoomTranscribeOff: SETTINGS,
  setTeamFeature: SETTINGS,
  setWalkiePref: SETTINGS,
  snoozeWalkie: SETTINGS,
  updateNotificationSettings: SETTINGS,
  updateIssueSyncSource: SETTINGS,
  updateChatSlackLink: SETTINGS,
  persistClientTips: SETTINGS,
  updateClientUI: SETTINGS,

  // Machine and agent control
  convCommand: MACHINE,
  cloudHostAction: MACHINE,
  restartSession: MACHINE,
  hibernateSession: MACHINE,
  moveSessionToDevice: MACHINE,
  markKilling: MACHINE,

  // Sharing
  setCallShareVideo: SHARING,
  setObjectShareLink: SHARING,
  setShareLink: SHARING,
  setTeamMembershipVisibility: SHARING,

  // Internal
  applyUndoPatches: never("internal: the undo replay itself"),
  restoreArchivedDoc: never("internal: the server half of undoing a doc archive"),
  flushResolvedSessionFields: INTERNAL,
};
