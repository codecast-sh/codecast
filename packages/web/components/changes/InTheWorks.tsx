// In the works (spec 4.7): what is still moving, in five short groups. Stuck
// and Building now quote team-visible session headlines verbatim; In review is
// open pull requests with their status; On branches is today's branch work as
// counts; the area bars are the viewed day's file touches.
import { foldShepherdState } from "@codecast/shared/contracts";
import { useState, type ReactNode } from "react";
import type { WorksRow } from "../../hooks/useSyncChanges";
import { PrStatusChip } from "../PrStatusChip";
import { areaColor, ink, STUCK_RULE } from "./areaColor";
import type { AreaTouch } from "./editionModel";
import { AreaTag, SessionPills, Tip } from "./StoryParts";

type Review = Extract<WorksRow, { kind: "review" }>;
type Insight = Extract<WorksRow, { kind: "stuck" | "building" }>;
type Branch = Extract<WorksRow, { kind: "branch" }>;

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h4 className="chg-ui text-[13px] font-semibold text-sol-text">{label}</h4>
      {children}
    </section>
  );
}

/** A group's first `cap` rows, then a quiet "+N more" that shows the rest. */
function Capped<T>({ label, rows, cap, render }: { label: string; rows: readonly T[]; cap: number; render: (row: T) => ReactNode }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return null;
  const more = rows.length - cap;
  return (
    <Group label={label}>
      {(all || more <= 0 ? rows : rows.slice(0, cap)).map(render)}
      {more > 0 && !all && (
        <button type="button" onClick={() => setAll(true)} className="font-mono text-[11px] text-sol-text/45 transition-colors hover:text-sol-text">
          +{more} more
        </button>
      )}
    </Group>
  );
}

function Quote({ row, rule }: { row: Insight; rule: string }) {
  return (
    <div className="border-l-2 pl-2.5" style={{ borderColor: rule }}>
      <p className="chg-ui text-[13px] leading-[1.55] text-sol-text/70">"{row.headline}"</p>
      <SessionPills story={{ conversation_ids: [String(row.conversation_id)] }} max={1} className="mt-0.5" />
    </div>
  );
}

function ReviewRow({ row }: { row: Review }) {
  const state = row.draft ? "draft" : foldShepherdState({ checks_state: row.checks_state ?? undefined, review_decision: row.review_decision ?? undefined });
  return (
    <div className="flex min-w-0 items-center gap-2">
      <PrStatusChip status={{ pr_id: String(row.pr_id), repository: row.repository, number: row.number, title: row.title, state, at: row.updated_at }} />
      <span className="chg-ui min-w-0 flex-1 truncate text-[13px] text-sol-text/70" title={row.title}>{row.title}</span>
    </div>
  );
}

function BranchRow({ row }: { row: Branch }) {
  return (
    <div className="flex min-w-0 items-center gap-2 font-mono text-[11px]">
      <span className="min-w-0 flex-1 truncate text-sol-text/70" title={row.branch}>{row.branch}</span>
      <span className="shrink-0 tabular-nums text-sol-text/45" title={`${row.commits} commits in ${row.stories} stories`}>{row.commits}</span>
      {row.top_area && <AreaTag area={row.top_area} className="shrink-0 text-[10px]" />}
    </div>
  );
}

const touchCount = (n: number) => `${n.toLocaleString()} file ${n === 1 ? "touch" : "touches"}`;

/** An area with stories of its own names its commits; one without says its touches sit inside other stories. */
function barTip(a: AreaTouch): string {
  if (!a.stories) return `${a.area}: ${touchCount(a.touches)}, inside other stories`;
  return `${a.area}: ${touchCount(a.touches)} in ${a.commits} ${a.commits === 1 ? "commit" : "commits"}`;
}

function AreaBars({ areas }: { areas: readonly AreaTouch[] }) {
  const max = Math.max(1, ...areas.map((a) => a.touches));
  return (
    <div className="space-y-1">
      {areas.slice(0, 8).map((a) => (
        <Tip key={a.area} text={barTip(a)} side="left">
          <div className="grid grid-cols-[5.5rem_minmax(0,1fr)_2.5rem] items-center gap-2">
            <span className="truncate font-mono text-[11px] text-sol-text/60">{a.area}</span>
            <span className="h-1.5 rounded-[1px]" style={{ background: ink(8) }}>
              <span className="block h-full rounded-[1px]" style={{ width: `${Math.max(3, (a.touches / max) * 100)}%`, background: a.stories ? areaColor(a.area) : ink(45) }} />
            </span>
            <span className="text-right font-mono text-[10px] tabular-nums text-sol-text/45">{a.touches}</span>
          </div>
        </Tip>
      ))}
    </div>
  );
}

export function InTheWorks({ works, areas, areasLabel }: { works: readonly WorksRow[]; areas: readonly AreaTouch[]; areasLabel: string }) {
  const stuck = works.filter((w): w is Insight => w.kind === "stuck");
  const building = works.filter((w): w is Insight => w.kind === "building");
  const reviews = works.filter((w): w is Review => w.kind === "review");
  const branches = works.filter((w): w is Branch => w.kind === "branch");
  const moving = stuck.length + building.length + reviews.length + branches.length > 0;
  return (
    <div className="chg-works-inner space-y-5">
      <h3 className="chg-ui text-[15px] font-semibold text-sol-text">In the works</h3>
      {!moving && <p className="chg-ui text-[13px] text-sol-text/55">Nothing stuck, building or in review in the last two days.</p>}
      <Capped label="Stuck" rows={stuck} cap={3} render={(w) => <Quote key={w._id} row={w} rule={STUCK_RULE} />} />
      <Capped label="Building now" rows={building} cap={3} render={(w) => <Quote key={w._id} row={w} rule={ink(18)} />} />
      <Capped label="In review" rows={reviews} cap={4} render={(w) => <ReviewRow key={w._id} row={w} />} />
      <Capped label="On branches" rows={branches} cap={4} render={(w) => <BranchRow key={w._id} row={w} />} />
      {areas.length > 0 && (
        <>
          <div className="h-px bg-sol-border/15" />
          <Group label={areasLabel}>
            <AreaBars areas={areas} />
          </Group>
        </>
      )}
    </div>
  );
}
