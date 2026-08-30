import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { AvatarImg } from "../../../lib/avatarCache";
import { Input } from "../../../components/ui/input";
import { Button } from "../../../components/ui/button";
import { InviteModal } from "../../../components/InviteModal";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useInboxStore } from "../../../store/inboxStore";
import { useCurrentUser } from "../../../hooks/useCurrentUser";
import { TEAM_ICONS, TEAM_COLORS, type TeamIconName, type TeamColorName } from "../../../components/TeamIcon";
import { TeamIdentityPicker, type TeamIdentity } from "../../../components/team/TeamIdentityPicker";
import { TeamTaskStatusEditor } from "../../../components/settings/TeamTaskStatusEditor";
import { TeamFeaturesEditor } from "../../../components/settings/TeamFeaturesEditor";
import { ChevronDown, Github, Users } from "lucide-react";
import {
  SettingsField, SettingsPanel, SettingsSection, SettingsRow,
} from "../../../components/settings/ui";

export default function TeamPage() {
  const router = useRouter();
  // Store-backed read: a populated cache paints the panel synchronously
  // instead of blanking it for the getCurrentUser round trip.
  const { user } = useCurrentUser();
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id) as Id<"teams"> | undefined;
  const effectiveTeamId = activeTeamId || user?.team_id;
  const team = useQuery(
    api.teams.getTeam,
    effectiveTeamId ? { team_id: effectiveTeamId } : "skip"
  );
  const teamContext = useQuery(
    api.teams.getActiveTeamContext,
    effectiveTeamId ? { team_id: effectiveTeamId } : "skip"
  );
  const removeMember = useMutation(api.teams.removeMember);
  const renameTeam = useMutation(api.teams.renameTeam);
  const setMemberRole = useMutation(api.teams.setMemberRole);
  const syncGithubOrg = useAction(api.teams.syncGithubOrg);
  const updateTeamIcon = useMutation(api.teams.updateTeamIcon);
  const teamMembers = useQuery(
    api.teams.getTeamMembers,
    effectiveTeamId ? { team_id: effectiveTeamId } : "skip"
  );

  const [teamName, setTeamName] = useState("");
  const [isEditingTeamName, setIsEditingTeamName] = useState(false);
  const [isSavingTeamName, setIsSavingTeamName] = useState(false);
  const [isSavingIcon, setIsSavingIcon] = useState(false);
  const [memberToRemove, setMemberToRemove] = useState<Id<"users"> | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const [roleChangeInProgress, setRoleChangeInProgress] = useState<Id<"users"> | null>(null);
  const [githubOrgName, setGithubOrgName] = useState("");
  const [isSyncingGithub, setIsSyncingGithub] = useState(false);
  const [syncResult, setSyncResult] = useState<{ imported: any[]; skipped: any[]; total: number } | null>(null);

  if (!user) {
    return null;
  }

  const handleSaveTeamName = async () => {
    if (!user._id || !effectiveTeamId || !teamName.trim()) return;
    setIsSavingTeamName(true);
    try {
      await renameTeam({
        team_id: effectiveTeamId,
        requesting_user_id: user._id,
        name: teamName.trim(),
      });
      setIsEditingTeamName(false);
      setTeamName("");
    } finally {
      setIsSavingTeamName(false);
    }
  };

  const identity: TeamIdentity = {
    icon: (TEAM_ICONS as readonly string[]).includes(team?.icon ?? "") ? (team!.icon as TeamIconName) : TEAM_ICONS[0],
    color: (TEAM_COLORS as readonly string[]).includes(team?.icon_color ?? "") ? (team!.icon_color as TeamColorName) : TEAM_COLORS[0],
  };

  const handleIdentityChange = async (next: TeamIdentity) => {
    if (!effectiveTeamId || isSavingIcon) return;
    const patch = {
      ...(next.icon !== identity.icon ? { icon: next.icon } : {}),
      ...(next.color !== identity.color ? { icon_color: next.color } : {}),
    };
    if (!Object.keys(patch).length) return;
    setIsSavingIcon(true);
    try {
      await updateTeamIcon({ team_id: effectiveTeamId, ...patch });
    } finally {
      setIsSavingIcon(false);
    }
  };

  const handleRemoveMember = async () => {
    if (!memberToRemove || !user._id || !effectiveTeamId) return;
    setIsRemoving(true);
    try {
      await removeMember({
        requesting_user_id: user._id,
        member_user_id: memberToRemove,
        team_id: effectiveTeamId,
      });
      setMemberToRemove(null);
    } finally {
      setIsRemoving(false);
    }
  };

  const handleRoleChange = async (memberId: Id<"users">, newRole: "member" | "admin") => {
    if (!user._id || !effectiveTeamId) return;
    setRoleChangeInProgress(memberId);
    try {
      await setMemberRole({
        requesting_user_id: user._id,
        member_user_id: memberId,
        role: newRole,
        team_id: effectiveTeamId,
      });
    } finally {
      setRoleChangeInProgress(null);
    }
  };

  const handleSyncGithubOrg = async () => {
    if (!user._id || !githubOrgName.trim()) return;
    setIsSyncingGithub(true);
    setSyncResult(null);
    try {
      const result = await syncGithubOrg({
        requesting_user_id: user._id,
        org_name: githubOrgName.trim(),
      });
      setSyncResult(result);
      setGithubOrgName("");
    } catch (error: any) {
      toast.error(`Failed to sync GitHub org: ${error.message}`);
    } finally {
      setIsSyncingGithub(false);
    }
  };

  const getRelativeTime = (timestamp: number | undefined) => {
    if (!timestamp) return "Never";
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "Just now";
    if (minutes === 1) return "1 minute ago";
    if (minutes < 60) return `${minutes} minutes ago`;
    if (hours === 1) return "1 hour ago";
    if (hours < 24) return `${hours} hours ago`;
    if (days === 1) return "1 day ago";
    return `${days} days ago`;
  };

  const getMemberDaemonStatus = (timestamp: number | undefined) => {
    if (!timestamp) return { status: "offline", text: "Never connected" };
    const diff = Date.now() - timestamp;
    if (diff < 60000) return { status: "online", text: "Online" };
    if (diff < 300000) return { status: "recent", text: getRelativeTime(timestamp) };
    return { status: "offline", text: getRelativeTime(timestamp) };
  };

  const isAdmin = teamContext?.role === "admin";
  const goTo = (path: string) => {
    useInboxStore.getState().closeSettingsModal();
    router.push(path);
  };

  if (!effectiveTeamId || !team) {
    return (
      <SettingsPanel>
        <SettingsSection title="Team" icon={Users} padded>
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <p className="max-w-prose text-sm text-sol-text-muted">
              You are not part of a team yet. Create one to work with your teammates, or join one you were invited to.
            </p>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => goTo("/settings/team/create")}
                variant="cyan"
              >
                Create a team
              </Button>
              <Button size="sm" variant="outline" onClick={() => goTo("/settings/team/join")}>
                Join a team
              </Button>
            </div>
          </div>
        </SettingsSection>
      </SettingsPanel>
    );
  }

  const memberCount = teamMembers?.length || 0;

  return (
    <SettingsPanel>
      <SettingsSection
        title="Team"
        icon={Users}
        actions={
          isAdmin ? (
            <InviteModal
              teamId={effectiveTeamId}
              trigger={
                <Button variant="outline" size="sm" className="border-sol-cyan text-sol-cyan">
                  Invite
                </Button>
              }
            />
          ) : undefined
        }
      >
        <SettingsRow label="Team name">
          {isEditingTeamName ? (
            <div className="flex items-center gap-2">
              <Input
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                placeholder={team.name}
                className="h-8 w-48 bg-sol-bg border-sol-border text-sol-text"
                autoFocus
              />
              <Button
                size="sm"
                onClick={handleSaveTeamName}
                disabled={!teamName.trim() || isSavingTeamName}
                variant="cyan" className="h-8"
              >
                {isSavingTeamName ? "..." : "Save"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setIsEditingTeamName(false);
                  setTeamName("");
                }}
                className="h-8"
              >
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-sol-text">{team.name}</span>
              {isAdmin && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsEditingTeamName(true)}
                  className="h-6 px-2 text-xs text-sol-text-muted hover:text-sol-text"
                >
                  Edit
                </Button>
              )}
            </div>
          )}
        </SettingsRow>
        {isAdmin && (
          <SettingsField label="Team icon">
            <TeamIdentityPicker
              value={identity}
              onChange={handleIdentityChange}
              previewName={team.name}
              disabled={isSavingIcon}
            />
          </SettingsField>
        )}
      </SettingsSection>

      {isAdmin && user.github_username && (
        <SettingsSection
          title="GitHub org sync"
          icon={Github}
          description="Import members from a GitHub organization to your team."
        >
          <SettingsField
            label="Organization"
            htmlFor="github-org"
            hint={
              syncResult && (
                <span>
                  <span className="text-sol-text">
                    Imported {syncResult.imported.length} of {syncResult.total} members
                  </span>
                  {syncResult.skipped.length > 0 && (
                    <span> · Skipped {syncResult.skipped.length} (already members)</span>
                  )}
                </span>
              )
            }
          >
            <div className="flex items-center gap-2">
              <Input
                id="github-org"
                value={githubOrgName}
                onChange={(e) => setGithubOrgName(e.target.value)}
                placeholder="org-name"
                className="w-64 bg-sol-bg border-sol-border text-sol-text"
                disabled={isSyncingGithub}
              />
              <Button
                onClick={handleSyncGithubOrg}
                disabled={!githubOrgName.trim() || isSyncingGithub}
                size="sm"
                variant="cyan"
              >
                {isSyncingGithub ? "Syncing..." : "Sync org"}
              </Button>
            </div>
          </SettingsField>
        </SettingsSection>
      )}

      <SettingsSection
        title="Members"
        icon={Users}
        actions={
          <span className="text-xs text-sol-text-muted">
            {memberCount} member{memberCount !== 1 ? "s" : ""}
          </span>
        }
      >
        {teamMembers?.filter((m): m is NonNullable<typeof m> => m !== null).map((member) => {
          const daemonStatus = getMemberDaemonStatus(member.daemon_last_seen);
          return (
            <div key={member._id} className="flex items-center justify-between gap-4 px-4 py-3 sm:px-5">
              <div className="flex min-w-0 items-center gap-3">
                <div className="relative shrink-0">
                  <AvatarImg
                    src={member.github_avatar_url}
                    alt={member.name || "User avatar"}
                    className="w-10 h-10 rounded-full"
                    fallback={
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-sol-bg-highlight text-sm font-semibold text-sol-text">
                        {member.name?.[0]?.toUpperCase() || member.email?.[0]?.toUpperCase() || "?"}
                      </div>
                    }
                  />
                  <div className={`absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-sol-bg ${
                    daemonStatus.status === "online" ? "bg-sol-green" :
                    daemonStatus.status === "recent" ? "bg-sol-yellow" : "bg-sol-text-dim"
                  }`} />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-sol-text">
                    {member.name || "Unnamed"}
                    {member._id === user._id && (
                      <span className="ml-2 text-xs text-sol-text-muted">(you)</span>
                    )}
                  </div>
                  <div className="truncate text-xs text-sol-text-muted">
                    {member.email}
                    {member.github_username && (
                      <>
                        {" • "}
                        <a
                          href={`https://github.com/${member.github_username}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sol-cyan hover:underline"
                        >
                          @{member.github_username}
                        </a>
                      </>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-xs text-sol-text-dim">{daemonStatus.text}</span>
                {isAdmin && member._id !== user._id ? (
                  <button
                    type="button"
                    onClick={() => handleRoleChange(
                      member._id,
                      member.role === "admin" ? "member" : "admin"
                    )}
                    disabled={roleChangeInProgress === member._id}
                    className={`flex cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
                      member.role === "admin"
                        ? "border-sol-cyan bg-sol-cyan/10 text-sol-cyan hover:bg-sol-cyan/20"
                        : "border-sol-border bg-sol-bg-highlight/20 text-sol-text-muted hover:bg-sol-bg-highlight/40 hover:text-sol-text"
                    }`}
                  >
                    {roleChangeInProgress === member._id ? "..." : member.role}
                    <ChevronDown className="h-3 w-3 opacity-60" />
                  </button>
                ) : (
                  <span className={`rounded-md px-2 py-1 text-xs font-medium ${
                    member.role === "admin"
                      ? "bg-sol-cyan/10 text-sol-cyan"
                      : "bg-sol-bg-highlight/20 text-sol-text-muted"
                  }`}>
                    {member.role}
                  </span>
                )}
                {isAdmin && member._id !== user._id && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setMemberToRemove(member._id)}
                    className="h-7 px-2 text-sol-red hover:bg-sol-red/10"
                  >
                    Remove
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </SettingsSection>

      {effectiveTeamId && (
        <TeamFeaturesEditor teamId={effectiveTeamId} isAdmin={isAdmin} />
      )}

      {effectiveTeamId && (
        <TeamTaskStatusEditor
          teamId={effectiveTeamId}
          configured={(team as any)?.task_statuses}
          isAdmin={isAdmin}
        />
      )}

      <Dialog open={!!memberToRemove} onOpenChange={() => setMemberToRemove(null)}>
        <DialogContent className="bg-sol-bg border-sol-border">
          <DialogHeader>
            <DialogTitle className="text-sol-text">Remove team member</DialogTitle>
            <DialogDescription className="text-sol-text-muted">
              Are you sure you want to remove this member from the team? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setMemberToRemove(null)}
              disabled={isRemoving}
            >
              Cancel
            </Button>
            <Button
              onClick={handleRemoveMember}
              disabled={isRemoving}
              className="bg-sol-red hover:bg-sol-red/80 text-sol-base03"
            >
              {isRemoving ? "Removing..." : "Remove member"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsPanel>
  );
}
