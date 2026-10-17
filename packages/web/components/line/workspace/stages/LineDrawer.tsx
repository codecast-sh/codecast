"use client";
// What opens from the Map slides in from the right as a drawer, the graph
// staying in view behind it (line-journeys.md LJ8.6 keeps the Table's step a
// page of its own): a station of a run (StepPage) or a stage before the runs
// (stages/*). Esc, the close button, or a press on the graph behind closes
// it; the address holds it, so a link opens on it.
import { type ReactNode } from "react";
import { X } from "lucide-react";
import { KeyCap } from "../../../KeyCap";
import { LINE_STAGES, type LineStage } from "../../../../lib/line/lineWorkspaceUrl";
import type { LineViewProps } from "../views/types";
import { MomentsStage } from "./MomentsStage";
import { ExpectationsStage } from "./ExpectationsStage";
import { JudgesStage } from "./JudgesStage";
import { GroupingStage } from "./GroupingStage";
import { DispatchStage } from "./DispatchStage";
import "./stages.css";

export const STAGE_NAMES: Record<LineStage, string> = { moments: "Moments", expectations: "Expectations", judges: "Judges", grouping: "Grouping", dispatch: "Dispatch" };

/** The drawer's frame: what it holds, a way to the other stages, and close. */
export function LineDrawer({ label, onClose, children, nav, edge }: { label: string; onClose: () => void; children: ReactNode; nav?: ReactNode; /** A resize handle on the drawer's left edge. */ edge?: ReactNode }) {
  return (
    <aside className="lw-drawer" aria-label={label} data-line-drawer={label}>
      {edge}
      <header className="lw-drawer-head">
        {nav}
        <button type="button" className="lw-iconbtn lw-drawer-close" onClick={onClose} aria-label="Close" title="Close (Esc)" data-line-drawer-close>
          <X className="w-4 h-4" aria-hidden />
        </button>
      </header>
      <div className="lw-drawer-body">{children}</div>
    </aside>
  );
}

/** Scrolls the head's strip, and only it, so the open tab shows (scrollIntoView would scroll the app's shell too). */
const showInStrip = (el: HTMLElement | null) => {
  const strip = el?.parentElement;
  if (!el || !strip) return;
  if (el.offsetLeft < strip.scrollLeft || el.offsetLeft + el.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = el.offsetLeft - 8;
};

/** A stage's drawer: the stages in flow order across its head, the open one its page below. */
export function StageDrawer(props: LineViewProps & { stage: LineStage; projectId: string | null }) {
  const { stage, select, href } = props;
  const nav = (
    <nav className="sd-flow" aria-label="Stages">
      {LINE_STAGES.map((s, i) => (
        <a key={s} href={href({ stage: s, item: null })} aria-current={s === stage ? "page" : undefined}
          // The open stage's tab stays in view when the head scrolls (a narrow screen).
          ref={s === stage ? showInStrip : undefined}
          onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); select({ stage: s, item: null }, undefined, { replace: true }); }} data-line-drawer-stage={s}>
          <span className="sd-flow-i lw-num">{i + 1}</span>{STAGE_NAMES[s]}
        </a>
      ))}
      <span className="sd-flow-key" aria-hidden><KeyCap size="xs">Esc</KeyCap></span>
    </nav>
  );
  const Page = { moments: MomentsStage, expectations: ExpectationsStage, judges: JudgesStage, grouping: GroupingStage, dispatch: DispatchStage }[stage];
  return (
    <LineDrawer label={STAGE_NAMES[stage]} onClose={() => select({ stage: null })} nav={nav}>
      <Page {...props} />
    </LineDrawer>
  );
}
