"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Card } from "../../../components/ui/card";
import { Label } from "../../../components/ui/label";
import { encodeBase64 } from "@codecast/shared/encryption";
import { useState } from "react";

type ActivityVisibility = "detailed" | "summary" | "minimal" | "hidden";

const visibilityOptions: { value: ActivityVisibility; label: string; description: string }[] = [
  { value: "detailed", label: "Detailed", description: "Title + bullet summary" },
  { value: "summary", label: "Summary", description: "e.g. \"Worked in codecast for 4h\"" },
  { value: "minimal", label: "Minimal", description: "e.g. \"3 agents in codecast\"" },
  { value: "hidden", label: "Hidden", description: "No activity visible" },
];

export default function PrivacyPage() {
  const user = useQuery(api.users.getCurrentUser);
  const updatePrivacySettings = useMutation(api.users.updatePrivacySettings);
  const teamSharePaths = useQuery(api.users.getTeamSharePaths);
  const updateTeamSharePaths = useMutation(api.users.updateTeamSharePaths);
  const recentProjects = useQuery(api.users.getRecentProjectPaths, { limit: 5 });
  const [newPath, setNewPath] = useState("");

  if (!user) {
    return null;
  }

  const handleActivityVisibilityChange = async (value: ActivityVisibility) => {
    await updatePrivacySettings({ activity_visibility: value });
  };

  const handleToggleEncryption = async () => {
    if (!user.encryption_enabled) {
      const masterKey = crypto.getRandomValues(new Uint8Array(32));
      const masterKeyBase64 = encodeBase64(masterKey);
      await updatePrivacySettings({
        encryption_enabled: true,
        encryption_master_key: masterKeyBase64,
      });
    } else {
      await updatePrivacySettings({
        encryption_enabled: false,
      });
    }
  };

  const handleAddPath = async () => {
    if (!newPath.trim()) return;
    const currentPaths = teamSharePaths || [];
    if (currentPaths.includes(newPath.trim())) return;
    await updateTeamSharePaths({ team_share_paths: [...currentPaths, newPath.trim()] });
    setNewPath("");
  };

  const handleRemovePath = async (path: string) => {
    const currentPaths = teamSharePaths || [];
    await updateTeamSharePaths({ team_share_paths: currentPaths.filter(p => p !== path) });
  };

  const handleAddRecentProject = async (path: string) => {
    const currentPaths = teamSharePaths || [];
    if (currentPaths.includes(path)) return;
    await updateTeamSharePaths({ team_share_paths: [...currentPaths, path] });
  };

  const currentVisibility = user.activity_visibility || "detailed";

  return (
    <div className="space-y-6">
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

          <div className="flex items-center justify-between py-3 border-t border-sol-border">
            <div>
              <Label className="text-sol-text font-medium">Activity Visibility</Label>
              <div className="text-sm text-sol-base1">
                What teammates see for your private conversations
              </div>
            </div>
            <select
              value={currentVisibility}
              onChange={(e) => handleActivityVisibilityChange(e.target.value as ActivityVisibility)}
              className="px-3 py-1.5 rounded-lg bg-sol-bg-alt border border-sol-border text-sol-text text-sm focus:outline-none focus:ring-2 focus:ring-sol-cyan/50"
            >
              {visibilityOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="pl-4 py-2 text-xs text-sol-text-muted border-l-2 border-sol-border/50">
            {visibilityOptions.find(o => o.value === currentVisibility)?.description}
            {currentVisibility !== "hidden" && (
              <span className="block mt-1 text-sol-text-dim">
                Shared conversations are always fully visible to teammates.
              </span>
            )}
          </div>

          <div className="flex items-center justify-between py-3 border-t border-sol-border">
            <div>
              <Label className="text-sol-text font-medium">End-to-End Encryption (Enterprise)</Label>
              <div className="text-sm text-sol-base1">
                Encrypt all conversation data client-side before syncing to server
              </div>
            </div>
            <button
              onClick={handleToggleEncryption}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                user.encryption_enabled ? "bg-sol-cyan" : "bg-sol-base02"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  user.encryption_enabled ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>
        </div>
      </Card>

      {user.team_id && (
        <Card className="p-6 bg-sol-bg border-sol-border">
          <h2 className="text-lg font-semibold text-sol-text mb-4">Auto-Share Folders</h2>
          <p className="text-sm text-sol-base1 mb-4">
            New conversations in these folders will be automatically shared with your team.
          </p>

          {teamSharePaths && teamSharePaths.length > 0 && (
            <div className="space-y-2 mb-4">
              {teamSharePaths.map((path) => (
                <div
                  key={path}
                  className="flex items-center justify-between px-3 py-2 bg-sol-bg-alt rounded-lg border border-sol-border"
                >
                  <span className="text-sm text-sol-text font-mono truncate">{path}</span>
                  <button
                    onClick={() => handleRemovePath(path)}
                    className="text-sol-text-muted hover:text-red-400 transition-colors ml-2"
                    title="Remove"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2 mb-4">
            <input
              type="text"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddPath()}
              placeholder="/Users/you/src/project"
              className="flex-1 px-3 py-2 bg-sol-bg-alt border border-sol-border rounded-lg text-sol-text text-sm placeholder:text-sol-text-dim focus:outline-none focus:ring-2 focus:ring-sol-cyan/50"
            />
            <button
              onClick={handleAddPath}
              disabled={!newPath.trim()}
              className="px-4 py-2 bg-sol-cyan text-sol-bg rounded-lg text-sm font-medium hover:bg-sol-cyan/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Add
            </button>
          </div>

          {recentProjects && recentProjects.length > 0 && (
            <div>
              <div className="text-xs text-sol-text-muted mb-2">Recent projects:</div>
              <div className="flex flex-wrap gap-2">
                {recentProjects
                  .filter(p => !teamSharePaths?.includes(p.path))
                  .slice(0, 5)
                  .map((project) => (
                    <button
                      key={project.path}
                      onClick={() => handleAddRecentProject(project.path)}
                      className="px-2 py-1 text-xs bg-sol-bg-alt border border-sol-border rounded hover:border-sol-cyan/50 text-sol-text-muted hover:text-sol-text transition-colors"
                      title={project.path}
                    >
                      {project.path.split('/').pop()}
                    </button>
                  ))}
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
