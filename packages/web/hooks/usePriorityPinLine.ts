import { api as _api } from "@codecast/convex/convex/_generated/api";
import { isConvexId } from "@codecast/shared/entities";
import { workspaceFeatureEnabled } from "@codecast/shared/contracts";
import type { PriorityPinLine } from "@codecast/shared/contracts/priorities";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useInboxStore } from "../store/inboxStore";

const api = _api as any;

/** The priority line under a session's pinned state, or null while the feature is off everywhere the viewer works or the session maps to no priority. */
export function usePriorityPinLine(conversationId: string): PriorityPinLine | null {
  // The session may sit in any of the viewer's workspaces, so the line asks
  // whenever any of them has the feature (the personal workspace has it then);
  // the server answers null where the session's own workspace does not.
  const on = useInboxStore((s) => workspaceFeatureEnabled(s.teams || [], null, "priorities"));
  // Remembered per conversation, so switching back to one paints its line at once;
  // a conversation never asked before shows nothing until its own answer lands.
  const { data } = useQueryNoThrow(api.priorities.pinLine, on && isConvexId(conversationId) ? { conversation_id: conversationId } : "skip", { remember: true });
  return on ? ((data as PriorityPinLine | null | undefined) ?? null) : null;
}
