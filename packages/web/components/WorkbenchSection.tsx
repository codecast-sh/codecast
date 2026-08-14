import { useCallback, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Zap, Hammer, Eye, Map, LayoutDashboard, Users, UserMinus } from "lucide-react";
import { toast } from "sonner";
import { useInboxStore, type SavedViewRow } from "../store/inboxStore";
import { WORKBENCH_PRESETS, matchesWorkbench, type WorkbenchSnapshot } from "../store/workbench";
import { switchToWorkbench } from "../lib/workbenchSwitch";
import { KeyCap } from "./KeyboardShortcutsHelp";
import { getShortcutsForAction, formatShortcutParts, type ShortcutAction } from "../shortcuts";

// The workbench rail: the whole chrome arrangement as a named, one-click
// switch (store/workbench.ts). Four presets carry ⌥1–⌥4; anything you save
// yourself lists after them. No per-panel controls appear anywhere here — the
// point of a workbench is that you stop touching individual panels.

const PRESET_ICONS: Record<string, React.ReactNode> = {
  "wb-triage": <Zap className="w-3.5 h-3.5 flex-shrink-0" />,
  "wb-build": <Hammer className="w-3.5 h-3.5 flex-shrink-0" />,
  "wb-review": <Eye className="w-3.5 h-3.5 flex-shrink-0" />,
  "wb-plan": <Map className="w-3.5 h-3.5 flex-shrink-0" />,
};

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
  const saveWorkbench = useInboxStore((s) => s.saveWorkbench);
  const deleteSavedView = useInboxStore((s) => s.deleteSavedView);
  const updateSavedView = useInboxStore((s) => s.updateSavedView);
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);

  const saved = useMemo(
    () =>
      (Object.values(savedViewRows ?? {}) as SavedViewRow[])
        .filter((v) => v.page === "workspace" && (!v.team_id || v.team_id === activeTeamId))
        .sort((a, b) => Number(!!b.is_mine) - Number(!!a.is_mine) || (a.name || "").localeCompare(b.name || "")),
    [savedViewRows, activeTeamId],
  );

  // Which arrangement the chrome currently IS — matching, not bookkeeping, so
  // hand-wrecking the layout honestly deselects. Presets first, so a saved
  // copy of a preset doesn't shadow it.
  const activeId = useMemo(() => {
    for (const p of WORKBENCH_PRESETS) {
      if (matchesWorkbench(workspace, p.snapshot, { zen })) return p.id;
    }
    for (const v of saved) {
      if (matchesWorkbench(workspace, v.prefs as WorkbenchSnapshot, { zen })) return v._id;
    }
    return undefined;
  }, [workspace, zen, saved]);

  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const apply = useCallback(
    (snap: WorkbenchSnapshot) => {
      switchToWorkbench(snap, router, pathname);
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

  const row = (opts: {
    id: string;
    label: string;
    icon: React.ReactNode;
    onSelect: () => void;
    hint?: string[] | null;
    actions?: React.ReactNode;
  }) => {
    const active = opts.id === activeId;
    return (
      <div
        key={opts.id}
        className={`flex items-center group/wb border-l-2 transition-colors motion-reduce:transition-none ${
          active
            ? "bg-sol-bg-highlight text-sol-text border-sol-cyan"
            : "text-sol-text-muted border-transparent hover:text-sol-text hover:bg-sol-bg-highlight/60"
        }`}
      >
        <button
          onClick={opts.onSelect}
          className={`flex-1 flex items-center min-w-0 ${isNarrow ? "justify-center px-0 py-2" : "gap-2.5 px-4 py-1.5"} text-left`}
          title={opts.label}
          aria-current={active ? "true" : undefined}
        >
          {opts.icon}
          {!isNarrow && <span className="truncate text-[13px] min-w-0">{opts.label}</span>}
        </button>
        {!isNarrow && opts.actions && (
          <span className="hidden group-hover/wb:flex items-center flex-shrink-0 mr-1">{opts.actions}</span>
        )}
        {!isNarrow && opts.hint && (
          <span className={`flex items-center gap-0.5 mr-2 flex-shrink-0 ${opts.actions ? "group-hover/wb:hidden" : ""}`}>
            {opts.hint.map((part, i) => (
              <KeyCap key={i} size="xs">{part}</KeyCap>
            ))}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="mb-1">
      <div className={`flex items-center ${isNarrow ? "justify-center" : "px-4"} mb-1 mt-1`}>
        {!isNarrow && (
          <span className="flex-1 text-xs font-medium text-sol-text-dim uppercase tracking-wide">Workbenches</span>
        )}
        {!isNarrow && !naming && (
          <button
            onClick={() => setNaming(true)}
            className="p-0.5 opacity-60 hover:opacity-100 text-sol-text-dim hover:text-sol-text transition-all"
            title="Save the current layout as a workbench"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" d="M12 5v14m-7-7h14" />
            </svg>
          </button>
        )}
      </div>
      <div className="text-sm">
        {WORKBENCH_PRESETS.map((p, i) =>
          row({
            id: p.id,
            label: p.name,
            icon: PRESET_ICONS[p.id] ?? <LayoutDashboard className="w-3.5 h-3.5 flex-shrink-0" />,
            onSelect: () => apply(p.snapshot),
            hint: keyHint(`workbench.${i + 1}` as ShortcutAction),
          }),
        )}
        {saved.map((v) =>
          row({
            id: v._id,
            label: v.name,
            icon: <LayoutDashboard className="w-3.5 h-3.5 flex-shrink-0" />,
            onSelect: () => apply(v.prefs as WorkbenchSnapshot),
            actions:
              v.is_mine === false ? undefined : (
                <>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!activeTeamId && !v.shared) {
                        toast.error("Pick a team first — a shared workbench needs a team to share with");
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
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteSavedView(v._id);
                    }}
                    className="p-1 rounded text-sol-text-dim hover:text-sol-text flex-shrink-0"
                    title="Remove workbench"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </>
              ),
          }),
        )}
        {naming && !isNarrow && (
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
