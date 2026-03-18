import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Card } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { Button } from "../../../components/ui/button";
import { Textarea } from "../../../components/ui/textarea";
import { Switch } from "../../../components/ui/switch";
import { useInboxStore } from "../../../store/inboxStore";

export default function ProfilePage() {
  const user = useQuery(api.users.getCurrentUser);
  const updateProfile = useMutation(api.users.updateProfile);

  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<"available" | "busy" | "away">("available");
  const [timezone, setTimezone] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  if (!user) {
    return null;
  }

  const handleSaveProfile = async () => {
    setIsSaving(true);
    try {
      const updates: any = {};
      if (name) updates.name = name;
      if (bio) updates.bio = bio;
      if (title) updates.title = title;
      if (status) updates.status = status;
      if (timezone) updates.timezone = timezone;
      await updateProfile(updates);
      setName("");
      setBio("");
      setTitle("");
      setTimezone("");
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
        <h2 className="text-lg font-semibold text-sol-text mb-4">Profile</h2>
        <div className="space-y-4">
          <div>
            <Label htmlFor="name" className="text-sol-base1">Display Name</Label>
            <Input
              id="name"
              type="text"
              placeholder={user.name || "Enter your name"}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 bg-sol-bg-alt border-sol-border text-sol-text"
            />
            <p className="text-xs text-sol-base01 mt-1">Current: {user.name || "Not set"}</p>
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
          <div>
            <Label htmlFor="title" className="text-sol-base1">Title/Role</Label>
            <Input
              id="title"
              type="text"
              placeholder={user.title || "e.g., Senior Developer"}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="mt-1 bg-sol-bg-alt border-sol-border text-sol-text"
            />
            <p className="text-xs text-sol-base01 mt-1">Current: {user.title || "Not set"}</p>
          </div>
          <div>
            <Label htmlFor="bio" className="text-sol-base1">Bio</Label>
            <Textarea
              id="bio"
              placeholder={user.bio || "Tell us about yourself"}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              className="mt-1 bg-sol-bg-alt border-sol-border text-sol-text"
              rows={3}
            />
            <p className="text-xs text-sol-base01 mt-1">Current: {user.bio || "Not set"}</p>
          </div>
          <div>
            <Label htmlFor="status" className="text-sol-base1">Status</Label>
            <select
              id="status"
              value={status}
              onChange={(e) => setStatus(e.target.value as "available" | "busy" | "away")}
              className="mt-1 w-full px-3 py-2 bg-sol-bg-alt border border-sol-border rounded-md text-sol-text"
            >
              <option value="available">Available</option>
              <option value="busy">Busy</option>
              <option value="away">Away</option>
            </select>
            <p className="text-xs text-sol-base01 mt-1">Current: {user.status || "Not set"}</p>
          </div>
          <div>
            <Label htmlFor="timezone" className="text-sol-base1">Timezone</Label>
            <Input
              id="timezone"
              type="text"
              placeholder={user.timezone || "e.g., America/Los_Angeles"}
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="mt-1 bg-sol-bg-alt border-sol-border text-sol-text"
            />
            <p className="text-xs text-sol-base01 mt-1">Current: {user.timezone || "Not set"}</p>
          </div>
          {user.github_username && (
            <div>
              <Label htmlFor="github" className="text-sol-base1">GitHub</Label>
              <Input
                id="github"
                type="text"
                value={user.github_username}
                disabled
                className="mt-1 bg-sol-bg-alt border-sol-border text-sol-base0"
              />
            </div>
          )}
          <Button
            onClick={handleSaveProfile}
            disabled={isSaving}
            className="bg-sol-cyan hover:bg-sol-cyan/80 text-sol-base03"
          >
            {isSaving ? "Saving..." : "Save Profile"}
          </Button>
        </div>
      </Card>

      <Card className="p-6 bg-sol-bg border-sol-border">
        <h2 className="text-lg font-semibold text-sol-text mb-4">Preferences</h2>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sol-base1">Sound effects</span>
              <p className="text-xs text-sol-base01 mt-0.5">Play subtle sounds for session events</p>
            </div>
            <SoundsToggle />
          </div>
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

function SoundsToggle() {
  const soundsEnabled = useInboxStore((s) => s.clientState?.ui?.sounds_enabled !== false);
  const updateUI = useInboxStore((s) => s.updateClientUI);
  return (
    <Switch
      checked={soundsEnabled}
      onCheckedChange={(v) => updateUI({ sounds_enabled: v })}
    />
  );
}
