"use client";

import type { CSSProperties } from "react";
import { SOL } from "../blogChrome";
import { FigureStyles, Stage, t } from "../figureKit";

/**
 * Illustrations for "A board on every call", built on the shared figure kit
 * (../figureKit.tsx). The mechanics follow the code: the board is made by
 * convex/callStage.ts (ensureCallBoard, writePin, STAGE_PIN_LIMIT), the agent
 * is fed by convex/transcripts.ts (an `ask` chunk when someone names it, a
 * `context` chunk at most every CONTEXT_MIN_GAP_MS = 60 s otherwise), and what
 * it is told lives in packages/shared/contracts/transcriptChunk.ts
 * (huddleBoardNote, HUDDLE_PASS).
 */

export { FigureStyles };

const STICKY = { yellow: "#f5e9cf", green: "#e1e8d2", blue: "#d8dee6", orange: "#f0dccd" } as const;
const PEOPLE = [
  { n: "Priya", c: SOL.magenta },
  { n: "Theo", c: SOL.blue },
  { n: "Maya", c: SOL.yellow },
];

function Head({ x, y, dir, color, style }: { x: number; y: number; dir: "r" | "d"; color: string; style?: CSSProperties }) {
  const d = dir === "r" ? `M${x} ${y}l-7 -4v8z` : `M${x} ${y}l-4 -7h8z`;
  return <path d={d} fill={color} className="bj-pop" style={style} />;
}

function Arrow({ d, at, dur = 0.35, color = SOL.base1, w = 1.2 }: { d: string; at: number; dur?: number; color?: string; w?: number }) {
  return <path d={d} pathLength={1} stroke={color} strokeWidth={w} fill="none" className="bj-draw" style={t(at, dur)} />;
}

/** A sticky note on a small board: pops in at `at`. */
function Note({ x, y, w = 46, h = 30, fill, at, label }: { x: number; y: number; w?: number; h?: number; fill: string; at: number; label?: string }) {
  return (
    <g className="bj-pop" style={t(at)}>
      <rect x={x} y={y} width={w} height={h} rx={3} fill={fill} />
      {label ? (
        <text x={x + w / 2} y={y + h / 2 + 3} textAnchor="middle" fontSize="8.5" fill={SOL.base02}>{label}</text>
      ) : (
        <>
          <rect x={x + 6} y={y + 9} width={w - 12} height={3} rx={1.5} fill={SOL.base1} opacity={0.55} />
          <rect x={x + 6} y={y + 16} width={w - 20} height={3} rx={1.5} fill={SOL.base1} opacity={0.55} />
        </>
      )}
    </g>
  );
}

// ─── From the room to the board ───────────────────────────────────────────

const LINES = [
  { who: 0, w: 120, at: 0.5 },
  { who: 1, w: 96, at: 0.8 },
  { who: 1, w: 132, at: 1.1 },
  { who: 2, w: 84, at: 1.4 },
  { who: 0, w: 110, at: 1.7 },
];

export function PipelineFigure() {
  return (
    <Stage minWidth={680}>
      <svg viewBox="0 0 740 380" className="w-full block font-mono" role="img" aria-label="People talk in the huddle. The transcript is written by speaker. A line that names the agent reaches it right away; the rest of the talk reaches it at most once a minute. On its turn the agent writes to the board, publishes a page, files a task, or passes. Every person's stage shows the change at once.">
        {[
          { x: 62, s: "the room" },
          { x: 210, s: "transcript" },
          { x: 372, s: "the agent's turn" },
          { x: 540, s: "what it does" },
          { x: 676, s: "every stage" },
        ].map((c, i) => (
          <text key={c.s} x={c.x} y={34} textAnchor="middle" fontSize="11.5" fontWeight={700} fill={SOL.base02} className="bj-fade" style={t(i * 0.12)}>{c.s}</text>
        ))}

        {/* The room: three people talking */}
        {PEOPLE.map((p, i) => {
          const y = 80 + i * 70;
          return (
            <g key={p.n}>
              <circle cx={44} cy={y} r={17} fill={p.c} className="bj-pop" style={t(0.1 + i * 0.1)} />
              <text x={44} y={y + 4.5} textAnchor="middle" fontSize="13" fontWeight={700} fill="#fff" className="bj-pop" style={t(0.1 + i * 0.1)}>{p.n[0]}</text>
              <text x={44} y={y + 34} textAnchor="middle" fontSize="9.5" fill={SOL.base01} className="bj-fade" style={t(0.2 + i * 0.1)}>{p.n}</text>
              {[0, 1, 2, 3].map((k) => (
                <rect key={k} x={72 + k * 7} y={y - 2 - ((k * 5 + i * 3) % 9)} width={3} height={4 + ((k * 5 + i * 3) % 9) * 2} rx={1.5} fill={p.c} opacity={0.75} className="bj-pulse bj-fade" style={t(0.3 + k * 0.15 + i * 0.4)} />
              ))}
            </g>
          );
        })}
        <Arrow d="M110 150H140" at={0.4} />
        <Head x={144} y={150} dir="r" color={SOL.base1} style={t(0.7)} />

        {/* Transcript, by speaker */}
        <rect x={148} y={58} width={124} height={190} rx={10} fill={SOL.base2} className="bj-fade" style={t(0.3)} />
        {LINES.map((l, i) => (
          <g key={i} className="bj-rise" style={t(l.at)}>
            <circle cx={162} cy={82 + i * 34} r={4} fill={PEOPLE[l.who].c} />
            <rect x={172} y={79 + i * 34} width={l.w * 0.7} height={6} rx={3} fill={SOL.base1} opacity={0.7} />
            <rect x={172} y={90 + i * 34} width={l.w * 0.45} height={6} rx={3} fill={SOL.base1} opacity={0.45} />
          </g>
        ))}
        <text x={210} y={270} textAnchor="middle" fontSize="9.5" fill={SOL.base1} className="bj-fade" style={t(1.2)}>every line has its speaker</text>

        {/* Two lanes */}
        <Arrow d="M274 108C296 108 300 96 318 96" at={2.0} color={SOL.cyan} w={1.6} />
        <Head x={322} y={96} dir="r" color={SOL.cyan} style={t(2.3)} />
        <text x={292} y={84} textAnchor="middle" fontSize="9.5" fill={SOL.cyan} className="bj-fade" style={t(2.1)}>named: now</text>
        <Arrow d="M274 196C296 196 300 208 318 208" at={2.2} color={SOL.base0} w={1.6} />
        <Head x={322} y={208} dir="r" color={SOL.base0} style={t(2.5)} />
        <text x={298} y={232} textAnchor="middle" fontSize="9.5" fill={SOL.base0} className="bj-fade" style={t(2.3)}>the rest:</text>
        <text x={298} y={244} textAnchor="middle" fontSize="9.5" fill={SOL.base0} className="bj-fade" style={t(2.3)}>once a minute</text>

        {/* The agent's turn */}
        <rect x={326} y={70} width={92} height={160} rx={12} fill={SOL.base3} stroke={SOL.cyan} strokeWidth={2} className="bj-pop" style={t(2.6)} />
        <text x={372} y={104} textAnchor="middle" fontSize="20" fill={SOL.cyan} className="bj-pop" style={t(2.8)}>✳</text>
        <text x={372} y={126} textAnchor="middle" fontSize="10.5" fontWeight={700} fill={SOL.base02} className="bj-fade" style={t(2.8)}>Juniper</text>
        {["reads board", "checks code", "decides"].map((s, i) => (
          <text key={s} x={372} y={156 + i * 18} textAnchor="middle" fontSize="9.5" fill={SOL.base01} className="bj-fade" style={t(3.0 + i * 0.2)}>{s}</text>
        ))}

        {/* What it does */}
        {[
          { y: 70, s: "notes on the board", c: SOL.yellow },
          { y: 112, s: "a page, on the board", c: SOL.blue },
          { y: 154, s: "a task from the call", c: SOL.green },
          { y: 196, s: "one line in the chat", c: SOL.violet },
          { y: 238, s: "[pass]: says nothing", c: SOL.base1 },
        ].map((o, i) => (
          <g key={o.s}>
            <Arrow d={`M420 150C446 150 448 ${o.y + 13} 466 ${o.y + 13}`} at={3.7 + i * 0.12} color={o.c} />
            <rect x={470} y={o.y} width={140} height={26} rx={7} fill={SOL.base2} className="bj-rise" style={t(3.9 + i * 0.12)} />
            <rect x={470} y={o.y} width={4} height={26} rx={2} fill={o.c} className="bj-rise" style={t(3.9 + i * 0.12)} />
            <text x={482} y={o.y + 17} fontSize="10" fill={SOL.base02} className="bj-rise" style={t(3.9 + i * 0.12)}>{o.s}</text>
          </g>
        ))}

        {/* Every stage: three screens, the same note lands on each */}
        <Arrow d="M612 98H636" at={4.8} color={SOL.yellow} w={1.6} />
        <Head x={640} y={98} dir="r" color={SOL.yellow} style={t(5.1)} />
        {PEOPLE.map((p, i) => {
          const y = 56 + i * 82;
          return (
            <g key={p.n}>
              <rect x={644} y={y} width={88} height={62} rx={7} fill={SOL.base02} className="bj-fade" style={t(4.6 + i * 0.08)} />
              <rect x={650} y={y + 6} width={60} height={50} rx={4} fill="#2a2f36" className="bj-fade" style={t(4.6 + i * 0.08)} />
              <circle cx={721} cy={y + 13} r={5} fill={p.c} className="bj-fade" style={t(4.6 + i * 0.08)} />
              <circle cx={721} cy={y + 27} r={5} fill={SOL.base01} className="bj-fade" style={t(4.6 + i * 0.08)} />
              <rect x={655} y={y + 11} width={20} height={14} rx={2} fill={STICKY.yellow} className="bj-fade" style={t(4.7)} />
              <rect x={679} y={y + 11} width={20} height={14} rx={2} fill={STICKY.blue} className="bj-fade" style={t(4.7)} />
              <rect x={655} y={y + 31} width={20} height={14} rx={2} fill={STICKY.green} className="bj-pop" style={t(5.3)} />
              <text x={688} y={y + 76} textAnchor="middle" fontSize="9" fill={SOL.base1} className="bj-fade" style={t(4.7)}>{p.n}</text>
            </g>
          );
        })}

        <text x={370} y={330} textAnchor="middle" fontSize="10.5" fill={SOL.base01} className="bj-fade" style={t(5.6)}>For a longer job the agent takes a hold: the talk waits and arrives in one piece when it is done.</text>
        <text x={370} y={350} textAnchor="middle" fontSize="10.5" fill={SOL.base01} className="bj-fade" style={t(5.8)}>Every chunk it gets names the board, so a long call does not make it forget the board exists.</text>
      </svg>
    </Stage>
  );
}

// ─── Two screens, one board ───────────────────────────────────────────────

function Screen({ x, who, color }: { x: number; who: string; color: string }) {
  const y = 48;
  return (
    <g>
      <rect x={x} y={y} width={330} height={236} rx={12} fill={SOL.base02} className="bj-fade" style={t(0)} />
      {/* top bar and stage tabs */}
      <circle cx={x + 16} cy={y + 16} r={3.5} fill={SOL.red} className="bj-fade" style={t(0)} />
      <text x={x + 26} y={y + 19.5} fontSize="9" fill={SOL.base1} className="bj-fade" style={t(0)}>Huddle · 4 in call</text>
      <rect x={x + 150} y={y + 7} width={92} height={18} rx={5} fill={SOL.cyan} opacity={0.28} className="bj-fade" style={t(0.3)} />
      <text x={x + 196} y={y + 19.5} textAnchor="middle" fontSize="8.5" fill="#d9f0ee" className="bj-fade" style={t(0.3)}>The call's board</text>
      <rect x={x + 246} y={y + 7} width={74} height={18} rx={5} fill="#3b434c" className="bj-fade" style={t(2.6)} />
      <text x={x + 283} y={y + 19.5} textAnchor="middle" fontSize="8.5" fill={SOL.base1} className="bj-fade" style={t(2.6)}>Pricing sheet</text>
      {/* board */}
      <rect x={x + 10} y={y + 32} width={250} height={194} rx={8} fill="#262b31" className="bj-fade" style={t(0.2)} />
      {/* faces strip */}
      {[0, 1, 2, 3].map((k) => (
        <g key={k}>
          <rect x={x + 268} y={y + 32 + k * 49} width={52} height={44} rx={6} fill="#262b31" className="bj-fade" style={t(0.1)} />
          <circle cx={x + 294} cy={y + 52 + k * 49} r={9} fill={[SOL.magenta, SOL.blue, SOL.yellow, SOL.cyan][k]} className="bj-fade" style={t(0.1)} />
        </g>
      ))}
      <text x={x + 165} y={y + 258} textAnchor="middle" fontSize="11" fontWeight={700} fill={color} className="bj-fade" style={t(0.2)}>{who}'s screen</text>
    </g>
  );
}

function SharedNotes({ ox, oy }: { ox: number; oy: number }) {
  return (
    <g>
      <Note x={ox + 22} y={oy + 52} w={64} h={38} fill={STICKY.yellow} at={0.6} label="Launch Thu" />
      <Note x={ox + 94} y={oy + 52} w={64} h={38} fill={STICKY.yellow} at={0.75} label="40 teams" />
      {/* Theo writes this one on his screen; it arrives on Priya's at once */}
      <Note x={ox + 22} y={oy + 104} w={64} h={38} fill={STICKY.blue} at={1.6} label="Debounce" />
      {/* the agent writes this one */}
      <Note x={ox + 94} y={oy + 104} w={64} h={38} fill={STICKY.green} at={3.4} label="Decided: A" />
      <path d={`M${ox + 87} ${oy + 123}H${ox + 93}`} stroke={SOL.base1} strokeWidth={1.2} className="bj-fade" style={t(3.6)} />
      <Note x={ox + 22} y={oy + 156} w={64} h={38} fill={STICKY.yellow} at={4.9} label="Theo: Tue" />
      <Note x={ox + 94} y={oy + 156} w={64} h={38} fill={STICKY.orange} at={5.1} label="Open?" />
      <Note x={ox + 168} y={oy + 52} w={84} h={90} fill="#fbf6e7" at={4.3} label=" " />
      <text x={ox + 175} y={oy + 68} fontSize="7.5" fontWeight={700} fill={SOL.base02} className="bj-fade" style={t(4.4)}>page: p95</text>
      <rect x={ox + 175} y={oy + 80} width={30} height={7} rx={2} fill={SOL.cyan} className="bj-grow" style={t(4.5, 0.3)} />
      <rect x={ox + 175} y={oy + 94} width={46} height={7} rx={2} fill={SOL.yellow} className="bj-grow" style={t(4.6, 0.3)} />
      <rect x={ox + 175} y={oy + 108} width={68} height={7} rx={2} fill={SOL.red} className="bj-grow" style={t(4.7, 0.3)} />
    </g>
  );
}

function Cursor({ x, y, label, color, at, to, dur }: { x: number; y: number; label: string; color: string; at: number; to: [number, number]; dur: number }) {
  const style = { ...t(at, dur), "--cx": `${to[0]}px`, "--cy": `${to[1]}px` } as CSSProperties;
  return (
    <g className="cb-move" style={style}>
      <g transform={`translate(${x} ${y})`}>
        <path d="M0 0L0 13L3.5 10L6 15.5L8 14.5L5.5 9.5L10 9.5Z" fill={color} stroke="#fff" strokeWidth={0.8} />
        <rect x={10} y={12} width={label.length * 5.6 + 10} height={13} rx={3} fill={color} />
        <text x={15} y={21.5} fontSize="8" fontWeight={700} fill="#fff">{label}</text>
      </g>
    </g>
  );
}

const CURSOR_CSS = `
.cb-move{opacity:0}
[data-play="1"] .cb-move{animation:cb-move var(--dur,1s) cubic-bezier(.45,0,.25,1) var(--at,0s) forwards}
@keyframes cb-move{0%{opacity:1;transform:translate(0,0)}100%{opacity:1;transform:translate(var(--cx),var(--cy))}}
@media (prefers-reduced-motion:reduce){.cb-move{opacity:1}}
`;

export function TwoScreensFigure() {
  return (
    <Stage minWidth={560}>
      <style>{CURSOR_CSS}</style>
      <svg viewBox="0 20 720 300" className="w-full block font-mono" role="img" aria-label="Two people's screens in the same huddle. Each shows the call's board itself, live. A note Theo adds appears on Priya's screen at once, with Theo's cursor; the agent's cursor adds the decision and a published page; a second pin, a pricing sheet, gets its own tab.">
        <Screen x={14} who="Priya" color={SOL.magenta} />
        <Screen x={376} who="Theo" color={SOL.blue} />
        <SharedNotes ox={14} oy={48} />
        <SharedNotes ox={376} oy={48} />
        {/* Theo's cursor on both screens, then Juniper's */}
        <Cursor x={130} y={250} label="Theo" color={SOL.blue} at={0.9} dur={0.8} to={[-50, -70]} />
        <Cursor x={492} y={250} label="Theo" color={SOL.blue} at={0.9} dur={0.8} to={[-50, -70]} />
        <Cursor x={230} y={110} label="✳ Juniper" color={SOL.cyan} at={2.7} dur={0.8} to={[-80, 70]} />
        <Cursor x={592} y={110} label="✳ Juniper" color={SOL.cyan} at={2.7} dur={0.8} to={[-80, 70]} />
      </svg>
    </Stage>
  );
}

// ─── The board's life ─────────────────────────────────────────────────────

const STEPS = [
  { x: 40, title: "Call starts", sub: ["faces and", "screen shares"], c: SOL.base1 },
  { x: 180, title: "First agent joins", sub: ["the board is made", "and pinned"], c: SOL.cyan },
  { x: 330, title: "The talk", sub: ["agent and people", "edit it together"], c: SOL.yellow },
  { x: 480, title: "Taken down?", sub: ["it stays down until", "someone pins it"], c: SOL.orange },
  { x: 630, title: "Call ends", sub: ["the board stays", "on the call's page"], c: SOL.green },
];

export function LifeFigure() {
  return (
    <Stage minWidth={560}>
      <svg viewBox="0 0 700 190" className="w-full block font-mono" role="img" aria-label="The board's life: the call starts with faces and screen shares; the first agent to join makes the board and pins it; people and the agent edit it during the talk; if someone takes it off the stage it stays off until someone pins it again; when the call ends the board stays, linked from the call's page and listed in Docs.">
        <path d="M30 70H680" pathLength={1} stroke={SOL.base2} strokeWidth={4} strokeLinecap="round" fill="none" className="bj-draw" style={t(0, 1.2)} />
        <path d="M30 70H680" pathLength={1} stroke={SOL.cyan} strokeWidth={4} strokeLinecap="round" fill="none" className="bj-draw" style={t(0.9, 3.6)} />
        {STEPS.map((s, i) => (
          <g key={s.title}>
            <circle cx={s.x} cy={70} r={9} fill={SOL.base3} stroke={s.c} strokeWidth={3} className="bj-pop" style={t(0.4 + i * 0.75)} />
            <text x={s.x} y={44} textAnchor="middle" fontSize="11.5" fontWeight={700} fill={SOL.base02} className="bj-rise" style={t(0.5 + i * 0.75)}>{s.title}</text>
            {s.sub.map((line, k) => (
              <text key={line} x={s.x} y={100 + k * 15} textAnchor="middle" fontSize="10" fill={SOL.base01} className="bj-rise" style={t(0.6 + i * 0.75)}>{line}</text>
            ))}
          </g>
        ))}
        {/* small board icons growing along the talk */}
        {[0, 1, 2, 3, 4, 5].map((k) => (
          <rect key={k} x={300 + (k % 3) * 22} y={140 + Math.floor(k / 3) * 16} width={18} height={12} rx={2} fill={[STICKY.yellow, STICKY.blue, STICKY.green][k % 3]} className="bj-pop" style={t(2.0 + k * 0.12)} />
        ))}
        <rect x={606} y={140} width={48} height={30} rx={4} fill={SOL.base2} className="bj-pop" style={t(3.8)} />
        <rect x={612} y={146} width={14} height={8} rx={1.5} fill={STICKY.yellow} className="bj-pop" style={t(3.9)} />
        <rect x={630} y={146} width={14} height={8} rx={1.5} fill={STICKY.green} className="bj-pop" style={t(4.0)} />
        <rect x={612} y={158} width={32} height={6} rx={1.5} fill={STICKY.blue} className="bj-pop" style={t(4.1)} />
      </svg>
    </Stage>
  );
}
