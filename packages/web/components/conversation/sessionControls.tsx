import { LogoIcon } from "../Logo";
import { useRef, useState, useMemo, useCallback, Fragment } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { isMac, hasOpenModal, altChordDirection } from "../../shortcuts";
import { useConvexSync } from "../../hooks/useConvexSync";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useShallow } from "zustand/react/shallow";
import { createPortal } from "react-dom";
import { AGENT_LAUNCH_OPTIONS, type ConvexAgentType } from "@codecast/shared/contracts";
import { StableContextPicker } from "../StableContextCards";
import { ErrorBoundary } from "../ErrorBoundary";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { toast } from "sonner";
import { AgentTypeIcon } from "../AgentTypeIcon";
import { AgentDefinitionPill, LaunchModelPill } from "../ModelEffortPicker";
import { useConvex, useConvexAuth } from "convex/react";
import { api as _typedApi } from "@codecast/convex/convex/_generated/api";
import { buildProjectPathOptions, inferHomeDir, resolveCustomPath, displayPath, inferProjectBase, type ProjectPathOption } from "../../lib/utils";
import { createProjectFolder, useDirListing } from "../../lib/fsBrowse";
import { CollabComposer } from "../CollabComposer";
import { useInboxStore, isConvexId, convBucketMap, type BucketItem, resolveCloudStartFrom } from "../../store/inboxStore";
import { isParkedDispatchError } from "../../store/mutativeMiddleware";
import { getLabelColor } from "../../lib/labelColors";
import { useCurrentUser } from "../../hooks/useCurrentUser";
import { browseProjectOrder, frequentProjectChips, mergeRecentProjectPaths, recentProjectPathsFromSessionKeys, recentProjectSessionKey } from "../../lib/recentProjectPaths";
import { ChevronDown, Search } from "lucide-react";
import { deviceDisplayName } from "../DeviceBadge";
import { MachineChips } from "../MachineChips";
import { SharedWithMark } from "../ProjectPathPicker";
import { SessionModeToggles } from "../SessionModeToggles";
import { dedupeProjectsByRepoName, pathOnMyMachines, repoName, resolveMachineSelection, resolveScopedProjects } from "../../lib/machinePicker";
import { cloudHostOf, cloudParkNeeded, cloudToggleAvailable, defaultSessionMachineId, isCloudHost, machineSelectionAfterCloudToggle, machineSelectionAfterPick, switchReconfigureArgs, type SessionMachine } from "../../lib/sessionMachines";
import { useSessionMachines } from "../../hooks/useSessionMachines";
import type { ConversationData, NewSessionAgentControls, PickerHandle, RecentProject } from "./types";

const api = _typedApi as any;

// The folder glyph is shown on the picker header and on every project chip.
// Factored out so the path data lives once instead of being copy-pasted.
function FolderGlyph({ className = "w-3 h-3" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
    </svg>
  );
}

// "Open this exact folder" chip glyph — a folder with a plus, distinct from the
// plain FolderGlyph the recent-project chips use.
function FolderPlusGlyph({ className = "w-3 h-3" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 10.5v6m3-3H9m-6.75 2.25V6A2.25 2.25 0 014.5 3.75h4.629a1.5 1.5 0 011.06.44l2.122 2.12a1.5 1.5 0 001.06.44H19.5A2.25 2.25 0 0121.75 9v9.75A2.25 2.25 0 0119.5 21h-15a2.25 2.25 0 01-2.25-2.25z" />
    </svg>
  );
}

// Project-path helpers (inferHomeDir / resolveCustomPath / displayPath /
// inferProjectBase / buildProjectPathOptions) live in lib/utils so they're unit-tested.

// Picker hint rows render key names as <KeyCap> caps (the keyboard-shortcuts
// panel component) — never as plain text in the surrounding font.
function HintKeys({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-flex items-center gap-[2px]">
        {keys.map((k, i) => <KeyCap key={i} size="xs">{k}</KeyCap>)}
      </span>
      <span className="text-sol-text-dim/70">{label}</span>
    </span>
  );
}

const ALT_CAP = isMac ? "⌥" : "Alt";

// "Back to the input" after a picker exits: whatever was focused when it
// opened, else the composer textarea (the only textarea on the null-state
// surface) — so Enter lands you typing even if the picker was opened while
// focus sat on body.
function restorePickerFocus(prev: HTMLElement | null) {
  if (prev && prev !== document.body && document.contains(prev)) {
    prev.focus();
    return;
  }
  document.querySelector<HTMLTextAreaElement>("textarea")?.focus();
}

export function ProjectSwitcher({ conversation, handleRef, machineSlot }: {
  conversation: ConversationData;
  handleRef?: React.MutableRefObject<PickerHandle | null>;
  // Where the machine picker renders. Omitted → inline above the folder chips
  // (the standalone non-owner surface). Provided → portaled into the host's
  // slot (NewSessionView puts it on the Context line); null while the slot
  // element hasn't mounted yet, during which nothing renders.
  machineSlot?: HTMLElement | null;
}) {
  // No-throw: the ladder below falls back to the store's cached list, so a
  // backend timeout (the 15 s db-wait cap under saturation) degrades to the
  // last answer instead of dropping the whole new-session header into its
  // ErrorBoundary.
  const { data: freshProjects } = useQueryNoThrow(api.users.getRecentProjectPaths, { limit: 50 });
  const cachedProjects = useInboxStore((s) => s.recentProjects);
  const setRecentProjects = useInboxStore((s) => s.setRecentProjects);
  const { user: currentUser } = useCurrentUser();
  // Select stable primitive keys—not session objects, which are replaced on
  // heartbeats. This avoids both the useSyncExternalStore allocation loop and
  // restoring the old ~1×/s ProjectSwitcher re-render regression.
  const loadedSessionProjectKeys = useInboxStore(useShallow((s) =>
    Object.values(s.sessions).map(recentProjectSessionKey),
  ));
  const ownSessionProjects = useMemo(
    () => recentProjectPathsFromSessionKeys(loadedSessionProjectKeys, currentUser?._id ? String(currentUser._id) : null),
    [loadedSessionProjectKeys, currentUser?._id],
  );
  // Narrowed: only _id/project_path/git_root/owner_device_id/target_device_id are
  // read here, none of which change on a heartbeat — so the always-rendered
  // ProjectSwitcher no longer re-renders ~1×/s. Anything the machine row needs
  // must be listed HERE: a field left out reads back undefined, and reading it
  // through an `as any` cast silently defeats that (which is how the empty-roster
  // fallback below shipped broken once already). Keep the reads typed.
  // resolveLiveSessionId follows the row across the compose popup's stub→real rekey
  // (which deletes sessions[stub]); without it a folder click after the create lands
  // updates the backend but never moves the highlight, since storeSession goes stale.
  const storeSession = useInboxStore(useShallow((s) => {
    const sess = s.sessions[s.resolveLiveSessionId(conversation._id)];
    if (!sess) return undefined;
    return { _id: sess._id, project_path: sess.project_path, git_root: sess.git_root, owner_device_id: sess.owner_device_id, target_device_id: sess.target_device_id, cloud_placement: sess.cloud_placement };
  }));
  const isolatedToggle = useInboxStore((s) => s.isolatedWorktreeMode);
  const convex = useConvex();
  const convCommand = useInboxStore((s) => s.convCommand);

  // --- machine row --------------------------------------------------------
  // Devices heartbeat every ~30s, so this subscription re-renders the switcher a
  // couple of times a minute — cheap next to the per-second churn the narrowed
  // store selector above avoids, and the row can't be drawn without it.
  const devices = useSessionMachines();
  // listDevices comes back sorted by last_seen, so the row would reshuffle every
  // time a machine heartbeats. Chips hold still instead: locals first, then name.
  const machineChips = useMemo(
    () => [...devices].sort((a, b) =>
      Number(a.is_remote) - Number(b.is_remote) || deviceDisplayName(a).localeCompare(deviceDisplayName(b))),
    [devices],
  );
  const [pickedDeviceId, setPickedDeviceId] = useState<string | null>(null);
  // Machine picker rests as a single pill showing where the session will run;
  // clicking it unfolds the full chip row for an explicit pick.
  const [machinesOpen, setMachinesOpen] = useState(false);
  const currentConvContext = useInboxStore((s) => s.currentConversation);
  // The context fallback can point at a TEAMMATE's session (team inbox) whose
  // checkout no machine of ours has — never present that as the current project.
  // Gate on the LIVE roster only: a persisted roster draws the chips at boot,
  // but a stale copy must not veto a freshly cloned checkout.
  const rosterLive = useInboxStore((s) => s.machineRosterLive);
  const ctxPath = [currentConvContext?.projectPath, currentConvContext?.gitRoot].find((p) => pathOnMyMachines(rosterLive ? devices : [], p));
  const currentPath = storeSession?.project_path || storeSession?.git_root || conversation.git_root || conversation.project_path || ctxPath;
  const currentName = currentPath?.split("/").filter(Boolean).pop() || "unknown";

  // Where the picker opens. Deterministic (owner → your standing pick → the
  // machine holding this checkout → stable tiebreak), so it can't change under
  // the user between the render that shows a chip and the send that acts on it.
  const lastPickedDeviceId = useInboxStore((s) => s.clientState.ui?.last_picked_device_id ?? null);
  const ownerDeviceIdForPicker = storeSession?.owner_device_id ?? (conversation as any).owner_device_id ?? null;
  const machineOpts = useMemo(() => ({
    ownerDeviceId: ownerDeviceIdForPicker,
    projectPath: currentPath,
    lastPicked: lastPickedDeviceId,
  }), [ownerDeviceIdForPicker, currentPath, lastPickedDeviceId]);
  // The machine this session WILL run on, plus the two things that must agree
  // with it: what gets stamped, and which machine's folders we offer. The stamp
  // already on the row is the last-resort rung — `devices` reads empty on mount
  // and on any Convex reconnect, and without it that gap would drop the folder
  // list back to the cross-machine union while the stamp survived.
  const existingStamp = storeSession?.target_device_id ?? null;
  const { selectedDeviceId, scopeProjectsToDeviceId } = resolveMachineSelection(devices, {
    ...machineOpts,
    picked: pickedDeviceId ?? defaultSessionMachineId(devices, machineOpts),
    existingStamp,
  });
  // The machine the pill names. Offline machines stay pickable: a laptop
  // falls back server-side to an online machine with the repo, and a cloud
  // host boots when the session starts.
  const routedMachine = machineChips.find((d) => d.device_id === selectedDeviceId) ?? machineChips[0];
  // The cloud host to offer, if the user has one (offline included — a stopped
  // host is asleep, not gone).
  const cloudHost = useMemo(() => cloudHostOf(machineChips), [machineChips]);
  // "Run in the cloud" is DERIVED from the routed machine, never stored beside
  // it: two independent states (the pick and a flag) is what let the two drift
  // — a laptop-owned eager row rendering as "Cloud Linux" without being parked,
  // OFF memory erased by a mirror. Held across an empty-roster gap by a ref
  // (`useDevices()` reads empty on mount and on any reconnect) so a reconnect
  // cannot flip the toggle. The store flag below is a write-only mirror for
  // surfaces that only need to know, reset when this composer unmounts: the
  // toggle really is THIS composer's override.
  const lastCloudModeRef = useRef(false);
  const cloudMode = routedMachine ? isCloudHost(routedMachine) : lastCloudModeRef.current;
  lastCloudModeRef.current = cloudMode;
  const setCloudSessionMode = useInboxStore((s) => s.setCloudSessionMode);
  useWatchEffect(() => { setCloudSessionMode(cloudMode); }, [cloudMode, setCloudSessionMode]);
  useWatchEffect(() => () => { setCloudSessionMode(false); }, [setCloudSessionMode]);
  // In cloud mode the isolated toggle is the WORKSPACE pick: on (default) =
  // its own worktree on the host, off = the host's main checkout (the store's
  // cloudSharedCheckout, reset whenever cloud mode flips). The local
  // isolatedWorktreeMode flag is never written from cloud mode: turning cloud
  // off must not strand the user with an isolated setting they never chose.
  const cloudShared = useInboxStore((s) => s.cloudSharedCheckout);
  const isolated = cloudMode ? !cloudShared : isolatedToggle;
  // What a cloud worktree starts from (persisted per device in clientUI).
  const cloudStartFrom = useInboxStore((s) => resolveCloudStartFrom(s.clientState.ui));

  // The folder list is scoped to the machine we're about to stamp, ALWAYS. The
  // unscoped query is `getOnlineLocalRoots` — a union across every online local —
  // so leaving it unscoped while the selection is forced would offer folders the
  // target machine doesn't have, and the stamp wins rung 1 outright: the session
  // would land on a machine that can't cd into its own project path. (Previously
  // the same list was safe because an unstamped session could be re-routed to
  // whichever machine actually held the checkout.)
  // Cloud mode is the one case where the folder list must NOT follow the
  // selected machine: the host has no checkout of its own — it clones whichever
  // repo you pick — so scoping the list at it would offer an empty row. Null
  // scoping falls back to the union across your own machines, which is the
  // honest set of repos a host can be told to fetch.
  const scopedDeviceId = cloudMode ? null : scopeProjectsToDeviceId;
  // The unscoped query stays mounted regardless — it's the shared subscription
  // that keeps the store's recentProjects cache (which the other pickers read)
  // warm. The scoped one deliberately never feeds that cache.
  const { data: scopedProjects } = useQueryNoThrow(
    api.users.getRecentProjectPaths,
    scopedDeviceId ? { limit: 50, device_id: scopedDeviceId } : "skip",
  );
  // Per-device cache so the picker paints instantly on every open instead of
  // waiting out the scoped round-trip. The cached list is that same machine's
  // prior answer, so — unlike the union — it can never offer a path the target
  // machine lacks; only cache-vs-cache staleness, which the live echo corrects.
  const cachedScopedProjects = useInboxStore((s) => s.recentProjectsByDevice);
  const setRecentProjectsForDevice = useInboxStore((s) => s.setRecentProjectsForDevice);
  const syncScopedProjects = useCallback(
    (projects: RecentProject[]) => {
      if (scopedDeviceId) setRecentProjectsForDevice(scopedDeviceId, projects);
    },
    [scopedDeviceId, setRecentProjectsForDevice],
  );
  useConvexSync(scopedProjects, syncScopedProjects);

  // One chip per repo name: the same project checked out on several machines
  // collapses to the routed machine's variant, and "other" means a different
  // PROJECT — the current one's foreign checkout is the machine row's job.
  const routedDevice = useMemo(
    () => devices.find((d) => d.device_id === selectedDeviceId) ?? null,
    [devices, selectedDeviceId],
  );

  // Memoized because five downstream useMemos take it as a dep — an identity
  // that churned every render would defeat all of them.
  //
  // While the scoped query is in flight we must NOT fall back to the raw union
  // (it offers folders the target machine lacks), but we must also not paint an
  // empty row: the chips popped in a beat late on every open — a visible
  // flicker. The union filtered by the routed machine's OWN local_project_roots
  // is the same predicate the server applies (deviceSeesPath mirrors
  // pathUnderRoot), computed from the device roster already in memory. So the
  // ladder is: live scoped answer → that machine's cached answer → the union
  // narrowed to that machine → nothing (roster not loaded yet).
  const unionProjects = useMemo<RecentProject[]>(
    () => mergeRecentProjectPaths(freshProjects ?? cachedProjects, ownSessionProjects),
    [freshProjects, cachedProjects, ownSessionProjects],
  );
  const recentProjects = useMemo<RecentProject[]>(
    () => resolveScopedProjects({
      scopedDeviceId,
      scoped: scopedProjects,
      cached: scopedDeviceId ? cachedScopedProjects[scopedDeviceId] : undefined,
      union: unionProjects,
      routedDevice,
    }),
    [scopedDeviceId, scopedProjects, cachedScopedProjects, unionProjects, routedDevice],
  );
  const suggestedPaths = useMemo(
    () => new Set(recentProjects.filter((p) => p.suggested).map((p) => p.path)),
    [recentProjects],
  );
  // The team a session in each folder will be shared with (its own rule, else
  // its repository's), shown on the chip so the folder choice carries its
  // consequence.
  const sharedWith = useMemo(
    () => new Map(recentProjects.map((p) => [p.path, p.team_name ?? null])),
    [recentProjects],
  );

  useConvexSync(freshProjects, setRecentProjects);

  const dedupedRecents = useMemo(
    () => dedupeProjectsByRepoName(recentProjects, routedDevice, currentPath),
    [recentProjects, routedDevice, currentPath],
  );
  const otherProjects = useMemo(() => {
    const currentName = currentPath ? repoName(currentPath) : null;
    return dedupedRecents.filter((p) => p.path !== currentPath && (!currentName || repoName(p.path) !== currentName));
  }, [dedupedRecents, currentPath]);

  // Resting row: the current project plus at most 4 you actually use most.
  // Machine-root suggestions (never-used folders, shown grayed) stay out of
  // this row entirely — they're reachable through "other".
  const visibleProjects = useMemo(() => frequentProjectChips(otherProjects), [otherProjects]);

  // --- keyboard picker ---------------------------------------------------
  // The chip row doubles as a keyboard listbox. It is dormant for mouse users
  // (renders exactly as before); ⌥↑ anywhere in the new-session view
  // activates it (NewSessionView's chord router).
  const [picking, setPicking] = useState(false);
  const [filter, setFilter] = useState("");
  const [hi, setHi] = useState(0);
  // Machine-root suggestions start collapsed on every picker open; one click
  // on the "N more folders" row reveals them for that open only.
  const [showSuggested, setShowSuggested] = useState(false);
  const pickerRef = useRef<HTMLInputElement>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);

  // Home dir inferred from real local roots, so "~/…" resolves to the same place
  // the daemon would cd to — until the daemon's own listing says for sure.
  const inferredHome = useMemo(
    () => inferHomeDir([currentPath, ...recentProjects.map((p: { path: string }) => p.path)]),
    [currentPath, recentProjects],
  );

  // The base a bare folder name resolves under — a sibling of the current
  // project (its parent dir), so typing "weekend-hack" means the folder next to
  // the one you're in, not a dead end.
  const projectBase = useMemo(
    () => inferProjectBase(currentPath, recentProjects.map((p: { path: string }) => p.path), inferredHome),
    [currentPath, recentProjects, inferredHome],
  );

  // The machine's real folders behind the typed text (shell-completion style),
  // from the daemon on THIS machine — and only while the session routes here:
  // a cloud session's folders live on the host, another machine's on it.
  const { listing: diskListing, home: diskHome } = useDirListing(convex, filter, inferredHome, projectBase, {
    enabled: picking && !cloudMode,
    deviceId: scopedDeviceId,
  });
  const homeDir = diskHome ?? inferredHome;

  // While navigating with the keyboard: ALL recent projects (current first —
  // the full fetched list, not just the 6 default chips), or — once the user
  // types — a live filter across them. Reuses the modal's match rule. When
  // the text instead NAMES a directory, a synthetic "open this folder" entry
  // rides at the end so ANY folder is reachable, not just previously-used ones:
  // an explicit path (absolute or ~/…) always offers it; a bare name resolves
  // against the project base and offers it only when nothing in recents matches
  // (so plain filtering — "co" → codecast — stays clean). The daemon's
  // start_session takes the cwd verbatim, so the fully-resolved path is all it
  // needs, and the chip shows that path so a wrong base guess is visible first.
  const pickList = useMemo<(ProjectPathOption & { extra?: boolean })[]>(() => {
    if (filter.trim()) {
      return buildProjectPathOptions({
        query: filter,
        recentPaths: dedupedRecents.map((p: { path: string }) => p.path),
        home: homeDir,
        base: projectBase,
        currentPath,
        listing: diskListing,
      });
    }
    // Unfiltered browse opens on EXACTLY the resting row — same chips, same
    // order (visibleProjects). Opening the picker must not silently grow the
    // list; everything else (rarely-used folders and the machine's never-used
    // roots) sits behind the one "N more folders" row until expanded. Typing
    // still searches all of them regardless.
    const base: { path: string; extra?: boolean }[] = currentPath ? [{ path: currentPath }] : [];
    const head = visibleProjects.map((p) => ({ path: p.path }));
    if (!showSuggested) return base.concat(head);
    const shown = new Set(head.map((p) => p.path));
    const rest = browseProjectOrder(otherProjects)
      .filter((p) => !shown.has(p.path))
      .map((p) => ({ path: p.path, extra: true }));
    return base.concat(head, rest);
  }, [filter, dedupedRecents, currentPath, otherProjects, visibleProjects, homeDir, projectBase, showSuggested, diskListing]);

  // How many folders the collapsed picker is holding back (rarely-used ones
  // plus the machine's never-used roots) — the expander's count.
  const hiddenCount = Math.max(0, otherProjects.length - visibleProjects.length);

  // Where the "more folders on this machine" divider renders once expanded
  // (-1 → no divider).
  const firstExtraIdx = useMemo(() => pickList.findIndex((p) => (p as { extra?: boolean }).extra), [pickList]);

  // Distinguish "you typed the folder you're already in" from a real miss.
  const filterIsCurrent = !!currentPath && resolveCustomPath(filter, homeDir, projectBase) === currentPath;

  const clampedHi = Math.min(hi, Math.max(0, pickList.length - 1));

  const exitPicker = useCallback((restoreFocus = true) => {
    setPicking(false);
    setFilter("");
    if (restoreFocus) restorePickerFocus(prevFocusRef.current);
  }, []);

  const focusPicker = useCallback(() => {
    prevFocusRef.current = document.activeElement as HTMLElement | null;
    setFilter("");
    setHi(0);
    setShowSuggested(false);
    setPicking(true);
    return true;
  }, []);

  // Focus the filter input AFTER the commit that mounts it. focusPicker is
  // called from a native window listener (the ⌥-chord router), where React 18
  // batches the state update past any rAF — an immediate/rAF focus() races the
  // mount and silently leaves focus where it was.
  useWatchEffect(() => {
    if (picking) pickerRef.current?.focus();
  }, [picking]);

  // `forceDeviceId` is how a machine chip re-routes a session whose folder isn't
  // changing (undefined = "whatever the machine row has selected"; null = clear
  // back to auto-routing), so passing it also defeats the same-path no-op guard.
  // A null/empty `projectPath` WITH a forceDeviceId means "reconfigure the
  // machine only": a pathless eager row (a task's context chat) can still be
  // parked on the host or un-parked back to a laptop.
  const handleSwitch = useCallback(async (projectPath: string | null, forceIsolated?: boolean, forceDeviceId?: string | null, opts: { onlyCloudPark?: boolean } = {}) => {
    const trimmed = (projectPath ?? "").trim();
    const machineOnly = !trimmed && forceDeviceId !== undefined;
    if (!trimmed && !machineOnly) return;
    // In cloud mode the target is the host the dropdown ROUTES to (there can
    // be more than one), falling back to the first host only if the routed
    // machine somehow is not one.
    const routedHostId = routedMachine && isCloudHost(routedMachine) ? routedMachine.device_id : cloudHost?.device_id ?? null;
    const targetDeviceId = forceDeviceId !== undefined ? forceDeviceId : (cloudMode ? routedHostId : scopedDeviceId);
    if (!machineOnly && trimmed === currentPath && !forceIsolated && forceDeviceId === undefined) return;
    const target = targetDeviceId ? machineChips.find((d) => d.device_id === targetDeviceId) : undefined;
    // ONE predicate (shared with createSessionFromStub and the server's start
    // chokepoint) decides whether the host needs a laptop to prepare it. A
    // folder the host already holds (~/work/<repo> and its worktrees) is a
    // plain start there; "ambiguous" parks — the user chose the host from a
    // laptop folder list, and the explicit cloud_device_id tells the server so.
    const locals = machineChips.filter((d) => !d.is_remote && d.bot_name === undefined);
    const cloudPark = cloudParkNeeded({ target, locals, path: trimmed });
    // The shared toggle only means something for a park; a native host
    // folder has no worktree-or-root choice to re-issue.
    if (opts.onlyCloudPark && !cloudPark) return;
    const store = useInboxStore.getState();
    const id = storeSession?._id || conversation._id;
    // What to restore on failure: nothing for a machine-only reconfigure,
    // which never touched the row's project.
    const prevPath = machineOnly ? undefined : currentPath;
    if (!machineOnly) store.updateSessionProject(id, trimmed);
    // Always push the switch to the daemon so it kills + recreates the tmux at
    // the new cwd. A freshly-created stub has no Convex id yet — its id arrives
    // via the in-flight create promise, so wait for that rather than dropping
    // the switch on the floor (which left the label and the tmux diverged).
    let convexId = isConvexId(id) ? id : store.getConvexId(id);
    if (!convexId) {
      const pending = store.awaitSessionCreate(id);
      if (pending) convexId = await pending.catch(() => undefined);
    }
    if (!convexId) return;
    // A cloud session's worktree is made on the HOST by the daemon that
    // prepares it. Asking the local daemon for one here would make a second,
    // unused worktree on this machine and route the session at it. Every
    // other target ships the user's REAL toggle (isolatedToggle), never the
    // cloud-locked `isolated`: leaving cloud mode for a laptop runs while
    // cloudMode is still true in this closure, and shipping it would make the
    // un-park build a laptop worktree nobody asked for (a host-native plain
    // start would likewise ask for a worktree inside a worktree).
    // Read at call time, not from the closure: the shared toggle (and the
    // start-from pick) set the flag and re-park in the same tick.
    const cloudShared = useInboxStore.getState().cloudSharedCheckout;
    convCommand(convexId, "reconfigureSession", switchReconfigureArgs({
      machineOnly,
      path: trimmed,
      cloudPark,
      targetDeviceId: cloudPark ? target!.device_id : targetDeviceId,
      isolated: forceIsolated ?? isolatedToggle,
      cloudShared,
      cloudStartFrom: resolveCloudStartFrom(useInboxStore.getState().clientState.ui),
    })).catch((err) => {
      if (isParkedDispatchError(err)) return;
      if (prevPath) useInboxStore.getState().updateSessionProject(convexId!, prevPath);
      toast.error(err instanceof Error ? err.message : "Failed to switch project");
    });
  }, [storeSession, conversation._id, convCommand, currentPath, isolatedToggle, cloudMode, cloudHost, routedMachine, machineChips, scopedDeviceId]);

  // A picker row: a folder to switch to, or one to CREATE first. Creation is
  // optimistic — the switch goes out on the assumption the daemon's mkdir
  // lands (it's one syscall away); a refusal surfaces as a toast.
  const pickOption = useCallback((p: ProjectPathOption) => {
    if (p.create) {
      createProjectFolder(convex, p.path, scopedDeviceId).catch((err) => {
        toast.error(err instanceof Error ? err.message : "Couldn't create folder");
      });
    }
    handleSwitch(p.path);
  }, [convex, scopedDeviceId, handleSwitch]);

  // Tab descends into the highlighted folder: the text becomes that path with
  // a trailing slash, which lists its children.
  const descendInto = useCallback((p: ProjectPathOption) => {
    setFilter(displayPath(p.path, homeDir) + "/");
    setHi(0);
  }, [homeDir]);

  // Picking a machine moves the (still blank) session there right away rather
  // than waiting on a folder pick the user may never make. That reconfigure only
  // bites when the conversation already exists server-side; every new-session
  // surface defers its create, so the stamp below is what usually carries the
  // choice — see createSessionFromStub.
  const updateClientUI = useInboxStore((s) => s.updateClientUI);
  const handleMachinePick = useCallback((d: SessionMachine) => {
    // The DROPDOWN is the standing choice: every transition goes through the
    // pure helpers so cloudMode === isCloudHost(picked) holds by construction.
    const next = machineSelectionAfterPick(d);
    setPickedDeviceId(next.pickedDeviceId);
    // Remember the choice: it becomes the picker's default for subsequent NEW
    // sessions, which is what makes "explicit every time" cost one click total
    // rather than one click per session. A cloud host is a legitimate standing
    // pick, honoured even while it sleeps.
    updateClientUI({ last_picked_device_id: d.device_id });
    // Same project, THAT machine's checkout: keep the stored path truthful for
    // where the session now routes (the daemon would remap by repo name anyway,
    // but the label/tooltip shouldn't show a path the machine doesn't have). A
    // cloud host is never remapped to its own roots: the laptop path is the
    // evidence the placement predicate needs. No folder yet → machine only.
    const remapped = currentPath
      ? (isCloudHost(d) ? currentPath : d.local_project_roots?.find((r) => repoName(r) === repoName(currentPath)) ?? currentPath)
      : null;
    handleSwitch(remapped, undefined, d.device_id);
  }, [currentPath, handleSwitch, updateClientUI]);

  // "Run in the cloud" is THIS composer's override: it moves the component-
  // local pick (on → the cloud host; off → what the ladder picks among the
  // non-cloud machines) and remembers nothing — a mode toggle must not repoint
  // every future new session at the cloud box; the dropdown does that. It DOES
  // reconfigure an existing row: on parks it on the host, off un-parks it.
  const toggleCloudMode = useCallback(() => {
    const next = machineSelectionAfterCloudToggle(machineChips, machineOpts, !cloudMode);
    if (next.pickedDeviceId === null && !cloudMode) return;
    setPickedDeviceId(next.pickedDeviceId);
    handleSwitch(currentPath ?? null, undefined, next.pickedDeviceId);
  }, [cloudMode, machineChips, machineOpts, currentPath, handleSwitch]);

  // Stamp the selection on the stub row so it rides the deferred create — the
  // machine shown in the row is the machine it runs on, whether or not the user
  // touched the picker. Previously only a move OFF the default was stamped, and
  // an unstamped session was re-decided server-side at send time by a
  // `last_seen` tiebreak that flips between idle machines on its own.
  const setSessionTargetDevice = useInboxStore((s) => s.setSessionTargetDevice);
  useWatchEffect(() => {
    // Never clear on a null. Null now means only "the device roster hasn't
    // loaded yet" — `useDevices()` starts empty, so defaultMachineId returns null
    // on the first render(s). Writing that through would wipe a stamp an earlier
    // mount already made, silently returning the session to server-side routing.
    // There is no longer any path that intentionally clears the selection: every
    // chip click names a machine.
    if (!selectedDeviceId) return;
    setSessionTargetDevice(storeSession?._id || conversation._id, selectedDeviceId);
  }, [storeSession?._id, conversation._id, selectedDeviceId, setSessionTargetDevice]);

  // Hand the imperative surface up to NewSessionView's ⌥-chord router.
  // Re-assigned every render so isOpen/commitAndClose read fresh state.
  useWatchEffect(() => {
    if (!handleRef) return;
    handleRef.current = {
      focus: focusPicker,
      isOpen: () => picking,
      move: (delta) => {
        setHi((i) => (pickList.length ? (i + delta + pickList.length) % pickList.length : 0));
        return pickList.length > 0;
      },
      commitAndClose: () => {
        const sel = pickList[clampedHi];
        if (sel) pickOption(sel);
        exitPicker(false);
      },
    };
  });
  useWatchEffect(() => () => { if (handleRef) handleRef.current = null; }, [handleRef]);

  // Focus lives in a real <input> (below) so the global capture-phase shortcut
  // dispatcher treats us as "typing" and suppresses single-letter hotkeys
  // (f/t/d/…). Letters + Backspace are handled natively by the input (onChange);
  // we only intercept the keys that drive chip selection. Option+H/L mirror
  // Left/Right while the arrow-key path remains available.
  const handlePickerKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowRight" || (e.altKey && e.code === "KeyL")) {
      e.preventDefault();
      setHi((i) => (pickList.length ? (i + 1) % pickList.length : 0));
      return;
    }
    if (e.key === "ArrowLeft" || (e.altKey && e.code === "KeyH")) {
      e.preventDefault();
      setHi((i) => (pickList.length ? (i - 1 + pickList.length) % pickList.length : 0));
      return;
    }
    const sel = pickList[Math.min(hi, Math.max(0, pickList.length - 1))];
    if (e.key === "Enter") {
      e.preventDefault();
      if (sel) pickOption(sel);
      exitPicker();
      return;
    }
    // Tab while typing completes into the highlighted folder (shell-style);
    // with nothing typed it drops back to the message box like ↓/Esc do
    // (⌥↓ — handled by the chord router before we see it — commits and
    // moves on to the agent row).
    if (e.key === "Tab" && !e.shiftKey && filter.trim() && sel && !sel.custom) {
      e.preventDefault();
      descendInto(sel);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      exitPicker();
    }
  }, [pickList, hi, filter, pickOption, descendInto, exitPicker]);

  // Mouse-first, and hidden entirely for the single-machine case so that
  // experience is untouched. Rests collapsed as one pill (the machine the
  // session will run on); a click unfolds the full chip row.
  const machineUi = (
    <MachineChips
      machines={machineChips}
      selectedDeviceId={selectedDeviceId}
      open={machinesOpen}
      onOpen={() => setMachinesOpen(true)}
      onPick={(d) => { handleMachinePick(d); setMachinesOpen(false); }}
    />
  );

  return (
    <div className="flex flex-col items-center gap-3">
      {machineSlot === undefined
        ? machineUi
        : machineUi && machineSlot
          ? createPortal(machineUi, machineSlot)
          : null}

      {!currentPath && recentProjects.length > 0 && (
        <div className="text-sol-text-dim text-xs">select a project</div>
      )}

      <div
        className={`rounded-lg transition-all ${picking ? "w-full max-w-3xl ring-1 ring-sol-cyan/40 bg-sol-cyan/[0.03] p-2" : ""}`}
      >
        {picking && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 pb-2 mb-2 border-b border-sol-cyan/20">
            <Search className="w-3.5 h-3.5 shrink-0 text-sol-cyan/70" />
            <input
              ref={pickerRef}
              value={filter}
              onChange={(e) => { setFilter(e.target.value); setHi(0); }}
              onKeyDown={handlePickerKeyDown}
              onBlur={() => exitPicker(false)}
              placeholder="search or paste a path"
              spellCheck={false}
              autoComplete="off"
              className="flex-1 min-w-[12rem] bg-transparent text-xs font-mono text-sol-cyan placeholder:text-sol-text-dim outline-none border-0 p-0"
            />
            <span className="inline-flex items-center gap-2 text-[11px] font-mono">
              <HintKeys keys={["←", "→"]} label="move" />
              <HintKeys keys={["↵"]} label={pickList[clampedHi]?.create ? "create" : pickList[clampedHi]?.custom ? "open" : "select"} />
              {filter.trim() && pickList[clampedHi] && !pickList[clampedHi].custom && (
                <HintKeys keys={["Tab"]} label="into" />
              )}
              <HintKeys keys={[ALT_CAP, "↓"]} label="agent" />
              <HintKeys keys={["Esc"]} label="back" />
            </span>
          </div>
        )}
        <div className="flex flex-wrap justify-center gap-1.5">
        {picking ? (
          <>
          {pickList.length === 0 ? (
            <span className="text-xs text-sol-text-dim px-2.5 py-1">
              {filterIsCurrent ? "already in this folder" : <>no match for &ldquo;{filter}&rdquo;</>}
            </span>
          ) : (
            pickList.map((p, i) => {
              const isHi = i === clampedHi;
              const isCurrent = p.path === currentPath;
              return (
                <Fragment key={p.path}>
                  {i === firstExtraIdx && (
                    <span className="w-full mt-1.5 mb-0.5 flex items-center gap-2 text-[10px] text-sol-text-dim/80">
                      <span className="flex-1 border-t border-sol-border/40" />
                      more folders on {routedDevice ? deviceDisplayName(routedDevice) : "this machine"}
                      <span className="flex-1 border-t border-sol-border/40" />
                    </span>
                  )}
                  <button
                    // onMouseDown (not onClick) + preventDefault keeps the filter
                    // input focused so the click isn't lost to an onBlur teardown.
                    onMouseDown={(e) => { e.preventDefault(); pickOption(p); exitPicker(); }}
                    onMouseEnter={() => setHi(i)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border transition-all max-w-[min(100%,22rem)] ${
                      isHi
                        ? "border-sol-cyan/70 bg-sol-cyan/15 text-sol-cyan ring-1 ring-sol-cyan/50"
                        : p.custom
                          ? "border-dashed border-sol-cyan/40 text-sol-cyan/80"
                          : isCurrent
                            ? "border-sol-cyan/60 bg-sol-cyan/15 text-sol-cyan font-medium"
                            : "border-sol-border/40 text-sol-text-dim"
                    } ${!isHi && (suggestedPaths.has(p.path) || (p.disk && !p.repo)) ? "opacity-60" : ""}`}
                    title={`${p.disk ? `${p.path}${p.repo ? " (git repository)" : ""}` : p.path}${
                      sharedWith.get(p.path) ? ` · shared with ${sharedWith.get(p.path)}` : p.custom || p.disk ? "" : " · only you"
                    }`}
                  >
                    {p.custom ? <FolderPlusGlyph className="w-3 h-3 shrink-0" /> : <FolderGlyph />}
                    {p.custom ? (
                      <span className="truncate">
                        <span className="opacity-60">{p.create ? "create " : "open "}</span>
                        <span className="font-mono">{displayPath(p.path, homeDir)}</span>
                      </span>
                    ) : (
                      <span>{p.path.split("/").filter(Boolean).pop()}</span>
                    )}
                    <SharedWithMark team={sharedWith.get(p.path)} />
                  </button>
                </Fragment>
              );
            })
          )}
          {!filter.trim() && !showSuggested && hiddenCount > 0 && (
            <button
              // onMouseDown + preventDefault, same as the chips: keep the
              // filter input focused so expanding doesn't blur-close the picker.
              onMouseDown={(e) => { e.preventDefault(); setShowSuggested(true); }}
              className="w-full mt-1.5 mb-0.5 flex items-center gap-2 text-[10px] text-sol-text-dim/70 hover:text-sol-text transition-colors"
            >
              <span className="flex-1 border-t border-sol-border/40" />
              <span className="inline-flex items-center gap-1">
                {hiddenCount} more folders on {routedDevice ? deviceDisplayName(routedDevice) : "this machine"}
                <ChevronDown className="w-3 h-3" />
              </span>
              <span className="flex-1 border-t border-sol-border/40" />
            </button>
          )}
          </>
        ) : (
          <>
            {currentPath && (
              <button
                onClick={() => handleSwitch(currentPath)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-sol-cyan/60 bg-sol-cyan/15 text-sol-cyan font-medium transition-all"
                title={`${currentPath}${sharedWith.get(currentPath) ? ` · shared with ${sharedWith.get(currentPath)}` : " · only you"}`}
              >
                <FolderGlyph />
                <span>{currentName}</span>
                <SharedWithMark team={sharedWith.get(currentPath)} />
              </button>
            )}
            {visibleProjects.map((p: { path: string }) => {
              const name = p.path.split("/").filter(Boolean).pop();
              return (
                <button
                  key={p.path}
                  onClick={() => handleSwitch(p.path)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-sol-border/40 text-sol-text-dim hover:text-sol-text hover:border-sol-cyan/40 hover:bg-sol-cyan/5 transition-all"
                  title={`${p.path}${sharedWith.get(p.path) ? ` · shared with ${sharedWith.get(p.path)}` : " · only you"}`}
                >
                  <FolderGlyph />
                  <span>{name}</span>
                  <SharedWithMark team={sharedWith.get(p.path)} />
                </button>
              );
            })}
            <button
              onClick={focusPicker}
              title="Search folders or paste any path"
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border border-dashed border-sol-border/50 text-sol-text-dim hover:text-sol-cyan hover:border-sol-cyan/40 hover:bg-sol-cyan/5 transition-all"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 12a.75.75 0 11-1.5 0 .75.75 0 011.5 0zM12.75 12a.75.75 0 11-1.5 0 .75.75 0 011.5 0zM18.75 12a.75.75 0 11-1.5 0 .75.75 0 011.5 0z" />
              </svg>
              <span>other</span>
            </button>
          </>
        )}
        </div>
      </div>

      {/* One quiet meta row instead of three stacked ones: label, worktree
          toggle, keyboard hints. While picking, the search input rides the top
          of the picker box and these hints hide. */}
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
        <NewSessionBucketPill conversation={conversation} />

        <SessionModeToggles
          cloudHost={cloudHost}
          cloudMode={cloudMode}
          cloudToggleEnabled={cloudToggleAvailable(machineChips, cloudMode)}
          onToggleCloud={toggleCloudMode}
          isolated={isolated}
          onToggleIsolated={() => {
            const turningOn = !isolated;
            useInboxStore.getState().setIsolatedWorktreeMode(turningOn);
            if (turningOn && currentPath) {
              handleSwitch(currentPath, true);
            }
          }}
          shared={cloudMode && cloudShared}
          onToggleShared={() => {
            useInboxStore.getState().setCloudSharedCheckout(isolated);
            // A row the machine pick already parked on the host re-parks with
            // the new mode (the child in flight is superseded). A deferred
            // stub reads the flag at send time, and a row the host already
            // placed keeps its checkout: neither is touched here.
            if (currentPath && storeSession?.cloud_placement === "pending" && routedMachine && isCloudHost(routedMachine)) {
              handleSwitch(currentPath, undefined, routedMachine.device_id, { onlyCloudPark: true });
            }
          }}
          startFrom={cloudStartFrom}
          onSetStartFrom={(v) => {
            useInboxStore.getState().setCloudStartFrom(v);
            // Same rule as the shared toggle: a parked row re-parks with the
            // new seed choice, a deferred stub reads it at send time.
            if (currentPath && storeSession?.cloud_placement === "pending" && routedMachine && isCloudHost(routedMachine)) {
              handleSwitch(currentPath, undefined, routedMachine.device_id, { onlyCloudPark: true });
            }
          }}
        />

        {!picking && recentProjects.length > 0 && (
          <button
            onClick={focusPicker}
            className="inline-flex items-center gap-2.5 text-[10px] opacity-40 hover:opacity-90 transition-opacity"
          >
            <HintKeys keys={[ALT_CAP, "K"]} label="pick folder" />
            <HintKeys keys={[ALT_CAP, "J"]} label="pick agent" />
          </button>
        )}
      </div>

    </div>
  );
}

// Registry-derived (shared with the mobile sheet): adding a client descriptor
// is all it takes to appear here. This surface keys by the convex spelling.
const AGENT_OPTIONS = AGENT_LAUNCH_OPTIONS.map((a) => ({ type: a.convexType, label: a.label }));

function AgentSwitcher({ conversation, showWorkflow, onToggleWorkflow, selectedWorkflowId, onSelectWorkflow, workflows, handleRef }: {
  conversation: ConversationData;
  showWorkflow: boolean;
  onToggleWorkflow: () => void;
  selectedWorkflowId: string;
  onSelectWorkflow: (id: string) => void;
  workflows: Array<{ _id: string; name: string }> | undefined;
  handleRef?: React.MutableRefObject<PickerHandle | null>;
}) {
  const convCommand = useInboxStore((s) => s.convCommand);
  // Narrowed: only _id/agent_type are read here — neither churns on a heartbeat.
  // resolveLiveSessionId follows the row across the compose popup's stub→real rekey
  // (see ProjectSwitcher) so an agent click after the create lands isn't lost.
  const storeSession = useInboxStore(useShallow((s) => {
    const sess = s.sessions[s.resolveLiveSessionId(conversation._id)];
    if (!sess) return undefined;
    return { _id: sess._id, agent_type: sess.agent_type };
  }));
  const currentAgent = storeSession?.agent_type || conversation.agent_type || "claude_code";

  const handleAgentSwitch = useCallback(async (agentType: ConvexAgentType) => {
    if (agentType === currentAgent) return;
    try {
      const id = storeSession?._id || conversation._id;
      useInboxStore.getState().setConversationAgent(id, agentType);

      if (isConvexId(id)) {
        convCommand(id, "reconfigureSession", {
          agent_type: agentType,
        }).catch((err) => {
          if (isParkedDispatchError(err)) return;
          toast.error(err instanceof Error ? err.message : "Failed to switch agent");
        });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to switch agent");
    }
  }, [storeSession, conversation._id, convCommand, currentAgent]);

  // --- keyboard mode (mirrors the project picker's) -----------------------
  // Entered via ⌥↓ from NewSessionView's chord router. Focus is held in a
  // real (1px, read-only) <input> so the capture-phase shortcut dispatcher
  // treats this as typing and single letters can't fire global hotkeys.
  const [picking, setPicking] = useState(false);
  const [hi, setHi] = useState(0);
  const holderRef = useRef<HTMLInputElement>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);

  const exitAgentPicker = useCallback((restoreFocus = true) => {
    setPicking(false);
    if (restoreFocus) restorePickerFocus(prevFocusRef.current);
  }, []);

  const focusAgentPicker = useCallback(() => {
    prevFocusRef.current = document.activeElement as HTMLElement | null;
    setHi(Math.max(0, AGENT_OPTIONS.findIndex((a) => a.type === currentAgent)));
    setPicking(true);
    return true;
  }, [currentAgent]);

  const moveAgentPicker = useCallback((delta: -1 | 1) => {
    if (!picking) prevFocusRef.current = document.activeElement as HTMLElement | null;
    setHi((i) => {
      const currentIndex = Math.max(0, AGENT_OPTIONS.findIndex((a) => a.type === currentAgent));
      const base = picking ? i : currentIndex;
      return (base + delta + AGENT_OPTIONS.length) % AGENT_OPTIONS.length;
    });
    setPicking(true);
    return true;
  }, [currentAgent, picking]);

  // Post-commit focus — same race as the project picker's (see note there).
  useWatchEffect(() => {
    if (picking) holderRef.current?.focus();
  }, [picking]);

  const handleAgentKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowRight" || (e.altKey && e.code === "KeyL")) {
      e.preventDefault();
      setHi((i) => (i + 1) % AGENT_OPTIONS.length);
      return;
    }
    if (e.key === "ArrowLeft" || (e.altKey && e.code === "KeyH")) {
      e.preventDefault();
      setHi((i) => (i - 1 + AGENT_OPTIONS.length) % AGENT_OPTIONS.length);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const sel = AGENT_OPTIONS[Math.min(hi, AGENT_OPTIONS.length - 1)];
      if (sel) {
        handleAgentSwitch(sel.type);
        if (showWorkflow) onToggleWorkflow();
      }
      exitAgentPicker();
      return;
    }
    // ↓/Esc/Tab drop back to the message box. ⌥↑ (chord router) climbs to
    // the project picker; our holder input exits via onBlur when focus moves.
    if (e.key === "ArrowDown" || e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      exitAgentPicker();
    }
  }, [hi, handleAgentSwitch, exitAgentPicker, showWorkflow, onToggleWorkflow]);

  // Hand the imperative surface up to NewSessionView's ⌥-chord router.
  useWatchEffect(() => {
    if (!handleRef) return;
    handleRef.current = {
      focus: focusAgentPicker,
      isOpen: () => picking,
      move: moveAgentPicker,
    };
  });
  useWatchEffect(() => () => { if (handleRef) handleRef.current = null; }, [handleRef]);

  return (
    <div className="flex flex-col items-center gap-2 px-4 pb-7">
      <div className={`flex flex-wrap items-center justify-center gap-1.5 rounded-lg transition-all ${picking ? "ring-1 ring-sol-cyan/40 bg-sol-cyan/[0.03] p-1.5" : ""}`}>
        {AGENT_OPTIONS.map((a, i) => {
          const isActive = currentAgent === a.type && !showWorkflow;
          const isHi = picking && i === hi;
          return (
            <button
              key={a.type}
              onClick={() => { handleAgentSwitch(a.type); if (showWorkflow) onToggleWorkflow(); }}
              onMouseEnter={() => { if (picking) setHi(i); }}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border whitespace-nowrap transition-all ${
                isHi
                  ? "border-sol-cyan/70 bg-sol-cyan/15 text-sol-cyan ring-1 ring-sol-cyan/50"
                  : isActive
                    ? a.type === "claude_code"
                      ? "bg-sol-yellow/15 text-sol-yellow border-sol-yellow/40"
                      : a.type === "codex"
                        ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/40"
                        : a.type === "cursor"
                          ? "bg-purple-500/15 text-purple-400 border-purple-500/40"
                          : "bg-blue-500/15 text-blue-400 border-blue-500/40"
                    : "border-sol-border/30 text-sol-text-dim hover:text-sol-text hover:border-sol-border/60"
              }`}
            >
              <AgentTypeIcon agentType={a.type} />
              {a.label}
            </button>
          );
        })}
        <span className="text-sol-border/50 text-xs">|</span>
        <LaunchModelPill conversationId={storeSession?._id || conversation._id} />
        <AgentDefinitionPill conversationId={storeSession?._id || conversation._id} />
      </div>

      {picking && (
        <div className="flex items-center gap-2 text-[11px] font-mono">
          <input
            ref={holderRef}
            readOnly
            value=""
            onKeyDown={handleAgentKeyDown}
            onBlur={() => exitAgentPicker(false)}
            aria-label="choose agent"
            className="w-px bg-transparent outline-none border-0 p-0 caret-transparent"
          />
          <span className="inline-flex items-center gap-2">
            <HintKeys keys={["←", "→"]} label="move" />
            <HintKeys keys={["↵"]} label="select" />
            <HintKeys keys={[ALT_CAP, "↑"]} label="folder" />
            <HintKeys keys={["Esc"]} label="back" />
          </span>
        </div>
      )}

      {showWorkflow && (
        <select
          value={selectedWorkflowId}
          onChange={(e) => onSelectWorkflow(e.target.value)}
          className="w-full max-w-sm px-3 py-1.5 text-xs bg-sol-bg-alt border border-sol-violet/40 rounded-lg text-sol-text focus:outline-none focus:border-sol-violet/70"
        >
          <option value="">Select a workflow...</option>
          {(workflows || []).map((wf) => (
            <option key={wf._id} value={wf._id}>{wf.name}</option>
          ))}
        </select>
      )}
    </div>
  );
}

/**
 * The new-session "null state" pickers — project picker (tabs + isolated-worktree
 * toggle) + agent picker — for a conversation with no messages yet. This is the
 * ONE definition used both by the in-app empty conversation (ConversationView's
 * empty state) and the floating compose popup (ComposeView). The message input
 * stays with each host (the in-app rich MessageInput pinned at the bottom; the
 * popup's lightweight one) since they need very different wiring. Pass
 * `agentControls` to drive workflow selection from the host; omitted, it manages
 * its own local state (the popup case).
 */
// Subtle bucket affordance on the new-session surface: invisible when the user
// has no buckets; otherwise a small pill showing where this session will be
// filed (defaults to the focused bucket chip). Click opens the same palette
// picker the Ctrl+Shift+M chord uses.
function NewSessionBucketPill({ conversation }: { conversation: ConversationData }) {
  const buckets = useInboxStore((st) => st.buckets);
  const bucketAssignments = useInboxStore((st) => st.bucketAssignments);
  // Auto-filing applies only to an INCLUDE label chip — an excluded label must
  // never claim new blanks.
  const activeBucketFilter = useInboxStore((st) => (st.chipFilterExclude ? null : st.activeBucketFilter));
  const convId = conversation._id;

  const visibleBuckets = useMemo(
    () => (Object.values(buckets) as BucketItem[]).filter((b) => !b.archived_at),
    [buckets],
  );
  const assigned = useMemo(() => {
    const bucketId = convBucketMap(bucketAssignments)[convId];
    return bucketId ? (buckets[bucketId] ?? null) : null;
  }, [bucketAssignments, buckets, convId]);

  // A pre-warmed blank opened while a bucket chip is focused files itself there
  // (the create-time stamp in beginOptimisticSession covers fresh creates; this
  // covers blanks that existed before the filter was set).
  useWatchEffect(() => {
    if (!activeBucketFilter || assigned) return;
    const store = useInboxStore.getState();
    const real = store.getConvexId(convId) ?? convId;
    if (!isConvexId(real)) return;
    if (Object.values(store.bucketAssignments).some((row) => row.conversation_id === real)) return;
    store.assignSessionToBucket(real, activeBucketFilter);
  }, [convId, activeBucketFilter, assigned]);

  if (visibleBuckets.length === 0) return null;

  const openPicker = () => {
    const store = useInboxStore.getState();
    const session = store.sessions[convId];
    if (session) store.openPalette({ targets: [session], targetType: "session", mode: "bucket" });
  };
  const color = assigned ? getLabelColor(assigned.name) : null;
  return (
    <button
      onClick={openPicker}
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] leading-4 transition-colors ${
        assigned && color
          ? "border-sol-border/40 bg-sol-bg-alt/40 hover:border-sol-border/70"
          : "border-dashed border-sol-border/50 text-sol-text-dim/60 hover:text-sol-cyan hover:border-sol-cyan/40 hover:bg-sol-cyan/5"
      }`}
      title="Choose a label for this session"
    >
      {assigned && color ? (
        <>
          <span className={`w-1.5 h-1.5 rounded-[2px] ${color.dot}`} />
          <span className={color.text}>{assigned.name}</span>
        </>
      ) : (
        <span>+ label</span>
      )}
    </button>
  );
}

export function NewSessionView({ conversation, agentControls }: { conversation: ConversationData; agentControls?: NewSessionAgentControls }) {
  const [localShowWorkflow, setLocalShowWorkflow] = useState(false);
  const [localWorkflowId, setLocalWorkflowId] = useState("");
  const ac: NewSessionAgentControls = agentControls ?? {
    showWorkflow: localShowWorkflow,
    onToggleWorkflow: () => setLocalShowWorkflow((v) => !v),
    selectedWorkflowId: localWorkflowId,
    onSelectWorkflow: setLocalWorkflowId,
    workflows: undefined,
  };
  // Spatial ⌥-chords for the whole new-session surface, capture-phase on
  // window so they work no matter what holds focus (textarea, toggle, body):
  // ⌥↑ climbs to the project picker; ⌥↓ drops to the agent row,
  // committing the picker's highlighted project on the way through. Enter
  // inside either picker returns focus to the input. Self-gating: the listener
  // exists only while this null-state surface is mounted. Chord resolution
  // (including releasing ⌥←/⌥→ word jump to a text caret) lives in
  // altChordDirection.
  const projectsRef = useRef<PickerHandle | null>(null);
  const agentsRef = useRef<PickerHandle | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The machine picker's logic lives in ProjectSwitcher (a machine pick scopes
  // the folder list), but it renders down on the Context line — this slot is
  // the portal target StableContextPicker mounts at the end of that line.
  const [machineSlot, setMachineSlot] = useState<HTMLElement | null>(null);
  useMountEffect(() => {
    const onChord = (e: KeyboardEvent) => {
      // altChordDirection also releases ⌥←/⌥→ from a text caret (word jump).
      const dir = altChordDirection(e);
      if (!dir) return;
      // The compose dialog hosts this surface inside an aria-modal container —
      // a modal that CONTAINS us doesn't block the chords, only one stacked
      // above (draft confirm, settings) does.
      if (hasOpenModal(rootRef.current)) return;
      // Docked composers are non-modal and several mount at once, each with
      // this listener: only the one holding focus answers.
      const dock = rootRef.current?.closest('[role="dialog"]:not([aria-modal="true"])');
      if (dock && !dock.contains(document.activeElement)) return;
      e.preventDefault();
      e.stopPropagation();
      if (dir === "left" || dir === "right") {
        const delta: -1 | 1 = dir === "left" ? -1 : 1;
        if (projectsRef.current?.isOpen()) projectsRef.current.move?.(delta);
        else agentsRef.current?.move?.(delta);
      } else if (dir === "up") {
        if (!projectsRef.current?.isOpen()) projectsRef.current?.focus();
      } else {
        if (projectsRef.current?.isOpen()) projectsRef.current.commitAndClose?.();
        if (!agentsRef.current?.isOpen()) agentsRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onChord, true);
    return () => window.removeEventListener("keydown", onChord, true);
  });

  // Project picker sits up top; a flex spacer pushes the agent picker down so it
  // pins to the bottom, directly above the message input (the host renders the
  // input right after this view). Needs a full-height parent.
  return (
    <div ref={rootRef} className="flex flex-col items-center w-full flex-1 min-h-0">
      <ErrorBoundary name="ProjectSwitcher" level="inline">
        <ProjectSwitcher conversation={conversation} handleRef={projectsRef} machineSlot={machineSlot} />
      </ErrorBoundary>
      <div className="flex-1" />
      <ErrorBoundary name="StableContextPicker" level="inline">
        <div className="w-full px-4 mb-4">
          <StableContextPicker
            conversationId={conversation._id}
            trailing={<div ref={setMachineSlot} className="flex-shrink-0 min-w-0" />}
          />
        </div>
      </ErrorBoundary>
      <AgentSwitcher
        conversation={conversation}
        showWorkflow={ac.showWorkflow}
        onToggleWorkflow={ac.onToggleWorkflow}
        selectedWorkflowId={ac.selectedWorkflowId}
        onSelectWorkflow={ac.onSelectWorkflow}
        workflows={ac.workflows}
        handleRef={agentsRef}
      />
    </div>
  );
}

function ConversationSkeleton() {
  return (
    <div className="conv-col mx-auto px-4 py-4 space-y-6 animate-pulse motion-reduce:animate-none">
      <div className="bg-sol-blue/10 border border-sol-blue/30 rounded-lg p-4">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-6 h-6 rounded bg-sol-blue/30" />
          <div className="h-3 w-12 bg-sol-blue/30 rounded" />
          <div className="h-3 w-16 bg-sol-blue/20 rounded" />
        </div>
        <div className="pl-8 space-y-2">
          <div className="h-3 bg-sol-blue/20 rounded w-3/4" />
          <div className="h-3 bg-sol-blue/20 rounded w-1/2" />
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-6 h-6 rounded bg-sol-orange/60" />
          <div className="h-3 w-14 bg-sol-bg-alt rounded" />
          <div className="h-3 w-16 bg-sol-bg-alt rounded" />
        </div>
        <div className="pl-8 space-y-2">
          <div className="h-3 bg-sol-bg-alt rounded w-full" />
          <div className="h-3 bg-sol-bg-alt rounded w-5/6" />
          <div className="h-3 bg-sol-bg-alt rounded w-4/5" />
        </div>
      </div>

      <div className="bg-sol-blue/10 border border-sol-blue/30 rounded-lg p-4">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-6 h-6 rounded bg-sol-blue/30" />
          <div className="h-3 w-12 bg-sol-blue/30 rounded" />
          <div className="h-3 w-16 bg-sol-blue/20 rounded" />
        </div>
        <div className="pl-8">
          <div className="h-3 bg-sol-blue/20 rounded w-2/3" />
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-6 h-6 rounded bg-sol-orange/60" />
          <div className="h-3 w-14 bg-sol-bg-alt rounded" />
          <div className="h-3 w-16 bg-sol-bg-alt rounded" />
        </div>
        <div className="pl-8 space-y-2">
          <div className="h-3 bg-sol-bg-alt rounded w-full" />
          <div className="h-3 bg-sol-bg-alt rounded w-11/12" />
          <div className="h-3 bg-sol-bg-alt rounded w-3/4" />
          <div className="h-3 bg-sol-bg-alt rounded w-5/6" />
        </div>
      </div>
    </div>
  );
}

function GuestJoinCTA() {
  return (
    <div className="bg-sol-bg border-t border-sol-border/30">
      <div className="mx-auto conv-col px-2 sm:px-4 py-3 flex items-center justify-between gap-4">
        <a href="/" className="flex items-center gap-2 text-sol-text-dim text-xs hover:text-sol-text transition-colors">
          <LogoIcon size={20} />
          <span className="font-mono font-bold text-sol-text-muted tracking-tight">codecast</span>
          <span className="opacity-50">|</span>
          <span>AI session sharing</span>
        </a>
        <a
          href="/signup"
          className="text-xs font-medium px-4 py-1.5 rounded-full bg-sol-cyan/15 text-sol-cyan border border-sol-cyan/30 hover:bg-sol-cyan/25 transition-colors whitespace-nowrap"
        >
          Join to message
        </a>
      </div>
    </div>
  );
}

// Isolated component: keeps useConvexAuth() out of ConversationView's render
// scope so auth-context re-renders don't cascade through the tooltip ref chain.
export function NonOwnerMessageInput({ conversation, onForkReply, autoFocusInput }: {
  conversation: ConversationData;
  onForkReply: (content: string) => void;
  autoFocusInput?: boolean;
}) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  if (!isAuthenticated && !isLoading) return <GuestJoinCTA />;
  // Signed-in non-owner: a grant-aware composer that can co-write, request send
  // access, send into the live session once granted, or fork as a fallback.
  return (
    <CollabComposer
      conversation={conversation}
      onForkReply={onForkReply}
      autoFocusInput={autoFocusInput}
    />
  );
}
