import { useCallback, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { LayoutDashboard, Users, UserMinus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useInboxStore, type SavedViewRow } from "../store/inboxStore";
import { chipFilterOf, matchesWorkbench, type WorkbenchSnapshot } from "../store/workbench";
import { switchToWorkbench, sortedWorkbenches } from "../lib/workbenchSwitch";
import { KeyCap } from "./KeyboardShortcutsHelp";
import { getShortcutsForAction, formatShortcutParts, type ShortcutAction } from "../shortcuts";

// Saved layouts (store/workbench.ts): the whole chrome arrangement as a named,
// one-click switch. Nothing ships by default — every row here is one the user
// saved from a real arrangement, and adjusting one is the same gesture in
// reverse: switch to it, move the panels, hit update. No per-panel controls
// appear anywhere; the point of a workbench is that you stop touching panels.

function keyHint(action: ShortcutAction): string[] | null {
  const defs = getShortcutsForAction(action);
  return defs.length ? formatShortcutParts(defs[0]) : null;
}

export function WorkbenchSection({
  isNarrow,
  onMobileClose,
}: {
  isNarrow: boolean;
  onMobileClose?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const workspace = useInboxStore((s) => s.workspace);
  const zen = useInboxStore((s) => s.clientState.ui?.zen_mode ?? false);
  const savedViewRows = useInboxStore((s) => s.savedViews);
  const activeWorkbenchId = useInboxStore((s) => s.activeWorkbenchId);
  const saveWorkbench = useInboxStore((s) => s.saveWorkbench);
  const updateWorkbench = useInboxStore((s) => s.updateWorkbench);
  const deleteSavedView = useInboxStore((s) => s.deleteSavedView);
  const updateSavedView = useInboxStore((s) => s.updateSavedView);
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  // The chip filter is part of the layout, so matching reads it too. Selected
  // field by field: one selector returning the composed filter would hand
  // zustand a fresh object every render.
  const activeBucketFilter = useInboxStore((s) => s.activeBucketFilter);
  const activeProjectFilter = useInboxStore((s) => s.activeProjectFilter);
  const activeProjectPath = useInboxStore((s) => s.activeProjectPath);
  const chipFilterExclude = useInboxStore((s) => s.chipFilterExclude);
  const buckets = useInboxStore((s) => s.buckets);

  const liveFilter = useMemo(
    () => chipFilterOf({ activeBucketFilter, activeProjectFilter, activeProjectPath, chipFilterExclude, buckets }),
    [activeBucketFilter, activeProjectFilter, activeProjectPath, chipFilterExclude, buckets],
  );

  const saved = useMemo(
    () => sortedWorkbenches({ savedViews: savedViewRows ?? {}, clientState: { ui: { active_team_id: activeTeamId } } }),
    [savedViewRows, activeTeamId],
  );

  // The row you are "in". The stamped id (last switch) wins, so the highlight
  // survives while you adjust panels away from the saved shape — exactly the
  // moment the update affordance matters. Matching is the fallback for an
  // arrangement that happens to equal a workbench you never clicked.
  const activeId = useMemo(() => {
    if (activeWorkbenchId && saved.some((v) => v._id === activeWorkbenchId)) return activeWorkbenchId;
    return saved.find((v) => matchesWorkbench(workspace, v.prefs as WorkbenchSnapshot, { zen, filter: liveFilter, buckets }))?._id;
  }, [workspace, zen, saved, activeWorkbenchId, liveFilter, buckets]);

  // Drifted from the saved shape → the active row offers update without hover.
  const activeIsDirty = useMemo(() => {
    const v = saved.find((r) => r._id === activeId);
    return !!v && !matchesWorkbench(workspace, v.prefs as WorkbenchSnapshot, { zen, filter: liveFilter, buckets });
  }, [saved, activeId, workspace, zen, liveFilter, buckets]);

  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const apply = useCallback(
    (v: SavedViewRow) => {
      switchToWorkbench(v.prefs as WorkbenchSnapshot, router, pathname, v._id);
      onMobileClose?.();
    },
    [router, pathname, onMobileClose],
  );

  const commitSave = useCallback(() => {
    const trimmed = name.trim();
    setNaming(false);
    setName("");
    if (!trimmed) return;
    saveWorkbench(trimmed, pathname ?? undefined);
    toast.success(`Saved the current layout as "${trimmed}"`);
  }, [name, pathname, saveWorkbench]);

  const update = useCallback(
    (v: SavedViewRow) => {
      updateWorkbench(v._id, pathname ?? undefined);
      toast.success(`"${v.name}" now matches the current layout`);
    },
    [updateWorkbench, pathname],
  );

  // The narrow rail is icon-only navigation; a layout switcher earns no icon
  // there, and the empty state would be unreadable. Wide rail only.
  if (isNarrow) return null;

  return (
    <div className="mt-4 mb-1">
      <div className="flex items-center px-4 mb-1">
        <span className="flex-1 text-xs font-medium text-sol-text-dim uppercase tracking-wide">Layouts</span>
        {!naming && (
          <button
            onClick={() => setNaming(true)}
            className="p-0.5 opacity-60 hover:opacity-100 text-sol-text-dim hover:text-sol-text transition-all"
            title="Save the current layout"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" d="M12 5v14m-7-7h14" />
            </svg>
          </button>
        )}
      </div>
      <div className="text-sm">
        {saved.length === 0 && !naming && (
          <button
            onClick={() => setNaming(true)}
            className="w-full flex items-center gap-2.5 px-4 py-1.5 text-left text-[13px] text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-highlight/40 transition-colors"
          >
            <LayoutDashboard className="w-3.5 h-3.5 flex-shrink-0" />
            <span>Save current layout…</span>
          </button>
        )}
        {saved.map((v, i) => {
          const active = v._id === activeId;
          const hint = i < 9 ? keyHint(`workbench.${i + 1}` as ShortcutAction) : null;
          const mine = v.is_mine !== false;
          const showUpdateAlways = active && activeIsDirty && mine;
          return (
            <div
              key={v._id}
              className={`flex items-center group/wb border-l-2 transition-colors motion-reduce:transition-none ${
                active
                  ? "bg-sol-bg-highlight text-sol-text border-sol-cyan"
                  : "text-sol-text-muted border-transparent hover:text-sol-text hover:bg-sol-bg-highlight/60"
              }`}
            >
              <button
                onClick={() => apply(v)}
                className="flex-1 flex items-center gap-2.5 px-4 py-1.5 min-w-0 text-left"
                title={`Switch to "${v.name}"`}
                aria-current={active ? "true" : undefined}
              >
                <LayoutDashboard className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="truncate text-[13px] min-w-0">{v.name}</span>
                {v.shared && (
                  <span title={mine ? "Shared with your team" : `Shared by ${v.owner_name ?? "a teammate"}`}>
                    <Users className="w-3 h-3 flex-shrink-0 text-sol-text-dim" />
                  </span>
                )}
              </button>
              {/* Update is THE adjust gesture — pinned visible the moment the
                  active layout drifts from what this row has saved. */}
              {showUpdateAlways && (
                <button
                  onClick={() => update(v)}
                  className="p-1 mr-1 rounded text-sol-cyan hover:text-sol-text flex-shrink-0"
                  title="Update to the current layout"
                >
                  <RefreshCw className="w-3 h-3" />
                </button>
              )}
              {mine && !showUpdateAlways && (
                <span className="hidden group-hover/wb:flex items-center flex-shrink-0 mr-1">
                  <button
                    onClick={() => update(v)}
                    className="p-1 rounded text-sol-text-dim hover:text-sol-text flex-shrink-0"
                    title="Update to the current layout"
                  >
                    <RefreshCw className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => {
                      if (!activeTeamId && !v.shared) {
                        toast.error("Pick a team first — a shared layout needs a team to share with");
                        return;
                      }
                      updateSavedView(v._id, { shared: !v.shared, team_id: v.team_id ?? activeTeamId });
                      toast.success(v.shared ? `"${v.name}" is private again` : `"${v.name}" shared with your team`);
                    }}
                    className="p-1 rounded text-sol-text-dim hover:text-sol-text flex-shrink-0"
                    title={v.shared ? "Stop sharing with your team" : "Share with your team"}
                  >
                    {v.shared ? <UserMinus className="w-3 h-3" /> : <Users className="w-3 h-3" />}
                  </button>
                  <button
                    onClick={() => deleteSavedView(v._id)}
                    className="p-1 rounded text-sol-text-dim hover:text-sol-text flex-shrink-0"
                    title="Remove saved layout"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              )}
              {hint && (
                <span className={`flex items-center gap-0.5 mr-2 flex-shrink-0 ${mine && !showUpdateAlways ? "group-hover/wb:hidden" : ""}`}>
                  {hint.map((part, j) => (
                    <KeyCap key={j} size="xs">{part}</KeyCap>
                  ))}
                </span>
              )}
            </div>
          );
        })}
        {naming && (
          <div className="px-4 py-1">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitSave();
                if (e.key === "Escape") { setNaming(false); setName(""); }
              }}
              onBlur={commitSave}
              placeholder="Name this layout…"
              className="w-full bg-sol-bg-alt border border-sol-border rounded px-2 py-1 text-[13px] text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-cyan"
            />
          </div>
        )}
      </div>
    </div>
  );
}
