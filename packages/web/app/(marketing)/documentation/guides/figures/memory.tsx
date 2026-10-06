"use client";

import { SOL } from "../../../blog/blogChrome";
import { PanelHead, Stage, t } from "../../../blog/figureKit";
import { Arrow, Box, Sheet, Term } from "../figureParts";

/**
 * Figures for the memory guide: how one search runs, and what the live
 * sessions stream prints while sessions change state.
 */

// ─── One search ────────────────────────────────────────────────────────────

const HITS = [
  { id: "jx7a1rw", msg: "msg 42", text: "…a queue with exponential backoff keeps a flaky endpoint from losing events…" },
  { id: "jx7k3fb", msg: "msg 7", text: "…fixed 30s retry lost 3 events, exponential lost none…" },
  { id: "jx7w9hk", msg: "msg 18", text: "…states: pending, retrying, delivered, dead…" },
];

/** Keyword and semantic matching run together and merge; the result is the
 *  original message text, with a title-only retry when content search fails. */
export function SearchPathFigure() {
  const W = 760;
  const H = 290;
  return (
    <Stage minWidth={680}>
      <Sheet w={W} h={H} label="A search runs keyword and semantic matching, merges them, and returns original message fragments; if content search fails it retries on titles only">
        {(arrow) => (
          <>

            <Box x={20} y={86} w={170} title={'cast search "backoff"'} sub="team scope, this project" at={0.2} dark bold={1} size={11.5} />
            <Arrow head={arrow()} d="M192 100C220 100 220 62 250 62" at={0.55} />
            <Arrow head={arrow()} d="M192 122C220 122 220 160 250 160" at={0.55} />
            <Box x={256} y={40} w={150} h={44} title="keyword" sub="exact phrase or words" at={0.85} ink="blue" bold={1.5} size={11.5} />
            <Box x={256} y={138} w={150} h={44} title="semantic" sub="similar meaning" at={0.85} ink="violet" bold={1.5} size={11.5} />
            <Arrow head={arrow()} d="M408 62C436 62 436 104 462 104" at={1.2} />
            <Arrow head={arrow()} d="M408 160C436 160 436 118 462 118" at={1.2} />
            <Box x={468} y={86} w={92} title="merge" sub="and rank" at={1.5} bold={1} size={11.5} />
            <Arrow head={arrow()} d="M562 111H586" at={1.75} />

            {HITS.map((h, i) => (
              <g key={h.id} className="bj-rise" style={t(1.95 + i * 0.18)}>
                <rect x={592} y={40 + i * 50} width={150} height={42} rx={6} fill={SOL.base3} stroke={SOL.base2} />
                <text x={600} y={56 + i * 50} fontSize="10" fontWeight={700} fill={SOL.cyan}>{h.id}<tspan fill={SOL.base1} fontWeight={400}>{`  ${h.msg}`}</tspan></text>
                <text x={600} y={72 + i * 50} fontSize="9" fill={SOL.base01}>{h.text.slice(0, 26)}…</text>
              </g>
            ))}
            <text x={667} y={204} textAnchor="middle" fontSize="10" fill={SOL.base01} className="bj-fade" style={t(2.6)}>
              <tspan x={667}>the words as written,</tspan>
              <tspan x={667} dy={13}>not a summary</tspan>
            </text>

            <g className="bj-fade" style={t(2.9)}>
              <line x1={20} x2={740} y1={232} y2={232} stroke={SOL.base2} />
              <text x={20} y={256} fontSize="10.5" fontWeight={700} fill={SOL.orange}>if content search fails</text>
              <text x={20} y={274} fontSize="10" fill={SOL.base01}>a network or backend error: the CLI asks once more for titles only, so a search still returns sessions</text>
            </g>
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── Watching sessions live ────────────────────────────────────────────────

type State = "working" | "needs_input" | "done";
const STATE_INK: Record<State, string> = { working: SOL.cyan, needs_input: SOL.yellow, done: SOL.green };

/** Time runs 0 to 10; each unit plays for SEC seconds. */
const SEC = 0.42;
const LANES: { id: string; title: string; spans: [number, number, State][] }[] = [
  { id: "jx7a1rw", title: "Retry failed webhooks", spans: [[0, 4, "working"], [4, 7, "needs_input"], [7, 10, "working"]] },
  { id: "jx7m4pg", title: "Migrate invoices", spans: [[0, 6, "working"], [6, 10, "done"]] },
  { id: "jx7d2ui", title: "Dashboard retry UI", spans: [[2, 8, "working"], [8, 10, "needs_input"]] },
];

const EVENTS: { at: number; line: string }[] = [
  { at: 2, line: `{"event":"new","id":"jx7d2ui","from":null,"to":"working"}` },
  { at: 4, line: `{"event":"transition","id":"jx7a1rw","from":"working","to":"needs_input"}` },
  { at: 6, line: `{"event":"transition","id":"jx7m4pg","from":"working","to":"done"}` },
  { at: 7, line: `{"event":"transition","id":"jx7a1rw","from":"needs_input","to":"working"}` },
  { at: 8, line: `{"event":"transition","id":"jx7d2ui","from":"working","to":"needs_input"}` },
];

/** Three sessions changing state, and the one line the stream prints for each
 *  change. Between changes it prints nothing. */
export function WatchStreamFigure() {
  const X0 = 140;
  const PX = 26;
  const x = (u: number) => X0 + u * PX;
  const laneY = (i: number) => 38 + i * 40;
  return (
    <Stage>
      <div className="grid grid-cols-1 *:min-w-0 md:grid-cols-[1fr_1.15fr]">
        <div className="border-b md:border-b-0 md:border-r" style={{ borderColor: SOL.base2 }}>
          <PanelHead title="What the sessions do" sub="Each bar is one session's work state over a few minutes." color={SOL.cyan} />
          <svg viewBox="0 0 420 206" className="w-full block font-mono" role="img" aria-label="Three session lanes changing between working, needs input and done">
            {LANES.map((l, i) => (
              <g key={l.id}>
                <text x={14} y={laneY(i) + 6} fontSize="10.5" fontWeight={700} fill={SOL.base02}>{l.id}</text>
                <text x={14} y={laneY(i) + 19} fontSize="10" fill={SOL.base1}>{l.title.length > 18 ? `${l.title.slice(0, 16)}…` : l.title}</text>
                {l.spans.map(([a, b, s]) => (
                  <rect key={a} x={x(a)} y={laneY(i) - 4} width={(b - a) * PX - 1.5} height={16} rx={3} fill={STATE_INK[s]} opacity={0.8} className="bj-grow" style={t(a * SEC, (b - a) * SEC)} />
                ))}
              </g>
            ))}
            {EVENTS.map((e) => (
              <circle key={e.at} cx={x(e.at)} cy={160} r={3.5} fill={SOL.base02} className="bj-pop" style={t(e.at * SEC)} />
            ))}
            <line x1={x(0)} x2={x(10)} y1={160} y2={160} stroke={SOL.base2} />
            <text x={x(0)} y={182} fontSize="9.5" fill={SOL.base1}>a dot for each line the stream printed</text>
            <line x1={x(0)} x2={x(0)} y1={22} y2={166} stroke={SOL.base02} strokeWidth={1.2} className="bj-sweep" style={t(0, 10 * SEC, { "--to": `${10 * PX}px` })} />
            {(Object.keys(STATE_INK) as State[]).map((s, i) => (
              <g key={s}>
                <rect x={14 + i * 108} y={192} width={10} height={6} rx={1.5} fill={STATE_INK[s]} opacity={0.8} />
                <text x={28 + i * 108} y={199} fontSize="10" fill={SOL.base01}>{s}</text>
              </g>
            ))}
          </svg>
        </div>
        <div>
          <PanelHead title="What the stream prints" sub="One JSON line per change, nothing in between." color={SOL.base02} />
          <Term size={10.5} leading={1.75} space="m-4 p-3">
            <div style={{ color: SOL.base3 }}>$ cast sessions -w --json</div>
            {EVENTS.map((e) => (
              <div key={e.at} className="bj-rise whitespace-pre" style={t(e.at * SEC)}>{e.line}</div>
            ))}
            <div className="bj-fade" style={t(10 * SEC)}>
              <span className="bj-pulse" style={{ color: SOL.base3 }}>▌</span>
            </div>
          </Term>
          <div className="px-5 pb-4 text-[12px] leading-snug" style={{ color: SOL.base01 }}>
            Real lines also carry a timestamp, the title and the label. <code className="font-mono">needs_input</code> means the session is waiting on a person.
          </div>
        </div>
      </div>
    </Stage>
  );
}
