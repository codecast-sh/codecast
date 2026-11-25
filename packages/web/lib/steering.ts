// Moderated steering, the client's read of it (convex teamSuggestions.ts).
// While an owner of a session is in it, a teammate's message waits as a
// suggestion; the roster carries the same two facts the server decides on
// (the member's view and their derived presence), so the composer can say
// "Suggest" before the press. The server still decides at send time. An
// admin of the session's team never suggests or proposes: they send, and
// answer its questions, plan approvals and permission prompts, directly.
import { isHostedAgentType } from "@codecast/shared/contracts";
import { memberPresenceState, viewersOf } from "../components/presence/memberPresence";
import { isConvexId, viewerCommandsSession } from "../store/inboxStore";

type SteeredConversation = { _id: unknown; user_id?: unknown; owner_user_id?: unknown; standing_role_id?: unknown; agent_type?: string; team_id?: unknown };
type AnsweredConversation = SteeredConversation & { access_level?: string; team_visibility?: string };

export type AnswerRoles = {
  /** The session's question and plan cards answer directly (else they propose or are read only). */
  canAnswer: boolean;
  /** Which side of team proposals this viewer is on (hooks/useTeamProposals). */
  proposalRole: "owner" | "teammate" | null;
  /** How pending permission prompts draw: answered by the runner or a team
   *  admin, or proposed. */
  permissionRole: "runner" | "admin" | "proposer" | null;
  /** "Allow all" switches the session to bypass mode, a daemon command. */
  allowAll: boolean;
};

/** Who this viewer is to the session's questions and prompts, the client's
 *  copy of the server's rules: commandsSession for the runner and primary
 *  owner, teamSuggestions.adminAnswers for an admin of the session's team,
 *  viewerSeesDetail for a teammate who proposes. */
export function answerRoles(conversation: AnsweredConversation | null | undefined, meId: string | null, teams: any[] | null | undefined): AnswerRoles {
  const commands = viewerCommandsSession(conversation as any, meId);
  const persisted = !!conversation?._id && isConvexId(String(conversation._id));
  // Reads the session's detail (the server's viewerSeesDetail): an owner, or a
  // teammate on a session shared above summary. A share link reads neither.
  const seesDetail = conversation?.access_level === "owner"
    || (conversation?.access_level === "team" && !["summary", "minimal", "private"].includes(conversation?.team_visibility as string));
  const admin = !!conversation && !conversation.standing_role_id && !isHostedAgentType(conversation.agent_type)
    && seesDetail && adminOfTeam(teams, conversation.team_id);
  const runner = !!meId && String(conversation?.user_id) === meId;
  return {
    canAnswer: commands || admin,
    proposalRole: !persisted ? null : commands ? "owner" : admin ? null : seesDetail ? "teammate" : null,
    permissionRole: !persisted || !meId ? null : runner ? "runner" : admin ? "admin" : "proposer",
    allowAll: commands,
  };
}

/** Whether the viewer is an admin of this team, read off their own team list
 *  (the store's `teams`, teams.getUserTeams). The client's copy of convex
 *  teamSuggestions.adminOfSessionTeam. */
export function adminOfTeam(teams: any[] | null | undefined, teamId: unknown): boolean {
  if (!teamId) return false;
  return (teams ?? []).some((t) => String(t?._id) === String(teamId) && t?.role === "admin");
}

/** The id of the owner attending this session right now, or null. */
export function attendingOwnerId(members: any[] | null | undefined, conversation: SteeredConversation | null | undefined, meId: string | null, teams: any[] | null | undefined): string | null {
  if (!conversation) return null;
  if (conversation.standing_role_id || isHostedAgentType(conversation.agent_type)) return null;
  const owners = new Set([conversation.user_id, conversation.owner_user_id].filter(Boolean).map(String));
  if (meId && owners.has(meId)) return null;
  if (adminOfTeam(teams, conversation.team_id)) return null;
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
