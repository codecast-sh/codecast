"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Card } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Button } from "../../../components/ui/button";
import { SettingsModal } from "../../../components/SettingsModal";

export default function ProfilePage() {
  const user = useQuery(api.users.getCurrentUser);
  const updateProfile = useMutation(api.users.updateProfile);

  const [name, setName] = useState("");
  const [isSaving, setIsSaving] = useState(false);

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
    <div className="space-y-6">
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
    </div>
  );
}
