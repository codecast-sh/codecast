// Undo policy for sessions, the inbox, buckets, favorites and decisions.
// Owned by the session coverage work (ct-56508 WP2); each entry below is a
// placeholder until that package gives it a spec or a final reason.
import type { UndoPolicy } from "../policy";

const TODO = { never: "todo: WP2" } as const;

export const SESSIONS_UNDO_POLICY: UndoPolicy = {
  deferSession: TODO,
  setSessionRest: TODO,
  pinSession: TODO,
  snoozeSession: TODO,
  wakeSnoozedSession: TODO,
  renameSession: TODO,
  setSessionCharacter: TODO,
  setSessionCharacters: TODO,
  patchConversation: TODO,
  toggleFavorite: TODO,
  updateSessionProject: TODO,
  setConversationModel: TODO,
  setConversationAgent: TODO,
  setConversationAgentDefinition: TODO,
  stashSession: TODO,
  killSession: TODO,
  killSessions: TODO,
  restoreSession: TODO,
  updateBucket: TODO,
  assignSessionToBucket: TODO,
  switchProject: TODO,
  reopenDecision: TODO,
};
