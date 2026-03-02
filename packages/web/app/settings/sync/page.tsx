"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Card } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Button } from "../../../components/ui/button";
import { Label } from "../../../components/ui/label";
import { useState } from "react";
import { GitBranch, Folder, Check, Search, Eye, EyeOff, ChevronDown } from "lucide-react";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu";
import { TeamIcon } from "../../../components/TeamIcon";

type TeamVisibility = "hidden" | "activity" | "summary" | "full";

const visibilityOptions: { value: TeamVisibility; label: string; description: string; preview: string }[] = [
  { value: "hidden", label: "Hidden", description: "Teammates see nothing", preview: "Your sessions won't appear in the team feed" },
  { value: "activity", label: "Activity", description: "Project name and session count", preview: "e.g. \"3 sessions in codecast today\"" },
  { value: "summary", label: "Summary", description: "Session title and bullet summary", preview: "e.g. \"Fix auth bug - Updated login flow, added error handling\"" },
  { value: "full", label: "Full", description: "Full conversation content", preview: "Teammates can read your complete session transcripts" },
];

export default function SyncPage() {
  const user = useQuery(api.users.getCurrentUser);
  const syncSettings = useQuery(api.users.getSyncSettings);
  const userTeams = useQuery(api.teams.getUserTeams);
  const projects = useQuery(api.users.getRecentProjectsWithGitInfo, { limit: 30 });
  const directoryMappings = useQuery(api.users.getDirectoryTeamMappings);
  const updateSyncSettings = useMutation(api.users.updateSyncSettings);
  const updateDirectoryMapping = useMutation(api.users.updateDirectoryTeamMapping);
  const removeDirectoryMapping = useMutation(api.users.removeDirectoryTeamMapping);
  const setTeamVisibility = useMutation(api.teams.setTeamVisibility);

  const [editMode, setEditMode] = useState(false);
  const [newProject, setNewProject] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  if (!user || !syncSettings) {
    return null;
  }

  const hasTeams = userTeams && userTeams.length > 0;
  const syncAll = syncSettings.sync_mode === "all";
  const syncProjects = syncSettings.sync_projects || [];

  const mappingsByPath = new Map(directoryMappings?.map(m => [m.path_prefix, m]) || []);

  const handleToggleSyncAll = async () => {
    await updateSyncSettings({
      sync_mode: syncAll ? "selected" : "all",
    });
  };

  const isSynced = (path: string): boolean => {
    return syncAll || syncProjects.includes(path);
  };

  const activeTeam = user?.active_team_id ? userTeams?.find(t => t?._id === user.active_team_id) || null : null;
  const teamSharePaths: string[] = (user as any)?.team_share_paths ?? [];

  const getTeamForProject = (path: string): { team: NonNullable<typeof userTeams>[number]; isDefault: boolean } | null => {
    const mapping = mappingsByPath.get(path);
    if (mapping?.team_id) {
      const team = userTeams?.find(t => t?._id === mapping.team_id);
      if (team) return { team, isDefault: false };
    }
    if (activeTeam && teamSharePaths.length > 0) {
      const matches = teamSharePaths.some(sp => path === sp || path.startsWith(sp + "/"));
      if (matches) return { team: activeTeam, isDefault: true };
    }
    return null;
  };

  const handleTeamChange = async (path: string, teamId: Id<"teams"> | null) => {
    if (teamId) {
      await updateDirectoryMapping({
        path_prefix: path,
        team_id: teamId,
        auto_share: true,
      });
    } else {
      const existingMapping = mappingsByPath.get(path);
      if (existingMapping) {
        await removeDirectoryMapping({ path_prefix: path });
      }
    }
  };

  const handleToggleProjectSync = async (path: string, shouldSync: boolean) => {
    if (shouldSync) {
      const newProjects = [...syncProjects, path];
      await updateSyncSettings({ sync_projects: newProjects });
    } else {
      const newProjects = syncProjects.filter(p => p !== path);
      await updateSyncSettings({ sync_projects: newProjects });
      const existingMapping = mappingsByPath.get(path);
      if (existingMapping) {
        await removeDirectoryMapping({ path_prefix: path });
      }
    }
  };

  const handleVisibilityChange = async (teamId: Id<"teams">, visibility: TeamVisibility) => {
    await setTeamVisibility({ team_id: teamId, visibility });
  };

  const handleAddProject = async () => {
    if (!newProject.trim()) return;
    const projectPath = newProject.trim();

    // When sync all is on, adding a path just creates a placeholder for team assignment
    // When sync all is off, it adds to the sync_projects list
    if (!syncAll) {
      if (syncProjects.includes(projectPath)) {
        setNewProject("");
        return;
      }
      const newProjects = [...syncProjects, projectPath];
      await updateSyncSettings({ sync_projects: newProjects });
    }
    setNewProject("");
  };

  const getProjectName = (path: string) => {
    const parts = path.split("/");
    return parts[parts.length - 1] || path;
  };

  const getRelativeTime = (timestamp: number) => {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(diff / 3600000);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(diff / 86400000);
    return `${days}d ago`;
  };

  // Merge recent projects with paths from team mappings and sync_projects
  const allProjects = (() => {
    const projectMap = new Map<string, { path: string; is_git_repo: boolean; session_count: number; last_active: number }>();

    // Add recent projects
    projects?.forEach(p => {
      projectMap.set(p.path, p);
    });

    // Add paths from team mappings that aren't in recent projects
    directoryMappings?.forEach(m => {
      if (!projectMap.has(m.path_prefix)) {
        projectMap.set(m.path_prefix, {
          path: m.path_prefix,
          is_git_repo: true, // Assume git repo for mapped paths
          session_count: 0,
          last_active: m.created_at,
        });
      }
    });

    // Add paths from sync_projects that aren't already present
    syncProjects.forEach(p => {
      if (!projectMap.has(p)) {
        projectMap.set(p, {
          path: p,
          is_git_repo: true,
          session_count: 0,
          last_active: 0,
        });
      }
    });

    const allPaths = Array.from(projectMap.values());

    // Filter out subdirectories of git repos - they should be controlled at the repo level
    const gitRepoPaths = allPaths.filter(p => p.is_git_repo).map(p => p.path);
    const filtered = allPaths.filter(project => {
      if (project.is_git_repo) return true;
      const isSubdirOfGitRepo = gitRepoPaths.some(repoPath =>
        project.path.startsWith(repoPath + "/")
      );
      return !isSubdirOfGitRepo;
    });

    return filtered.sort((a, b) => b.last_active - a.last_active);
  })();

  const filteredProjects = allProjects.filter(p => {
    if (!searchQuery) return true;
    const name = getProjectName(p.path).toLowerCase();
    const path = p.path.toLowerCase();
    const query = searchQuery.toLowerCase();
    return name.includes(query) || path.includes(query);
  });

  return (
    <div className="space-y-6">
      <Card className="p-6 bg-sol-bg border-sol-border">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-sol-text">Sync All Projects</h2>
            <p className="text-sm text-sol-base1 mt-1">
              {syncAll
                ? "All projects sync privately by default"
                : `Only ${syncProjects.length} selected project${syncProjects.length === 1 ? "" : "s"} will sync`
              }
            </p>
          </div>
          <button
            onClick={handleToggleSyncAll}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              syncAll ? "bg-sol-cyan" : "bg-sol-base02"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                syncAll ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>
      </Card>

      <Card className="p-6 bg-sol-bg border-sol-border">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-sol-text">Projects & Sharing</h2>
            <p className="text-sm text-sol-base1 mt-1">
              {hasTeams
                ? "Control which teams can see each project"
                : "Your recent projects"
              }
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => setEditMode(!editMode)}
            className="border-sol-border text-sol-base1"
          >
            {editMode ? "Done" : "+ Add Path"}
          </Button>
        </div>

        {hasTeams && (
          <div className="mb-4 space-y-2">
            {userTeams?.filter(Boolean).map((team) => {
              const currentVisibility = team!.visibility || "summary";
              const currentOption = visibilityOptions.find(o => o.value === currentVisibility);
              return (
                <div key={team!._id} className="px-3 py-2.5 rounded-lg border border-sol-border/40 bg-sol-bg-alt/50">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <TeamIcon icon={team!.icon} color={team!.icon_color} className="w-3.5 h-3.5" />
                      <span className="text-sm font-medium text-sol-text">{team!.name}</span>
                    </div>
                    <div className="flex gap-0.5 ml-auto">
                      {visibilityOptions.map((opt) => (
                        <button
                          key={opt.value}
                          onClick={() => handleVisibilityChange(team!._id, opt.value)}
                          title={currentVisibility === opt.value ? opt.description : `Switch to: ${opt.preview}`}
                          className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                            currentVisibility === opt.value
                              ? "bg-sol-cyan/15 text-sol-cyan border border-sol-cyan/30"
                              : "text-sol-base1 hover:text-sol-text hover:bg-sol-base02/40"
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {currentOption && (
                    <p className="text-xs text-sol-base1 mt-1.5">
                      {currentOption.description}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="flex gap-2 mb-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sol-base1" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search projects..."
              className="pl-9 bg-sol-bg-alt border-sol-border text-sol-text placeholder-sol-base1"
            />
          </div>
        </div>

        {editMode && (
          <div className="flex gap-2 mb-4 p-3 bg-sol-base02/30 rounded-lg">
            <Input
              type="text"
              value={newProject}
              onChange={(e) => setNewProject(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddProject()}
              placeholder="/path/to/project"
              className="flex-1 bg-sol-bg-alt border-sol-border text-sol-text placeholder-sol-base1"
            />
            <Button onClick={handleAddProject} className="bg-sol-cyan text-sol-bg hover:bg-sol-cyan/90">
              Add
            </Button>
          </div>
        )}

        <div className="space-y-2">
          {filteredProjects && filteredProjects.length > 0 ? (
            filteredProjects.map((project) => {
              const synced = isSynced(project.path);
              const teamResult = getTeamForProject(project.path);

              return (
                <div
                  key={project.path}
                  className={`flex items-center justify-between p-3 rounded-lg border transition-colors ${
                    synced
                      ? "bg-white border-sol-border/50 hover:border-sol-border"
                      : "bg-white/50 border-sol-border/30 opacity-60"
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    {project.is_git_repo ? (
                      <GitBranch className={`w-5 h-5 flex-shrink-0 ${synced ? "text-sol-cyan" : "text-sol-base1"}`} />
                    ) : (
                      <Folder className="w-5 h-5 text-sol-base1 flex-shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className={`font-medium truncate ${synced ? "text-sol-text" : "text-sol-base1"}`}>
                        {getProjectName(project.path)}
                      </div>
                      <div className="text-xs text-sol-base1 truncate">
                        {project.path}
                      </div>
                      <div className="text-xs text-sol-base1 mt-0.5">
                        {project.session_count} session{project.session_count !== 1 ? "s" : ""} &middot; {getRelativeTime(project.last_active)}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    {synced && hasTeams && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            className={`flex items-center gap-2 px-3 py-1.5 rounded-md border transition-colors text-sm min-w-[140px] justify-between ${
                              teamResult && !teamResult.isDefault
                                ? "border-sol-cyan bg-sol-cyan/15 text-sol-text"
                                : teamResult?.isDefault
                                  ? "border-sol-border/60 bg-sol-base02/15 text-sol-text"
                                  : "border-sol-border bg-sol-bg hover:bg-sol-base02/50 text-sol-text"
                            }`}
                          >
                            <span className="flex items-center gap-2">
                              {teamResult ? (
                                <>
                                  <Eye className="w-4 h-4" />
                                  <span>
                                    {teamResult.team.name}
                                    {teamResult.isDefault && (
                                      <span className="text-sol-base1 text-xs ml-0.5">(auto)</span>
                                    )}
                                  </span>
                                </>
                              ) : (
                                <>
                                  <EyeOff className="w-4 h-4" />
                                  <span>Only Me</span>
                                </>
                              )}
                            </span>
                            <ChevronDown className="w-3 h-3 opacity-50" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-[140px]">
                          <DropdownMenuItem
                            onClick={() => handleTeamChange(project.path, null)}
                            className={!teamResult || teamResult.isDefault ? "bg-sol-base02/30" : ""}
                          >
                            <EyeOff className="w-4 h-4 mr-2" />
                            Only Me
                          </DropdownMenuItem>
                          {userTeams?.filter(Boolean).map((t) => (
                            <DropdownMenuItem
                              key={t!._id}
                              onClick={() => handleTeamChange(project.path, t!._id)}
                              className={teamResult?.team?._id === t!._id && !teamResult.isDefault ? "bg-sol-base02/30" : ""}
                            >
                              <Eye className="w-4 h-4 mr-2" />
                              {t!.name}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}

                    {!syncAll && (
                      <button
                        onClick={() => handleToggleProjectSync(project.path, !synced)}
                        className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                          synced
                            ? "bg-sol-cyan border-sol-cyan"
                            : "border-sol-base1 hover:border-sol-cyan"
                        }`}
                      >
                        {synced && <Check className="w-3 h-3 text-sol-bg" />}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="text-center py-8 text-sol-base1">
              {searchQuery ? (
                <p>No projects matching &ldquo;{searchQuery}&rdquo;</p>
              ) : (
                <p>No recent projects found. Start a coding session to see your projects here.</p>
              )}
            </div>
          )}
        </div>
      </Card>

      <Card className="p-6 bg-sol-bg border-sol-border">
        <h2 className="text-lg font-semibold text-sol-text mb-4">CLI Management</h2>
        <div className="text-sm text-sol-base1 space-y-2">
          <p>Manage sync settings from the command line:</p>
          <div className="bg-sol-base03 p-3 rounded font-mono text-sm space-y-1">
            <p><span className="text-sol-cyan">codecast sync-settings</span> <span className="text-sol-base1">- Interactive project selection</span></p>
            {hasTeams && (
              <>
                <p><span className="text-sol-cyan">codecast teams</span> <span className="text-sol-base1">- List your teams</span></p>
                <p><span className="text-sol-cyan">codecast teams map &lt;path&gt; &lt;team_id&gt;</span> <span className="text-sol-base1">- Map directory to team</span></p>
                <p><span className="text-sol-cyan">codecast teams mappings</span> <span className="text-sol-base1">- List directory mappings</span></p>
              </>
            )}
          </div>
          <p className="mt-3">
            Changes sync to your daemon on the next cycle.
          </p>
        </div>
      </Card>
    </div>
  );
}
