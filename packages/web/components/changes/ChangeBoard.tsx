"use client";
// Every change in a repository as one lifecycle grid (docs/architecture/changes.md CH4):
// a row per change, the five stages as its columns with one track across
// them, grouped by who acts next. The branches page and the Deploys page draw
// their changes through it.
import { memo, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { HoverCard } from "../ui/HoverCard";
import { CHANGE_STAGES, STAGE_LABEL, nowElapsed, vehicleName } from "../../lib/changes/lifecycle";
import { deployAgo } from "../../lib/deploys/deployPill";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useChangeReach } from "../../hooks/useRepoChanges";
import { ChangeChip, ChangeJourney } from "./ChangeChip";
import { VEHICLE_GLYPH } from "../../lib/changes/vehicleGlyph";
import { PICKABLE_GROUPS, attentionTone, groupChanges, groupLabel, type ChangeGroupId, type ChangeRow } from "../../lib/changes/rows";
import "./changes.css";

const MONO = new Set(["branch", "pr", "commit"]);

const Row = memo(function Row({ row, at, focused }: { row: ChangeRow; at: number; focused: boolean }) {
  const l = row.lifecycle;
  const v = l.vehicle;
  const Glyph = VEHICLE_GLYPH[v.kind];
  const time = nowElapsed(l.now, at);
  const writers = row.writers ?? [];
  // Sessions the viewer's store names come first; the rest only count.
  const named = writers.filter((w) => w.title);
  const body = (
    <>
      <div className="chb-who">
        <HoverCard card={<ChangeJourney lifecycle={l} links={row.links} writers={row.writers} />} className="w-[340px] p-0" triggerClassName="chb-name">
          <Glyph className="chg-glyph" aria-hidden />
          <span data-mono={MONO.has(v.kind) ? "" : undefined}>{vehicleName(v)}</span>
          {v.kind === "pr" && v.title ? <span className="chb-title">{v.title}</span> : null}
        </HoverCard>
        {row.where || writers.length ? (
          <div className="chb-sub">
            {row.where ? <span>{row.where}</span> : null}
            {named.slice(0, 1).map((w, i) => <span key={i} className="chb-writer" data-state={w.state}><i aria-hidden />{w.title}</span>)}
            {writers.length > Math.min(1, named.length) ? <span className="chb-more">{named.length ? "+" : ""}{writers.length - Math.min(1, named.length)} {named.length ? "" : writers.length === 1 ? "session" : "sessions"}</span> : null}
          </div>
        ) : null}
      </div>
      {l.stages.map((s) => {
        const isNow = s.id === l.now.stage;
        return (
          <div key={s.id} className="chb-cell" data-state={s.state} data-now={isNow ? "" : undefined} data-tone={isNow ? l.now.tone : undefined} title={s.line ?? undefined}>
            <span className="chb-bar" aria-hidden />
            <span className="chb-words">
              {isNow && l.now.state !== "done" ? <>{l.now.word}{time ? <em> {time}</em> : null}{l.now.detail ? <em> · {l.now.detail}</em> : null}</> : s.short}
            </span>
          </div>
        );
      })}
      <span className="chb-age">{row.updated_at ? deployAgo(row.updated_at, at).replace(" ago", "") : ""}</span>
      <ChangeChip lifecycle={l} hover={false} at={at} bare className="chb-compact" />
    </>
  );
  const aria = `${vehicleName(v)}: ${l.now.word}`;
  const attn = attentionTone(row);
  const focus = focused ? "" : undefined;
  return row.links?.href
    ? <Link href={row.links.href} className="chb-row" data-tone={l.now.tone} data-attn={attn} data-focus={focus} aria-label={aria} data-change-row={row.key}>{body}</Link>
    : <div className="chb-row" data-tone={l.now.tone} data-attn={attn} data-focus={focus} aria-label={aria} data-change-row={row.key}>{body}</div>;
});

/** Feeds one landed change's reach, whether or not its row is drawn: a hidden group still needs to know where it stands. */
function ReachFeed({ refId }: { refId: string }) {
  useChangeReach(refId);
  return null;
}

/** The grid. `at` freezes its clock (a preview); otherwise it ticks each half minute. */
export function ChangeBoard({ rows, at, empty = "Nothing on its way", hideGroups = [], mine = false, pick, focused }: {
  rows: ReadonlyArray<ChangeRow>;
  at?: number;
  empty?: string;
  /** Groups left out by id (`closed`, `live`), for a surface that shows only what is on its way. */
  hideGroups?: ReadonlyArray<string>;
  /** The rows are only the viewer's own: the failures and turns read "Needs you". */
  mine?: boolean;
  /** A surface that narrows the grid to one group: each pickable group's name presses it, and again clears it. */
  pick?: { group: ChangeGroupId | null; onPick: (g: ChangeGroupId | null) => void };
  /** The row a link points at, highlighted. */
  focused?: (r: ChangeRow) => boolean;
}) {
  const tick = useCoarseNow(30_000);
  const now = at ?? tick;
  // Grouping turns on days, not seconds: regroup on a ten-minute clock so a ticking grid keeps its rows still.
  const groupClock = Math.floor(now / 600_000) * 600_000;
  const picked = pick?.group ?? null;
  // The picked group keeps its name on screen with nothing in it, so the press that clears it is still there.
  const groups = useMemo(() => groupChanges(rows, groupClock, picked).filter((g) => !hideGroups.includes(g.id)), [rows, hideGroups, groupClock, picked]);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  return (
    <div className="chb-scope">
      {rows.map((r) => (r.reach_ref ? <ReachFeed key={r.reach_ref} refId={r.reach_ref} /> : null))}
      <div className="chb" data-change-board>
        <div className="chb-head" aria-hidden>
          <span>Change</span>
          {CHANGE_STAGES.map((id) => <span key={id}>{STAGE_LABEL[id]}</span>)}
          <span className="chb-age">Updated</span>
        </div>
        {groups.length ? groups.map((g) => {
          const folded = g.folded && !unfolded.has(g.id);
          const head = <><i aria-hidden />{g.label}<b>{g.rows.length}</b></>;
          return (
            <section key={g.id} className="chb-group" data-tone={g.tone} data-change-group={g.id} data-folded={folded ? "" : undefined}>
              {g.folded ? (
                <button type="button" className="chb-group-head chb-fold" aria-expanded={!folded} onClick={() => setUnfolded((u) => {
                  const next = new Set(u);
                  if (next.has(g.id)) next.delete(g.id); else next.add(g.id);
                  return next;
                })} data-change-fold={g.id}>{head}<ChevronRight className="chb-chevron" aria-hidden /></button>
              ) : <div className="chb-group-head">{head}</div>}
              {folded ? null : <div className="chb-rows">{g.rows.map((r) => <Row key={r.key} row={r} at={now} />)}</div>}
            </section>
          );
        }) : <div className="chb-rows"><div className="chb-empty">{empty}</div></div>}
      </div>
    </div>
  );
}
