// Undo policy for work objects: tasks, plans, projects, initiatives, docs,
// comments, stacks, bookmarks, saved views, triggers, chat, privacy and the
// org record. Owned by the work coverage work (ct-56508 WP3); each entry
// below is a placeholder until that package gives it a spec (org verbs get
// `external: "org"`) or a final reason.
import type { UndoPolicy } from "../policy";

const TODO = { never: "todo: WP3" } as const;

export const WORK_UNDO_POLICY: UndoPolicy = {
  updateTask: TODO,
  updateTaskStatus: TODO,
  updatePlan: TODO,
  updateProject: TODO,
  setProjectLead: TODO,
  updateInitiative: TODO,
  addInitiativeProject: TODO,
  removeInitiativeProject: TODO,
  setInitiativeProjects: TODO,
  updateDoc: TODO,
  pinDoc: TODO,
  moveDoc: TODO,
  archiveDoc: TODO,
  updateSavedView: TODO,
  resolveCommentThread: TODO,
  editComment: TODO,
  reorderStack: TODO,
  setStackPolicy: TODO,
  triggerAction: TODO,
  setTriggerInterval: TODO,
  updateChatChannel: TODO,
  archiveChatChannel: TODO,
  addChatChannelMembers: TODO,
  removeChatChannelMember: TODO,
  dispatchChatEdit: TODO,
  setPrivacy: TODO,
  setTeamVisibility: TODO,
  toggleBookmark: TODO,
  // Org verbs (orgSlice.ts): display-only history items pointing at the org record.
  reparentOrgSession: TODO,
  reparentOrgRole: TODO,
  createOrgRole: TODO,
  updateOrgRole: TODO,
  setRoleLine: TODO,
  followOrgChannel: TODO,
  staffHeadOfPeople: TODO,
  hireExecutiveAssistant: TODO,
  acceptAllOrgProposal: TODO,
  decideOrgProposalAsk: TODO,
  decideOrgProposalChange: TODO,
  withdrawOrgProposal: TODO,
  sayOnOrgProposal: TODO,
  undoOrgChange: TODO,
  redoOrgChange: TODO,
  retireOrgRole: TODO,
};
