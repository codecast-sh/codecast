"use client";
// A change wherever one is named (docs/architecture/changes.md CH3): its
// vehicle and name, the five-stage track, and the one word for now. The hover
// card is the whole journey. Every surface draws a change through this, so a
// branch, a pull request, a commit and a checkout's pass read alike.
import { memo, type ReactNode } from "react";
import Link from "next/link";
import { Ban, Check, CircleDot, Clock, CornerDownLeft, Minus, UserRound, X, type LucideIcon } from "lucide-react";
import { MONO_VEHICLE as MONO, VEHICLE_GLYPH } from "../../lib/changes/vehicleGlyph";
import type { ChangeLinks } from "../../lib/changes/rows";
import { HoverCard } from "../ui/HoverCard";
import { useNowWhen } from "../../hooks/useCoarseNow";
import { STAGE_LABEL, nowElapsed, vehicleName, type ChangeVehicle, type Lifecycle, type LifecycleStage, type StageState } from "../../lib/changes/lifecycle";
import "./changes.css";


/** The five bars. */
export const ChangeTrack = memo(function ChangeTrack({ lifecycle }: { lifecycle: Lifecycle }) {
  return (
    <span className="chg-track" aria-hidden>
      {lifecycle.stages.map((s) => (
        <span key={s.id} className="chg-pip" data-state={s.state} data-now={s.id === lifecycle.now.stage ? "" : undefined} />
      ))}
    </span>
  );
});

function where(v: ChangeVehicle): string | null {
  switch (v.kind) {
    case "branch": return v.pr ? `#${v.pr}` : v.worktree ? "worktree" : null;
    case "pr": return v.branch ?? null;
    case "commit": return v.branch ?? null;
    case "edits": return `${v.files} ${v.files === 1 ? "file" : "files"}`;
    case "pass": return `${v.sessions} sessions · ${v.files} files`;
  }
}

const NODE: Record<StageState, LucideIcon | null> = {
  done: Check,
  active: CircleDot,
  waiting: Clock,
  you: UserRound,
  back: CornerDownLeft,
  failed: X,
  skipped: Minus,
  stopped: Ban,
  idle: null,
};

function Stage({ s, isNow }: { s: LifecycleStage; isNow: boolean }) {
  const Icon = NODE[s.state];
  return (
    <li className="chj-stage" data-state={s.state} data-now={isNow ? "" : undefined} data-stage={s.id}>
      <span className="chj-node" aria-hidden>{Icon ? <Icon strokeWidth={s.state === "failed" ? 3 : 2.5} /> : null}</span>
      <span className="chj-label">{s.label}</span>
      <span className="chj-line">{s.line ?? (s.state === "skipped" ? "Not on its path" : null)}</span>
    </li>
  );
}


/** The hover card: the change's journey, its writers and where to go next. */
export function ChangeJourney({ lifecycle, links, writers, at: since = null }: {
  lifecycle: Lifecycle;
  /** The clock the lifecycle was read at, to say how long the now has lasted. */
  at?: number | null;
  links?: ChangeLinks;
  writers?: ReadonlyArray<{ title: string | null; state: string; href?: string | null }>;
}) {
  const v = lifecycle.vehicle;
  const Glyph = VEHICLE_GLYPH[v.kind];
  const now = lifecycle.now;
  return (
    <div className="chj" data-tone={now.tone} data-change-journey>
      <div className="chj-head">
        <Glyph className="chg-glyph" aria-hidden />
        <span className="chj-name" data-sans={MONO[v.kind] ? undefined : ""}>{vehicleName(v)}</span>
        {where(v) ? <span className="chj-where">{where(v)}</span> : null}
      </div>
      <div className="chj-now">
        <span className="chj-now-word">{capitalize(now.word)}</span>
        {now.detail ? <span className="chj-now-detail">{now.detail}</span> : null}
        <span className="chj-now-stage">{STAGE_LABEL[now.stage]}</span>
        <NowTime lifecycle={lifecycle} at={since} className="chj-now-since" prefix="for " />
      </div>
      <ol className="chj-stages" aria-label="Stages">
        {lifecycle.stages.map((s) => <Stage key={s.id} s={s} isNow={s.id === now.stage} />)}
      </ol>
      {links?.action ? (
        links.action.href
          ? <Link className="chj-action" href={links.action.href} data-tone={now.tone}>{links.action.label}</Link>
          : <button type="button" className="chj-action" onClick={links.action.onClick} data-tone={now.tone}>{links.action.label}</button>
      ) : null}
      {writers?.length || links?.pr || links?.run || links?.deploys?.length ? (
        <div className="chj-foot">
          {writers?.length ? (
            <span className="chj-writers">
              {writers.slice(0, 4).map((w, i) => (
                <span key={i} className="chj-writer" data-state={w.state}><i aria-hidden />{w.href ? <Link href={w.href}>{w.title ?? "a session"}</Link> : w.title ?? "a session"}</span>
              ))}
              {writers.length > 4 ? <span>+{writers.length - 4}</span> : null}
            </span>
          ) : null}
          {links?.pr ? <Link href={links.pr.href}>{links.pr.label}</Link> : null}
          {links?.run ? <Link href={links.run.href}>{links.run.label}</Link> : null}
          {links?.deploys?.map((d) => <Link key={d.label} href={d.href}>{d.label}</Link>)}
        </div>
      ) : null}
    </div>
  );
}

/** The now's elapsed time, ticking while it moves; frozen at `at` when given (a preview, a test). */
function NowTime({ lifecycle, at, className, prefix = "" }: { lifecycle: Lifecycle; at: number | null; className: string; prefix?: string }) {
  if (at != null) {
    const t = nowElapsed(lifecycle.now, at);
    return t ? <span className={className}>{prefix}{t}</span> : null;
  }
  return <TickingTime lifecycle={lifecycle} className={className} prefix={prefix} />;
}

function TickingTime({ lifecycle, className, prefix }: { lifecycle: Lifecycle; className: string; prefix: string }) {
  const now = useNowWhen((t) => nowElapsed(lifecycle.now, t) ?? "", 15_000);
  const t = nowElapsed(lifecycle.now, now);
  return t ? <span className={className}>{prefix}{t}</span> : null;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The chip. `label` replaces the vehicle's name (the inline code that named it, say). With `links.href` it is a link;
 * with `hover` false it draws no card (a row whose page already shows the journey).
 */
export const ChangeChip = memo(function ChangeChip({ lifecycle, label, links, writers, at = null, hover = true, bare = false, className = "" }: {
  lifecycle: Lifecycle;
  label?: ReactNode;
  links?: ChangeLinks;
  writers?: ReadonlyArray<{ title: string | null; state: string; href?: string | null }>;
  at?: number | null;
  hover?: boolean;
  /** Only the track and the word: for a row that already names the change. */
  bare?: boolean;
  className?: string;
}) {
  const v = lifecycle.vehicle;
  const Glyph = VEHICLE_GLYPH[v.kind];
  const body = (
    <>
      {bare ? null : <Glyph className="chg-glyph" aria-hidden strokeWidth={2.25} />}
      {bare ? null : <span className="chg-name" data-mono={MONO[v.kind] ? "" : undefined}>{label ?? vehicleName(v)}</span>}
      <ChangeTrack lifecycle={lifecycle} />
      <span className="chg-word">{lifecycle.now.word}<NowTime lifecycle={lifecycle} at={at} className="chg-time" /></span>
      {lifecycle.now.detail ? <span className="chg-detail">{lifecycle.now.detail}</span> : null}
    </>
  );
  const aria = `${vehicleName(v)}: ${lifecycle.now.word}, at ${STAGE_LABEL[lifecycle.now.stage]}`;
  const chip = links?.href
    ? <Link href={links.href} className={`chg not-prose ${className}`} data-tone={lifecycle.now.tone} data-change-chip={lifecycle.now.stage} aria-label={aria}>{body}</Link>
    : <span className={`chg not-prose ${className}`} data-tone={lifecycle.now.tone} data-change-chip={lifecycle.now.stage} aria-label={aria} tabIndex={hover ? 0 : undefined}>{body}</span>;
  if (!hover) return chip;
  return (
    <HoverCard card={<ChangeJourney lifecycle={lifecycle} links={links} writers={writers} at={at} />} className="w-[340px] p-0">
      {chip}
    </HoverCard>
  );
});

/**
 * A reference pill's state after its name (a pull request, a commit): the chip's track and word with no chrome of its
 * own, so `#4501` in a message reads exactly as its row on the Branches page does.
 */
export const ChangeSegment = memo(function ChangeSegment({ lifecycle }: { lifecycle: Lifecycle }) {
  return (
    <span className="chg-seg" data-tone={lifecycle.now.tone} data-change-segment={lifecycle.now.stage}>
      <ChangeTrack lifecycle={lifecycle} />
      <span className="chg-word">{lifecycle.now.word}<NowTime lifecycle={lifecycle} at={null} className="chg-time" /></span>
      {lifecycle.now.detail ? <span className="chg-detail">{lifecycle.now.detail}</span> : null}
    </span>
  );
});
