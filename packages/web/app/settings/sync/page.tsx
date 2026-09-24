import { useSettingsData } from "../../../hooks/useSyncSettings";
import { useInboxStore } from "../../../store/inboxStore";
import { useCurrentUser } from "../../../hooks/useCurrentUser";
import { useConvex, useMutation } from "convex/react";
import { fetchLocalSessions, fetchPathsExist, type LocalFolder } from "../../../lib/fsBrowse";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { api } from "@codecast/convex/convex/_generated/api";
import { Input } from "../../../components/ui/input";
import { Button } from "../../../components/ui/button";
import { Switch } from "../../../components/ui/switch";
import { Fragment, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  GitBranch, Folder, FolderGit2, Search, AlertTriangle, RefreshCw, Terminal,
} from "lucide-react";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
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
import { SharePanel, ShareTrigger, type ShareChoice, type ShareCurrent } from "../../../components/settings/SharePanel";
import { useShareSummaries } from "../../../hooks/useShareSummaries";
import {
  describeMappingScope,
  describeSince,
  formatDateRange,
  formatSessionCount,
  summarizeShareImpact,
  type ShareImpact,
} from "../../../lib/team/shareImpact";
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
  /** Absent on a "never share" lock. */
  team_id?: Id<"teams"> | null;
  team_name?: string | null;
  auto_share: boolean;
  /** A lock the owner wrote: no rule can share the folder. */
  private?: boolean;
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
  /** The server resolved this checkout to a "never share" lock (its own or the repository's). */
  private?: boolean;
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

  // Sessions per folder on this machine, synced or not, straight from the
  // local daemon: undefined while asking, null when it can't be asked (another
  // machine, daemon down). It is what lets a folder that never synced show its
  // numbers before the person chooses to sync or share it.
  const convex = useConvex();
  const [localFolders, setLocalFolders] = useState<LocalFolder[] | null | undefined>(undefined);
  const [localTick, setLocalTick] = useState(0);
  useWatchEffect(() => {
    let live = true;
    void fetchLocalSessions(convex).then((folders) => { if (live) setLocalFolders(folders); });
    return () => { live = false; };
  }, [convex, localTick]);
  const localByPath = useMemo(() => new Map((localFolders ?? []).map((f) => [f.path, f])), [localFolders]);
  // Folders under this machine's home that are no longer on disk: a project
  // that moved leaves its old path behind with sessions that stop on the move.
  const [gonePaths, setGonePaths] = useState<Set<string>>(() => new Set());

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
  // The row whose sharing panel is open under it; one at a time.
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [isSharing, setIsSharing] = useState(false);
  const setPrivacy = useInboxStore((s) => s.setPrivacy);

  const hasTeams = userTeams && userTeams.length > 0;
  const syncAll = syncSettings?.sync_mode === "all";
  const syncProjects = syncSettings?.sync_projects || [];
  const teams = (userTeams?.filter(Boolean) ?? []) as UserTeam[];
  const mappings = (directoryMappings ?? []) as DirectoryMapping[];
  const recentProjects = (projects ?? []) as SyncProject[];

  const mappingsByPath = new Map<string, DirectoryMapping>(mappings.map((mapping) => [mapping.path_prefix, mapping]));

  // Exact counts for every directory the page can list, read once on open
  // and again after each write. The rows below are built from these same
  // three sources, so this is a superset of every row's checkouts.
  const summaryPaths = useMemo(
    () => [...new Set([...recentProjects.map((p) => p.path), ...mappings.map((m) => m.path_prefix), ...syncProjects])],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects, directoryMappings, syncProjects.join("\n")],
  );
  const { summaries, loading: counting, reload: reloadSummaries } = useShareSummaries(summaryPaths);
  // Every path a row can show, known before the rows are built (the effect
  // must run above the early return).
  const existKey = [...new Set([...recentProjects.map((p) => p.path), ...mappings.map((m) => m.path_prefix), ...syncProjects, ...(localFolders ?? []).map((f) => f.path)])].sort().join("\n");
  useWatchEffect(() => {
    const list = existKey ? existKey.split("\n") : [];
    let live = true;
    void fetchPathsExist(convex, list).then((answer) => {
      if (!live || !answer) return;
      const home = answer.home.endsWith("/") ? answer.home : `${answer.home}/`;
      setGonePaths(new Set(Object.entries(answer.exists).filter(([p, ok]) => !ok && p.startsWith(home)).map(([p]) => p)));
    });
    return () => { live = false; };
  }, [convex, existKey]);

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
  // The lock a row is under: written on one of its checkouts, or resolved by
  // the server through the repository from another checkout's lock.
  const getLockForRow = (row: ShareRow): { mapping?: DirectoryMapping; inherited: boolean } | null => {
    for (const checkout of row.checkouts) {
      const mapping = mappingsByPath.get(checkout.path);
      if (mapping?.private) return { mapping, inherited: false };
    }
    if (row.checkouts.some((checkout) => checkout.private)) {
      const mapping = mappings.find((m) => m.private && !!row.repository && m.repository === row.repository);
      return { mapping, inherited: true };
    }
    return null;
  };
  const getTeamForRow = (row: ShareRow): RowTeam | null => {
    if (getLockForRow(row)) return null;
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
  const rowImpact = (row: ShareRow): ShareImpact => summarizeShareImpact(rowPaths(row), summaries, row.checkouts);
  /** The row's sessions on this machine, every checkout folded. */
  const rowLocal = (row: ShareRow): { sessions: number; synced: number; times: number[] } | null => {
    const folders = rowPaths(row).map((path) => localByPath.get(path)).filter((f): f is LocalFolder => !!f);
    if (folders.length === 0) return null;
    return {
      sessions: folders.reduce((n, f) => n + f.sessions, 0),
      synced: folders.reduce((n, f) => n + f.synced, 0),
      times: folders.flatMap((f) => f.times).sort((a, b) => b - a),
    };
  };
  const rowCurrent = (row: ShareRow): ShareCurrent => {
    const lock = getLockForRow(row);
    if (lock) return { kind: "lock", inherited: lock.inherited };
    const current = getTeamForRow(row);
    if (!current) return { kind: "private" };
    return {
      kind: "team",
      teamId: current.team._id,
      teamName: current.team.name,
      shareSince: current.mapping?.share_since ?? null,
      inherited: current.inherited,
      isDefault: current.isDefault,
    };
  };

  // One rule per repository, written on the row's newest checkout; the server
  // lands it on whichever checkout already carries the rule. `prev` is the
  // rule as it was, so the toast can put it back.
  type RuleState = { teamId: Id<"teams">; shareSince: number | null } | { locked: true } | null;
  const ruleOf = (row: ShareRow): RuleState => {
    if (getLockForRow(row)) return { locked: true };
    const current = getTeamForRow(row);
    return current && !current.isDefault ? { teamId: current.team._id, shareSince: current.mapping?.share_since ?? null } : null;
  };
  const writeRule = async (row: ShareRow, rule: RuleState, lockPrivate: Id<"conversations">[] = []) => {
    await updateDirectoryMapping(
      rule && "locked" in rule
        ? { path_prefix: row.path, private: true }
        : rule
          ? {
              path_prefix: row.path,
              team_id: rule.teamId,
              auto_share: true,
              include_past: rule.shareSince == null,
              share_since: rule.shareSince ?? undefined,
              lock_private: lockPrivate.length > 0 ? lockPrivate : undefined,
            }
          : { path_prefix: row.path },
    );
    reloadSummaries();
  };
  const describeRule = (row: ShareRow, rule: RuleState) =>
    rule && "locked" in rule
      ? `${rowName(row)} is never shared again`
      : rule
        ? `${rowName(row)} shares with ${teams.find((t) => t._id === rule.teamId)?.name ?? "the team"} again`
        : `${rowName(row)} is private again`;
  const undoTo = (row: ShareRow, prev: RuleState) => ({
    label: "Undo",
    onClick: () => {
      writeRule(row, prev)
        .then(() => toast.success(describeRule(row, prev)))
        .catch((err) => { console.error("Undo failed:", err); toast.error("Could not undo"); });
    },
  });
  const lockRow = async (row: ShareRow) => {
    const prev = ruleOf(row);
    try {
      await writeRule(row, { locked: true });
      toast.success(`${rowName(row)} is never shared`, {
        description: "No rule can share its sessions, this repository's included. Only you can open them.",
        action: undoTo(row, prev),
        duration: 10000,
      });
    } catch (err) {
      console.error("Lock failed:", err);
      toast.error(`Could not lock ${rowName(row)}`);
    }
  };
  const shareRow = async (row: ShareRow, teamId: Id<"teams">, since: number | null, keepPrivate: Id<"conversations">[] = []) => {
    const prev = ruleOf(row);
    const team = teams.find((t) => t._id === teamId);
    try {
      // Kept sessions lock private in the same mutation, before its backfill
      // is queued; the store action makes the feed agree at once.
      for (const id of keepPrivate) setPrivacy(String(id), true);
      await writeRule(row, { teamId, shareSince: since }, keepPrivate);
      toast.success(`${rowName(row)} now shares with ${team?.name ?? "the team"}`, {
        description:
          (since == null ? "Past sessions included." : `Sessions from ${describeSince(since)} on. Older ones stay private.`) +
          (keepPrivate.length > 0 ? ` ${keepPrivate.length} kept private.` : ""),
        action: undoTo(row, prev),
        duration: 10000,
      });
    } catch (err) {
      console.error("Share failed:", err);
      toast.error(`Could not share ${rowName(row)}`);
    }
  };
  const stopSharing = async (row: ShareRow) => {
    const prev = ruleOf(row);
    const unlocking = !!prev && "locked" in prev;
    try {
      await writeRule(row, null);
      toast.success(unlocking ? `${rowName(row)} is unlocked` : `${rowName(row)} is private again`, {
        description: unlocking
          ? "Still private to you. A share rule can reach it again."
          : "Only you can open its sessions. Synced sessions stay on the server.",
        action: undoTo(row, prev),
        duration: 10000,
      });
    } catch (err) {
      console.error("Stop sharing failed:", err);
      toast.error(`Could not stop sharing ${rowName(row)}`);
    }
  };

  const applyChoice = async (row: ShareRow, choice: ShareChoice) => {
    if (isSharing) return;
    setIsSharing(true);
    try {
      // A team can only see what uploads: sharing a folder that is not
      // syncing turns its sync on first.
      if (choice.kind === "team" && !row.checkouts.some((checkout) => isSynced(checkout.path))) {
        await handleToggleProjectSync(row, true);
      }
      if (choice.kind === "team") await shareRow(row, choice.teamId, choice.since, choice.keepPrivate);
      else if (choice.kind === "lock") await lockRow(row);
      else await stopSharing(row);
      setOpenPath(null);
    } finally {
      setIsSharing(false);
    }
  };

  const handleToggleProjectSync = async (row: ShareRow, shouldSync: boolean) => {
    const paths = rowPaths(row);
    if (shouldSync) {
      const newProjects = [...syncProjects, ...paths.filter((path) => !syncProjects.includes(path))];
      await updateSyncSettings({ sync_projects: newProjects });
      // The daemon uploads the folder's past sessions on its next heartbeat;
      // read the local numbers again once it has had the chance.
      setTimeout(() => setLocalTick((n) => n + 1), 45_000);
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

  // A typed path is a row from the moment it is added, sessions or none, so
  // a rule can be written on it before the first session ever syncs. The
  // path joins the chosen folders list either way: with sync all on the
  // list is not read by the daemon, and it is what keeps the row across a
  // reload until a rule of its own does.
  const handleAddProject = async () => {
    const projectPath = newProject.trim().replace(/\/+$/, "");
    if (!projectPath) return;
    if (!projectPath.startsWith("/")) {
      toast.error("Type the full path", { description: "Like /Users/you/src/app. Rules match full paths, so ~ does not work here." });
      return;
    }
    setNewProject("");
    if (syncProjects.includes(projectPath) || recentProjects.some((p) => p.path === projectPath)) {
      toast.info(`${getProjectName(projectPath)} is already listed`);
      return;
    }
    await updateSyncSettings({ sync_projects: [...syncProjects, projectPath] });
    toast.success(`${getProjectName(projectPath)} added`, { description: "Pick who can open it from its row." });
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

    // Folders with sessions on this machine the server has not seen: the
    // ones that never synced, with their local numbers.
    (localFolders ?? []).forEach((folder) => {
      if (projectMap.has(folder.path) || !folder.exists) return;
      projectMap.set(folder.path, {
        path: folder.path,
        is_git_repo: folder.git,
        repository: folder.repository,
        session_count: 0,
        first_active: folder.first,
        last_active: folder.last,
      });
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

    // Typed paths: a folder until a session says it is a checkout.
    syncProjects.forEach((projectPath: string) => {
      if (!projectMap.has(projectPath)) {
        projectMap.set(projectPath, {
          path: projectPath,
          is_git_repo: false,
          session_count: 0,
          last_active: 0,
        });
      }
    });

    const allPaths = Array.from(projectMap.values());

    // A plain folder inside a repository follows the repository's rule, so it
    // is not a row of its own; a folder with a rule or one typed on purpose
    // is (a lock on a subfolder of a shared repository is a real ask).
    const gitRepoPaths = allPaths.filter((project) => project.is_git_repo).map((project) => project.path);
    const filtered = allPaths.filter((project) => {
      if (project.is_git_repo) return true;
      if (mappingsByPath.has(project.path) || syncProjects.includes(project.path)) return true;
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

  const isGone = (row: ShareRow) => row.checkouts.every((checkout) => gonePaths.has(checkout.path));

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
    const locked: ShareRow[] = [];
    const privateSynced: ShareRow[] = [];
    const notSyncing: ShareRow[] = [];
    const gone: ShareRow[] = [];
    filteredProjects.forEach((project) => {
      if (!project.checkouts.some((checkout) => isSynced(checkout.path))) { notSyncing.push(project); return; }
      if (getLockForRow(project)) { locked.push(project); return; }
      const shared = getTeamForRow(project);
      const bucket = shared ? byTeam.get(String(shared.team._id)) : undefined;
      if (bucket) bucket.push(project);
      else if (isGone(project)) gone.push(project);
      else privateSynced.push(project);
    });
    const groups: SharingGroup[] = teams
      .map((team) => ({ key: String(team._id), team, items: byTeam.get(String(team._id)) ?? [] }))
      // A team shows once something is shared with it; before that its
      // header only pointed at repositories that might not exist yet.
      .filter((group) => group.items.length > 0);
    groups.push(
      { key: "private", label: hasTeams ? "Private — only you" : "Syncing", items: privateSynced },
      { key: "locked", label: "Never shared — locked by you", items: locked },
      { key: "off", label: "Not syncing", items: notSyncing },
      { key: "gone", label: "No longer on this machine: moved or deleted", items: gone },
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
            ? "Everything is private to you until you share a repository with a team. A share covers all its checkouts and worktrees. Never share locks a folder private for good."
            : "Repositories and folders whose sessions sync to your workspace. Anything not listed here is private to you."
        }
        actions={
          shareRows.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => setEditMode(!editMode)}>
              {editMode ? "Done" : "+ Add path"}
            </Button>
          )
        }
      >
        {shareRows.length > 0 && (
        <div className="flex items-center gap-2.5 px-4 py-2.5 sm:px-5">
          <Search className="h-4 w-4 flex-shrink-0 text-sol-text-dim" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search repositories and folders..."
            className="w-full bg-transparent text-sm text-sol-text placeholder:text-sol-text-dim focus:outline-none"
          />
        </div>
        )}

        {/* Open for good while nothing is listed: adding a folder is the one
            thing a person who has not synced yet can do here. */}
        {(editMode || shareRows.length === 0) && (
          <div className="flex items-center gap-2 px-4 py-2.5 sm:px-5">
            <Input
              type="text"
              value={newProject}
              onChange={(e) => setNewProject(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddProject()}
              placeholder="Full path of a folder, like /Users/you/src/app"
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
                    projectCount={group.items.length}
                    impact={summarizeShareImpact(
                      group.items.flatMap(rowPaths),
                      summaries,
                      group.items.flatMap((row) => row.checkouts),
                    )}
                    counting={counting}
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
                  const impact = rowImpact(project);
                  const local = rowLocal(project);

                  const open = openPath === project.path;
                  const current = rowCurrent(project);
                  return (
                    <div key={project.path}>
                    <div
                      className={`flex items-center justify-between gap-3 px-4 py-2.5 transition-colors sm:px-5 ${
                        "hover:bg-sol-bg-highlight/30"
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
                                className="min-w-[12ch] truncate font-mono text-[11px] text-sol-text-muted"
                                title={more > 0 ? project.checkouts.map((checkout) => prettyPath(checkout.path)).join("\n") : undefined}
                              >
                                {prettyPath(project.path)}
                                {more > 0 && (
                                  <span className="ml-1 text-sol-text-dim">+{more} more checkout{more === 1 ? "" : "s"}</span>
                                )}
                              </span>
                              {/* The synced count once it lands; this machine's
                                  count when nothing synced; the recent window's
                                  count, marked as such, until then. */}
                              <span className="flex-shrink-0 text-sol-text-dim tabular-nums">
                                · {impact.exact && impact.sessions > 0
                                  ? `${formatSessionCount(impact.sessions, impact.truncated)} · started ${formatDateRange(impact.first, impact.last, Date.now(), impact.truncated)}`
                                  : local && local.sessions > 0
                                    ? `${formatSessionCount(local.sessions)} on this machine · active ${formatDateRange(local.times[local.times.length - 1], local.times[0], Date.now())}`
                                    : impact.exact
                                      ? "no sessions yet"
                                      : project.session_count > 0
                                        ? `at least ${formatSessionCount(project.session_count)} · counting`
                                        : "counting"}
                              </span>
                              {!synced && local && <span className="flex-shrink-0 text-sol-text-dim">· not synced</span>}

                            </div>
                            {/* Its own line: beside the count it squeezed the path to nothing. */}
                            {isGone(project) && (
                              <div className="mt-0.5 text-[11px] text-sol-yellow">Folder moved or deleted on this machine</div>
                            )}
                            {teamResult && !teamResult.isDefault && (
                              <MappingScopeLine
                                path={project.path}
                                impact={impact}
                                shareSince={teamResult.mapping?.share_since ?? null}
                                onReview={() => setOpenPath(project.path)}
                              />
                            )}
                          </div>
                        </div>

                        <div className="flex flex-shrink-0 items-center gap-3">
                          {(synced || !!local) && (
                            <ShareTrigger
                              name={rowName(project)}
                              current={current}
                              open={open}
                              onClick={() => setOpenPath(open ? null : project.path)}
                            />
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
                      {open && (
                        <SharePanel
                          key={`${project.path}|${JSON.stringify(current)}`}
                          name={rowName(project)}
                          paths={rowPaths(project)}
                          isRepository={!!project.repository}
                          local={local && impact.sessions === 0 ? local.times : undefined}
                          syncsOnShare={!synced}
                          projects={recentProjects}
                          teams={teams}
                          current={current}
                          busy={isSharing}
                          onApply={(choice) => applyChoice(project, choice)}
                          onClose={() => setOpenPath(null)}
                        />
                      )}
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
              <>
                <p>Nothing has synced yet, so nothing is shared.</p>
                <p className="mt-1 text-xs text-sol-text-dim">
                  Folders show up here as your agents run. To set a rule before that, add a folder above.
                </p>
              </>
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
              <p><span className="text-sol-cyan">cast teams lock &lt;path&gt;</span> <span className="text-sol-text-muted">- Never share a folder</span></p>
            </>
          )}
        </div>
      </SettingsSection>

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

/** The header of a team's group: who is on it, what they see, what it can
 *  open across every repository under it, and the level control. */
function TeamSharingHeader({ team, projectCount, impact, counting, onIncludePast }: {
  team: UserTeam;
  projectCount: number;
  impact: ShareImpact;
  counting: boolean;
  onIncludePast: () => void;
}) {
  const option = teamVisibilityOption(team.visibility);
  const visible = Math.max(0, impact.sessions - impact.older);
  const totals =
    projectCount === 0
      ? null
      : !impact.exact
        ? counting ? "Counting sessions." : null
        : impact.sessions === 0
          ? "No sessions there yet."
          : [
              `Can open ${formatSessionCount(visible, impact.truncated && impact.older === 0)}${
                visible > 0 && impact.older === 0 && impact.first != null ? `, ${formatDateRange(impact.first, impact.last, Date.now(), impact.truncated)}` : ""
              }.`,
              impact.older > 0 ? `${formatSessionCount(impact.older, impact.truncated)} before a share start stay private.` : "",
              impact.hidden > 0 ? `${formatSessionCount(impact.hidden)} hidden by hand.` : "",
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
function MappingScopeLine({ path, impact, shareSince, onReview }: { path: string; impact: ShareImpact; shareSince: number | null; onReview: () => void }) {
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-sol-text-dim">
      <span className="tabular-nums">{describeMappingScope(shareSince, impact.exact ? impact.older : undefined, Date.now(), impact.truncated)}</span>
      {impact.hidden > 0 && <span>· {formatSessionCount(impact.hidden)} hidden by hand</span>}
      <Link
        href={`/team/activity?dir=${encodeURIComponent(path)}`}
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
