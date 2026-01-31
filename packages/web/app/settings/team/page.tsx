"use client";

import { useState } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Card } from "../../../components/ui/card";
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
import { useActiveTeamStore } from "../../../store/activeTeamStore";
import { TeamIcon, TEAM_ICONS, TEAM_COLORS, colorBgClassMap } from "../../../components/TeamIcon";

export default function TeamPage() {
  const user = useQuery(api.users.getCurrentUser);
  const { activeTeamId } = useActiveTeamStore();
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

  const handleIconChange = async (icon: string) => {
    if (!effectiveTeamId || isSavingIcon) return;
    setIsSavingIcon(true);
    try {
      await updateTeamIcon({
        team_id: effectiveTeamId,
        icon,
      });
    } finally {
      setIsSavingIcon(false);
    }
  };

  const handleColorChange = async (color: string) => {
    if (!effectiveTeamId || isSavingIcon) return;
    setIsSavingIcon(true);
    try {
      await updateTeamIcon({
        team_id: effectiveTeamId,
        icon_color: color,
      });
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
      alert(`Failed to sync GitHub org: ${error.message}`);
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

  if (!effectiveTeamId || !team) {
    return (
      <div className="space-y-6">
        <Card className="p-6 bg-sol-bg border-sol-border">
          <p className="text-sol-base1">You are not part of a team.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card className="p-6 bg-sol-bg border-sol-border">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-sol-text">Team</h2>
          <div className="flex items-center gap-2">
            {isAdmin && (
              <InviteModal
                trigger={
                  <Button variant="outline" size="sm" className="border-sol-cyan text-sol-cyan">
                    Invite
                  </Button>
                }
              />
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between py-2 border-b border-sol-border">
            <div>
              <div className="text-xs text-sol-base1 uppercase tracking-wider">Team Name</div>
              {isEditingTeamName ? (
                <div className="flex items-center gap-2 mt-1">
                  <Input
                    value={teamName}
                    onChange={(e) => setTeamName(e.target.value)}
                    placeholder={team.name}
                    className="h-8 w-48 bg-sol-bg-alt border-sol-border text-sol-text"
                    autoFocus
                  />
                  <Button
                    size="sm"
                    onClick={handleSaveTeamName}
                    disabled={!teamName.trim() || isSavingTeamName}
                    className="h-8 bg-sol-cyan hover:bg-sol-cyan/80 text-sol-base03"
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
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-sol-text font-medium">{team.name}</span>
                  {isAdmin && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setIsEditingTeamName(true)}
                      className="h-6 px-2 text-xs text-sol-base1 hover:text-sol-text"
                    >
                      Edit
                    </Button>
                  )}
                </div>
              )}
            </div>
            <div className="text-sm text-sol-base1">
              {teamMembers?.length || 0} member{(teamMembers?.length || 0) !== 1 ? "s" : ""}
            </div>
          </div>

          {isAdmin && (
            <div className="flex items-start justify-between py-2 border-b border-sol-border">
              <div className="flex-1">
                <div className="text-xs text-sol-base1 uppercase tracking-wider mb-2">Team Icon</div>
                <div className="flex items-start gap-6">
                  <div className="flex items-center justify-center w-16 h-16 rounded-xl bg-sol-bg-alt">
                    <TeamIcon icon={team.icon} color={team.icon_color} className="w-8 h-8" />
                  </div>
                  <div className="flex-1 space-y-3">
                    <div>
                      <div className="text-xs text-sol-base1 mb-1.5">Icon</div>
                      <div className="flex flex-wrap gap-1.5">
                        {TEAM_ICONS.map((icon) => (
                          <button
                            key={icon}
                            onClick={() => handleIconChange(icon)}
                            disabled={isSavingIcon}
                            className={`p-1.5 rounded-md transition-colors ${
                              team.icon === icon
                                ? "bg-sol-base02 ring-1 ring-sol-base01"
                                : "hover:bg-sol-base02/50"
                            } ${isSavingIcon ? "opacity-50" : ""}`}
                          >
                            <TeamIcon icon={icon} color={team.icon === icon ? team.icon_color : undefined} className={`w-4 h-4 ${team.icon !== icon ? "text-sol-base1" : ""}`} />
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-sol-base1 mb-1.5">Color</div>
                      <div className="flex gap-2">
                        {TEAM_COLORS.map((color) => (
                          <button
                            key={color}
                            onClick={() => handleColorChange(color)}
                            disabled={isSavingIcon}
                            className={`w-7 h-7 rounded-full transition-all ${colorBgClassMap[color]} ${
                              team.icon_color === color
                                ? "ring-2 ring-offset-2 ring-offset-sol-bg ring-sol-base1 scale-110"
                                : "hover:scale-105"
                            } ${isSavingIcon ? "opacity-50" : ""}`}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {isAdmin && user.github_username && (
            <div className="flex items-start justify-between py-2 border-b border-sol-border">
              <div className="flex-1">
                <div className="text-xs text-sol-base1 uppercase tracking-wider mb-2">GitHub Org Sync</div>
                <p className="text-sm text-sol-base1 mb-3">
                  Import members from a GitHub organization to your team
                </p>
                <div className="flex items-center gap-2">
                  <Input
                    value={githubOrgName}
                    onChange={(e) => setGithubOrgName(e.target.value)}
                    placeholder="org-name"
                    className="h-9 w-64 bg-sol-bg-alt border-sol-border text-sol-text"
                    disabled={isSyncingGithub}
                  />
                  <Button
                    onClick={handleSyncGithubOrg}
                    disabled={!githubOrgName.trim() || isSyncingGithub}
                    className="h-9 bg-sol-cyan hover:bg-sol-cyan/80 text-sol-base03"
                  >
                    {isSyncingGithub ? "Syncing..." : "Sync Org"}
                  </Button>
                </div>
                {syncResult && (
                  <div className="mt-3 p-3 rounded-lg bg-sol-bg-alt">
                    <div className="text-sm text-sol-text">
                      Imported {syncResult.imported.length} of {syncResult.total} members
                    </div>
                    {syncResult.skipped.length > 0 && (
                      <div className="text-xs text-sol-base1 mt-1">
                        Skipped {syncResult.skipped.length} (already members)
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="space-y-2">
            <div className="text-xs text-sol-base1 uppercase tracking-wider">Members</div>
            {teamMembers?.filter((m): m is NonNullable<typeof m> => m !== null).map((member) => {
              const daemonStatus = getMemberDaemonStatus(member.daemon_last_seen);
              return (
                <div key={member._id} className="flex items-center justify-between py-3 px-3 rounded-lg bg-sol-bg-alt">
                  <div className="flex items-center gap-3">
                    <div className="relative">
                      {member.github_avatar_url ? (
                        <img
                          src={member.github_avatar_url}
                          alt={member.name || "User avatar"}
                          className="w-10 h-10 rounded-full"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-sol-base02 flex items-center justify-center text-sol-text text-sm font-semibold">
                          {member.name?.[0]?.toUpperCase() || member.email?.[0]?.toUpperCase() || "?"}
                        </div>
                      )}
                      <div className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-sol-bg-alt ${
                        daemonStatus.status === "online" ? "bg-sol-green" :
                        daemonStatus.status === "recent" ? "bg-sol-yellow" : "bg-sol-base01"
                      }`} />
                    </div>
                    <div>
                      <div className="text-sol-text font-medium">
                        {member.name || "Unnamed"}
                        {member._id === user._id && (
                          <span className="ml-2 text-xs text-sol-base1">(you)</span>
                        )}
                      </div>
                      <div className="text-sm text-sol-base1">
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
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-sol-base1">{daemonStatus.text}</span>
                    {isAdmin && member._id !== user._id ? (
                      <button
                        onClick={() => handleRoleChange(
                          member._id,
                          member.role === "admin" ? "member" : "admin"
                        )}
                        disabled={roleChangeInProgress === member._id}
                        className={`px-2 py-1 rounded text-xs font-medium cursor-pointer transition-colors ${
                          member.role === "admin"
                            ? "bg-sol-cyan/20 text-sol-cyan hover:bg-sol-cyan/30"
                            : "bg-sol-base02/20 text-sol-base1 hover:bg-sol-base02/30"
                        }`}
                      >
                        {roleChangeInProgress === member._id ? "..." : member.role}
                      </button>
                    ) : (
                      <span className={`px-2 py-1 rounded text-xs font-medium ${
                        member.role === "admin"
                          ? "bg-sol-cyan/20 text-sol-cyan"
                          : "bg-sol-base02/20 text-sol-base1"
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
          </div>
        </div>
      </Card>

      <Dialog open={!!memberToRemove} onOpenChange={() => setMemberToRemove(null)}>
        <DialogContent className="bg-sol-bg border-sol-border">
          <DialogHeader>
            <DialogTitle className="text-sol-text">Remove Team Member</DialogTitle>
            <DialogDescription className="text-sol-base1">
              Are you sure you want to remove this member from the team? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setMemberToRemove(null)}
              disabled={isRemoving}
              className="border-sol-border text-sol-base1"
            >
              Cancel
            </Button>
            <Button
              onClick={handleRemoveMember}
              disabled={isRemoving}
              className="bg-sol-red hover:bg-sol-red/80 text-sol-base3"
            >
              {isRemoving ? "Removing..." : "Remove Member"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
