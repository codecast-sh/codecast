// Moderated steering, the client's read of it (convex teamSuggestions.ts).
// While an owner of a session is in it, a teammate's message waits as a
// suggestion; the roster carries the same two facts the server decides on
// (the member's view and their derived presence), so the composer can say
// "Suggest" before the press. The server still decides at send time.
import { isHostedAgentType } from "@codecast/shared/contracts";
import { memberPresenceState, viewersOf } from "../components/presence/memberPresence";

type SteeredConversation = { _id: unknown; user_id?: unknown; owner_user_id?: unknown; team_suggestions?: boolean | null; standing_role_id?: unknown; agent_type?: string };

/** The id of the owner attending this session right now, or null. */
export function attendingOwnerId(members: any[] | null | undefined, conversation: SteeredConversation | null | undefined, meId: string | null): string | null {
  if (!conversation || conversation.team_suggestions === false) return null;
  if (conversation.standing_role_id || isHostedAgentType(conversation.agent_type)) return null;
  const owners = new Set([conversation.user_id, conversation.owner_user_id].filter(Boolean).map(String));
  if (meId && owners.has(meId)) return null;
  for (const m of viewersOf(members, String(conversation._id), meId)) {
    if (owners.has(String(m._id)) && memberPresenceState(m) === "active") return String(m._id);
  }
  return null;
}

/** The words a proposal shows: a poll answer's display text, else the body. */
export function proposalText(body: string): string {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && typeof parsed.display === "string") return parsed.display;
  } catch {}
  return body;
}
