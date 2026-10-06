"use client";

import { SOL } from "../../../blog/blogChrome";
import { Stage, t } from "../../../blog/figureKit";

/**
 * Figures for the Codex Cloud guide: which machine talks to Codex and with
 * what, how attempts become branches of one session, and the states a
 * computer's Codex Cloud link can be in.
 */

function Dots({ id, w, h }: { id: string; w: number; h: number }) {
  return (
    <>
      <defs>
        <pattern id={id} width="20" height="20" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.9" fill={SOL.base2} />
        </pattern>
        <marker id={`${id}-arrow`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0L8 4L0 8z" fill={SOL.base1} />
        </marker>
      </defs>
      <rect width={w} height={h} fill={`url(#${id})`} />
    </>
  );
}

function Box({ x, y, w, h, title, lines, color, at }: { x: number; y: number; w: number; h: number; title: string; lines: string[]; color: string; at: number }) {
  return (
    <g className="bj-pop" style={t(at)}>
      <rect x={x} y={y} width={w} height={h} rx={8} fill={SOL.base3} stroke={color} strokeWidth={1.5} />
      <text x={x + 12} y={y + 20} fontSize="11.5" fontWeight={700} fill={SOL.base02}>{title}</text>
      {lines.map((l, i) => (
        <text key={l} x={x + 12} y={y + 38 + i * 14} fontSize="10" fill={SOL.base01}>{l}</text>
      ))}
    </g>
  );
}

// ─── Who talks to Codex ────────────────────────────────────────────────────

/** The browser cannot call Codex; your computer does, with a sign-in it only reads. */
export function CodexPathFigure() {
  return (
    <Stage minWidth={700}>
      <svg viewBox="0 0 760 320" className="w-full block font-mono" role="img" aria-label="A message from the composer reaches your computer's daemon, which calls Codex Cloud with the local ChatGPT sign-in; the task's transcript comes back as a mirrored session">
        <Dots id="cx-grid" w={760} h={320} />
        <Box x={20} y={40} w={170} h={76} title="composer" lines={["Codex, OpenAI's cloud,", "ChatGPT plan"]} color={SOL.blue} at={0.2} />
        <Box x={20} y={206} w={170} h={76} title="your inbox" lines={["a Codex session:", "title, branch, PR, diff"]} color={SOL.blue} at={3.4} />

        <g className="bj-pop" style={t(0.6)}>
          <rect x={260} y={40} width={230} height={242} rx={10} fill={SOL.base3} stroke={SOL.green} strokeWidth={1.6} />
          <text x={274} y={62} fontSize="11.5" fontWeight={700} fill={SOL.base02}>your computer</text>
          <text x={274} y={78} fontSize="10" fill={SOL.base01}>the codecast daemon</text>
          <rect x={274} y={92} width={202} height={50} rx={6} fill={`${SOL.yellow}14`} stroke={SOL.yellow} strokeDasharray="3 3" />
          <text x={286} y={112} fontSize="10.5" fill={SOL.base02}>~/.codex/auth.json</text>
          <text x={286} y={128} fontSize="10" fill={SOL.yellow}>read only, never refreshed</text>
          <rect x={274} y={204} width={202} height={62} rx={6} fill={SOL.base2} opacity={0.7} />
          <text x={286} y={222} fontSize="10.5" fill={SOL.base02}>~/.codecast/codex-cloud/</text>
          <text x={286} y={237} fontSize="10.5" fill={SOL.base02}>  &lt;task id&gt;/</text>
          <text x={286} y={254} fontSize="10" fill={SOL.base01}>the mirror, your user only</text>
        </g>

        <Box x={560} y={40} w={180} h={150} title="Codex Cloud" lines={["OpenAI's machines", "", "the repo's environment", "clones from GitHub", "pushed commits only"]} color={SOL.violet} at={1.4} />

        {/* message out */}
        <path d="M192 78C224 78 226 78 256 78" pathLength={1} fill="none" stroke={SOL.blue} strokeWidth={1.5} markerEnd="url(#cx-grid-arrow)" className="bj-draw" style={t(0.9, 0.3)} />
        <text x={224} y={70} fontSize="9.5" textAnchor="middle" fill={SOL.base01} className="bj-fade" style={t(0.9)}>via</text>
        <text x={224} y={96} fontSize="9.5" textAnchor="middle" fill={SOL.base01} className="bj-fade" style={t(0.9)}>Convex</text>
        <path d="M492 112C522 112 528 100 556 100" pathLength={1} fill="none" stroke={SOL.violet} strokeWidth={1.5} markerEnd="url(#cx-grid-arrow)" className="bj-draw" style={t(1.6, 0.35)} />
        <text x={524} y={92} fontSize="9.5" textAnchor="middle" fill={SOL.violet} className="bj-fade" style={t(1.8)}>private API</text>

        {/* poll back */}
        <path d="M650 192C650 236 560 236 494 236" pathLength={1} fill="none" stroke={SOL.violet} strokeWidth={1.5} strokeDasharray="4 3" markerEnd="url(#cx-grid-arrow)" className="bj-draw" style={t(2.3, 0.5)} />
        <g className="bj-rise" style={t(2.6)}>
          <text x={560} y={258} fontSize="10" fill={SOL.base02}>polls every 5 min,</text>
          <text x={560} y={272} fontSize="10" fill={SOL.base02}>every 30 s while a task</text>
          <text x={560} y={286} fontSize="10" fill={SOL.base02}>runs or just got a message</text>
        </g>
        <path d="M258 244C228 244 224 244 194 244" pathLength={1} fill="none" stroke={SOL.blue} strokeWidth={1.5} markerEnd="url(#cx-grid-arrow)" className="bj-draw" style={t(3.1, 0.3)} />

        <g className="bj-pop" style={t(3.8)}>
          <circle cx={30} cy={304} r={6} fill={SOL.green} />
          <path d="M27 304l2 2 4-4.5" stroke={SOL.base3} strokeWidth={1.6} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </g>
        <text x={42} y={308} fontSize="10.5" fill={SOL.green} className="bj-fade" style={t(3.9)}>the sign-in and its tokens never leave your computer</text>
      </svg>
    </Stage>
  );
}

// ─── Attempts as branches ──────────────────────────────────────────────────

/** Three attempts at one prompt: the session forks at the prompt; each branch keeps its own follow-ups. */
export function AttemptsFigure() {
  const PROMPT = { x: 70, y: 150 };
  const ys = [70, 150, 230];
  const colors = [SOL.blue, SOL.magenta, SOL.cyan];
  return (
    <Stage minWidth={660}>
      <svg viewBox="0 0 760 300" className="w-full block font-mono" role="img" aria-label="A first message with three attempts forks the session into three branches at the shared prompt; a follow-up on attempt 2 continues that attempt, while the task's own line stays on attempt 1">
        <Dots id="at-grid" w={760} h={300} />
        <g className="bj-pop" style={t(0.2)}>
          <rect x={20} y={PROMPT.y - 30} width={150} height={60} rx={8} fill={SOL.base03} />
          <text x={34} y={PROMPT.y - 8} fontSize="10" fill={SOL.base1}>first message</text>
          <text x={34} y={PROMPT.y + 8} fontSize="11" fill={SOL.base3}>"port the v1 routes"</text>
          <text x={34} y={PROMPT.y + 22} fontSize="10" fill={SOL.orange}>attempts: 3</text>
        </g>
        {ys.map((y, i) => (
          <g key={i}>
            <path d={`M172 ${PROMPT.y}C220 ${PROMPT.y} 220 ${y} 268 ${y}`} pathLength={1} fill="none" stroke={colors[i]} strokeWidth={1.8} className="bj-draw" style={t(0.6 + i * 0.15, 0.4)} />
            <g className="bj-pop" style={t(1.0 + i * 0.15)}>
              <rect x={268} y={y - 16} width={164} height={32} rx={6} fill={SOL.base3} stroke={colors[i]} strokeWidth={1.4} />
              <text x={280} y={y + 4} fontSize="11" fill={SOL.base02}>{`attempt ${i + 1}`}</text>
              <text x={420} y={y + 4} fontSize="10" textAnchor="end" fill={SOL.base1}>{i === 0 ? "the task's line" : "a branch"}</text>
            </g>
          </g>
        ))}
        {/* follow-up on attempt 2 */}
        <path d={`M434 ${ys[1]}H500`} pathLength={1} stroke={colors[1]} strokeWidth={1.8} className="bj-draw" style={t(1.8, 0.3)} />
        <g className="bj-pop" style={t(2.1)}>
          <rect x={500} y={ys[1] - 16} width={240} height={32} rx={6} fill={`${SOL.magenta}14`} stroke={colors[1]} strokeWidth={1.4} />
          <text x={512} y={ys[1] + 4} fontSize="11" fill={SOL.base02}>"keep the old route too"</text>
        </g>
        <text x={500} y={ys[1] + 34} fontSize="10" fill={SOL.magenta} className="bj-fade" style={t(2.3)}>sent on a branch: continues attempt 2</text>
        <path d={`M434 ${ys[0]}H500`} pathLength={1} stroke={colors[0]} strokeWidth={1.8} strokeDasharray="3 3" className="bj-draw" style={t(2.6, 0.3)} />
        <text x={508} y={ys[0] + 4} fontSize="10" fill={SOL.blue} className="bj-fade" style={t(2.8)}>the task's own line stays on attempt 1</text>
        <text x={20} y={286} fontSize="10" fill={SOL.base01} className="bj-fade" style={t(3.1)}>
          Switch between attempts under the shared prompt. Stopping the session cancels the whole task, every attempt at once.
        </text>
      </svg>
    </Stage>
  );
}

// ─── States of the link ────────────────────────────────────────────────────

const STATES = [
  { x: 20, y: 22, color: SOL.yellow, title: "limited", into: "a plan window is used up", life: ["new tasks and messages wait", "running tasks keep syncing"], out: "the window resets" },
  { x: 520, y: 22, color: SOL.orange, title: "rate limited", into: "Codex limits the requests", life: ["nothing syncs; backs off", "1 min up to 30 min"], out: "as long as Codex says" },
  { x: 20, y: 196, color: SOL.violet, title: "no access", into: "the workspace keeps it off", life: ["asks once per poll,", "says nothing more"], out: "an answer that lets it in" },
  { x: 520, y: 196, color: SOL.red, title: "paused", into: "a field changed, or 3 odd answers", life: ["nothing syncs, nothing sent", "checks again every 5 min"], out: "a check that reads cleanly" },
];

/** One computer's link to Codex Cloud: syncing, and the four ways it stops, each with its own way back. */
export function CodexStatesFigure() {
  const C = { x: 290, y: 118, w: 180, h: 72 };
  const centre = { x: C.x + C.w / 2, y: C.y + C.h / 2 };
  return (
    <Stage minWidth={700}>
      <svg viewBox="0 0 760 340" className="w-full block font-mono" role="img" aria-label="From syncing, a used-up window, request rate limiting, a workspace without access or an API change each lead to a state with its own way back to syncing">
        <Dots id="st-grid" w={760} h={340} />
        <g className="bj-pop" style={t(0.2)}>
          <rect x={C.x} y={C.y} width={C.w} height={C.h} rx={10} fill={SOL.base3} stroke={SOL.green} strokeWidth={2} />
          <text x={centre.x} y={C.y + 30} fontSize="13" fontWeight={700} textAnchor="middle" fill={SOL.green}>syncing</text>
          <text x={centre.x} y={C.y + 48} fontSize="10" textAnchor="middle" fill={SOL.base01}>an outage retries as usual</text>
        </g>
        {STATES.map((s, i) => {
          const w = 220;
          const h = 118;
          const at = 0.7 + i * 0.55;
          const left = s.x < 300;
          const top = s.y < 100;
          const sx = left ? s.x + w : s.x;
          const sy = s.y + h / 2;
          const cx = left ? C.x : C.x + C.w;
          const cy = top ? C.y + 18 : C.y + C.h - 18;
          return (
            <g key={s.title}>
              <path d={`M${cx} ${cy - 6}C${(cx + sx) / 2} ${cy - 6} ${(cx + sx) / 2} ${sy - 8} ${sx + (left ? 4 : -4)} ${sy - 8}`} pathLength={1} fill="none" stroke={s.color} strokeWidth={1.4} markerEnd="url(#st-grid-arrow)" className="bj-draw" style={t(at, 0.35)} />
              <path d={`M${sx + (left ? 2 : -2)} ${sy + 10}C${(cx + sx) / 2} ${sy + 10} ${(cx + sx) / 2} ${cy + 6} ${cx + (left ? -4 : 4)} ${cy + 6}`} pathLength={1} fill="none" stroke={SOL.green} strokeOpacity={0.7} strokeDasharray="3 3" strokeWidth={1.3} markerEnd="url(#st-grid-arrow)" className="bj-draw" style={t(at + 0.4, 0.35)} />
              <g className="bj-rise" style={t(at + 0.15)}>
                <rect x={s.x} y={s.y} width={w} height={h} rx={8} fill={SOL.base3} stroke={s.color} strokeWidth={1.5} />
                <text x={s.x + 12} y={s.y + 20} fontSize="12" fontWeight={700} fill={s.color}>{s.title}</text>
                <text x={s.x + 12} y={s.y + 36} fontSize="9.5" fill={SOL.base1}>{`when ${s.into}`}</text>
                {s.life.map((l, j) => (
                  <text key={l} x={s.x + 12} y={s.y + 58 + j * 14} fontSize="10" fill={SOL.base02}>{l}</text>
                ))}
                <text x={s.x + 12} y={s.y + h - 12} fontSize="9.5" fill={SOL.green}>{`back on: ${s.out}`}</text>
              </g>
            </g>
          );
        })}
        <text x={380} y={330} fontSize="10" textAnchor="middle" fill={SOL.base01} className="bj-fade" style={t(3.4)}>
          A message sent while not syncing is held with a card that names the reason, and goes out on its own.
        </text>
      </svg>
    </Stage>
  );
}
