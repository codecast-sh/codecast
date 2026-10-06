// In the works (spec 4.7): what is still moving, in five short groups. Stuck
// and In progress quote team-visible session headlines verbatim; In review is
// open pull requests with their status; On branches is today's branch work as
// counts; the area bars are the viewed day's file touches. Everything but the
// bars is the state right now, whichever edition is on screen, so a past
// edition says so and puts its own bars first.
import { foldShepherdState } from "@codecast/shared/contracts";
import { useState, type ReactNode } from "react";
import type { WorksRow } from "../../hooks/useSyncChanges";
import { ImageGalleryProvider, useImageGallery } from "../ImageGallery";
import { PrStatusChip } from "../PrStatusChip";
import { areaFill, areaLabel, ink, STUCK_RULE } from "./areaColor";
import type { AreaTouch } from "./editionModel";
import { plural } from "./format";
import { AreaTag, SessionPills, Tip } from "./StoryParts";
import { useAreaColors } from "./storyContext";

type Review = Extract<WorksRow, { kind: "review" }>;
type Insight = Extract<WorksRow, { kind: "stuck" | "building" }>;
type Branch = Extract<WorksRow, { kind: "branch" }>;

function Group({ label, unit, children }: { label: string; unit?: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <div>
        <h4 className="chg-ui text-[12px] font-medium text-sol-text/75">{label}</h4>
        {unit && <p className="font-mono text-[10px]" style={{ color: ink(45) }}>{unit}</p>}
      </div>
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
    // The 2px rule is the quote mark. The pill sits at the end of the last line, never on a row of its own.
    <div className="border-l-2 pl-2.5" style={{ borderColor: rule }}>
      <div className="flex items-end gap-2">
        <p className="chg-ui line-clamp-2 min-w-0 flex-1 text-[12.5px] leading-[1.5] text-sol-text/60" title={row.headline}>{row.headline}</p>
        <SessionPills story={{ conversation_ids: [String(row.conversation_id)] }} max={1} className="shrink-0 leading-[1.5]" />
      </div>
      {row.shots?.length ? <Shots shots={row.shots} /> : null}
    </div>
  );
}

/** The session's latest screenshots, a glance at the work before it lands; each opens in the lightbox. */
function Shots({ shots }: { shots: readonly string[] }) {
  const gallery = useImageGallery();
  const images = shots.map((src) => ({ src, href: src }));
  return (
    <div className="mt-1.5 flex gap-1.5">
      {shots.map((src, i) => (
        <button key={src} type="button" onClick={() => gallery?.openList(images, i)} className="overflow-hidden rounded-[4px] border border-sol-border/30 hover:border-sol-border/70">
          <img src={src} alt="" loading="lazy" className="h-14 w-24 object-cover object-top" />
        </button>
      ))}
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
      <span className="shrink-0 tabular-nums text-sol-text/45" title={`${plural(row.commits, "commit")} in ${plural(row.stories, "story", "stories")}`}>{plural(row.commits, "commit")}</span>
      {row.top_area && <AreaTag area={row.top_area} className="shrink-0 text-[10px]" />}
    </div>
  );
}

const touchCount = (n: number) => plural(n, "file touch", "file touches");

/** An area with stories of its own names its commits; one without says its touches sit inside other stories. */
function barTip(a: AreaTouch): string {
  if (!a.stories) return `${areaLabel(a.area)}: ${touchCount(a.touches)}, inside other stories`;
  return `${areaLabel(a.area)}: ${touchCount(a.touches)} in ${plural(a.commits, "commit")}`;
}

/**
 * One bar per area, each a button that toggles the area filter, its count in
 * words on hover, focus and to a screen reader. An area whose touches all sit
 * inside other stories has no story to filter to: it still answers, and does nothing.
 */
function AreaBars({ areas, active, onArea }: { areas: readonly AreaTouch[]; active: readonly string[]; onArea?: (area: string) => void }) {
  const colors = useAreaColors();
  const max = Math.max(1, ...areas.map((a) => a.touches));
  return (
    <div className="space-y-0.5">
      {areas.slice(0, 8).map((a) => (
        <Tip key={a.area} text={barTip(a)} side="left">
          <button
            type="button"
            aria-label={barTip(a)}
            aria-pressed={a.stories > 0 ? active.includes(a.area) : undefined}
            aria-disabled={a.stories > 0 && onArea ? undefined : true}
            onClick={() => a.stories > 0 && onArea?.(a.area)}
            className={`-mx-1 grid w-[calc(100%+0.5rem)] grid-cols-[5.5rem_minmax(0,1fr)_2.5rem] items-center gap-2 rounded px-1 py-[1px] text-left transition-colors ${
              a.stories > 0 && onArea ? "hover:bg-sol-bg-alt/60" : "cursor-default"
            } ${active.includes(a.area) ? "bg-sol-bg-alt/60" : ""}`}
          >
            <span className="truncate font-mono text-[11px] text-sol-text/60">{areaLabel(a.area)}</span>
            <span className="h-1 rounded-[1px]" style={{ background: ink(8) }}>
              <span className="block h-full rounded-[1px]" style={{ width: `${Math.max(3, (a.touches / max) * 100)}%`, background: a.stories ? areaFill(a.area, 55, colors) : ink(30) }} />
            </span>
            <span className="text-right font-mono text-[10px] tabular-nums text-sol-text/45">{a.touches}</span>
          </button>
        </Tip>
      ))}
    </div>
  );
}

export function InTheWorks({ works, areas, areasLabel, live, viewed, activeAreas = [], onArea }: {
  works: readonly WorksRow[];
  areas: readonly AreaTouch[];
  /** The area filter, which the bars toggle. */
  activeAreas?: readonly string[];
  onArea?: (area: string) => void;
  areasLabel: string;
  /** The edition on screen is today's (or this week's), so the moving work belongs to it. */
  live: boolean;
  /** What is on screen when it is not: "Sun 27 Sep", or "the week of Mon 21 Sep". */
  viewed: string;
}) {
  const stuck = works.filter((w): w is Insight => w.kind === "stuck");
  const building = works.filter((w): w is Insight => w.kind === "building");
  const reviews = works.filter((w): w is Review => w.kind === "review");
  const branches = works.filter((w): w is Branch => w.kind === "branch");
  const moving = stuck.length + building.length + reviews.length + branches.length > 0;
  const bars = areas.length > 0 && (
    <Group label={areasLabel} unit="file touches">
      <AreaBars areas={areas} active={activeAreas} onArea={onArea} />
    </Group>
  );
  const rule = bars && <div className="h-px bg-sol-border/15" />;
  return (
    <ImageGalleryProvider>
    <div className="chg-works-inner space-y-4">
      {/* A past edition leads with the one group that is its own. */}
      {!live && bars}
      {!live && rule}
      <div>
        <h3 className="chg-ui text-[13px] font-semibold text-sol-text">{live ? "In the works" : "In the works now"}</h3>
        {!live && <p className="mt-0.5 font-mono text-[11px] text-sol-text/45">Live state, not {viewed}</p>}
      </div>
      {!moving && <p className="chg-ui text-[13px] text-sol-text/55">Nothing stuck, in progress or in review in the last two days.</p>}
      <Capped label="Stuck" rows={stuck} cap={2} render={(w) => <Quote key={w._id} row={w} rule={STUCK_RULE} />} />
      <Capped label="In progress" rows={building} cap={2} render={(w) => <Quote key={w._id} row={w} rule={ink(18)} />} />
      <Capped label="In review" rows={reviews} cap={4} render={(w) => <ReviewRow key={w._id} row={w} />} />
      <Capped label="On branches now" rows={branches} cap={4} render={(w) => <BranchRow key={w._id} row={w} />} />
      {live && rule}
      {live && bars}
    </div>
    </ImageGalleryProvider>
  );
}
