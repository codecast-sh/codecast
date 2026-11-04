"use client";

// Who answers for the team (anchors.workspaceAgentRoleOf): the role that
// Slack, team chat, @anchor and decision talk reach. The Head of People
// until an admin picks another of the team's roles here.

import { toast } from "sonner";
import { SelectBox } from "../ui/select-box";
import { SettingsRow } from "./ui";
import { useAnchors } from "../../hooks/useSyncAnchors";
import { anchorIdentityWords } from "../../lib/headerPins";
import { isHeadOfPeopleRole } from "../org/orgStaffingTypes";
import { useInboxStore } from "../../store/inboxStore";

export function TeamWorkspaceAgent({ teamId, isAdmin }: { teamId: string; isAdmin: boolean }) {
  const anchors = useAnchors();
  const seats = anchors.filter((a) => a.scope_type === "team" && String(a.team_id) === teamId && a.role?.scope_type === "team");
  if (seats.length === 0) return null;
  const root = seats.find((a) => a.is_root);
  const choose = (roleId: string) => {
    const seat = seats.find((a) => String(a.role!._id) === roleId);
    useInboxStore.getState().setTeamWorkspaceAgent(teamId, seat && isHeadOfPeopleRole(seat.role!) ? null : roleId)
      .catch((e: any) => toast.error(e?.message?.replace(/^.*Uncaught Error: /, "") || "Could not change who answers for the team"));
  };
  return (
    <SettingsRow label="Answers for the team" description="Slack, team chat and @anchor">
      <SelectBox
        value={root?.role ? String(root.role._id) : ""}
        onChange={(e) => choose(e.target.value)}
        disabled={!isAdmin}
        aria-label="Role that answers for the team"
        data-team-workspace-agent
      >
        {!root && <option value="" disabled>Nobody</option>}
        {seats.map((a) => {
          const { name, subtitle } = anchorIdentityWords(a);
          return <option key={a._id} value={String(a.role!._id)}>{name === subtitle ? name : `${name} · ${subtitle}`}</option>;
        })}
      </SelectBox>
    </SettingsRow>
  );
}
