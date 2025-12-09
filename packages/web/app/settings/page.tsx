"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { Card } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Button } from "../../components/ui/button";
import { useRouter } from "next/navigation";
import { SettingsModal } from "../../components/SettingsModal";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";

export default function SettingsPage() {
  const user = useQuery(api.users.getCurrentUser);
  const updateProfile = useMutation(api.users.updateProfile);
  const removeMember = useMutation(api.teams.removeMember);
  const teamMembers = useQuery(
    api.teams.getTeamMembers,
    user?.team_id ? { team_id: user.team_id } : "skip"
  );
  const router = useRouter();

  const [name, setName] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [memberToRemove, setMemberToRemove] = useState<Id<"users"> | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);

  if (!user) {
    return null;
  }

  const handleSaveProfile = async () => {
    setIsSaving(true);
    try {
      await updateProfile({ name });
      setName("");
    } finally {
      setIsSaving(false);
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

  const daemonConnected = user.daemon_last_seen &&
    Date.now() - user.daemon_last_seen < 60000;
  const lastSeenText = user.daemon_last_seen
    ? new Date(user.daemon_last_seen).toLocaleString()
    : "Never";

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

  const lastSeenRelative = getRelativeTime(user.daemon_last_seen);

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="max-w-3xl mx-auto space-y-6">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-semibold text-sol-text">Settings</h1>
            <Button
              variant="ghost"
              onClick={() => router.push("/dashboard")}
              className="text-sol-base1"
            >
              Back to Dashboard
            </Button>
          </div>

          <Card className="p-6 bg-sol-bg border-sol-border">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-sol-text">Profile</h2>
              <SettingsModal
                trigger={
                  <Button variant="outline" size="sm">
                    Edit in Modal
                  </Button>
                }
              />
            </div>
            <div className="space-y-4">
              <div>
                <Label htmlFor="name" className="text-sol-base1">Name</Label>
                <Input
                  id="name"
                  type="text"
                  placeholder={user.name || "Enter your name"}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 bg-sol-bg-alt border-sol-border text-sol-text"
                />
              </div>
              <div>
                <Label htmlFor="email" className="text-sol-base1">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={user.email || ""}
                  disabled
                  className="mt-1 bg-sol-bg-alt border-sol-border text-sol-base0"
                />
              </div>
              <Button
                onClick={handleSaveProfile}
                disabled={!name || isSaving}
                className="bg-sol-cyan hover:bg-sol-cyan/80 text-sol-base03"
              >
                {isSaving ? "Saving..." : "Save Profile"}
              </Button>
            </div>
          </Card>

          <Card className="p-6 bg-sol-bg border-sol-border">
            <h2 className="text-lg font-semibold text-sol-text mb-4">Daemon</h2>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sol-base1">Status</span>
                <span className={`font-medium ${daemonConnected ? "text-sol-green" : "text-sol-orange"}`}>
                  {daemonConnected ? "Connected" : "Not connected"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sol-base1">Last sync</span>
                <span className="text-sol-text">{lastSeenText}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sol-base1">Last seen</span>
                <span className="text-sol-text">{lastSeenRelative}</span>
              </div>
            </div>
          </Card>

          <Card className="p-6 bg-sol-bg border-sol-border">
            <h2 className="text-lg font-semibold text-sol-text mb-4">Privacy</h2>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sol-text font-medium">Default sharing</div>
                  <div className="text-sm text-sol-base1">
                    New conversations are private by default
                  </div>
                </div>
                <span className="px-3 py-1 rounded-full text-sm font-medium bg-sol-orange/20 text-sol-orange">
                  Private
                </span>
              </div>
            </div>
          </Card>

          {user.team_id && user.role === "admin" && teamMembers && (
            <Card className="p-6 bg-sol-bg border-sol-border">
              <h2 className="text-lg font-semibold text-sol-text mb-4">Team Settings</h2>
              <div className="space-y-3">
                {teamMembers.map((member) => (
                  <div key={member._id} className="flex items-center justify-between py-2">
                    <div>
                      <div className="text-sol-text font-medium">{member.name || "Unnamed"}</div>
                      <div className="text-sm text-sol-base1">{member.email}</div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`px-2 py-1 rounded text-xs font-medium ${
                        member.role === "admin"
                          ? "bg-sol-cyan/20 text-sol-cyan"
                          : "bg-sol-base02/20 text-sol-base1"
                      }`}>
                        {member.role}
                      </span>
                      {member._id !== user._id && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setMemberToRemove(member._id)}
                          className="border-sol-red text-sol-red hover:bg-sol-red/10"
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>

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
      </DashboardLayout>
    </AuthGuard>
  );
}
