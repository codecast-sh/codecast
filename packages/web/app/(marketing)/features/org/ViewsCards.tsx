"use client";

import type { CSSProperties, ReactNode } from "react";
import { Person, Tile } from "./kit";
import { DIM, INK, LINE, MUTED, SOL, TEXT, accentOf, person, role, tint, type RoleRow } from "./model";
import {
  AREA, COUNT_META, COUNT_ORDER, HOLDERS, STANDING, stateWords, tallyTitle,
  type Counts, type Item, type Level, type Metric,
} from "./viewsData";

/*
 * The chart section's cards, drawn the way the app's OrgNodeCards draw them,
 * at the three zoom levels: far is a dot and a title, middle the standing line,
 * area and sessions, close adds the charter, open work, sessions running now and
 * every metric.
 */

export type Mark = { lit?: boolean; dim?: boolean; match?: "hit" | "focus" };

/** A card's frame: width from the canvas level, rings for Needs you and Find. */
/** `flip` names the card across views and zoom levels, so it slides to its new place. */
export function Shell({ level, mark, top, children, flip, chip }: { level: Level; mark: Mark; top?: string; children: ReactNode; flip: string; /** A person beside the tree: as wide as its words. */ chip?: boolean }) {
  const ring = mark.match === "focus" ? `0 0 0 2px ${SOL.blue}` : mark.match === "hit" ? `0 0 0 1.5px ${tint(SOL.blue, 60)}` : mark.lit ? `0 0 0 2px ${SOL.yellow}` : "";
  const style: CSSProperties = {
    width: chip ? "max-content" : "var(--og-views-w)",
    borderColor: LINE,
    borderTopColor: top ?? LINE,
    borderTopWidth: top ? 2 : 1,
    boxShadow: [ring, "0 12px 26px -22px rgba(0,43,54,.55)"].filter(Boolean).join(", "),
  };
  return (
    <div className="og-views-card rounded-xl border bg-[#fffdf6] font-mono" data-dim={mark.dim ? "" : undefined} data-flip={flip} style={style}>
      <div key={level} className={`og-anim og-views-swap ${chip ? "px-2.5 py-1.5" : "px-3 py-2"}`}>{children}</div>
    </div>
  );
}

function Far({ color, title, hollow }: { color: string; title: string; hollow?: boolean }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="w-[9px] h-[9px] rounded-full shrink-0" style={hollow ? { border: `2px solid ${color}` } : { background: color }} aria-hidden />
      <span className="font-bold text-[14px] leading-tight tracking-[-0.02em] line-clamp-2" style={{ color: INK }}>{title}</span>
    </div>
  );
}

/** Five proportional segments in state order, the full tally on hover (StateBar). */
export function StateBar({ counts }: { counts: Counts }) {
  const shown = COUNT_ORDER.filter((k) => (counts[k] ?? 0) > 0);
  return (
    <div className="flex h-[5px] flex-1 gap-[2px] rounded-full overflow-hidden" title={tallyTitle(counts)}>
      {shown.length === 0 ? <div className="flex-1 rounded-full" style={{ background: tint(LINE, 60) }} /> : shown.map((k) => (
        <div key={k} className="rounded-full" style={{ flex: counts[k], background: COUNT_META[k].color, opacity: k === "idle" ? 0.45 : 0.9 }} />
      ))}
    </div>
  );
}

/** "4 need you · 2 working", most actionable first (StateWords). */
export function Words({ counts, className = "" }: { counts: Counts; className?: string }) {
  const w = stateWords(counts);
  return (
    <span className={`inline-flex items-center gap-1 text-meta tabular-nums whitespace-nowrap ${className}`} style={{ color: DIM }} title={tallyTitle(counts)}>
      {w.length === 0 ? "no sessions" : w.map((x, i) => (
        <span key={x.text} className="inline-flex items-center gap-1">{i > 0 && <span aria-hidden>·</span>}<span style={{ color: x.color }}>{x.text}</span></span>
      ))}
    </span>
  );
}

function Sessions({ counts }: { counts: Counts }) {
  return (
    <div className="mt-2 flex items-center gap-2">
      <Words counts={counts} />
      <StateBar counts={counts} />
    </div>
  );
}

const ARROW = { up: "↑", down: "↓", flat: "→" } as const;

function Metrics({ metrics }: { metrics: Metric[] }) {
  return (
    <div className="mt-2 space-y-1">
      {metrics.map((m) => (
        <div key={m.name} className="flex items-baseline gap-1.5 text-meta tabular-nums min-w-0">
          <span className="truncate" style={{ color: MUTED }}>{m.name}</span>
          <span className="ml-auto font-semibold shrink-0" style={{ color: TEXT }}>{m.value}</span>
          <span className="shrink-0" style={{ color: m.trend === "flat" ? DIM : m.good ? SOL.green : SOL.red }}>{ARROW[m.trend]}</span>
          <span className="shrink-0" style={{ color: DIM }}>{m.date}</span>
        </div>
      ))}
    </div>
  );
}

function Rule() {
  return <div className="my-2 h-px" style={{ background: LINE }} />;
}

/** Reached against closed, day by day, Monday to Sunday (the This week overlay). */
function Week({ reached, closed }: { reached: number[]; closed: number[] }) {
  const top = Math.max(1, ...reached, ...closed);
  const sum = (a: number[]) => a.reduce((n, x) => n + x, 0);
  return (
    <div className="mt-2 flex items-end gap-2.5">
      <div className="flex items-end gap-[3px] h-6" aria-hidden>
        {reached.map((r, i) => (
          <div key={i} className="flex items-end gap-px h-full">
            <span className="w-[3px] rounded-sm" style={{ height: `${Math.max(6, (r / top) * 100)}%`, background: tint(SOL.blue, r ? 70 : 20) }} />
            <span className="w-[3px] rounded-sm" style={{ height: `${Math.max(6, (closed[i] / top) * 100)}%`, background: tint(SOL.green, closed[i] ? 80 : 20) }} />
          </div>
        ))}
      </div>
      <div className="text-meta leading-[1.35] tabular-nums">
        <div style={{ color: SOL.blue }}>{sum(reached)} reached it</div>
        <div style={{ color: SOL.green }}>{sum(closed)} closed</div>
      </div>
    </div>
  );
}

export function RoleCard({ r, level, mark, week }: { r: RoleRow; level: Level; mark: Mark; week: boolean }) {
  const h = HOLDERS[r.id];
  const st = h.standing ? STANDING[h.standing.s] : null;
  const area = h.area ? AREA[h.area.status] : null;
  const close = level === "close";
  if (level === "far") return <Shell level={level} mark={mark} flip={r.id} top={accentOf(r.k)}><Far color={st?.color ?? DIM} title={r.title} /></Shell>;
  return (
    <Shell level={level} mark={mark} flip={r.id} top={accentOf(r.k)}>
      <div className="flex items-center gap-2.5 min-w-0">
        <Tile k={r.k} size={24} />
        <div className="min-w-0">
          <div className="font-bold text-[12.5px] leading-tight truncate" style={{ color: INK }}>{r.title}</div>
          <div className="text-meta leading-tight" style={{ color: DIM }}>{r.handle}</div>
        </div>
      </div>
      {st && h.standing && (
        <div className={`mt-1.5 text-meta leading-[1.45] ${close ? "" : "truncate"}`} title={h.standing.line}>
          <span className="mr-1.5 inline-block w-[7px] h-[7px] rounded-full align-middle" style={{ background: st.color }} aria-hidden />
          <span className="font-semibold" style={{ color: st.color === SOL.yellow ? "#a07c00" : st.color }}>{st.label}</span>
          <span style={{ color: DIM }}> · </span>
          <span style={{ color: MUTED }}>{h.standing.line}</span>
        </div>
      )}
      {area && h.area && (close || h.area.status !== "ok" || h.flag) && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {(close || h.area.status !== "ok") && <AreaPill color={area.color} label={area.label} why={h.area.why} />}
          {h.flag && <AreaPill color={SOL.magenta} label={h.flag.label} why={h.flag.why} />}
        </div>
      )}
      {week && h.week ? <Week {...h.week} /> : <Sessions counts={h.counts} />}
      {close && (
        <>
          <Rule />
          {h.charter && <p className="text-meta leading-[1.5]" style={{ color: MUTED }}>{h.charter}</p>}
          {h.work && (
            <div className="mt-1.5 text-meta tabular-nums" style={{ color: MUTED }}>
              {h.work.tasks} tasks <span style={{ color: DIM }}>·</span> {h.work.inFlight} in flight <span style={{ color: DIM }}>·</span> {h.work.plans} {h.work.plans === 1 ? "plan" : "plans"}
            </div>
          )}
          {h.running?.map((x) => (
            <div key={x.id} className="mt-1 flex items-center gap-1.5 text-meta min-w-0" style={{ color: MUTED }}>
              <span className="w-[6px] h-[6px] rounded-full shrink-0" style={{ background: SOL.green }} aria-hidden />
              <span className="shrink-0" style={{ color: DIM }}>{x.id}</span>
              <span className="truncate">{x.title}</span>
            </div>
          ))}
          {h.metrics && <Metrics metrics={h.metrics} />}
        </>
      )}
    </Shell>
  );
}

/** An area status (or health flag) with its reason: "Stuck: 1 session waiting unanswered for a day". */
function AreaPill({ color, label, why }: { color: string; label: string; why?: string }) {
  return (
    <span className="inline-flex max-w-full items-start gap-1 rounded-md px-1.5 py-[2px] text-meta leading-[1.4]" style={{ background: tint(color, 13, "#fffdf6"), color: `color-mix(in srgb, ${color} 70%, ${TEXT})` }}>
      <span><span className="font-semibold">{label}</span>{why && <span style={{ color: MUTED }}>: {why}</span>}</span>
    </span>
  );
}

export function PersonCard({ id, level, mark, note }: { id: string; level: Level; mark: Mark; note: string }) {
  const p = person(id);
  const h = HOLDERS[id];
  if (level === "far") return <Shell level={level} mark={mark} flip={id}><Far color={SOL.cyan} title={p.name} hollow /></Shell>;
  return (
    <Shell level={level} mark={mark} flip={id}>
      <div className="flex items-center gap-2.5 min-w-0">
        <Person p={p} size={24} />
        <div className="min-w-0">
          <div className="font-bold text-[13px] leading-tight truncate" style={{ color: INK }}>{p.name}</div>
          <div className="text-meta" style={{ color: DIM }}>{note}</div>
        </div>
      </div>
      <Sessions counts={h.counts} />
    </Shell>
  );
}

/** A team member with no role above them, drawn beside the owner as a peer: face, name, sessions. */
export function PersonChip({ id, level, mark }: { id: string; level: Level; mark: Mark }) {
  const p = person(id);
  return (
    <Shell level={level} mark={mark} flip={id} chip>
      <div className="flex items-center gap-2">
        <Person p={p} size={level === "far" ? 18 : 22} />
        <span className="font-bold text-[12px] whitespace-nowrap" style={{ color: INK }}>{p.name}</span>
        {level !== "far" && <Words counts={HOLDERS[id].counts} />}
      </div>
    </Shell>
  );
}

const KIND = {
  mission: { word: "mission", color: SOL.cyan },
  goal: { word: "goal", color: SOL.cyan },
  project: { word: "project", color: SOL.blue },
} as const;

/** The owner's face: a role's tile or a person's circle. */
export function OwnerFace({ owner, size = 22 }: { owner: string; size?: number }) {
  return owner.startsWith("p:") ? <Person p={person(owner.slice(2))} size={size} /> : <Tile k={role(owner).k} size={size} />;
}

const ownerName = (owner: string) => (owner.startsWith("p:") ? person(owner.slice(2)).name : role(owner).handle);

export function ItemCard({ it, level, mark }: { it: Item; level: Level; mark: Mark }) {
  const kind = KIND[it.kind];
  const atRisk = it.health === "at risk";
  if (level === "far") return <Shell level={level} mark={mark} flip={it.id}><Far color={atRisk ? SOL.orange : kind.color} title={it.title} hollow={it.kind === "project"} /></Shell>;
  return (
    <Shell level={level} mark={mark} flip={it.id}>
      <div className="flex items-start gap-2.5 min-w-0">
        <OwnerFace owner={it.owner} size={24} />
        <div className="min-w-0">
          <div className="text-meta" style={{ color: kind.color }}>{kind.word} <span style={{ color: DIM }}>· {ownerName(it.owner)}</span></div>
          <div className="font-bold text-[12.5px] leading-[1.3]" style={{ color: INK }}>{it.title}</div>
        </div>
      </div>
      {it.health && (
        <div className="mt-1.5 flex items-center gap-1.5 text-meta">
          <span className="w-[7px] h-[7px] rounded-full" style={{ background: atRisk ? SOL.orange : SOL.green }} aria-hidden />
          <span style={{ color: atRisk ? SOL.orange : SOL.green }}>{it.health}</span>
        </div>
      )}
      {it.counts && <Sessions counts={it.counts} />}
      {level === "close" && it.metrics && <><Rule /><Metrics metrics={it.metrics} /></>}
    </Shell>
  );
}
