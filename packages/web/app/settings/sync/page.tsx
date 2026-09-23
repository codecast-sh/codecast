import { useSettingsData } from "../../../hooks/useSyncSettings";
import { useInboxStore } from "../../../store/inboxStore";
import { useCurrentUser } from "../../../hooks/useCurrentUser";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Input } from "../../../components/ui/input";
import { Button } from "../../../components/ui/button";
import { Switch } from "../../../components/ui/switch";
import { Fragment, useRef, useState } from "react";
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
import { SettingsPanel, SettingsRow, SettingsSection } from "../../../components/settings/ui";
import { TeamVisibilityControl } from "../../../components/settings/TeamVisibilityControl";
import Link from "next/link";
import { ShareReviewDialog, type ShareReviewRequest } from "../../../components/settings/ShareReviewDialog";
import { useShareImpact } from "../../../hooks/useShareImpact";
import { describeMappingScope, formatDateRange, formatSessionCount } from "../../../lib/team/shareImpact";
import { describePinnedPast, describeTeamSharing, hasPinnedPast, teamVisibilityOption, type TeamSharingFacts } from "../../../lib/teamVisibility";

type UserTeam = TeamSharingFacts & {
  _id: Id<"teams">;
  icon?: string | null;
  icon_color?: string | null;
  role?: string;
};
type DirectoryMapping = {
  _id?: string;
  path_prefix: string;
  team_id: Id<"teams">;
  team_name?: string;
  auto_share: boolean;
  share_since?: number | null;
  /** The repository the mapped checkout is a clone of; the rule reaches every clone of it. */
  repository?: string;
  created_at?: number;
};
type SyncProject = {
  path: string;
  is_git_repo: boolean;
  session_count: number;
  first_active?: number;
  last_active: number;
  /** repositoryKeyOfRemote of the checkout's origin; absent for a plain folder. */
  repository?: string;
  /** The team the server resolves this checkout to (its own rule, else the repository's). */
  team_id?: Id<"teams"> | null;
  /** True when the rule is on this checkout itself, not inherited from the repository. */
  mapped_directly?: boolean;
  git_remote_url?: string | null;
  auto_share?: boolean;
};

/**
 * One row of the sharing list: a repository with every checkout of it folded
 * beneath (Dhaval had four clones of littlebird and twenty codex worktrees,
 * one "Only me" row each), or a single folder with no repository. `path` is
 * the newest checkout, the one a share is written on; the server stamps the
 * repository on that rule and the other checkouts follow it.
 */
type ShareRow = SyncProject & { checkouts: SyncProject[] };

export default function SyncPage() {
  const { user } = useCurrentUser();
  const syncSettings = user ? { sync_mode: user.sync_mode ?? "all", sync_projects: user.sync_projects ?? [] } : null;
  const userTeams = useInboxStore((s) => s.teams);
  const { data: projects } = useSettingsData("syncProjects");
  const { data: directoryMappings } = useSettingsData("directoryMappings");
  const updateSyncSettings = useMutation(api.users.updateSyncSettings);
  const updateDirectoryMapping = useMutation(api.users.updateDirectoryTeamMapping);
  const removeDirectoryMapping = useMutation(api.users.removeDirectoryTeamMapping);
  const deleteConversationsForPath = useMutation(api.users.deleteConversationsForPath);
  const setTeamMembershipVisibility = useInboxStore((s) => s.setTeamMembershipVisibility);

  const [editMode, setEditMode] = useState(false);
  const [newProject, setNewProject] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [isUnsyncing, setIsUnsyncing] = useState(false);
  const unsyncingRef = useRef(false);
  const [pendingUnsync, setPendingUnsync] = useState<{
    path: string;
    /** Every checkout the action applies to; `path` names the row. */
    paths: string[];
    sessionCount: number;
    action: "unsync" | "remove_team";
  } | null>(null);
  // A repository moving to a team, or one already shared being narrowed,
  // goes through the review: the level, the share start, the count that
  // exposes, and the sessions themselves. Nothing writes until confirmed.
  const [pendingShare, setPendingShare] = useState<ShareReviewRequest | null>(null);
  const [isSharing, setIsSharing] = useState(false);
  const setPrivacy = useInboxStore((s) => s.setPrivacy);

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

  // The rule a row is under: a rule on one of its checkouts (its own word),
  // else the rule the server resolved through the repository (a checkout of
  // the same repository elsewhere carries it), else the team's share paths.
  type RowTeam = { team: UserTeam; isDefault: boolean; mapping?: DirectoryMapping; inherited?: boolean };
  const getTeamForRow = (row: ShareRow): RowTeam | null => {
    for (const checkout of row.checkouts) {
      const mapping = mappingsByPath.get(checkout.path);
      const team = mapping?.team_id ? teams.find((team) => team._id === mapping.team_id) : undefined;
      if (mapping && team) return { team, isDefault: false, mapping };
    }
    const resolved = row.checkouts.find((checkout) => checkout.team_id);
    if (resolved?.team_id) {
      const team = teams.find((team) => team._id === resolved.team_id);
      const mapping = mappings.find((m) => m.team_id === resolved.team_id && !!row.repository && m.repository === row.repository);
      if (team) return { team, isDefault: false, mapping, inherited: true };
    }
    if (activeTeam && teamSharePaths.length > 0) {
      const matches = teamSharePaths.some(sp => row.path === sp || row.path.startsWith(sp + "/"));
      if (matches) return { team: activeTeam, isDefault: true };
    }
    return null;
  };

  const rowPaths = (row: ShareRow) => row.checkouts.map((checkout) => checkout.path);
  const directMappingsOf = (row: ShareRow) => rowPaths(row).filter((path) => mappingsByPath.has(path));

  const openReview = (row: ShareRow, teamId: Id<"teams">) => {
    const current = getTeamForRow(row);
    const existing = !!current && !current.isDefault && current.team._id === teamId;
    setPendingShare({
      path: row.path,
      paths: rowPaths(row),
      teamId,
      shareSince: existing ? current?.mapping?.share_since ?? null : null,
      existing,
    });
  };

  const handleTeamChange = async (row: ShareRow, teamId: Id<"teams"> | null) => {
    if (teamId) {
      openReview(row, teamId);
    } else {
      const direct = directMappingsOf(row);
      if (direct.length === 0) return;
      if (row.session_count > 0) {
        setPendingUnsync({ path: row.path, paths: direct, sessionCount: row.session_count, action: "remove_team" });
        return;
      }
      for (const path of direct) await removeDirectoryMapping({ path_prefix: path });
    }
  };

  const handleToggleProjectSync = async (row: ShareRow, shouldSync: boolean) => {
    const paths = rowPaths(row);
    if (shouldSync) {
      const newProjects = [...syncProjects, ...paths.filter((path) => !syncProjects.includes(path))];
      await updateSyncSettings({ sync_projects: newProjects });
    } else {
      if (row.session_count > 0) {
        setPendingUnsync({ path: row.path, paths, sessionCount: row.session_count, action: "unsync" });
        return;
      }
      const newProjects = syncProjects.filter((projectPath: string) => !paths.includes(projectPath));
      await updateSyncSettings({ sync_projects: newProjects });
      for (const path of directMappingsOf(row)) await removeDirectoryMapping({ path_prefix: path });
    }
  };

  const executeShare = async ({ since, keepPrivate }: { since: number | null; keepPrivate: Id<"conversations">[] }) => {
    if (!pendingShare || isSharing) return;
    setIsSharing(true);
    try {
      // The kept sessions lock private first, so the mapping's backfill
      // (which leaves a hand locked row alone) never exposes them.
      for (const id of keepPrivate) setPrivacy(String(id), true);
      await updateDirectoryMapping({
        path_prefix: pendingShare.path,
        team_id: pendingShare.teamId,
        auto_share: true,
        include_past: since == null,
        share_since: since ?? undefined,
      });
      const team = teams.find((t) => t._id === pendingShare.teamId);
      toast.success(`${getProjectName(pendingShare.path)} shares with ${team?.name ?? "the team"}`, {
        description:
          (since == null ? "Past sessions included." : "Sessions before the share start stay private.") +
          (keepPrivate.length > 0 ? ` ${keepPrivate.length} kept private.` : ""),
      });
      setPendingShare(null);
    } catch (err) {
      console.error("Failed to share project:", err);
      toast.error("Could not share the project");
    } finally {
      setIsSharing(false);
    }
  };

  const executeUnsync = async (deleteConversations: boolean) => {
    if (!pendingUnsync || unsyncingRef.current) return;
    const { paths, action } = pendingUnsync;

    unsyncingRef.current = true;
    setIsUnsyncing(true);
    try {
      if (action === "unsync") {
        const newProjects = syncProjects.filter((projectPath: string) => !paths.includes(projectPath));
        await updateSyncSettings({ sync_projects: newProjects });
      }
      for (const path of paths) {
        const existingMapping = mappingsByPath.get(path);
        if (existingMapping) {
          const first = await removeDirectoryMapping({ path_prefix: path, delete_conversations: deleteConversations });
          let hasMore = first?.hasMore;
          while (hasMore) {
            const next = await deleteConversationsForPath({ path_prefix: path });
            hasMore = next?.hasMore;
          }
        } else if (action === "unsync" && deleteConversations) {
          let hasMore = true;
          while (hasMore) {
            const next = await deleteConversationsForPath({ path_prefix: path });
            hasMore = next?.hasMore ?? false;
          }
        }
      }
      setPendingUnsync(null);
    } catch (err) {
      console.error("Failed to unsync project:", err);
      toast.error("Failed to remove sync", { description: "The project may have too many conversations to delete at once." });
    } finally {
      unsyncingRef.current = false;
      setIsUnsyncing(false);
    }
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

  // Every checkout of one repository folds into one row, newest checkout
  // first; a folder with no repository is a row of its own.
  const shareRows: ShareRow[] = (() => {
    const byRepository = new Map<string, ShareRow>();
    const rows: ShareRow[] = [];
    for (const project of allProjects) {
      if (!project.repository) { rows.push({ ...project, checkouts: [project] }); continue; }
      const row = byRepository.get(project.repository);
      if (!row) {
        const fresh = { ...project, checkouts: [project] };
        byRepository.set(project.repository, fresh);
        rows.push(fresh);
        continue;
      }
      row.checkouts.push(project);
      row.session_count += project.session_count;
      row.last_active = Math.max(row.last_active, project.last_active);
      const starts = [row.first_active, project.first_active].filter((t): t is number => typeof t === "number");
      row.first_active = starts.length ? Math.min(...starts) : undefined;
    }
    return rows.sort((a, b) => b.last_active - a.last_active);
  })();

  const rowName = (row: ShareRow) => row.repository ? row.repository.split("/").pop() || row.repository : getProjectName(row.path);

  const filteredProjects = shareRows.filter((row) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return rowName(row).toLowerCase().includes(query) || row.checkouts.some((checkout) => checkout.path.toLowerCase().includes(query));
  });

  // One group per team (its level control in the header, the projects that
  // flow to it underneath), then the projects only you see, then the ones not
  // syncing. The card answers "what does this team see, and of what" in one
  // glance. A team with nothing shared still shows its header unless a search
  // is narrowing the list.
  type SharingGroup = { key: string; team?: UserTeam; label?: string; items: ShareRow[] };
  const sharingGroups = (() => {
    const byTeam = new Map<string, ShareRow[]>(teams.map((team) => [String(team._id), []]));
    const privateSynced: ShareRow[] = [];
    const notSyncing: ShareRow[] = [];
    filteredProjects.forEach((project) => {
      if (!project.checkouts.some((checkout) => isSynced(checkout.path))) { notSyncing.push(project); return; }
      const shared = getTeamForRow(project);
      const bucket = shared ? byTeam.get(String(shared.team._id)) : undefined;
      if (bucket) bucket.push(project);
      else privateSynced.push(project);
    });
    const groups: SharingGroup[] = teams
      .map((team) => ({ key: String(team._id), team, items: byTeam.get(String(team._id)) ?? [] }))
      .filter((group) => group.items.length > 0 || !searchQuery);
    groups.push(
      { key: "private", label: hasTeams ? "Private — only you" : "Syncing", items: privateSynced },
      { key: "off", label: "Not syncing", items: notSyncing },
    );
    return groups.filter((group) => group.team || group.items.length > 0);
  })();

  return (
    <SettingsPanel>
      <SettingsSection title="Sync" icon={RefreshCw}>
        <SettingsRow
          label="Sync all folders"
          description={
            syncAll
              ? "Sessions from every folder upload to your workspace. They stay private to you unless you share them."
              : `Only ${syncProjects.length} chosen folder${syncProjects.length === 1 ? "" : "s"} upload${syncProjects.length === 1 ? "s" : ""} sessions — pick them in the list below.`
          }
        >
          <Switch checked={syncAll} onCheckedChange={handleToggleSyncAll} aria-label="Sync all folders" />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Sharing"
        icon={FolderGit2}
        description={
          hasTeams
            ? "Synced repositories and folders stay private to you until you share one with a team. A share covers every checkout and worktree of the repository. Each team's level sets how much teammates see of what you share with it."
            : "Repositories and folders whose sessions sync to your workspace."
        }
        actions={
          <Button variant="outline" size="sm" onClick={() => setEditMode(!editMode)}>
            {editMode ? "Done" : "+ Add path"}
          </Button>
        }
      >
        <div className="flex items-center gap-2.5 px-4 py-2.5 sm:px-5">
          <Search className="h-4 w-4 flex-shrink-0 text-sol-text-dim" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search repositories and folders..."
            className="w-full bg-transparent text-sm text-sol-text placeholder:text-sol-text-dim focus:outline-none"
          />
        </div>

        {editMode && (
          <div className="flex items-center gap-2 px-4 py-2.5 sm:px-5">
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

        {sharingGroups.length > 0 ? (
          <>
            {sharingGroups.map((group) => (
              <Fragment key={group.key}>
                {group.team ? (
                  <TeamSharingHeader
                    team={group.team}
                    rows={group.items}
                    onIncludePast={() => {
                      const option = teamVisibilityOption(group.team!.visibility);
                      setTeamMembershipVisibility(String(group.team!._id), option.value, "everything");
                      toast.success(`${group.team!.name} now sees ${option.sees} for every session`);
                    }}
                  />
                ) : (
                  <div className="flex items-baseline gap-1.5 bg-sol-bg-alt/50 px-4 py-1.5 sm:px-5">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-sol-text-dim">
                      {group.label}
                    </span>
                    <span className="text-[10px] text-sol-text-dim/70">{group.items.length}</span>
                  </div>
                )}
                {group.team && group.items.length === 0 && (
                  <div className="px-4 py-2 pl-10 text-xs text-sol-text-dim sm:px-5 sm:pl-12">
                    Nothing shared with {group.team.name} yet. Pick it on a repository below.
                  </div>
                )}
                {group.items.length > 0 && (
                <div
                  className={
                    group.team
                      // A team's repos read as its children: indented under the
                      // tinted header, on the plain card surface.
                      ? "pl-6 divide-y divide-sol-border/40 sm:pl-7"
                      : "divide-y divide-sol-border/40"
                  }
                >
                {group.items.map((project) => {
                  const synced = project.checkouts.some((checkout) => isSynced(checkout.path));
                  const teamResult = getTeamForRow(project);
                  const more = project.checkouts.length - 1;

                  return (
                    <div
                      key={project.path}
                      className={`flex items-center justify-between gap-3 px-4 py-2.5 transition-colors sm:px-5 ${
                        synced ? "hover:bg-sol-bg-highlight/30" : "opacity-60"
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
                              {rowName(project)}
                            </div>
                            <div className="flex items-center gap-1.5 text-xs">
                              <span
                                className="truncate font-mono text-[11px] text-sol-text-muted"
                                title={more > 0 ? project.checkouts.map((checkout) => prettyPath(checkout.path)).join("\n") : undefined}
                              >
                                {prettyPath(project.path)}
                                {more > 0 && (
                                  <span className="ml-1 text-sol-text-dim">+{more} more checkout{more === 1 ? "" : "s"}</span>
                                )}
                              </span>
                              {/* A shared row's exact count rides its scope line; the
                                  recent window count would disagree with the team total. */}
                              {!(teamResult && !teamResult.isDefault) && (
                                <span className="flex-shrink-0 text-sol-text-dim tabular-nums">
                                  · {project.session_count > 0
                                    ? `${formatSessionCount(project.session_count)} · ${formatDateRange(project.first_active ?? project.last_active, project.last_active)}`
                                    : "no sessions yet"}
                                </span>
                              )}
                            </div>
                            {teamResult && !teamResult.isDefault && (
                              <MappingScopeLine
                                paths={rowPaths(project)}
                                shareSince={teamResult.mapping?.share_since ?? null}
                                onReview={() => openReview(project, teamResult.team._id)}
                              />
                            )}
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
                                          {teamResult.inherited && (
                                            <span
                                              className="ml-0.5 text-xs text-sol-text-muted"
                                              title="Shared through a rule on another checkout of this repository"
                                            >
                                              (repo)
                                            </span>
                                          )}
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
                                {teamResult && !teamResult.isDefault && (
                                  <DropdownMenuItem onClick={() => openReview(project, teamResult.team._id)}>
                                    <Search className="mr-2 h-4 w-4" />
                                    <span className="flex-1">Review sharing</span>
                                    <span className="ml-3 text-xs text-sol-text-dim">scope, sessions</span>
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem
                                  onClick={() => handleTeamChange(project, null)}
                                  className={!teamResult || teamResult.isDefault ? "bg-sol-bg-highlight/40" : ""}
                                >
                                  <EyeOff className="mr-2 h-4 w-4" />
                                  <span className="flex-1">Only me</span>
                                  <span className="ml-3 text-xs text-sol-text-dim">private</span>
                                </DropdownMenuItem>
                                {teams.map((team) => (
                                  <DropdownMenuItem
                                    key={team._id}
                                    onClick={() => handleTeamChange(project, team._id)}
                                    className={teamResult?.team?._id === team._id && !teamResult?.isDefault ? "bg-sol-bg-highlight/40" : ""}
                                  >
                                    <Eye className="mr-2 h-4 w-4" />
                                    <span className="flex-1">{team.name}</span>
                                    <span className="ml-3 text-xs text-sol-text-dim">
                                      {teamVisibilityOption(team.visibility).label}
                                    </span>
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}

                          {!syncAll && (
                            <Switch
                              checked={synced}
                              onCheckedChange={(v) => handleToggleProjectSync(project, v)}
                              aria-label={`Sync ${rowName(project)}`}
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                )}
              </Fragment>
            ))}
          </>
        ) : (
          <div className="px-4 py-8 text-center text-sm text-sol-text-muted">
            {searchQuery ? (
              <p>Nothing matching &ldquo;{searchQuery}&rdquo;</p>
            ) : (
              <p>No recent folders found. Start a coding session to see your repositories and folders here.</p>
            )}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title="CLI"
        icon={Terminal}
        description="Manage sync settings from the command line. Changes sync to your daemon on the next cycle."
      >
        <div className="space-y-1 px-4 py-3 font-mono text-sm sm:px-5">
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

      <ShareReviewDialog
        request={pendingShare}
        team={pendingShare ? teams.find((t) => t._id === pendingShare.teamId) ?? null : null}
        projects={recentProjects}
        busy={isSharing}
        onCancel={() => setPendingShare(null)}
        onConfirm={executeShare}
      />

      <Dialog open={!!pendingUnsync} onOpenChange={(open) => !open && setPendingUnsync(null)}>
        <DialogContent className="bg-sol-bg border-sol-border sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sol-text">
              <AlertTriangle className="h-5 w-5 text-sol-yellow" />
              Remove sync for {pendingUnsync ? getProjectName(pendingUnsync.path) : ""}?
            </DialogTitle>
            <DialogDescription className="text-sol-text-muted">
              This has {pendingUnsync?.sessionCount} synced conversation{pendingUnsync?.sessionCount !== 1 ? "s" : ""}.
              You can keep them on the server or delete them permanently.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <div className="truncate rounded-md bg-sol-bg-alt px-3 py-2 font-mono text-xs text-sol-text-muted">
              {pendingUnsync?.path}
            </div>
          </div>
          <DialogFooter className="min-w-0 flex-wrap gap-2 sm:space-x-0">
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

/** The header of a team's group: who is on it, what they see, and the level
 *  control. The projects that flow to the team follow as the group's rows. */
function TeamSharingHeader({ team, rows, onIncludePast }: { team: UserTeam; rows: ShareRow[]; onIncludePast: () => void }) {
  const option = teamVisibilityOption(team.visibility);
  const projectCount = rows.length;
  // Exact totals across every checkout the team's rules reach, each read at
  // its own share start: what the team can open, what a start keeps private,
  // and what the member hid by hand.
  const paths = rows.flatMap((row) => row.checkouts.map((checkout) => checkout.path));
  const impact = useShareImpact(paths, rows.flatMap((row) => row.checkouts));
  const visible = Math.max(0, impact.sessions - impact.older);
  const totals =
    projectCount === 0
      ? null
      : impact.sessions === 0
        ? "No sessions there yet."
        : [
            `Can open ${formatSessionCount(visible, impact.truncated)}${visible > 0 && impact.older === 0 && impact.first != null ? `, ${formatDateRange(impact.first, impact.last)}` : ""}.`,
            impact.older > 0 ? `${formatSessionCount(impact.older)} before a share start stay private.` : "",
            impact.hidden > 0 ? `${formatSessionCount(impact.hidden)} hidden by hand.` : "",
            !impact.exact ? "Still counting." : "",
          ].filter(Boolean).join(" ");
  return (
    <SettingsRow
      className="bg-sol-bg-alt/70"
      label={
        <span className="flex items-center gap-1.5">
          <TeamIcon icon={team.icon} color={team.icon_color} className="h-3.5 w-3.5" />
          <span className="font-medium">{team.name}</span>
          <span className="text-xs text-sol-text-muted">
            · {describeTeamSharing(team)} · {projectCount === 1 ? "1 shared" : `${projectCount} shared`}
          </span>
        </span>
      }
      description={
        <>
          Teammates see {option.sees}.{totals ? ` ${totals}` : ""}
          {hasPinnedPast(team) && (
            <>
              {" "}
              {describePinnedPast(team)}{" "}
              <button type="button" onClick={onIncludePast} className="text-sol-cyan hover:underline">
                Include past sessions
              </button>
            </>
          )}
        </>
      }
    >
      <TeamVisibilityControl team={team} />
    </SettingsRow>
  );
}

/** One line under a shared repository: its share start and what that keeps
 *  private, what the member hid by hand, the way to see the feed as the team
 *  does, and the way into the review. */
function MappingScopeLine({ paths, shareSince, onReview }: { paths: string[]; shareSince: number | null; onReview: () => void }) {
  const impact = useShareImpact(paths, undefined);
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-sol-text-dim">
      <span className="tabular-nums">
        {impact.exact
          ? impact.sessions > 0
            ? `${formatSessionCount(impact.sessions, impact.truncated)} · started ${formatDateRange(impact.first, impact.last)} · `
            : "no sessions yet · "
          : "counting · "}
        {describeMappingScope(shareSince, impact.exact ? impact.older : undefined)}
      </span>
      {impact.hidden > 0 && <span>· {formatSessionCount(impact.hidden)} hidden by hand</span>}
      <Link
        href={`/team/activity?dir=${encodeURIComponent(paths[0])}`}
        className="text-sol-cyan hover:underline"
        title="Open the team feed filtered to this repository"
      >
        View as the team
      </Link>
      <button type="button" onClick={onReview} className="text-sol-cyan hover:underline">
        Review
      </button>
    </div>
  );
}
