"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { useEventListener } from "@/hooks/useEventListener";
import { useNearViewport } from "@/hooks/useNearViewport";
import { useWatchEffect } from "@/hooks/useWatchEffect";
import { SOL } from "../../blog/blogChrome";
import { Section } from "./kit";
import { BACK, BAD, DIM, GOOD, HAIR, INK, LINE, MUTED, PAPER, PERSON, TEXT, tint, usePlayOnView, useStill } from "./base";
import { CHANGE, PROBLEM } from "./story";
import { CHAPTERS, CHIPS, CHIP_FONT, CHIP_H, GEO_H, GEO_V, LOOP_MS, MOVE_MS, ORDER, SHIP_RUN, STEPS, TONE, WAYS, WAYS_OUT, buildBeats, chipLabel, chipW, dist, legs, polyLen, stateAt, travelMs, type Answer, type Beat, type Chip, type ChipTone, type Geo, type Pt, type StepId, type Tone } from "./changeRunModel";
import { Chiplet, Icon, Moment, PanelHead, Visits } from "./ChangeRunMoment";
import "./changerun.css";

/*
 * One change through the Change flow (templates/change.cast), as a run the
 * reader can steer. The flow is drawn the way the app draws it; a token
 * travels it, slipping behind each box to pass through, and takes the violet
 * rail back to the Session on every way back, drawing the loop as it goes.
 *
 * The run is a list of beats built from the reader's answers at Decide
 * (`buildBeats`): Ship lands and deploys, Revise sends the change back to the
 * session (3 visits; a fourth ends the run), Drop ends it. Left alone at Decide
 * for 4 seconds, the run presses Ship itself. The same beats drive two
 * drawings: a horizontal flow on wide screens and a vertical one below 1100px,
 * with travel times fixed per move so both stay in step with one clock.
 *
 * Before it plays, in still mode and in the prerender, it shows the finished
 * Ship run: the path taken with both loops back, and the whole log.
 */

// ---------- Drawing ----------


function Node({ geo, id, active, wait, reached, sub, landDone, picked, dim, endTone }: {
  geo: Geo; id: StepId; active: boolean; wait: boolean; reached: boolean; sub?: "rebase" | "land"; landDone: boolean; picked: boolean; dim: boolean; endTone?: Tone;
}) {
  const r = geo.node[id];
  const k = STEPS[id].kind;
  const pill = k === "session" || k === "end";
  const blue = k === "person" || k === "session";
  const live = id === "live";
  const glow = endTone === "bad" ? BAD : blue ? PERSON : LINE;
  const stroke = live ? (reached ? LINE : DIM) : blue ? tint(PERSON, 60) : "rgba(88,110,117,.28)";
  const fill = live ? (reached ? LINE : "transparent") : blue ? "#e8f0f3" : "#fffdf8";
  const ink = blue ? "#1f6fa8" : live ? (reached ? SOL.base3 : MUTED) : INK;
  const cy = id === "land" && geo.vertical ? r.y + 22 : r.y + r.h / 2;
  const cells = id === "land" ? geo.landCells(r) : null;
  return (
    <g className="flx-run-node" data-on={active || undefined} data-wait={wait || undefined} data-pick={picked || undefined} data-dim={dim || undefined} style={{ ["--glow" as string]: glow } as CSSProperties}>
      <rect className="flx-run-box" x={r.x} y={r.y} width={r.w} height={r.h} rx={pill ? r.h / 2 : 10} fill={fill} stroke={stroke} strokeWidth={1.4} strokeDasharray={live && !reached ? "5 4" : undefined} />
      {pill ? (
        <text x={r.x + r.w / 2} y={cy + 5} textAnchor="middle" fontSize={15} fontWeight={650} fill={ink}>{STEPS[id].label}</text>
      ) : (
        <>
          <Icon kind={k} x={r.x + 14} y={cy - 8} color={k === "person" ? PERSON : MUTED} />
          <text x={r.x + 36} y={cy + 5} fontSize={15} fontWeight={700} fill={ink}>{STEPS[id].label}</text>
        </>
      )}
      {cells && (
        <g fontSize={14.5}>
          {([["rebase", "Rebase", cells.rebase], ["land", "Land", cells.land]] as const).map(([key, label, c]) => {
            const on = sub === key;
            const done = landDone || (key === "rebase" && sub === "land");
            return (
              <g key={key} className="flx-run-sub" data-on={on || undefined} data-done={done || undefined}>
                <rect x={c.x} y={c.y} width={c.w} height={c.h} rx={6} />
                <text x={c.x + c.w / 2} y={c.y + 17} textAnchor="middle">{label}</text>
              </g>
            );
          })}
          <path d={`M${cells.arrow.x - 2} ${cells.arrow.y - 3} l3 3 -3 3`} fill="none" stroke={DIM} strokeWidth={1.3} />
        </g>
      )}
    </g>
  );
}

function ChipShape({ geo, c, lit, flash, picked, dim }: { geo: Geo; c: Chip; lit: boolean; flash: boolean; picked: boolean; dim: boolean }) {
  const { x, y } = geo.chipAt(c);
  const color = c.tone === "back" ? BACK : c.tone === "end" ? BAD : MUTED;
  return (
    <g className="flx-run-chip" data-lit={lit || undefined} data-flash={flash || undefined} data-pick={picked || undefined} data-dim={dim || undefined} style={{ ["--c" as string]: color } as CSSProperties}>
      <rect x={x} y={y} width={chipW(c)} height={CHIP_H} rx={c.tone === "end" ? 12 : 6}
        fill={c.tone === "on" ? "#fdfaf1" : c.tone === "end" ? "#fbeee9" : "#f1eff6"}
        stroke={tint(color, c.tone === "on" ? 55 : 45)} strokeDasharray={c.tone === "on" ? "3 3" : undefined} />
      <text x={x + 9} y={y + 17} fontSize={CHIP_FONT} fill={c.tone === "on" ? MUTED : color}>{chipLabel(c)}</text>
    </g>
  );
}

/** The token: glides leg by leg with CSS transitions, chained by timers. */
function Token({ geo, beats, beat, animate, still }: { geo: Geo; beats: Beat[]; beat: number; animate: boolean; still: boolean }) {
  const [seg, setSeg] = useState<{ p: Pt; ms: number; ease: string }>({ p: geo.dock(beats[beat].step), ms: 0, ease: "linear" });
  useWatchEffect(() => {
    const { pts, ms, ease } = legs(geo, beats, beat);
    const last = pts[pts.length - 1];
    if (still || !animate || pts.length < 2) { setSeg({ p: last, ms: 0, ease: "linear" }); return; }
    let k = 1;
    let t: ReturnType<typeof setTimeout> | undefined;
    const go = () => {
      setSeg({ p: pts[k], ms: ms[k - 1], ease });
      k++;
      if (k < pts.length) t = setTimeout(go, ms[k - 2]);
    };
    go();
    return () => { if (t) clearTimeout(t); };
  }, [beat, beats, animate, still]);
  const b = beats[beat];
  const color = b.tone === "bad" ? BAD : b.via ? BACK : b.step === "decide" || b.step === "session" ? PERSON : LINE;
  return (
    <g className="flx-run-token" style={{ transform: `translate(${seg.p.x}px, ${seg.p.y}px)`, transition: `transform ${seg.ms}ms ${seg.ease}`, ["--tk" as string]: color } as CSSProperties}>
      <circle className="flx-run-halo" r={11} />
      <circle className="flx-run-dot" r={6.5} strokeWidth={2.2} stroke="#fffdf8" />
    </g>
  );
}

function Flow({ geo, beats, beat, animate, still, inspect, onInspect }: {
  geo: Geo; beats: Beat[]; beat: number; animate: boolean; still: boolean; inspect: StepId | null; onInspect: (s: StepId) => void;
}) {
  const b = beats[beat];
  const prev = beats[beat - 1];
  const s = stateAt(beats, beat);
  const moving = animate && !still;
  const dimStep = (step: StepId) => inspect !== null && inspect !== step;
  const landIdx = beats.findIndex((x) => x.sub === "land");
  const landDone = landIdx >= 0 && beat > landIdx;
  const arrowId = geo.vertical ? "flx-run-av" : "flx-run-ah";
  return (
    <div className="relative" style={{ aspectRatio: `${geo.W} / ${geo.H}` }}>
      <svg viewBox={`0 0 ${geo.W} ${geo.H}`} preserveAspectRatio="xMidYMid meet" className="flx-run-svg absolute inset-0 w-full h-full" role="img"
        aria-label="The Change flow: Session, Check, Review, Decide, Land, Deploy, Live, with each step's ways out and the ways back to the Session">
        <defs>
          <marker id={`${arrowId}-g`} viewBox="0 0 8 8" refX={7} refY={4} markerWidth={7} markerHeight={7} orient="auto">
            <path d="M1 1 L7 4 L1 7" fill="none" stroke="rgba(88,110,117,.55)" strokeWidth={1.4} />
          </marker>
          <marker id={`${arrowId}-v`} viewBox="0 0 8 8" refX={7} refY={4} markerWidth={7} markerHeight={7} orient="auto">
            <path d="M1 1 L7 4 L1 7" fill="none" stroke={BACK} strokeWidth={1.4} />
          </marker>
        </defs>

        {/* The rail back to the Session, and each way back's drop to it. */}
        <path d={geo.rail} fill="none" stroke={tint(BACK, 45)} strokeWidth={1.4} markerEnd={`url(#${arrowId}-v)`} />
        {WAYS.map((w) => (
          <path key={w.key} d={geo.drop(w.step)} fill="none" stroke={tint(BACK, 45)} strokeWidth={1.3} strokeDasharray="4 4" />
        ))}
        {/* Loops the change took, drawn as the token travels them. */}
        {WAYS.map((w) => {
          const drawn = s.loops.has(w.key);
          const live = drawn && b.via === w.key && moving;
          const lp = geo.loop(w.step);
          const total = polyLen(lp.pts);
          // The drawn loop starts where the token leaves the box; time it along the same legs.
          let before = 0;
          for (let k = 1; k < lp.pts.length; k++) {
            const a = lp.pts[k - 1], z = lp.pts[k];
            const onSeg = (a.x === z.x && a.x === lp.start.x && (lp.start.y - a.y) * (lp.start.y - z.y) <= 0) || (a.y === z.y && a.y === lp.start.y && (lp.start.x - a.x) * (lp.start.x - z.x) <= 0);
            if (onSeg) { before += dist(a, lp.start); break; }
            before += dist(a, z);
          }
          const drawnLen = total - before - dist(lp.pts[lp.pts.length - 2], lp.pts[lp.pts.length - 1]) * 0.5;
          const delay = (before / total) * LOOP_MS;
          const dur = (drawnLen / total) * LOOP_MS;
          return (
            <path key={`taken-${w.key}`} d={lp.d} pathLength={1} fill="none" stroke={BACK} strokeWidth={2.4} strokeLinejoin="round" strokeDasharray="1 1"
              style={{ strokeDashoffset: drawn ? 0 : 1, transition: live ? `stroke-dashoffset ${dur}ms linear ${delay}ms` : "none" }} />
          );
        })}

        {/* The main line. */}
        {ORDER.slice(1).map((z, i) => {
          const a = ORDER[i];
          const key = `${a}>${z}`;
          const taken = s.edges.has(key);
          const live = taken && !b.via && !b.end && prev?.step === a && b.step === z && moving;
          return (
            <g key={key}>
              <path d={geo.edge(a, z)} stroke="rgba(88,110,117,.35)" strokeWidth={1.3} markerEnd={`url(#${arrowId}-g)`} fill="none" />
              <path d={geo.edge(a, z)} pathLength={1} strokeDasharray="1 1" stroke={LINE} strokeWidth={2.4} fill="none"
                style={{ strokeDashoffset: taken ? 0 : 1, transition: live ? `stroke-dashoffset ${MOVE_MS}ms cubic-bezier(.55,0,.25,1)` : "none" }} />
            </g>
          );
        })}
        {geo.already && (
          <path d={geo.already} fill="none" stroke="rgba(88,110,117,.4)" strokeWidth={1.2} strokeDasharray="3 3" className="flx-run-fadeable" data-dim={dimStep("land") || undefined} />
        )}
        {geo.branchArc && (
          <path d={geo.branchArc} fill="none" stroke="rgba(88,110,117,.5)" strokeWidth={1.2} markerEnd={`url(#${arrowId}-g)`} className="flx-run-fadeable" data-dim={dimStep("land") || undefined}>
            <title>default branch moved: Rebase again</title>
          </path>
        )}

        <Token geo={geo} beats={beats} beat={beat} animate={animate} still={still} />

        {ORDER.map((id) => (
          <Node key={id} geo={geo} id={id} active={b.step === id && !inspect} wait={b.step === id && !!b.pending} reached={id === "live" && b.step === "live"}
            sub={id === "land" && b.step === "land" ? b.sub : undefined} landDone={landDone} picked={inspect === id} dim={dimStep(id)} endTone={b.step === id && b.terminal ? b.tone : undefined} />
        ))}
        {CHIPS.map((c) => (
          <ChipShape key={c.id} geo={geo} c={c} lit={s.lit.has(c.id)} flash={moving && b.chip === c.id} picked={inspect === c.step} dim={dimStep(c.step)} />
        ))}

        {/* Each way back with its visits: a station on the rail, or a line under its chip. */}
        {WAYS.map((w) => {
          const n = s.visits[w.key];
          const text = `${w.label} ${n}/3`;
          const at = geo.wayLabel(w);
          const bumped = moving && b.via === w.key;
          const pw = text.length * 9 + 18;
          return (
            <g key={`way-${w.key}`} className="flx-run-way" data-on={n > 0 || undefined} data-pill={at.pill || undefined} data-dim={dimStep(w.step) || undefined}>
              <g key={bumped ? `b${beat}` : "rest"} className={bumped ? "flx-run-bump" : undefined} style={{ ["--d" as string]: `${LOOP_MS * 0.5}ms` } as CSSProperties}>
                {at.pill && <rect x={at.x - pw / 2} y={at.y - 12} width={pw} height={24} rx={12} />}
                <text x={at.x} y={at.pill ? at.y + 5 : at.y} textAnchor={at.anchor} fontSize={geo.vertical ? 12.5 : 15}>{text}</text>
              </g>
            </g>
          );
        })}

        {/* What the active step just did, above it. */}
        {!inspect && geo.tag && (
          <text key={`tag-${beat}-${b.tag}`} className="flx-run-tag" x={geo.tag(b.step).x} y={geo.tag(b.step).y} textAnchor={geo.tag(b.step).anchor} fontSize={14.5} fontWeight={650} fill={TONE[b.tone]}
            style={{ ["--d" as string]: moving ? `${travelMs(beats, beat)}ms` : "0ms" } as CSSProperties}>
            {b.tag}
          </text>
        )}
      </svg>
      {/* Real buttons over the steps: click one to see its ways out. */}
      {ORDER.map((id) => {
        const r = geo.node[id];
        const pill = STEPS[id].kind === "session" || STEPS[id].kind === "end";
        return (
          <button key={id} type="button" className="flx-run-hit absolute" aria-pressed={inspect === id} aria-label={`Ways out of ${STEPS[id].label}`} onClick={() => onInspect(id)}
            style={{ left: `${(r.x / geo.W) * 100}%`, top: `${(r.y / geo.H) * 100}%`, width: `${(r.w / geo.W) * 100}%`, height: `${(r.h / geo.H) * 100}%`, borderRadius: pill ? 999 : 10 }} />
        );
      })}
    </div>
  );
}

function WaysOut({ step, onClose }: { step: StepId; onClose: () => void }) {
  const k = STEPS[step].kind;
  const color: Record<ChipTone | "go" | "ok", string> = { go: LINE, ok: GOOD, back: BACK, end: BAD, on: MUTED };
  const way = WAYS.find((w) => w.step === step);
  return (
    <>
      <PanelHead title={STEPS[step].label} sub="ways out" icon={k === "session" || k === "end" ? undefined : k} color={k === "person" || k === "session" ? PERSON : INK}
        right={<button type="button" onClick={onClose} className="flx-run-btn font-mono text-[12.5px] px-2.5 h-7 rounded-md border" style={{ borderColor: HAIR, color: TEXT }}>back to the run</button>} />
      <div className="mt-3 grid gap-2">
        {WAYS_OUT[step].map((w) => (
          <div key={w.out} className="flex items-center gap-x-3 gap-y-1 font-mono text-[12.5px] flex-wrap">
            <Chiplet color={color[w.tone]} dashed={w.tone === "on"}>{w.tone === "back" ? `↺ ${w.out}` : w.out}</Chiplet>
            <svg width={16} height={10} viewBox="0 0 16 10" aria-hidden><path d="M1 5 H13 M9.5 1.5 L13 5 L9.5 8.5" fill="none" stroke={DIM} strokeWidth={1.3} /></svg>
            <span style={{ color: TEXT }}>{w.to}</span>
          </div>
        ))}
      </div>
      {way && <div className="mt-4"><Visits label={way.label} n={0} /></div>}
      {step === "deploy" && <div className="mt-4 font-mono text-[12.5px]" style={{ color: DIM }}>parks · holds no slot or session · up to 7 days</div>}
    </>
  );
}

/** Every snapshot the run checked: each way back makes a new one, and the approved one lands. */
function Snapshots({ beats, beat }: { beats: Beat[]; beat: number }) {
  const shown = beats.map((b, i) => ({ b, i })).filter(({ b }) => b.sha);
  const notes: Record<string, string> = { [CHANGE.frozen]: "frozen", [CHANGE.afterFix]: "after Fix check", [CHANGE.approved]: "after Address review", [CHANGE.landed]: "rebased onto main" };
  const approvedAt = (i: number) => beats.slice(i + 1).find((x) => x.sha || x.kind === "reviewOk")?.kind === "reviewOk";
  let current = -1;
  shown.forEach(({ i }, k) => { if (i <= beat) current = k; });
  return (
    <div className="mt-auto pt-5">
      <div className="pt-4 border-t border-dashed flex flex-wrap items-center gap-x-2 font-mono text-[12px]" style={{ borderColor: HAIR, color: DIM }}>
        <span className="font-semibold" style={{ color: TEXT }}>Snapshots</span>
        <span>each way back checks a new one</span>
      </div>
      <ol className="mt-2.5 flex flex-wrap gap-x-2 gap-y-3 font-mono">
        {shown.map(({ b, i }, k) => {
          const on = i <= beat;
          const now = k === current;
          const landed = b.sha === CHANGE.landed;
          const c = landed ? LINE : k === 0 ? PERSON : BACK;
          const note = landed ? notes[b.sha!] : approvedAt(i) && beat > i + 1 ? "approved" : notes[b.sha!] ?? "after Revise";
          return (
            <li key={`${b.sha}-${i}`} className="flex items-start gap-2">
              <div>
                <span className="h-[24px] inline-flex items-center gap-1.5 px-2 rounded-md text-[12.5px] transition-colors"
                  style={{ color: on ? (landed ? SOL.base3 : c) : DIM, backgroundColor: on ? (landed ? LINE : tint(c, now ? 16 : 9)) : "transparent", border: `1px ${on ? "solid" : "dashed"} ${on ? tint(c, now ? 80 : 40) : HAIR}`, boxShadow: now ? `0 0 0 3px ${tint(c, 14)}` : undefined }}>
                  <svg width={10} height={10} viewBox="0 0 10 10" aria-hidden><circle cx={5} cy={5} r={3} fill="none" stroke="currentColor" strokeWidth={1.5} /></svg>
                  {on ? b.sha : "·······"}
                </span>
                <div className="mt-1 text-meta" style={{ color: on ? MUTED : DIM }}>{on ? note : "next"}</div>
              </div>
              {k < shown.length - 1 && <span className="mt-[12px] w-4 h-px shrink-0" style={{ backgroundColor: on ? tint(BACK, 50) : HAIR }} />}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Log({ beats, beat, ghosts }: { beats: Beat[]; beat: number; ghosts: number }) {
  return (
    <ol className="font-mono text-[12.5px]" aria-label="Run log">
      {Array.from({ length: Math.max(beats.length, ghosts) }, (_, i) => {
        const b = beats[i];
        const on = !!b && i <= beat;
        return (
          <li key={i} className="flx-run-row flex items-center gap-2.5 min-h-[25px] px-2 rounded-md" data-on={on || undefined} data-now={(on && i === beat) || undefined}>
            <span className="w-5 shrink-0 tabular-nums text-meta" style={{ color: DIM }}>{String(i + 1).padStart(2, "0")}</span>
            {on ? (
              <>
                <span className="font-semibold shrink-0" style={{ color: b.via ? BACK : b.step === "decide" || b.step === "session" ? PERSON : INK }}>{b.log.name}</span>
                <span className="min-w-0" style={{ color: TONE[b.tone] }}>{b.log.out}</span>
                {b.log.meta && <span className="ml-auto shrink-0 text-[12px]" style={{ color: b.via ? BACK : MUTED }}>{b.log.meta}</span>}
              </>
            ) : (
              <span className="flx-run-ghost h-[3px] rounded-full" style={{ width: `${30 + ((i * 37) % 45)}%`, backgroundColor: HAIR }} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ---------- The player ----------

function PlayIcon({ mode }: { mode: "play" | "pause" | "replay" }) {
  if (mode === "pause") return <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden><rect x={2} y={1.5} width={2.8} height={9} rx={0.8} fill="currentColor" /><rect x={7.2} y={1.5} width={2.8} height={9} rx={0.8} fill="currentColor" /></svg>;
  if (mode === "play") return <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden><path d="M3 1.5 L10.5 6 L3 10.5 Z" fill="currentColor" /></svg>;
  return <svg width={13} height={13} viewBox="0 0 14 14" aria-hidden><path d="M3.2 4.2 A5 5 0 1 1 2.2 8" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" /><path d="M1.5 1.8 V5 H4.7" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function ChangeRun() {
  const still = useStill();
  const [ref, playing] = usePlayOnView<HTMLDivElement>();
  const inView = useNearViewport(ref, "0px", { latch: false });
  // Before it plays: the finished Ship run.
  const [answers, setAnswers] = useState<Answer[]>(["S"]);
  const [beat, setBeat] = useState(SHIP_RUN.length - 1);
  const [started, setStarted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [animate, setAnimate] = useState(false);
  const [inspect, setInspect] = useState<StepId | null>(null);
  const [lap, setLap] = useState(0); // restarts the current beat's clock on resume

  const beats = useMemo(() => buildBeats(answers), [answers]);
  const last = beats.length - 1;
  const b = beats[beat] ?? beats[last];
  const halted = paused || !!inspect;

  useWatchEffect(() => {
    if (still || !playing || started) return;
    const t = setTimeout(() => { setStarted(true); setAnswers([]); setAnimate(false); setBeat(0); }, 250);
    return () => clearTimeout(t);
  }, [playing, still, started]);

  const answer = (a: Answer) => {
    if (!b.pending) return;
    setAnswers((xs) => [...xs, a]);
    setAnimate(true);
    setBeat(beat + 1);
  };

  const beatMs = (animate ? travelMs(beats, beat) : 0) + b.dwell;
  useWatchEffect(() => {
    if (still || !started || halted || b.terminal) return;
    const t = setTimeout(() => {
      if (b.pending) return answer("S");
      if (beat < last) { setAnimate(true); setBeat(beat + 1); }
    }, beatMs);
    return () => clearTimeout(t);
  }, [beat, beats, halted, started, still, lap]);

  // At Decide the real keys answer while the figure is on screen.
  useEventListener("keydown", (e: KeyboardEvent) => {
    if (!b.pending || !inView || !started || e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
    const k = e.key.toUpperCase();
    if (k === "S" || k === "R" || k === "D") { e.preventDefault(); setInspect(null); setPaused(false); answer(k); }
  });

  const go = (nextAnswers: Answer[], i: number) => {
    setInspect(null); setAnimate(false); setStarted(true); setPaused(false);
    setAnswers(nextAnswers); setBeat(i); setLap((n) => n + 1);
  };
  // Jumping back to Decide or before asks again; jumping past it takes Ship.
  const jump = (c: number) => {
    const next = c <= 3 ? [] : ["S" as Answer];
    go(next, buildBeats(next).findIndex((x) => x.ch === c));
  };
  const done = !started || !!b.terminal;
  const mode: "play" | "pause" | "replay" = done ? "replay" : halted ? "play" : "pause";
  const onPlay = () => {
    if (mode === "replay") return go([], 0);
    if (mode === "play") { setInspect(null); setPaused(false); setLap((n) => n + 1); return; }
    setPaused(true);
  };
  const onInspect = (s: StepId) => {
    if (inspect === s) { setInspect(null); setLap((n) => n + 1); return; }
    setInspect(s);
  };

  const ch = b.ch;
  const status = b.kind === "live" ? "Live" : b.kind === "cap" ? "Revise · run ends" : `${STEPS[b.step].label} · ${b.tag}`;
  const ghosts = b.terminal ? 0 : buildBeats([...answers, ...(b.pending || !answers.includes("S") ? ["S" as Answer] : [])]).length;
  const flowProps = { beats, beat, animate, still, inspect, onInspect };
  return (
    <div ref={ref} className="flx-run-fig rounded-2xl border overflow-hidden" data-play={playing && !still ? "" : undefined} style={{ borderColor: HAIR, backgroundColor: PAPER, boxShadow: "0 30px 60px -44px rgba(0,43,54,.55)" }}>
      {/* The run's identity, status and controls. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 sm:px-5 py-3 border-b" style={{ borderColor: HAIR }}>
        <span className="w-2 h-2 rounded-full shrink-0 self-start mt-[7px]" style={{ backgroundColor: TONE[b.tone] }} />
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="font-mono font-semibold text-[14px]" style={{ color: INK }}>{PROBLEM.title}</span>
            <Chiplet color={MUTED}>{CHANGE.task}</Chiplet>
            <Chiplet color={LINE}>Change</Chiplet>
          </span>
          <span className="block mt-0.5 font-mono text-[12.5px]" style={{ color: DIM }}>{CHANGE.subject}</span>
        </span>
        <span className="ml-auto flex items-center gap-3">
          <span key={status} className="flx-run-status font-mono text-[12.5px]" style={{ color: TONE[b.tone] }}>{status}</span>
          <button type="button" onClick={onPlay} className="flx-run-btn inline-flex items-center gap-2 h-8 px-3 rounded-lg border font-mono text-[12.5px]" style={{ borderColor: HAIR, color: INK }} aria-label={mode === "pause" ? "Pause the run" : mode === "play" ? "Play the run" : "Replay the run"}>
            <PlayIcon mode={mode} />
            <span>{mode === "pause" ? "Pause" : mode === "play" ? "Play" : "Replay"}</span>
          </button>
        </span>
      </div>

      {/* Chapters: each a jump. Played ones carry a check, the current one fills; a finished run shows them all done. */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5 px-4 sm:px-5 pt-3">
        {CHAPTERS.map((name, c) => {
          const inCh = beats.filter((x) => x.ch === c);
          const first = beats.findIndex((x) => x.ch === c);
          const reached = first >= 0 && first <= beat;
          const state = b.terminal ? (reached ? (b.tone === "bad" && c === ch ? "ended" : "played") : "skipped") : c < ch ? "played" : c === ch ? "now" : "ahead";
          const count = Math.max(inCh.length, 1);
          const pos = beat - first;
          const from = state === "now" ? (pos / count) * 100 : state === "played" || state === "ended" ? 100 : 0;
          const to = state === "now" ? ((pos + 1) / count) * 100 : from;
          const moving = state === "now" && started && !still && !b.pending;
          return (
            <button key={name} type="button" onClick={() => jump(c)} aria-current={state === "now" ? "step" : undefined}
              className="flx-run-btn flx-run-chap text-left rounded-md px-2 pt-1.5 pb-2" data-state={state}>
              <span className="flex items-center gap-1.5 font-mono text-[12.5px]">
                <span className="flx-run-chap-n inline-flex items-center justify-center w-[18px] h-[18px] rounded-full text-meta tabular-nums shrink-0">
                  {state === "played" ? (
                    <svg width={9} height={9} viewBox="0 0 10 10" aria-hidden><path d="M1.5 5.2 L4 7.6 L8.5 2.6" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" /></svg>
                  ) : c + 1}
                </span>
                <span className="flx-run-chap-name">{name}</span>
              </span>
              <span className="flx-run-chap-bar mt-1.5 block rounded-full overflow-hidden">
                <span key={moving ? `${beat}-${lap}` : "rest"} className={`block h-full rounded-full ${moving ? "flx-run-fill" : ""}`}
                  style={{ width: `${to}%`, ["--from" as string]: `${from}%`, ["--ms" as string]: `${beatMs}ms`, animationPlayState: halted ? "paused" : "running" } as CSSProperties} />
              </span>
            </button>
          );
        })}
      </div>

      {/* Wide: the flow across the top, then the moment and the log side by side.
          Narrower: the flow stacked vertically on the left (or on top on a phone), the moment and log beside it. */}
      <div className="hidden min-[1100px]:block px-5 pt-4 pb-3">
        <Flow geo={GEO_H} {...flowProps} />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] md:grid-cols-[minmax(0,360px)_minmax(0,1fr)] min-[1100px]:grid-cols-[minmax(0,1fr)] mt-2 min-[1100px]:mt-0">
        <div className="min-[1100px]:hidden px-4 sm:px-5 pt-3 pb-5 md:border-r" style={{ borderColor: HAIR }}>
          <div className="mx-auto max-w-[400px]"><Flow geo={GEO_V} {...flowProps} /></div>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)] min-[1100px]:grid-cols-[minmax(0,1fr)_380px] border-t" style={{ borderColor: HAIR }}>
          <div className="p-4 sm:p-5 flex flex-col">
            <div key={inspect ? `i-${inspect}` : `b-${beat}-${b.kind}`} className="flx-run-moment" aria-live="polite">
              {inspect ? <WaysOut step={inspect} onClose={() => onInspect(inspect)} /> : <Moment beats={beats} beat={beat} onAnswer={(a) => { setPaused(false); answer(a); }} paused={halted} lap={lap} />}
            </div>
            <Snapshots beats={beats} beat={beat} />
          </div>
          <div className="p-3 sm:p-4 border-t min-[1100px]:border-t-0 min-[1100px]:border-l" style={{ borderColor: HAIR, backgroundColor: "#fbf6e8" }}>
            <div className="flex items-center gap-2 px-2 pb-2 font-mono text-[12.5px]" style={{ color: DIM }}>
              <span className="font-semibold" style={{ color: TEXT }}>Run log</span>
              <span className="ml-auto tabular-nums">{beat + 1} / {b.terminal ? beats.length : ghosts}</span>
            </div>
            <Log beats={beats} beat={beat} ghosts={ghosts} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function ChangeRunSection() {
  return (
    <Section
      id="checks"
      tone="plain"
      wide
      title="Check, Review and Decide"
      ticket={{ at: 3, state: "approved, shipped at Decide", value: CHANGE.approved }}
      lede={
        <>
          <p>A change written by hand passes the same <b>Check</b>, <b>Review</b> and <b>Decide</b> as one an agent wrote overnight. Every way back runs in the session the change came from and returns to Check on a fresh snapshot.</p>
          <p>Each way back may run 3 times; a fourth ends the run. Decide waits on a person: S ships, R sends a note back, D drops it. What lands is the snapshot Review approved and Decide accepted.</p>
        </>
      }
    >
      <ChangeRun />
    </Section>
  );
}
