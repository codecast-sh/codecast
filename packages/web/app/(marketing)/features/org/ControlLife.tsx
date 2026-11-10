"use client";

import { useState, type ReactNode } from "react";
import { ArrowUp, Clock, Mail, Pause, Play, RotateCcw, Split, Trash2, Undo2 } from "lucide-react";
import { Person, SessionDot, Tile } from "./kit";
import { BODY, DIM, INK, LINE, MUTED, PAPER, SAND, SOL, accentOf, at, person, tint } from "./model";
import { HALVES, SESSIONS, SOCIAL, WHERE_IT_STANDS, type LastChange, type Life, type LifeChange, type Seat } from "./controlData";

/*
 * One role's lifecycle: the controls a person owns on its Settings page, and a
 * small chart that shows what each press does. Every press also lands in the
 * History log beside it, so it can be taken back from there.
 */

export function ControlLife({ life, last, onChange, onUndoShape, children }: {
  life: Life;
  /** The role's quieter settings, under the controls. */
  children?: ReactNode;
  /** The newest History entry, drawn as the before and after over the chart. */
  last?: LastChange;
  onChange: (c: LifeChange) => void;
  /** Take back the split or retire from History (the latest entry that set it). */
  onUndoShape: () => void;
}) {
  const [confirm, setConfirm] = useState<"split" | "retire" | null>(null);
  const [restarted, setRestarted] = useState(false);
  const one = life.shape === "one";
  const set = (c: LifeChange) => { setConfirm(null); setRestarted(false); onChange(c); };

  return (
    <div className="grid md:grid-cols-[280px_minmax(0,1fr)]">
      <div className="p-4 border-b md:border-b-0 md:border-r flex flex-col gap-3" style={{ borderColor: LINE }}>
        <div className="flex items-center gap-2.5">
          <Tile k={SOCIAL.k} size={30} />
          <div className="min-w-0">
            <div className="font-mono font-bold text-[13px] leading-tight" style={{ color: one ? INK : DIM }}>{SOCIAL.title}</div>
            <div className="font-mono text-meta" style={{ color: DIM }}>{SOCIAL.handle} · reports to @cmo</div>
          </div>
        </div>

        <button type="button" role="switch" aria-checked={life.auto} disabled={!one}
          onClick={() => set({ key: "auto", before: life.auto, after: !life.auto })}
          className="og-press flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left disabled:opacity-45" style={{ borderColor: LINE, background: "#fffdf6" }}>
          <span className="flex-1 text-[12.5px] font-medium" style={{ color: INK }}>Starts work on its own</span>
          <span className="relative w-9 h-5 rounded-full shrink-0 transition-colors" style={{ background: life.auto ? SOL.green : tint(DIM, 55) }}>
            <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-[left] duration-200" style={{ left: life.auto ? 18 : 2, boxShadow: "0 1px 2px rgba(0,0,0,.25)" }} />
          </span>
        </button>

        {one ? (
          <div className="grid grid-cols-2 gap-2">
            <Btn onClick={() => set({ key: "paused", before: life.paused, after: !life.paused })} icon={life.paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}>{life.paused ? "Resume" : "Pause"}</Btn>
            <Btn onClick={() => { setConfirm(null); setRestarted(true); }} icon={<RotateCcw className="w-3.5 h-3.5" />}>Restart</Btn>
            <Btn onClick={() => setConfirm(confirm === "split" ? null : "split")} on={confirm === "split"} icon={<Split className="w-3.5 h-3.5" />} wide>Split into two leads</Btn>
            <Btn onClick={() => setConfirm(confirm === "retire" ? null : "retire")} on={confirm === "retire"} tone={SOL.red} icon={<Trash2 className="w-3.5 h-3.5" />} wide>Retire</Btn>
          </div>
        ) : (
          <Btn onClick={onUndoShape} icon={<Undo2 className="w-3.5 h-3.5" />} tone={SOL.violet} wide>{life.shape === "split" ? "Undo the split" : "Undo the retire"}</Btn>
        )}

        {confirm === "split" && (
          <div className="og-anim og-ctl-drop rounded-lg border p-2.5" style={{ borderColor: LINE, background: tint(SOL.cyan, 6, "#fffdf6") }}>
            {HALVES.map((h) => (
              <div key={h.handle} className="flex items-center gap-2 py-1 text-meta font-mono">
                <span className="flex-1 truncate" style={{ color: BODY }}>{h.areas[0]}</span>
                <span style={{ color: DIM }}>→</span>
                <Tile k={h.k} size={16} /><span style={{ color: INK }}>{h.handle}</span>
              </div>
            ))}
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => set({ key: "shape", before: "one", after: "split" })} className="og-press h-7 px-3 rounded-md font-mono text-meta font-semibold" style={{ background: SOL.cyan, color: "#fffdf6" }}>Split</button>
              <button type="button" onClick={() => setConfirm(null)} className="og-press h-7 px-2 font-mono text-meta" style={{ color: MUTED }}>Cancel</button>
            </div>
          </div>
        )}
        {confirm === "retire" && (
          <div className="og-anim og-ctl-drop rounded-lg border p-2.5" style={{ borderColor: tint(SOL.red, 40), background: tint(SOL.red, 5, "#fffdf6") }}>
            <div className="text-meta font-mono" style={{ color: BODY }}>Area falls back to @cmo</div>
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => set({ key: "shape", before: "one", after: "retired" })} className="og-press h-7 px-3 rounded-md font-mono text-meta font-semibold" style={{ background: SOL.red, color: "#fffdf6" }}>Retire Social lead</button>
              <button type="button" onClick={() => setConfirm(null)} className="og-press h-7 px-2 font-mono text-meta" style={{ color: MUTED }}>Cancel</button>
            </div>
          </div>
        )}
        {children && <div className="pt-3 flex flex-col gap-2.5 border-t" style={{ borderColor: LINE }}>{children}</div>}
      </div>

      <Chart life={life} restarted={restarted} last={last} onResume={() => set({ key: "paused", before: true, after: false })} />
    </div>
  );
}

function Btn({ children, icon, onClick, on, tone, wide }: { children: ReactNode; icon: ReactNode; onClick: () => void; on?: boolean; tone?: string; wide?: boolean }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on}
      className={`og-press h-8 px-2.5 rounded-md border inline-flex items-center justify-center gap-1.5 font-mono text-meta ${wide ? "col-span-2" : ""}`}
      style={{ borderColor: on ? tone ?? SOL.cyan : LINE, color: tone ?? BODY, background: on ? tint(tone ?? SOL.cyan, 8, "#fffdf6") : "#fffdf6" }}>
      {icon}{children}
    </button>
  );
}

// ---- The tiny chart ----------------------------------------------------------

const CONSEQUENCE = (life: Life): string[] =>
  life.shape === "split" ? ["2 leads, no overlap", "Briefs carry (from @social)", "@social hands over, 24h"]
    : life.shape === "retired" ? ["Area back to @cmo", "Handoff first, 24h", "Sessions under @cmo"]
      : life.paused ? ["Triggers held", "Sessions stop at a safe point", "Messages still arrive"]
        : life.auto ? ["Starts sessions", "Answers decisions in its area"]
          : ["Reads and answers", "Recommends", "You start the work"];

function Chart({ life, restarted, last, onResume }: { life: Life; restarted: boolean; last?: LastChange; onResume: () => void }) {
  const maya = person("maya");
  const retired = life.shape === "retired";
  const sig = `${life.shape}-${life.paused}-${life.auto}`;
  return (
    <div className="relative p-4 sm:p-6 flex flex-col items-center min-h-[460px]" style={{ background: PAPER }}>
      <div className="self-stretch min-h-[26px] mb-3 flex justify-center sm:justify-start">
        {last && (
          <span key={last.line} className="og-anim og-ctl-drop inline-flex flex-wrap items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-meta max-w-full" style={{ borderColor: LINE, background: "#fffdf6", color: INK }}>
            <span className="truncate">{last.line}</span>
            {last.change && <><span className="px-1.5 rounded" style={{ background: tint(SOL.red, 9), color: tint(SOL.red, 70, INK) }}>{last.change[0]}</span><span style={{ color: DIM }}>→</span><span className="px-1.5 rounded" style={{ background: tint(SOL.green, 11), color: tint(SOL.green, 65, INK) }}>{last.change[1]}</span></>}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 rounded-full border pl-1 pr-3 py-1 bg-[#fffdf6]" style={{ borderColor: LINE }}>
        <Person p={maya} size={22} /><span className="font-mono text-meta" style={{ color: INK }}>{maya.name}</span>
      </div>
      <Stem />
      <div className="w-full max-w-[360px] rounded-xl border px-3 py-2.5 bg-[#fffdf6] transition-colors" style={{ borderColor: retired ? accentOf("billboard") : LINE, boxShadow: retired ? `0 0 0 3px ${tint(accentOf("billboard"), 18)}` : undefined }}>
        <div className="flex items-center gap-2">
          <Tile k="billboard" size={26} />
          <span className="font-mono font-bold text-[12.5px]" style={{ color: INK }}>CMO</span>
          <span className="font-mono text-meta" style={{ color: DIM }}>@cmo</span>
        </div>
        {retired && (
          <div key="took" className="og-anim og-pop mt-2 space-y-1.5" style={at(0.75)}>
            <Areas areas={SOCIAL.areas} />
            <Brief lines={SOCIAL.areas.map((a) => WHERE_IT_STANDS[a])} />
            <Sessions ids={SOCIAL.sessions} />
          </div>
        )}
      </div>

      {retired ? (
        <div key="flow" className="flex gap-6 sm:gap-10 py-2">
          {SOCIAL.areas.map((a, i) => (
            <span key={a} className="og-anim og-ctl-up flex flex-col items-center gap-0.5" style={at(0.1 + i * 0.12)}>
              <ArrowUp className="w-4 h-4" style={{ color: accentOf("billboard") }} />
              <span className="rounded px-1.5 py-px font-mono text-meta" style={{ background: tint(SOL.violet, 10), color: tint(SOL.violet, 65, INK) }}>{a}</span>
            </span>
          ))}
        </div>
      ) : <Stem />}

      {life.shape === "one" && <SeatCard key="one" seat={SOCIAL} life={life} restarted={restarted} />}
      {life.shape === "split" && (
        <div className="w-full max-w-[640px] flex flex-col items-center">
          <div className="og-anim og-fade mb-3 flex items-center gap-1.5 rounded-full border border-dashed px-2.5 py-1 font-mono text-meta" style={{ borderColor: tint(DIM, 70), color: MUTED }}>
            <Tile k={SOCIAL.k} size={14} style={{ opacity: 0.6 }} />@social hands over the rest · <Clock className="w-3 h-3" />24h
          </div>
          <div className="w-full grid grid-cols-2 gap-2 sm:gap-4">
            {HALVES.map((h, i) => (
              <div key={h.handle} className={`og-anim ${i === 0 ? "og-ctl-fromR" : "og-ctl-fromL"}`}>
                <SeatCard seat={h} life={{ ...life, paused: false }} brief />
              </div>
            ))}
          </div>
        </div>
      )}
      {retired && (
        <div key="ret" className="og-anim og-fade w-full max-w-[360px] rounded-xl border border-dashed px-3 py-2.5" style={{ borderColor: tint(SOL.red, 45), background: tint(SOL.red, 4, "#fffdf6") }}>
          <div className="flex items-center gap-2">
            <Tile k={SOCIAL.k} size={24} style={{ opacity: 0.55 }} />
            <span className="font-mono text-[12px] line-through" style={{ color: DIM }}>Social lead</span>
            <span className="ml-auto inline-flex items-center gap-1 font-mono text-meta font-semibold" style={{ color: SOL.red }}><Clock className="w-3 h-3" />24h left</span>
          </div>
          <div className="mt-1.5 font-mono text-meta" style={{ color: MUTED }}>Handoff first, then retires</div>
          <div className="mt-2 flex gap-1.5">
            <span className="h-6 px-2 rounded-md inline-flex items-center font-mono text-meta font-semibold" style={{ background: INK, color: "#fffdf6" }}>Hand over now</span>
            <span className="h-6 px-2 rounded-md border inline-flex items-center font-mono text-meta" style={{ borderColor: LINE, color: BODY }}>Close now</span>
          </div>
        </div>
      )}

      {life.shape === "one" && life.paused && (
        <div key="note" className="og-anim og-rise mt-3 w-full max-w-[360px] rounded-lg border px-2.5 py-1.5 flex items-center gap-2 text-meta" style={{ borderColor: tint(SOL.yellow, 50), background: tint(SOL.yellow, 9, "#fffdf6"), color: BODY }}>
          <Pause className="w-3.5 h-3.5 shrink-0" style={{ color: SOL.yellow }} />
          <span className="flex-1 leading-snug">Social lead is paused. Messages still reach it.</span>
          <button type="button" onClick={onResume} className="og-press shrink-0 h-6 px-2 rounded-md border inline-flex items-center gap-1 font-mono text-meta" style={{ borderColor: LINE, color: INK, background: "#fffdf6" }}><Play className="w-3 h-3" />Resume</button>
        </div>
      )}

      <div key={sig} className="mt-auto pt-5 flex flex-wrap justify-center gap-1.5">
        {CONSEQUENCE(life).map((c, i) => (
          <span key={c} className="og-anim og-rise rounded-full px-2.5 py-1 font-mono text-meta" style={{ background: "#fffdf6", border: `1px solid ${LINE}`, color: INK, ["--d" as string]: `${0.08 * i}s` }}>{c}</span>
        ))}
      </div>
    </div>
  );
}

const Stem = ({ dashed }: { dashed?: boolean }) => (
  <span aria-hidden className="block w-px h-6 my-0.5" style={{ background: dashed ? undefined : tint(DIM, 70), borderLeft: dashed ? `1px dashed ${tint(DIM, 70)}` : undefined }} />
);

const TRIGGERS = ["Post check · daily 9:00", "Mentions sweep · hourly"];

function SeatCard({ seat, life, restarted, brief }: { seat: Seat; life: Life; restarted?: boolean; brief?: boolean }) {
  const chip = life.paused ? { w: "Paused", c: SOL.yellow } : life.auto ? { w: "Starts work", c: SOL.green } : { w: "Recommends", c: SOL.blue };
  return (
    <div className="w-full max-w-[360px] mx-auto rounded-xl border px-2.5 sm:px-3.5 py-3 bg-[#fffdf6] transition-colors" style={{ borderColor: life.paused ? tint(SOL.yellow, 60) : LINE, boxShadow: "0 14px 30px -22px rgba(0,43,54,.5)" }}>
      <div className="flex items-center gap-2 min-w-0">
        <Tile k={seat.k} size={brief ? 26 : 32} />
        <div className="min-w-0 flex-1">
          <div className="font-mono font-bold text-[12.5px] leading-tight truncate" style={{ color: INK }}>{seat.title}</div>
          <div className="font-mono text-meta truncate" style={{ color: DIM }}>{seat.handle}</div>
        </div>
        {!brief && <span key={chip.w} className="og-anim og-pop inline-flex shrink-0 rounded-full px-2 py-0.5 font-mono text-meta font-semibold" style={{ background: tint(chip.c, 14), color: tint(chip.c, 70, INK) }}>{chip.w}</span>}
      </div>
      <div className="mt-2.5 space-y-2">
        <Areas areas={seat.areas} />
        {brief && <Brief lines={seat.areas.map((a) => WHERE_IT_STANDS[a])} />}
        {!brief && (
          <ul className="space-y-0.5">
            {TRIGGERS.map((t) => (
              <li key={t} className="flex items-center gap-1.5 text-meta min-w-0" style={{ color: life.paused ? DIM : BODY }}>
                {life.paused ? <Pause className="w-3 h-3 shrink-0" style={{ color: SOL.yellow }} /> : <Clock className="w-3 h-3 shrink-0" style={{ color: MUTED }} />}
                <span className="truncate" style={{ textDecoration: life.paused ? "line-through" : undefined }}>{t}</span>
                {life.paused && <span className="ml-auto shrink-0 font-mono text-meta" style={{ color: SOL.yellow }}>held</span>}
              </li>
            ))}
          </ul>
        )}
        <div>
          {life.paused && <div className="og-anim og-fade mb-0.5 font-mono text-meta font-semibold" style={{ color: MUTED }}>Stop at a safe point</div>}
          <Sessions ids={seat.sessions} stopped={life.paused} />
        </div>
        {!life.auto && !life.paused && (
          <div className="og-anim og-fade flex items-center gap-1.5 text-meta min-w-0">
            <span className="w-2 h-2 rounded-full border border-dashed shrink-0" style={{ borderColor: SOL.blue }} />
            <span className="truncate" style={{ color: MUTED }}>v2.4 teaser · you start it</span>
          </div>
        )}
        {life.paused && (
          <div className="og-anim og-fade flex items-center gap-1.5 text-meta" style={{ color: MUTED }}>
            <Mail className="w-3 h-3" style={{ color: SOL.blue }} />1 message arrived
          </div>
        )}
        {restarted && <div className="og-anim og-fade text-meta" style={{ color: MUTED }}>Restarted · brief and charter reloaded</div>}
      </div>
    </div>
  );
}

function Areas({ areas }: { areas: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {areas.map((a) => <span key={a} className="rounded px-1.5 py-px font-mono text-meta" style={{ background: tint(SOL.violet, 10), color: tint(SOL.violet, 65, INK) }}>{a}</span>)}
    </div>
  );
}

function Brief({ lines }: { lines: string[] }) {
  return (
    <div className="rounded-md px-2 py-1.5" style={{ background: tint(SAND, 70, "#fffdf6") }}>
      <div className="font-mono text-meta font-semibold" style={{ color: DIM }}>Where it stands</div>
      {lines.map((l) => (
        <div key={l} className="text-meta leading-snug" style={{ color: BODY }}>{l} <span style={{ color: SOL.magenta }}>(from @social)</span></div>
      ))}
    </div>
  );
}

function Sessions({ ids, stopped }: { ids: number[]; stopped?: boolean }) {
  return (
    <ul className="space-y-0.5">
      {ids.map((i) => (
        <li key={i} className="flex items-center gap-1.5 text-meta min-w-0">
          {stopped ? <span className="w-2 h-2 rounded-full shrink-0" style={{ background: tint(DIM, 70) }} /> : <SessionDot state={SESSIONS[i].state} />}
          <span className="truncate" style={{ color: stopped ? DIM : BODY }}>{SESSIONS[i].title}</span>
          {stopped && <span className="ml-auto shrink-0 font-mono text-meta" style={{ color: DIM }}>safe point</span>}
        </li>
      ))}
    </ul>
  );
}
