"use client";
// A pane folded to a rail while another leaf takes the width
// (store.stageWide): the pane's icon and its title read down the strip, and
// a click brings the arrangement back. Drawn by the stage for a sibling leaf
// and by the shell for the session rail, so the two fold the same way.
import { PageIcon } from "../RecentVisitRow";
import { STAGE_RAIL_PX } from "../../store/stageSplit";

export function StageRail({ side, title, path, onRestore }: { side: "left" | "right"; title: string; path: string; onRestore: () => void }) {
  return (
    <button
      type="button"
      onClick={onRestore}
      title={`Show ${title}`}
      aria-label={`Show ${title}`}
      data-stage-rail={side}
      className={`h-full shrink-0 flex flex-col items-center gap-2 pt-2.5 select-none transition-colors hover:bg-sol-bg-highlight/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset ${side === "left" ? "border-r" : "border-l"}`}
      style={{ width: STAGE_RAIL_PX, background: "var(--sol-bg-alt)", borderColor: "var(--cc-panel-rule)", ["--tw-ring-color" as string]: "var(--sol-cyan)" }}
    >
      <PageIcon path={path} className="w-3.5 h-3.5 shrink-0 text-sol-text-dim" />
      <span className="min-h-0 truncate text-[11px] font-medium" style={{ color: "var(--sol-text-muted)", writingMode: "vertical-rl" }}>
        {title}
      </span>
    </button>
  );
}
