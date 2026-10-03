// How an undo reaches the server for store keys off the patch rail.
//
// Keys with a registry dispatchTable (sessions, conversations, buckets,
// sessionDecisions) ride the engine's single applyUndoPatches pass. Every
// other local-first key needs a writer here, naming the existing action that
// carries a row's prior values to the server, or an entry in
// LOCAL_ONLY_UNDO_KEYS saying why it needs none. The guard test
// (store/__tests__/undoWriters.guard.test.ts) enforces it. Owned by the work
// coverage work (ct-56508 WP3), which fills both.
import type { UndoWriter } from "@platform/engine";

export const UNDO_WRITERS: Record<string, UndoWriter> = {};

/** Local-first keys off the patch rail that need no writer, with the reason. */
export const LOCAL_ONLY_UNDO_KEYS: Record<string, string> = {
  tasks: "todo: WP3",
  capabilityBindings: "todo: WP3",
  docs: "todo: WP3",
  decisionStacks: "todo: WP3",
  handledDecisions: "todo: WP3",
  plans: "todo: WP3",
  projects: "todo: WP3",
  initiatives: "todo: WP3",
  bucketAssignments: "todo: WP3",
  comments: "todo: WP3",
  sessionReads: "todo: WP3",
  agentTasks: "todo: WP3",
  foreignTriggers: "todo: WP3",
  agentDefinitions: "todo: WP3",
  agentChains: "todo: WP3",
  issueSyncSources: "todo: WP3",
  notifications: "todo: WP3",
  callRooms: "todo: WP3",
  teams: "todo: WP3",
  teamMembers: "todo: WP3",
  bookmarks: "todo: WP3",
  currentUser: "todo: WP3",
};
