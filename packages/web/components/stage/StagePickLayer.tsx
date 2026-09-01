"use client";
// "Where should this open?" — the split stage's answer to an ambiguous click.
//
// A navigation that starts OUTSIDE the stage (a sidebar section, a session
// card in the rail) has no obvious destination once the stage is split.
// Instead of guessing, the stage overlays its cells in the same visual
// language as the drag preview: hover lights a pane, click places the
// navigation there, Esc (or a click on the veil's edge chip) cancels. One
// extra click, total control — and because it shares the drop preview's
// geometry and styling, the two gestures read as one system.

import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { useInboxStore, useTrackedStore, type AppTab } from "../../store/inboxStore";
import { stageGeometry } from "../../store/stageSplit";
import { placeStagePick, tabStageLayout } from "../../lib/stage";
import { pathLabel } from "../../lib/pathLabel";
import { hasOpenModal } from "../../shortcuts/registry";
import { PageIcon } from "../RecentVisitRow";

export function StagePickLayer({ tab, enabled }: { tab: AppTab; enabled: boolean }) {
  const s = useTrackedStore([(st) => st.stagePick]);
  const pick = enabled ? s.stagePick : null;
  const layout = tabStageLayout(tab);
  const geo = useMemo(() => (layout ? stageGeometry(layout) : null), [layout]);
  const [hover, setHover] = useState<string | null>(null);

  const cancel = useCallback(() => useInboxStore.getState().setStagePick(null), []);

  // Esc cancels; Enter takes the hovered pane, or the focused one — a full
  // keyboard path through the picker. Listeners exist only while a pick is up.
  useEffect(() => {
    if (!pick) return;
    const onKey = (e: KeyboardEvent) => {
      // The veil covers only the stage — the palette or a modal can open on
      // top of it, and their Esc must win (same guard as DetailSplitLayout).
      if (hasOpenModal()) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        const st = useInboxStore.getState();
        const t = st.tabs.find((x) => x.id === st.activeTabId);
        const target = hover ?? t?.focusedLeafId;
        if (target) placeStagePick({ leafId: target });
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [pick, cancel, hover]);

  // A pick with nothing to choose (layout collapsed meanwhile) resolves to
  // plain navigation instead of stranding the request.
  useEffect(() => {
    if (pick && !layout) placeStagePick("newTab");
  }, [pick, layout]);

  if (!pick || !geo) return null;
  const title = pick.title ?? pathLabel(pick.path);

  return (
    <div className="stage-drop-veil stage-pick absolute inset-0 z-50" aria-modal onClick={cancel}>
      {geo.leaves.map((l) => (
        <div
          key={l.id}
          className={`stage-drop-cell stage-pick__cell${hover === l.id ? " stage-drop-cell--target" : ""}`}
          style={{ left: `${l.rect.left}%`, top: `${l.rect.top}%`, width: `${l.rect.width}%`, height: `${l.rect.height}%` }}
          onMouseEnter={() => setHover(l.id)}
          onMouseLeave={() => setHover((h) => (h === l.id ? null : h))}
          onClick={(e) => {
            e.stopPropagation();
            placeStagePick({ leafId: l.id });
          }}
        >
          {hover === l.id && (
            <div className="stage-drop-chip">
              <span className="stage-drop-chip__verb">Open here</span>
              <span className="stage-drop-chip__title">{title}</span>
            </div>
          )}
        </div>
      ))}
      {/* The question, and the ways out that aren't a pane. */}
      <div className="stage-pick__bar" onClick={(e) => e.stopPropagation()}>
        <PageIcon path={pick.path} className="w-3.5 h-3.5 text-sol-text-dim" />
        <span className="stage-pick__title">{title}</span>
        <span className="stage-pick__hint">choose a pane</span>
        <button className="stage-pick__action" onClick={() => placeStagePick("newTab")}>
          New tab
        </button>
        <button className="stage-pick__action stage-pick__action--quiet" onClick={cancel} title="Cancel (Esc)">
          <X className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
