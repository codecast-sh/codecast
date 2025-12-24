"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
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

export default function TeamPage() {
  const user = useQuery(api.users.getCurrentUser);
  const team = useQuery(
    api.teams.getTeam,
    user?.team_id ? { team_id: user.team_id } : "skip"
  );
  const removeMember = useMutation(api.teams.removeMember);
  const renameTeam = useMutation(api.teams.renameTeam);
  const setMemberRole = useMutation(api.teams.setMemberRole);
  const teamMembers = useQuery(
    api.teams.getTeamMembers,
    user?.team_id ? { team_id: user.team_id } : "skip"
  );

  const [teamName, setTeamName] = useState("");
  const [isEditingTeamName, setIsEditingTeamName] = useState(false);
  const [isSavingTeamName, setIsSavingTeamName] = useState(false);
  const [memberToRemove, setMemberToRemove] = useState<Id<"users"> | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const [roleChangeInProgress, setRoleChangeInProgress] = useState<Id<"users"> | null>(null);

  if (!user) {
    return null;
  }

  const handleSaveTeamName = async () => {
    if (!user._id || !user.team_id || !teamName.trim()) return;
    setIsSavingTeamName(true);
    try {
      await renameTeam({
        team_id: user.team_id,
        requesting_user_id: user._id,
        name: teamName.trim(),
      });
      setIsEditingTeamName(false);
      setTeamName("");
    } finally {
      setIsSavingTeamName(false);
    }
  };

  const handleRemoveMember = async () => {
    if (!memberToRemove || !user._id) return;
    setIsRemoving(true);
    try {
      await removeMember({
        requesting_user_id: user._id,
        member_user_id: memberToRemove,
      });
      setMemberToRemove(null);
    } finally {
      setIsRemoving(false);
    }
  };

  const handleRoleChange = async (memberId: Id<"users">, newRole: "member" | "admin") => {
    if (!user._id) return;
    setRoleChangeInProgress(memberId);
    try {
      await setMemberRole({
        requesting_user_id: user._id,
        member_user_id: memberId,
        role: newRole,
      });
    } finally {
      setRoleChangeInProgress(null);
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

  const isAdmin = user.role === "admin";

  if (!user.team_id || !team) {
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

          <div className="space-y-2">
            <div className="text-xs text-sol-base1 uppercase tracking-wider">Members</div>
            {teamMembers?.map((member) => {
              const daemonStatus = getMemberDaemonStatus(member.daemon_last_seen);
              return (
                <div key={member._id} className="flex items-center justify-between py-3 px-3 rounded-lg bg-sol-bg-alt">
                  <div className="flex items-center gap-3">
                    <div className={`w-2 h-2 rounded-full ${
                      daemonStatus.status === "online" ? "bg-sol-green" :
                      daemonStatus.status === "recent" ? "bg-sol-yellow" : "bg-sol-base01"
                    }`} />
                    <div>
                      <div className="text-sol-text font-medium">
                        {member.name || "Unnamed"}
                        {member._id === user._id && (
                          <span className="ml-2 text-xs text-sol-base1">(you)</span>
                        )}
                      </div>
                      <div className="text-sm text-sol-base1">{member.email}</div>
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
