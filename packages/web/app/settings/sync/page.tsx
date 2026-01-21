"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Card } from "../../../components/ui/card";
import { Label } from "../../../components/ui/label";
import { useState, useEffect } from "react";

export default function SyncPage() {
  const user = useQuery(api.users.getCurrentUser);
  const syncSettings = useQuery(api.users.getSyncSettings);
  const updateSyncSettings = useMutation(api.users.updateSyncSettings);
  const [editMode, setEditMode] = useState(false);
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const [newProject, setNewProject] = useState("");

  useEffect(() => {
    if (syncSettings?.sync_projects) {
      setSelectedProjects(syncSettings.sync_projects);
    }
  }, [syncSettings?.sync_projects]);

  if (!user || !syncSettings) {
    return null;
  }

  const handleToggleSyncMode = async () => {
    const newMode = syncSettings.sync_mode === "all" ? "selected" : "all";
    await updateSyncSettings({
      sync_mode: newMode,
      sync_projects: newMode === "all" ? [] : selectedProjects,
    });
  };

  const handleRemoveProject = async (projectPath: string) => {
    const newProjects = selectedProjects.filter(p => p !== projectPath);
    setSelectedProjects(newProjects);
    await updateSyncSettings({
      sync_mode: "selected",
      sync_projects: newProjects,
    });
  };

  const handleAddProject = async () => {
    if (!newProject.trim()) return;
    const projectPath = newProject.trim();
    if (selectedProjects.includes(projectPath)) {
      setNewProject("");
      return;
    }
    const newProjects = [...selectedProjects, projectPath];
    setSelectedProjects(newProjects);
    setNewProject("");
    await updateSyncSettings({
      sync_mode: "selected",
      sync_projects: newProjects,
    });
  };

  return (
    <div className="space-y-6">
      <Card className="p-6 bg-sol-bg border-sol-border">
        <h2 className="text-lg font-semibold text-sol-text mb-4">Sync Settings</h2>
        <div className="space-y-3">
          <div className="flex items-center justify-between py-3 border-b border-sol-border">
            <div>
              <Label className="text-sol-text font-medium">Sync Mode</Label>
              <div className="text-sm text-sol-base1">
                {syncSettings.sync_mode === "all"
                  ? "Syncing all projects from your machine"
                  : `Syncing ${selectedProjects.length} selected project${selectedProjects.length === 1 ? "" : "s"}`
                }
              </div>
            </div>
            <button
              onClick={handleToggleSyncMode}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                syncSettings.sync_mode === "all" ? "bg-sol-cyan" : "bg-sol-base02"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  syncSettings.sync_mode === "all" ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>
          <div className="py-3">
            <div className="flex items-center justify-between mb-2">
              <Label className="text-sol-text font-medium">
                {syncSettings.sync_mode === "all" ? "Sync All Projects" : "Selected Projects"}
              </Label>
              {syncSettings.sync_mode === "selected" && (
                <button
                  onClick={() => setEditMode(!editMode)}
                  className="text-sm text-sol-cyan hover:text-sol-cyan/80"
                >
                  {editMode ? "Done" : "Edit"}
                </button>
              )}
            </div>
            {syncSettings.sync_mode === "all" ? (
              <div className="text-sm text-sol-base1">
                All Claude Code sessions from your machine are being synced to codecast.
                Toggle off to select specific projects.
              </div>
            ) : (
              <div className="space-y-2">
                {selectedProjects.length === 0 ? (
                  <div className="text-sm text-sol-base1">
                    No projects selected. Add projects below or use the CLI: <code className="bg-sol-base03 px-1 rounded">codecast sync-settings</code>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {selectedProjects.map(projectPath => (
                      <div key={projectPath} className="flex items-center justify-between py-1.5 px-3 bg-sol-base02 rounded border border-sol-border">
                        <span className="text-sm text-sol-base1 font-mono truncate">{projectPath}</span>
                        {editMode && (
                          <button
                            onClick={() => handleRemoveProject(projectPath)}
                            className="text-sol-red hover:text-sol-red/80 ml-2"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {editMode && (
                  <div className="flex gap-2 mt-3">
                    <input
                      type="text"
                      value={newProject}
                      onChange={(e) => setNewProject(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleAddProject()}
                      placeholder="/path/to/project"
                      className="flex-1 px-3 py-1.5 bg-sol-base03 border border-sol-border rounded text-sm text-sol-text placeholder-sol-base1"
                    />
                    <button
                      onClick={handleAddProject}
                      className="px-3 py-1.5 bg-sol-cyan text-sol-bg rounded text-sm font-medium hover:bg-sol-cyan/90"
                    >
                      Add
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </Card>
      <Card className="p-6 bg-sol-bg border-sol-border">
        <h2 className="text-lg font-semibold text-sol-text mb-4">CLI Management</h2>
        <div className="text-sm text-sol-base1 space-y-2">
          <p>You can also manage sync settings from the command line:</p>
          <div className="bg-sol-base03 p-3 rounded font-mono text-sm space-y-1">
            <p><span className="text-sol-cyan">codecast sync-settings</span> - Interactive project selection</p>
            <p><span className="text-sol-cyan">codecast sync-settings --all</span> - Sync all projects</p>
            <p><span className="text-sol-cyan">codecast sync-settings --show</span> - View current settings</p>
          </div>
          <p className="mt-3">
            Changes made here or in the CLI will apply to your daemon on the next sync cycle.
          </p>
        </div>
      </Card>
    </div>
  );
}
