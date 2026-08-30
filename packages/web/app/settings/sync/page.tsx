import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Input } from "../../../components/ui/input";
import { Button } from "../../../components/ui/button";
import { Switch } from "../../../components/ui/switch";
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  GitBranch, Folder, FolderGit2, Search, Eye, EyeOff, ChevronDown, AlertTriangle, RefreshCw, Terminal,
} from "lucide-react";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../../../components/ui/dialog";
import { TeamIcon } from "../../../components/TeamIcon";
import { SettingsOptionGroup, SettingsPanel, SettingsRow, SettingsSection } from "../../../components/settings/ui";

type TeamVisibility = "hidden" | "activity" | "summary" | "full";
type UserTeam = {
  _id: Id<"teams">;
  name: string;
  icon?: string | null;
  icon_color?: string | null;
  role?: string;
  visibility?: TeamVisibility;
};
type DirectoryMapping = {
  _id?: string;
  path_prefix: string;
  team_id: Id<"teams">;
  team_name?: string;
  auto_share: boolean;
  created_at?: number;
};
type SyncProject = {
  path: string;
  is_git_repo: boolean;
  session_count: number;
  last_active: number;
  git_remote_url?: string | null;
  team_id?: Id<"teams"> | null;
  auto_share?: boolean;
};

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
  const projects = useQuery(api.users.getRecentProjectsWithGitInfo, { limit: 100 });
  const directoryMappings = useQuery(api.users.getDirectoryTeamMappings);
  const updateSyncSettings = useMutation(api.users.updateSyncSettings);
  const updateDirectoryMapping = useMutation(api.users.updateDirectoryTeamMapping);
  const removeDirectoryMapping = useMutation(api.users.removeDirectoryTeamMapping);
  const deleteConversationsForPath = useMutation(api.users.deleteConversationsForPath);
  const setTeamVisibility = useMutation(api.teams.setTeamVisibility);

  const [editMode, setEditMode] = useState(false);
  const [newProject, setNewProject] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [isUnsyncing, setIsUnsyncing] = useState(false);
  const unsyncingRef = useRef(false);
  const [pendingUnsync, setPendingUnsync] = useState<{
    path: string;
    sessionCount: number;
    action: "unsync" | "remove_team";
  } | null>(null);

  const hasTeams = userTeams && userTeams.length > 0;
  const syncAll = syncSettings?.sync_mode === "all";
  const syncProjects = syncSettings?.sync_projects || [];
  const teams = (userTeams?.filter(Boolean) ?? []) as UserTeam[];
  const mappings = (directoryMappings ?? []) as DirectoryMapping[];
  const recentProjects = (projects ?? []) as SyncProject[];

  const mappingsByPath = new Map<string, DirectoryMapping>(mappings.map((mapping) => [mapping.path_prefix, mapping]));

  const handleToggleSyncAll = async () => {
    if (syncAll) {
      await updateSyncSettings({
        sync_mode: "selected",
        sync_projects: allProjects.map(p => p.path),
      });
    } else {
      await updateSyncSettings({ sync_mode: "all" });
    }
  };

  const isSynced = (path: string): boolean => {
    return syncAll || syncProjects.includes(path);
  };

  const activeTeam = user?.active_team_id ? teams.find((team) => team._id === user.active_team_id) || null : null;
  const teamSharePaths: string[] = (user as any)?.team_share_paths ?? [];

  if (!user || !syncSettings) {
    return null;
  }

  const getTeamForProject = (path: string): { team: UserTeam; isDefault: boolean } | null => {
    const mapping = mappingsByPath.get(path);
    if (mapping?.team_id) {
      const team = teams.find((team) => team._id === mapping.team_id);
      if (team) return { team, isDefault: false };
    }
    if (activeTeam && teamSharePaths.length > 0) {
      const matches = teamSharePaths.some(sp => path === sp || path.startsWith(sp + "/"));
      if (matches) return { team: activeTeam, isDefault: true };
    }
    return null;
  };

  const getSessionCountForPath = (path: string): number => {
    const project = allProjects.find(p => p.path === path);
    return project?.session_count ?? 0;
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
        const count = getSessionCountForPath(path);
        if (count > 0) {
          setPendingUnsync({ path, sessionCount: count, action: "remove_team" });
          return;
        }
        await removeDirectoryMapping({ path_prefix: path });
      }
    }
  };

  const handleToggleProjectSync = async (path: string, shouldSync: boolean) => {
    if (shouldSync) {
      const newProjects = [...syncProjects, path];
      await updateSyncSettings({ sync_projects: newProjects });
    } else {
      const count = getSessionCountForPath(path);
      if (count > 0) {
        setPendingUnsync({ path, sessionCount: count, action: "unsync" });
        return;
      }
      const newProjects = syncProjects.filter((projectPath: string) => projectPath !== path);
      await updateSyncSettings({ sync_projects: newProjects });
      const existingMapping = mappingsByPath.get(path);
      if (existingMapping) {
        await removeDirectoryMapping({ path_prefix: path });
      }
    }
  };

  const executeUnsync = async (deleteConversations: boolean) => {
    if (!pendingUnsync || unsyncingRef.current) return;
    const { path, action } = pendingUnsync;

    unsyncingRef.current = true;
    setIsUnsyncing(true);
    try {
      if (action === "unsync") {
        const newProjects = syncProjects.filter((projectPath: string) => projectPath !== path);
        await updateSyncSettings({ sync_projects: newProjects });
        const existingMapping = mappingsByPath.get(path);
        if (existingMapping) {
          const first = await removeDirectoryMapping({ path_prefix: path, delete_conversations: deleteConversations });
          let hasMore = first?.hasMore;
          while (hasMore) {
            const next = await deleteConversationsForPath({ path_prefix: path });
            hasMore = next?.hasMore;
          }
        } else if (deleteConversations) {
          let hasMore = true;
          while (hasMore) {
            const next = await deleteConversationsForPath({ path_prefix: path });
            hasMore = next?.hasMore ?? false;
          }
        }
      } else {
        const first = await removeDirectoryMapping({ path_prefix: path, delete_conversations: deleteConversations });
        let hasMore = first?.hasMore;
        while (hasMore) {
          const next = await deleteConversationsForPath({ path_prefix: path });
          hasMore = next?.hasMore;
        }
      }
      setPendingUnsync(null);
    } catch (err) {
      console.error("Failed to unsync project:", err);
      toast.error("Failed to remove sync. The project may have too many conversations to delete at once.");
    } finally {
      unsyncingRef.current = false;
      setIsUnsyncing(false);
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

  const prettyPath = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+/, "~");

  const getRelativeTime = (timestamp: number) => {
    if (!timestamp) return "no sessions yet";
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(diff / 3600000);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(diff / 86400000);
    return `${days}d ago`;
  };

  // Merge recent projects with paths from team mappings and sync_projects
  const allProjects = (() => {
    const projectMap = new Map<string, SyncProject>();

    recentProjects.forEach((project: SyncProject) => {
      projectMap.set(project.path, project);
    });

    mappings.forEach((mapping: DirectoryMapping) => {
      if (!projectMap.has(mapping.path_prefix)) {
        projectMap.set(mapping.path_prefix, {
          path: mapping.path_prefix,
          is_git_repo: true,
          session_count: 0,
          last_active: mapping.created_at ?? 0,
        });
      }
    });

    // Add paths from sync_projects that aren't already present
    syncProjects.forEach((projectPath: string) => {
      if (!projectMap.has(projectPath)) {
        projectMap.set(projectPath, {
          path: projectPath,
          is_git_repo: true,
          session_count: 0,
          last_active: 0,
        });
      }
    });

    const allPaths = Array.from(projectMap.values());

    // Filter out subdirectories of git repos - they should be controlled at the repo level
    const gitRepoPaths = allPaths.filter((project) => project.is_git_repo).map((project) => project.path);
    const filtered = allPaths.filter((project) => {
      if (project.is_git_repo) return true;
      const isSubdirOfGitRepo = gitRepoPaths.some((repoPath) =>
        project.path.startsWith(repoPath + "/")
      );
      return !isSubdirOfGitRepo;
    });

    return filtered.sort((a, b) => b.last_active - a.last_active);
  })();

  const filteredProjects = allProjects.filter((project) => {
    if (!searchQuery) return true;
    const name = getProjectName(project.path).toLowerCase();
    const path = project.path.toLowerCase();
    const query = searchQuery.toLowerCase();
    return name.includes(query) || path.includes(query);
  });

  // Group by effective state so the list answers "what am I sharing?" at a glance.
  const projectGroups = (() => {
    const shared: SyncProject[] = [];
    const privateSynced: SyncProject[] = [];
    const notSyncing: SyncProject[] = [];
    filteredProjects.forEach((project) => {
      if (!isSynced(project.path)) notSyncing.push(project);
      else if (getTeamForProject(project.path)) shared.push(project);
      else privateSynced.push(project);
    });
    return [
      { key: "shared", label: "Shared with a team", items: shared },
      { key: "private", label: hasTeams ? "Private — only you" : "Syncing", items: privateSynced },
      { key: "off", label: "Not syncing", items: notSyncing },
    ].filter((group) => group.items.length > 0);
  })();

  return (
    <SettingsPanel>
      <SettingsSection title="Sync" icon={RefreshCw}>
        <SettingsRow
          label="Sync all projects"
          description={
            syncAll
              ? "Sessions from every project upload to your workspace. They stay private to you unless you share them."
              : `Only ${syncProjects.length} chosen project${syncProjects.length === 1 ? "" : "s"} upload${syncProjects.length === 1 ? "s" : ""} sessions — pick them in the list below.`
          }
        >
          <Switch checked={syncAll} onCheckedChange={handleToggleSyncAll} aria-label="Sync all projects" />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Projects & sharing"
        icon={FolderGit2}
        description={
          hasTeams
            ? "Synced projects stay private to you until you share one with a team."
            : "Projects whose sessions sync to your workspace."
        }
        actions={
          <Button variant="outline" size="sm" onClick={() => setEditMode(!editMode)}>
            {editMode ? "Done" : "+ Add path"}
          </Button>
        }
        padded
      >
        <div className="mb-4 flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-sol-text-dim" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search projects..."
              className="bg-sol-bg border-sol-border pl-9 text-sol-text"
            />
          </div>
        </div>

        {editMode && (
          <div className="mb-4 flex gap-2 rounded-lg bg-sol-bg-highlight/30 p-3">
            <Input
              type="text"
              value={newProject}
              onChange={(e) => setNewProject(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddProject()}
              placeholder="/path/to/project"
              className="flex-1 bg-sol-bg border-sol-border text-sol-text"
            />
            <Button onClick={handleAddProject} variant="cyan">
              Add
            </Button>
          </div>
        )}

        {projectGroups.length > 0 ? (
          <div className="space-y-4">
            {projectGroups.map((group) => (
              <div key={group.key}>
                {projectGroups.length > 1 && (
                  <div className="mb-1.5 flex items-baseline gap-1.5 px-1">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-sol-text-dim">
                      {group.label}
                    </span>
                    <span className="text-[10px] text-sol-text-dim/70">{group.items.length}</span>
                  </div>
                )}
                <div className="space-y-1.5">
                  {group.items.map((project) => {
                    const synced = isSynced(project.path);
                    const teamResult = getTeamForProject(project.path);

                    return (
                      <div
                        key={project.path}
                        className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                          synced
                            ? "border-sol-border/50 bg-sol-bg/40 hover:border-sol-border"
                            : "border-sol-border/30 bg-sol-bg/20 opacity-60"
                        }`}
                      >
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                          {project.is_git_repo ? (
                            <GitBranch className={`h-4 w-4 flex-shrink-0 ${synced ? "text-sol-cyan" : "text-sol-text-dim"}`} />
                          ) : (
                            <Folder className="h-4 w-4 flex-shrink-0 text-sol-text-dim" />
                          )}
                          <div className="min-w-0">
                            <div className={`truncate text-sm font-medium ${synced ? "text-sol-text" : "text-sol-text-muted"}`}>
                              {getProjectName(project.path)}
                            </div>
                            <div className="flex items-center gap-1.5 text-xs">
                              <span className="truncate font-mono text-[11px] text-sol-text-muted">
                                {prettyPath(project.path)}
                              </span>
                              <span className="flex-shrink-0 text-sol-text-dim">
                                · {project.session_count > 0
                                  ? `${project.session_count} session${project.session_count === 1 ? "" : "s"} · ${getRelativeTime(project.last_active)}`
                                  : "no sessions yet"}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-shrink-0 items-center gap-3">
                          {synced && hasTeams && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button
                                  type="button"
                                  className={`flex min-w-[140px] items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors ${
                                    teamResult && !teamResult.isDefault
                                      ? "border-sol-cyan bg-sol-cyan/10 text-sol-text"
                                      : teamResult?.isDefault
                                        ? "border-sol-border/60 bg-sol-bg-highlight/20 text-sol-text"
                                        : "border-sol-border bg-sol-bg text-sol-text-muted hover:bg-sol-bg-highlight/40 hover:text-sol-text"
                                  }`}
                                >
                                  <span className="flex items-center gap-2">
                                    {teamResult ? (
                                      <>
                                        <Eye className="h-4 w-4" />
                                        <span>
                                          {teamResult.team.name}
                                          {teamResult.isDefault && (
                                            <span
                                              className="ml-0.5 text-xs text-sol-text-muted"
                                              title="Shared automatically via your team's share paths"
                                            >
                                              (auto)
                                            </span>
                                          )}
                                        </span>
                                      </>
                                    ) : (
                                      <>
                                        <EyeOff className="h-4 w-4" />
                                        <span>Only me</span>
                                      </>
                                    )}
                                  </span>
                                  <ChevronDown className="h-3 w-3 opacity-50" />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="min-w-[200px]">
                                <DropdownMenuItem
                                  onClick={() => handleTeamChange(project.path, null)}
                                  className={!teamResult || teamResult.isDefault ? "bg-sol-bg-highlight/40" : ""}
                                >
                                  <EyeOff className="mr-2 h-4 w-4" />
                                  <span className="flex-1">Only me</span>
                                  <span className="ml-3 text-xs text-sol-text-dim">private</span>
                                </DropdownMenuItem>
                                {teams.map((team) => (
                                  <DropdownMenuItem
                                    key={team._id}
                                    onClick={() => handleTeamChange(project.path, team._id)}
                                    className={teamResult?.team?._id === team._id && !teamResult?.isDefault ? "bg-sol-bg-highlight/40" : ""}
                                  >
                                    <Eye className="mr-2 h-4 w-4" />
                                    <span className="flex-1">{team.name}</span>
                                    <span className="ml-3 text-xs capitalize text-sol-text-dim">
                                      {team.visibility || "summary"}
                                    </span>
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}

                          {!syncAll && (
                            <Switch
                              checked={synced}
                              onCheckedChange={(v) => handleToggleProjectSync(project.path, v)}
                              aria-label={`Sync ${getProjectName(project.path)}`}
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="py-8 text-center text-sm text-sol-text-muted">
            {searchQuery ? (
              <p>No projects matching &ldquo;{searchQuery}&rdquo;</p>
            ) : (
              <p>No recent projects found. Start a coding session to see your projects here.</p>
            )}
          </div>
        )}
      </SettingsSection>

      {hasTeams && (
        <SettingsSection
          title="Team visibility"
          icon={Eye}
          description="How much detail teammates see across the projects you share with each team."
        >
          {teams.map((team) => {
            const currentVisibility = team.visibility || "summary";
            const currentOption = visibilityOptions.find((option) => option.value === currentVisibility);
            return (
              <SettingsRow
                key={team._id}
                label={
                  <span className="flex items-center gap-1.5">
                    <TeamIcon icon={team.icon} color={team.icon_color} className="h-3.5 w-3.5" />
                    {team.name}
                  </span>
                }
                description={currentOption?.description}
              >
                <SettingsOptionGroup
                  label={`What ${team.name} sees`}
                  variant="pill"
                  value={currentVisibility}
                  onChange={(v) => handleVisibilityChange(team._id, v as TeamVisibility)}
                  options={visibilityOptions.map((opt) => ({
                    value: opt.value,
                    label: opt.label,
                    title: currentVisibility === opt.value ? opt.description : `Switch to: ${opt.preview}`,
                  }))}
                />
              </SettingsRow>
            );
          })}
        </SettingsSection>
      )}

      <SettingsSection
        title="CLI"
        icon={Terminal}
        description="Manage sync settings from the command line. Changes sync to your daemon on the next cycle."
        padded
      >
        <div className="space-y-1 rounded-lg border border-sol-border/60 bg-sol-bg p-3 font-mono text-sm">
          <p><span className="text-sol-cyan">cast sync-settings</span> <span className="text-sol-text-muted">- Interactive project selection</span></p>
          {hasTeams && (
            <>
              <p><span className="text-sol-cyan">cast teams</span> <span className="text-sol-text-muted">- List your teams</span></p>
              <p><span className="text-sol-cyan">cast teams map &lt;path&gt; &lt;team_id&gt;</span> <span className="text-sol-text-muted">- Map directory to team</span></p>
              <p><span className="text-sol-cyan">cast teams mappings</span> <span className="text-sol-text-muted">- List directory mappings</span></p>
            </>
          )}
        </div>
      </SettingsSection>

      <Dialog open={!!pendingUnsync} onOpenChange={(open) => !open && setPendingUnsync(null)}>
        <DialogContent className="bg-sol-bg border-sol-border">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sol-text">
              <AlertTriangle className="h-5 w-5 text-sol-yellow" />
              Remove sync for {pendingUnsync ? getProjectName(pendingUnsync.path) : ""}?
            </DialogTitle>
            <DialogDescription className="text-sol-text-muted">
              This project has {pendingUnsync?.sessionCount} synced conversation{pendingUnsync?.sessionCount !== 1 ? "s" : ""}.
              You can keep them on the server or delete them permanently.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <div className="truncate rounded-md border border-sol-border/60 bg-sol-bg-alt px-3 py-2 font-mono text-xs text-sol-text-muted">
              {pendingUnsync?.path}
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => setPendingUnsync(null)}
              disabled={isUnsyncing}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              onClick={() => executeUnsync(false)}
              className="border-sol-cyan text-sol-cyan hover:bg-sol-cyan/10"
              disabled={isUnsyncing}
            >
              {isUnsyncing ? "Removing..." : "Keep conversations"}
            </Button>
            <Button
              onClick={() => executeUnsync(true)}
              className="bg-sol-red hover:bg-sol-red/80 text-sol-base03"
              disabled={isUnsyncing}
            >
              {isUnsyncing ? "Deleting..." : "Delete conversations"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsPanel>
  );
}
