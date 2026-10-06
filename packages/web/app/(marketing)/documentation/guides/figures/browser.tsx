"use client";

import { SOL } from "../../../blog/blogChrome";
import { Stage, t } from "../../../blog/figureKit";

/**
 * Figures for the browser guide: the bridge between short CLI processes and
 * the human's Chrome, the cost of separate commands against one `do` flow,
 * and how a stale ref finds its way back to the row the agent chose.
 */

function Grid({ id, w, h }: { id: string; w: number; h: number }) {
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

// ─── The bridge ─────────────────────────────────────────────────────────────

const CLIS = [
  { y: 52, verb: "cast browser click", who: "session A", color: SOL.blue, at: 0.2 },
  { y: 106, verb: "cast browser open", who: "session B", color: SOL.magenta, at: 0.7 },
  { y: 160, verb: "cast browser shot", who: "session A", color: SOL.blue, at: 1.2 },
];

/** Many short CLI processes share one long-lived host; the extension drives only agent tabs. */
export function BridgeFigure() {
  const HOST = { x: 258, y: 86, w: 176, h: 76 };
  const CHROME = { x: 498, y: 26, w: 246, h: 196 };
  return (
    <Stage minWidth={660}>
      <svg viewBox="0 0 760 330" className="w-full block font-mono" role="img" aria-label="Short cast browser processes reach a bridge host on loopback, which the extension in the human's Chrome connects to after a mutual HMAC proof">
        <Grid id="br-grid" w={760} h={330} />

        <text x={20} y={30} fontSize="10.5" fill={SOL.base1}>short processes, one per command</text>
        {CLIS.map((c, i) => (
          <g key={i}>
            <g className="bj-pop" style={t(c.at)}>
              <rect x={20} y={c.y} width={168} height={38} rx={6} fill={SOL.base3} stroke={c.color} strokeWidth={1.3} />
              <text x={30} y={c.y + 16} fontSize="11" fontWeight={700} fill={SOL.base02}>{c.verb}</text>
              <text x={30} y={c.y + 30} fontSize="10" fill={c.color}>{c.who}</text>
            </g>
            <path d={`M190 ${c.y + 19}C224 ${c.y + 19} 226 ${HOST.y + HOST.h / 2} ${HOST.x - 4} ${HOST.y + HOST.h / 2}`} pathLength={1} fill="none" stroke={c.color} strokeOpacity={0.7} strokeWidth={1.3} markerEnd="url(#br-grid-arrow)" className="bj-draw" style={t(c.at + 0.25, 0.4)} />
          </g>
        ))}

        <g className="bj-pop" style={t(0.05)}>
          <rect x={HOST.x} y={HOST.y} width={HOST.w} height={HOST.h} rx={8} fill={SOL.base3} stroke={SOL.cyan} strokeWidth={1.8} />
          <text x={HOST.x + HOST.w / 2} y={HOST.y + 24} textAnchor="middle" fontSize="12.5" fontWeight={700} fill={SOL.base02}>bridge host</text>
          <text x={HOST.x + HOST.w / 2} y={HOST.y + 42} textAnchor="middle" fontSize="10.5" fill={SOL.base01}>127.0.0.1</text>
          <text x={HOST.x + HOST.w / 2} y={HOST.y + 58} textAnchor="middle" fontSize="10.5" fill={SOL.base01}>a DevTools endpoint</text>
        </g>
        <text x={HOST.x + HOST.w / 2} y={HOST.y + HOST.h + 18} textAnchor="middle" fontSize="10" fill={SOL.cyan} className="bj-fade" style={t(1.6)}>outlives every command</text>

        {/* Chrome */}
        <g className="bj-fade" style={t(0.1)}>
          <rect x={CHROME.x} y={CHROME.y} width={CHROME.w} height={CHROME.h} rx={10} fill={SOL.base3} stroke={SOL.base1} />
          <circle cx={CHROME.x + 14} cy={CHROME.y + 14} r={3.5} fill={SOL.red} opacity={0.7} />
          <circle cx={CHROME.x + 26} cy={CHROME.y + 14} r={3.5} fill={SOL.yellow} opacity={0.7} />
          <circle cx={CHROME.x + 38} cy={CHROME.y + 14} r={3.5} fill={SOL.green} opacity={0.7} />
          <text x={CHROME.x + 52} y={CHROME.y + 18} fontSize="10.5" fill={SOL.base01}>your Chrome, your logins</text>
          <rect x={CHROME.x + 14} y={CHROME.y + 34} width={CHROME.w - 28} height={40} rx={6} fill={`${SOL.cyan}14`} stroke={SOL.cyan} strokeDasharray="3 3" />
          <text x={CHROME.x + 24} y={CHROME.y + 51} fontSize="11" fontWeight={700} fill={SOL.base02}>codecast extension</text>
          <text x={CHROME.x + 24} y={CHROME.y + 65} fontSize="10" fill={SOL.base01}>drives tabs with chrome.debugger</text>
        </g>

        {/* Cast tab group */}
        <g className="bj-rise" style={t(2.6)}>
          <text x={CHROME.x + 14} y={CHROME.y + 98} fontSize="10" fill={SOL.base1}>tab group "Cast", in the background</text>
          <rect x={CHROME.x + 14} y={CHROME.y + 106} width={94} height={26} rx={5} fill={`${SOL.blue}18`} stroke={SOL.blue} />
          <text x={CHROME.x + 61} y={CHROME.y + 123} textAnchor="middle" fontSize="10.5" fill={SOL.blue}>session A</text>
          <rect x={CHROME.x + 114} y={CHROME.y + 106} width={94} height={26} rx={5} fill={`${SOL.magenta}18`} stroke={SOL.magenta} />
          <text x={CHROME.x + 161} y={CHROME.y + 123} textAnchor="middle" fontSize="10.5" fill={SOL.magenta}>session B</text>
        </g>
        <g className="bj-rise" style={t(2.9)}>
          <text x={CHROME.x + 14} y={CHROME.y + 154} fontSize="10" fill={SOL.base1}>your own tabs</text>
          {["mail", "docs", "calendar"].map((n, i) => (
            <g key={n}>
              <rect x={CHROME.x + 14 + i * 66} y={CHROME.y + 162} width={60} height={22} rx={5} fill={SOL.base2} />
              <text x={CHROME.x + 44 + i * 66} y={CHROME.y + 177} textAnchor="middle" fontSize="10" fill={SOL.base1}>{n}</text>
            </g>
          ))}
        </g>
        <text x={CHROME.x + CHROME.w} y={CHROME.y + CHROME.h + 18} textAnchor="end" fontSize="10" fill={SOL.base01} className="bj-fade" style={t(3.1)}>never candidates</text>

        {/* WebSocket between host and extension */}
        <path d={`M${CHROME.x + 12} ${CHROME.y + 54}C${CHROME.x - 40} ${CHROME.y + 54} ${HOST.x + HOST.w + 40} ${HOST.y + 30} ${HOST.x + HOST.w + 4} ${HOST.y + 30}`} pathLength={1} fill="none" stroke={SOL.cyan} strokeWidth={1.6} markerEnd="url(#br-grid-arrow)" className="bj-draw" style={t(1.7, 0.5)} />
        <text x={462} y={66} textAnchor="middle" fontSize="10" fill={SOL.cyan} className="bj-fade" style={t(1.9)}>WebSocket</text>

        {/* Handshake */}
        <g fontSize="10.5">
          <g className="bj-rise" style={t(2.0)}>
            <text x={258} y={262} fill={SOL.base01}>1</text>
            <text x={274} y={262} fill={SOL.base02}><tspan fontWeight={700}>extension → host</tspan>{"   hello  nonce, HMAC(token, \"ext:\" + nonce)"}</text>
          </g>
          <g className="bj-rise" style={t(2.3)}>
            <text x={258} y={282} fill={SOL.base01}>2</text>
            <text x={274} y={282} fill={SOL.base02}><tspan fontWeight={700}>host → extension</tspan>{"   welcome  HMAC(token, nonce)"}</text>
          </g>
          <g className="bj-pop" style={t(2.55)}>
            <circle cx={264} cy={300} r={6} fill={SOL.green} />
            <path d="M261 300l2 2 4-4.5" stroke={SOL.base3} strokeWidth={1.6} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </g>
          <text x={274} y={304} fill={SOL.green} className="bj-fade" style={t(2.6)}>the extension executes nothing until the host proves the token</text>
        </g>

        {/* A web page that tries */}
        <g className="bj-rise" style={t(3.3)}>
          <rect x={20} y={236} width={168} height={38} rx={6} fill={SOL.base3} stroke={SOL.red} strokeDasharray="3 3" />
          <text x={30} y={252} fontSize="11" fill={SOL.base02}>a web page</text>
          <text x={30} y={266} fontSize="10" fill={SOL.base01}>Origin: https://…</text>
        </g>
        <path d={`M190 250C220 250 238 210 ${HOST.x + 20} ${HOST.y + HOST.h + 4}`} pathLength={1} fill="none" stroke={SOL.red} strokeOpacity={0.6} strokeDasharray="3 3" className="bj-draw" style={t(3.5, 0.4)} />
        <g className="bj-pop" style={t(3.9)}>
          <circle cx={226} cy={214} r={8} fill={SOL.red} />
          <path d="M222.5 210.5l7 7M229.5 210.5l-7 7" stroke={SOL.base3} strokeWidth={1.8} strokeLinecap="round" />
        </g>
        <text x={20} y={292} fontSize="10" fill={SOL.red} className="bj-fade" style={t(4.0)}>upgrade refused: an http(s) Origin</text>
      </svg>
    </Stage>
  );
}

// ─── Six commands against one do flow ──────────────────────────────────────

const STEPS = ["open", "find", "click", "type", "wait", "shot"];
const START_S = 1.6; // a typical CLI start, inside the 1 to 3 s range
const WORK_S = 0.085;

/** Six commands pay the CLI start six times; `do` pays it once and stops at the first failure. */
export function DoFlowFigure() {
  const X0 = 112;
  const PX = 58; // px per second
  const SEC = 0.32; // animation seconds per real second
  const x = (s: number) => X0 + s * PX;
  const sep = STEPS.map((_, i) => i * (START_S + WORK_S));
  const failAt = 3; // "type" fails in the do flow
  const doEnd = START_S + (failAt + 1) * WORK_S;
  return (
    <Stage minWidth={680}>
      <svg viewBox="0 0 760 300" className="w-full block font-mono" role="img" aria-label="Six separate commands take about ten seconds; one do flow takes about two and stops at the failing step">
        <defs>
          <pattern id="do-start" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="2.2" height="6" fill={SOL.base1} opacity={0.55} />
          </pattern>
        </defs>
        {[0, 2, 4, 6, 8, 10].map((s) => (
          <g key={s}>
            <line x1={x(s)} x2={x(s)} y1={30} y2={142} stroke={SOL.base2} />
            <text x={x(s)} y={158} fontSize="10" textAnchor="middle" fill={SOL.base1}>{`${s} s`}</text>
          </g>
        ))}

        <text x={16} y={22} fontSize="11.5" fontWeight={700} fill={SOL.base02}>Six commands</text>
        <text x={16} y={58} fontSize="10.5" fill={SOL.base01}>separate</text>
        {sep.map((s0, i) => (
          <g key={i}>
            <rect x={x(s0)} y={44} width={START_S * PX - 1} height={20} rx={3} fill="url(#do-start)" className="bj-grow" style={t(s0 * SEC, START_S * SEC)} />
            <rect x={x(s0 + START_S) - 1} y={44} width={Math.max(WORK_S * PX, 3)} height={20} rx={1} fill={SOL.blue} className="bj-pop" style={t((s0 + START_S) * SEC)} />
            <text x={x(s0) + (START_S * PX) / 2} y={80} fontSize="9.5" textAnchor="middle" fill={SOL.base01} className="bj-fade" style={t((s0 + START_S) * SEC)}>{STEPS[i]}</text>
          </g>
        ))}
        <text x={x(sep[5] + START_S + WORK_S) + 8} y={58} fontSize="10.5" fontWeight={700} fill={SOL.base02} className="bj-fade" style={t(10.1 * SEC)}>≈10 s</text>

        <text x={16} y={110} fontSize="11.5" fontWeight={700} fill={SOL.base02}>One do flow</text>
        <text x={16} y={128} fontSize="10.5" fill={SOL.base01}>one process</text>
        <rect x={x(0)} y={114} width={START_S * PX - 1} height={20} rx={3} fill="url(#do-start)" className="bj-grow" style={t(0, START_S * SEC)} />
        {STEPS.slice(0, failAt + 1).map((_, i) => (
          <rect key={i} x={x(START_S + i * WORK_S)} y={114} width={WORK_S * PX - 0.6} height={20} fill={i === failAt ? SOL.red : SOL.blue} className="bj-pop" style={t((START_S + i * WORK_S) * SEC + i * 0.12)} />
        ))}
        <text x={x(doEnd) + 8} y={128} fontSize="10.5" fontWeight={700} fill={SOL.base02} className="bj-fade" style={t(doEnd * SEC + 0.5)}>≈2 s, then the evidence</text>

        <g fontSize="10" fill={SOL.base1}>
          <rect x={X0} y={172} width={18} height={10} rx={2} fill="url(#do-start)" />
          <text x={X0 + 24} y={181}>starting cast: 1 to 3 s each time</text>
          <rect x={X0 + 262} y={172} width={10} height={10} rx={1} fill={SOL.blue} />
          <text x={X0 + 278} y={181}>the browser work: about 85 ms</text>
        </g>

        {/* the do flow, zoomed */}
        <g className="bj-fade" style={t(doEnd * SEC + 0.6)}>
          <line x1={16} x2={744} y1={198} y2={198} stroke={SOL.base2} />
          <text x={16} y={222} fontSize="10.5" fill={SOL.base01}>the do flow, step by step</text>
        </g>
        {STEPS.map((s, i) => {
          const ok = i < failAt;
          const failed = i === failAt;
          const at = doEnd * SEC + 0.8 + i * 0.18;
          const color = ok ? SOL.green : failed ? SOL.red : SOL.base1;
          return (
            <g key={s} className="bj-rise" style={t(at)}>
              <rect x={16 + i * 74} y={234} width={66} height={26} rx={5} fill={failed ? `${SOL.red}14` : SOL.base3} stroke={color} strokeDasharray={!ok && !failed ? "3 3" : undefined} />
              <text x={49 + i * 74} y={251} fontSize="10.5" textAnchor="middle" fill={ok || failed ? SOL.base02 : SOL.base1}>{`${ok ? "✓" : failed ? "✗" : "·"} ${s}`}</text>
            </g>
          );
        })}
        <text x={382} y={274} textAnchor="middle" fontSize="10" fill={SOL.base1} className="bj-fade" style={t(doEnd * SEC + 1.8)}>not run</text>

        <g className="bj-rise" style={t(doEnd * SEC + 1.6)}>
          <path d={`M${16 + failAt * 74 + 33} 262V282H470`} fill="none" stroke={SOL.red} strokeOpacity={0.6} />
          <rect x={470} y={210} width={274} height={84} rx={6} fill={SOL.base03} />
          <text x={482} y={230} fontSize="10.5" fontWeight={700} fill={SOL.red}>type failed: one evidence block</text>
          <text x={482} y={248} fontSize="10" fill={SOL.base1}>up to 8 console lines</text>
          <text x={482} y={263} fontSize="10" fill={SOL.base1}>up to 6 failed requests</text>
          <text x={482} y={278} fontSize="10" fill={SOL.base1}>a screenshot in the thread</text>
          <text x={732} y={278} fontSize="10" textAnchor="end" fill={SOL.yellow}>≤ 8 s total</text>
        </g>
      </svg>
    </Stage>
  );
}

// ─── Stale refs and namesakes ──────────────────────────────────────────────

const ROWS = ["invoice-0141", "invoice-0142", "invoice-0143", "invoice-0144"];

function RowList({ x, y, target, color, label, at, wrong }: { x: number; y: number; target: number; color: string; label: string; at: number; wrong?: boolean }) {
  return (
    <g>
      <text x={x} y={y - 12} fontSize="11" fontWeight={700} fill={SOL.base02} className="bj-fade" style={t(at - 0.4)}>{label}</text>
      {ROWS.map((r, i) => (
        <g key={r} className="bj-rise" style={t(at - 0.3 + i * 0.06)}>
          <rect x={x} y={y + i * 34} width={300} height={28} rx={5} fill={SOL.base3} stroke={i === target ? color : SOL.base2} strokeWidth={i === target ? 1.6 : 1} />
          <text x={x + 12} y={y + i * 34 + 18} fontSize="10.5" fill={SOL.base01}>{r}</text>
          <rect x={x + 228} y={y + i * 34 + 5} width={60} height={18} rx={4} fill={i === target ? color : SOL.base2} />
          <text x={x + 258} y={y + i * 34 + 18} fontSize="10" textAnchor="middle" fill={i === target ? SOL.base3 : SOL.base01}>Delete</text>
        </g>
      ))}
      <g className="bj-pop" style={t(at + 0.5)}>
        <circle cx={x + 314} cy={y + target * 34 + 14} r={8} fill={color} />
        {wrong ? (
          <path d={`M${x + 310.5} ${y + target * 34 + 10.5}l7 7M${x + 317.5} ${y + target * 34 + 10.5}l-7 7`} stroke={SOL.base3} strokeWidth={1.8} strokeLinecap="round" />
        ) : (
          <path d={`M${x + 310} ${y + target * 34 + 14}l3 3 5.5-6`} stroke={SOL.base3} strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        )}
      </g>
    </g>
  );
}

/** The agent meant the third Delete. A re-find by name lands on the first; the position table does not. */
export function StaleRefFigure() {
  return (
    <Stage minWidth={680}>
      <svg viewBox="0 0 760 300" className="w-full block font-mono" role="img" aria-label="After a re-render, finding the element by role and name picks the first Delete button; the saved position picks the third, the one the agent chose">
        <Grid id="sr-grid" w={760} h={300} />
        <g className="bj-rise" style={t(0.1)}>
          <rect x={20} y={18} width={600} height={44} rx={6} fill={SOL.base03} />
          <text x={34} y={36} fontSize="10" fill={SOL.base1}>the snapshot's table for this session</text>
          <text x={34} y={53} fontSize="11.5" fill={SOL.base3}>
            <tspan fill={SOL.yellow}>#e42</tspan>
            <tspan dx={14}>role button</tspan>
            <tspan dx={14}>name "Delete"</tspan>
            <tspan dx={14} fill={SOL.cyan}>3rd of 4 namesakes</tspan>
          </text>
        </g>
        <text x={380} y={86} fontSize="10.5" textAnchor="middle" fill={SOL.orange} className="bj-fade" style={t(0.7)}>the page renders again: the node behind #e42 is gone</text>

        <RowList x={20} y={124} target={0} color={SOL.red} label="re-find by role and name" at={1.4} wrong />
        <RowList x={400} y={124} target={2} color={SOL.green} label="fresh snapshot, same position" at={2.2} />
        <text x={20} y={278} fontSize="10" fill={SOL.red} className="bj-fade" style={t(2.1)}>lands on the first match</text>
        <text x={400} y={278} fontSize="10" fill={SOL.green} className="bj-fade" style={t(2.9)}>the row the agent chose</text>
      </svg>
    </Stage>
  );
}
