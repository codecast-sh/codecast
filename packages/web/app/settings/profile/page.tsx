import { useEffect, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { isDesktop, getAppVersion, checkDesktopUpdate } from "../../../lib/desktop";
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
        <h2 className="text-lg font-semibold text-sol-text mb-4">Preferences</h2>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sol-base1">Sound effects</span>
              <p className="text-xs text-sol-base01 mt-0.5">Play sounds for session events</p>
            </div>
            <SoundsToggle />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sol-base1">Model badge</span>
              <p className="text-xs text-sol-base01 mt-0.5">Show each session's model in the inbox session list</p>
            </div>
            <ModelBadgeToggle />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sol-base1">Comments</span>
              <p className="text-xs text-sol-base01 mt-0.5">Show the tools to leave comments on conversations. You can always read and reply to comments others leave, even with this off.</p>
            </div>
            <CommentsToggle />
          </div>
          <DesktopVersionRow />
          <DesktopLinksRow />
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

      <PublicProfileSection user={user} />
    </div>
  );
}

// Shows the running desktop app's version + whether an update is waiting. The
// "Update now" action lives in the global banner (DesktopProvider); here it's a
// passive at-a-glance readout so you can always see what version you're on.
function DesktopVersionRow() {
  const [current, setCurrent] = useState<string | null>(null);
  const [update, setUpdate] = useState<{ current: string; latest: string } | null>(null);
  useEffect(() => {
    if (!isDesktop()) return;
    getAppVersion().then(setCurrent);
    checkDesktopUpdate().then(setUpdate);
  }, []);
  if (!isDesktop() || !current) return null;
  return (
    <div className="flex items-center justify-between">
      <div>
        <span className="text-sol-base1">Desktop app</span>
        <p className="text-xs text-sol-base01 mt-0.5">
          {update ? `Version ${current} — v${update.latest} available` : `Version ${current} — up to date`}
        </p>
      </div>
      {update && (
        <span className="text-[11px] rounded-md bg-sol-cyan/15 text-sol-cyan px-2 py-0.5">Update available</span>
      )}
    </div>
  );
}

// Inverse of the sticky "Always open Codecast links in browser" opt-out from
// OpenInDesktopHandoff — this is the only place to turn the handoff back on.
function DesktopLinksRow() {
  const hasUsedDesktop = useInboxStore((s) => s.clientState?.dismissed?.has_used_desktop === true);
  const preferBrowser = useInboxStore((s) => s.clientState?.dismissed?.prefer_browser_links === true);
  const updateDismissed = useInboxStore((s) => s.updateClientDismissed);
  if (!hasUsedDesktop) return null;
  return (
    <div className="flex items-center justify-between">
      <div>
        <span className="text-sol-base1">Open links in desktop app</span>
        <p className="text-xs text-sol-base01 mt-0.5">Hand off codecast.sh pages from the browser to the desktop app</p>
      </div>
      <Switch
        checked={!preferBrowser}
        onCheckedChange={(v) => updateDismissed("prefer_browser_links", !v)}
      />
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

function ModelBadgeToggle() {
  const enabled = useInboxStore((s) => s.clientState?.ui?.show_model_badge === true);
  const updateUI = useInboxStore((s) => s.updateClientUI);
  return (
    <Switch
      checked={enabled}
      onCheckedChange={(v) => updateUI({ show_model_badge: v })}
    />
  );
}

function CommentsToggle() {
  const enabled = useInboxStore((s) => s.clientState?.ui?.comments_enabled === true);
  const updateUI = useInboxStore((s) => s.updateClientUI);
  return (
    <Switch
      checked={enabled}
      onCheckedChange={(v) => updateUI({ comments_enabled: v })}
    />
  );
}

// Claim a handle + flip the master public-profile switch. The handle is the
// public URL, so enabling is gated on having claimed one (the mutation enforces
// this too). Availability is checked live as you type via isUsernameAvailable.
function PublicProfileSection({ user }: { user: any }) {
  const claimUsername = useMutation(api.users.claimUsername);
  const setEnabled = useMutation(api.users.setPublicProfileEnabled);

  const [handle, setHandle] = useState<string>(user.username || "");
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = handle.trim().toLowerCase();
  const dirty = trimmed !== (user.username || "");
  // Only probe availability for a changed, non-trivial candidate.
  const check = useQuery(
    api.users.isUsernameAvailable,
    dirty && trimmed.length >= 3 ? { username: trimmed } : "skip"
  );
  const suggestion = user.github_username && !user.username ? user.github_username.toLowerCase() : null;

  const handleClaim = async () => {
    setClaiming(true);
    setError(null);
    try {
      await claimUsername({ username: trimmed });
    } catch (e: any) {
      setError(e?.message?.replace(/^.*Error:\s*/, "") || "Could not claim username");
    } finally {
      setClaiming(false);
    }
  };

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const canEnable = !!user.username;

  return (
    <Card className="p-6 bg-sol-bg border-sol-border">
      <div className="flex items-start justify-between mb-1">
        <h2 className="text-lg font-semibold text-sol-text">Public profile</h2>
        <Switch
          checked={!!user.public_profile_enabled}
          disabled={!canEnable}
          onCheckedChange={(v) => setEnabled({ enabled: v }).catch(() => {})}
        />
      </div>
      <p className="text-xs text-sol-base01 mb-4 max-w-prose">
        When on, anyone can view <span className="font-mono">{origin}/{user.username || "your-handle"}</span> —
        your identity, an anonymized activity graph, and the sessions you’ve pinned. Off by default; nothing is
        public until you turn this on.
      </p>

      <div className="space-y-2">
        <Label htmlFor="handle" className="text-sol-base1">Username</Label>
        <div className="flex items-center gap-2">
          <div className="flex items-center flex-1 rounded-md border border-sol-border bg-sol-bg-alt px-2">
            <span className="text-sol-base01 text-sm select-none">/</span>
            <Input
              id="handle"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              placeholder={suggestion || "your-handle"}
              className="border-0 bg-transparent px-1 focus-visible:ring-0"
              autoCapitalize="none"
              spellCheck={false}
            />
          </div>
          <Button
            onClick={handleClaim}
            disabled={!dirty || claiming || trimmed.length < 3 || (check && !check.available)}
            className="bg-sol-cyan hover:bg-sol-cyan/80 text-sol-base03"
          >
            {claiming ? "Saving..." : user.username ? "Update" : "Claim"}
          </Button>
        </div>

        {/* Live status line */}
        <div className="text-xs min-h-[1rem]">
          {error ? (
            <span className="text-sol-red">{error}</span>
          ) : suggestion && !user.username && !dirty ? (
            <button onClick={() => setHandle(suggestion)} className="text-sol-cyan hover:underline">
              Use @{suggestion} from GitHub
            </button>
          ) : dirty && trimmed.length >= 3 && check ? (
            check.available ? (
              <span className="text-sol-green">@{trimmed} is available</span>
            ) : (
              <span className="text-sol-orange">{check.reason}</span>
            )
          ) : user.username ? (
            <span className="text-sol-base01">
              Your profile lives at{" "}
              <a href={`/${user.username}`} target="_blank" rel="noreferrer" className="text-sol-cyan hover:underline">
                /{user.username}
              </a>
            </span>
          ) : null}
        </div>
      </div>

      {!canEnable && (
        <p className="text-xs text-sol-base01 mt-3">Claim a username to enable your public profile.</p>
      )}
    </Card>
  );
}

