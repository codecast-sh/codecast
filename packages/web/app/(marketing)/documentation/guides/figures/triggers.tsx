"use client";

import { SOL } from "../../../blog/blogChrome";
import { PanelHead, Stage, t } from "../../../blog/figureKit";
import { Box, Label, Sheet } from "../figureParts";

/**
 * Figures for the triggers guide. The precheck gate follows `cast trigger add
 * --precheck` (60s limit, events and manual runs skip it); inline and spawned
 * runs follow the triggers snippet in shared/contracts/snippets.ts.
 */

// ─── Three ways to fire, on one twelve hour axis ───────────────────────────

const X0 = 170;
const X1 = 730;
const HOURS = 12;
const PLAY = 6;
const hx = (h: number) => X0 + ((X1 - X0) * h) / HOURS;
const hat = (h: number) => 0.4 + (h / HOURS) * PLAY;

const LANES = [
  { flag: "--in 30m", sub: "once, after a delay", y: 62, ink: SOL.blue, fires: [0.5], note: "fires once, then completes" },
  { flag: "--every 4h", sub: "repeats on a schedule", y: 124, ink: SOL.green, fires: [4, 8, 12], note: "" },
  { flag: "--on pr_comment", sub: "a GitHub or Linear event", y: 186, ink: SOL.magenta, fires: [1.3, 1.6, 6.7, 9.4], note: "" },
];

/** A twelve hour window: what each kind of trigger does in it. */
export function FiringModesFigure() {
  return (
    <Stage minWidth={640}>
      <Sheet w={760} h={250} label="Over twelve hours, an --in 30m trigger fires once, --every 4h fires at four, eight and twelve hours, and --on pr_comment fires whenever a review comment arrives">
        {() => (
          <>
            {LANES.map((l, i) => (
              <g key={l.flag}>
                <g className="bj-rise" style={t(0.1 + i * 0.12)}>
                  <text x={16} y={l.y - 2} fontSize="12" fontWeight={700} fill={l.ink}>{l.flag}</text>
                  <text x={16} y={l.y + 13} fontSize="10" fill={SOL.base01}>{l.sub}</text>
                </g>
                <line x1={X0} x2={X1} y1={l.y} y2={l.y} stroke={SOL.base2} strokeWidth={2} />
                {l.fires.map((h, k) => (
                  <g key={k}>
                    {i === 2 && (
                      <path d={`M${hx(h)} ${l.y - 22}l5 6l-5 6l-5 -6z`} fill={l.ink} fillOpacity={0.35} className="bj-pop" style={t(hat(h) - 0.05)} />
                    )}
                    <circle cx={hx(h)} cy={l.y} r={6} fill={l.ink} className="bj-pop" style={t(hat(h))} />
                  </g>
                ))}
                {l.note && <Label x={hx(l.fires[0]) + 14} y={l.y + 4} lines={[l.note]} ink="base01" className="bj-fade" style={t(hat(l.fires[0]) + 0.2)} />}
              </g>
            ))}
            <Label x={hx(1.6) + 12} y={164} lines={["a review comment lands"]} ink="magenta" size={10} className="bj-fade" style={t(hat(1.3) + 0.2)} />

            {Array.from({ length: HOURS / 2 + 1 }, (_, i) => (
              <g key={i}>
                <line x1={hx(i * 2)} x2={hx(i * 2)} y1={214} y2={219} stroke={SOL.base1} />
                <text x={hx(i * 2)} y={234} textAnchor="middle" fontSize="10" fill={SOL.base1}>{i * 2}h</text>
              </g>
            ))}
            <line x1={X0} x2={X1} y1={214} y2={214} stroke={SOL.base1} />
            <line x1={X0} x2={X0} y1={36} y2={210} stroke={SOL.orange} strokeWidth={1.5} className="bj-sweep" style={t(0.4, PLAY, { "--to": `${X1 - X0}px` })} />
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── The precheck gate ─────────────────────────────────────────────────────

const HISTORY = [
  { text: "ran · 4 PRs", ok: true },
  { text: "skipped · exit 1", ok: false },
  { text: "skipped · exit 1", ok: false },
  { text: "ran · 1 PR", ok: true },
];

/** A cheap shell command decides whether a scheduled firing spends a session. */
export function PrecheckGateFigure() {
  return (
    <Stage minWidth={640}>
      <Sheet w={760} h={250} label="A scheduled firing runs the precheck. Exit 0 starts the agent run. Any other exit, or 60 seconds without one, records a skipped run and starts no session. Events and manual runs bypass the gate">
        {(arrow) => (
          <>
            <Box x={20} y={112} w={140} h={46} title="schedule fires" sub="--in or --every" className="bj-pop" style={t(0.1)} />
            <Box x={210} y={106} w={170} h={58} title="--precheck" sub="shell, in the project dir" ink="orange" bold={1.6} className="bj-pop" style={t(0.5)} />
            <Box x={450} y={44} w={150} h={46} title="agent run" sub="a session starts" ink="green" className="bj-pop" style={t(1.3)} />
            <Box x={450} y={176} w={150} h={46} title="skipped run" sub="no session, no tokens" ink="base1" dashed className="bj-pop" style={t(1.9)} />

            <path d="M163 135H206" pathLength={1} stroke={SOL.base1} strokeWidth={1.4} fill="none" markerEnd={arrow()} className="bj-draw" style={t(0.35, 0.2)} />
            <path d="M380 122Q420 70 446 68" pathLength={1} stroke={SOL.green} strokeWidth={1.5} fill="none" markerEnd={arrow("green")} className="bj-draw" style={t(1.0, 0.3)} />
            <Label x={392} y={84} lines={["exit 0"]} ink="green" weight={700} anchor="end" className="bj-fade" style={t(1.1)} />
            <path d="M380 150Q420 200 446 199" pathLength={1} stroke={SOL.red} strokeWidth={1.5} fill="none" markerEnd={arrow("red")} className="bj-draw" style={t(1.6, 0.3)} />
            <Label x={300} y={196} lines={["any other exit,", "or 60s with none"]} ink="red" className="bj-fade" style={t(1.7)} />

            {/* events and manual runs go around the gate */}
            <Box x={20} y={24} w={140} h={46} title="event, or" sub="cast trigger run" ink="magenta" className="bj-pop" style={t(2.3)} />
            <path d="M163 47H446" pathLength={1} stroke={SOL.magenta} strokeWidth={1.4} strokeDasharray="5 3" fill="none" markerEnd={arrow("magenta")} className="bj-draw" style={t(2.5, 0.5)} />
            <Label x={300} y={40} lines={["no gate: the event is the reason"]} ink="magenta" anchor="middle" className="bj-fade" style={t(2.8)} />

            {/* run history */}
            <g className="bj-fade" style={t(3.1)}>
              <text x={630} y={100} fontSize="10.5" fontWeight={700} fill={SOL.base02}>run history</text>
            </g>
            {HISTORY.map((h, i) => (
              <g key={i} className="bj-rise" style={t(3.2 + i * 0.15)}>
                <circle cx={636} cy={118 + i * 20} r={4} fill={h.ok ? SOL.green : "none"} stroke={h.ok ? SOL.green : SOL.base1} />
                <text x={646} y={121.5 + i * 20} fontSize="10" fill={h.ok ? SOL.base02 : SOL.base1}>{h.text}</text>
              </g>
            ))}
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── Inline versus --spawn ─────────────────────────────────────────────────

const FIRINGS = [0.35, 0.65, 0.95];

function Turn({ who, text, at, tone }: { who: string; text: string; at: number; tone?: string }) {
  return (
    <div className="rounded-md px-2.5 py-1.5 bj-rise" style={{ ...t(at), backgroundColor: tone ? `${tone}14` : SOL.base3, border: `1px solid ${tone ?? SOL.base2}` }}>
      <span className="font-bold" style={{ color: tone ?? SOL.base01 }}>{who}</span> <span style={{ color: SOL.base00 }}>{text}</span>
    </div>
  );
}

/** Where a firing runs decides what it costs and where its result lands. */
export function InlineVsSpawnFigure() {
  return (
    <Stage>
      <div className="grid md:grid-cols-2">
        <div className="border-b md:border-b-0 md:border-r" style={{ borderColor: SOL.base2 }}>
          <PanelHead title="Inline (the default)" sub="Each firing is a new turn in this session, with the whole thread behind it." color={SOL.blue} />
          <div className="m-4 space-y-1.5 font-mono text-[11.5px]">
            <Turn who="you" text="ship the retry queue" at={0.1} />
            <Turn who="agent" text="PR #482 open; check CI in 30m" at={0.25} />
            {FIRINGS.map((w, i) => (
              <div key={i} className="space-y-1">
                <Turn who="tr-42" text={`firing ${i + 1}: check CI`} at={0.6 + i * 0.5} tone={SOL.blue} />
                <div className="flex items-center gap-2 bj-fade" style={t(0.75 + i * 0.5)}>
                  <span className="text-[10px] w-24 shrink-0" style={{ color: SOL.base1 }}>history reloaded</span>
                  <span className="flex-1"><span className="block h-1.5 rounded-full bj-grow" style={{ ...t(0.75 + i * 0.5, 0.4), width: `${w * 100}%`, backgroundColor: SOL.blue, opacity: 0.6 }} /></span>
                </div>
              </div>
            ))}
            <div className="text-[11px] pt-1 bj-fade" style={{ ...t(2.2), color: SOL.base01 }}>Right for a follow-up that needs this conversation and fires a few times.</div>
          </div>
        </div>
        <div>
          <PanelHead title="--spawn" sub="Each firing is a fresh session nested under the one that armed it." color={SOL.green} />
          <div className="m-4 font-mono text-[11.5px]">
            <div className="rounded-md px-2.5 py-1.5 bj-rise" style={{ ...t(0.1), backgroundColor: SOL.base3, border: `1px solid ${SOL.base1}` }}>
              <span className="font-bold" style={{ color: SOL.base02 }}>arming session</span> <span style={{ color: SOL.base00 }}>stays asleep</span>
            </div>
            <div className="ml-4 mt-1 pl-3 space-y-1.5" style={{ borderLeft: `1px dashed ${SOL.base1}` }}>
              {[
                { text: "run 1 · prompt only · clean", ok: true },
                { text: "run 2 · prompt + run 1's summary · clean", ok: true },
                { text: "run 3 · failed", ok: false },
              ].map((r, i) => (
                <div key={i} className="rounded-md px-2.5 py-1.5 bj-rise" style={{ ...t(0.6 + i * 0.5), backgroundColor: r.ok ? `${SOL.green}12` : `${SOL.red}12`, border: `1px solid ${r.ok ? SOL.green : SOL.red}` }}>
                  <span style={{ color: r.ok ? SOL.base02 : SOL.red }}>{r.text}</span>
                </div>
              ))}
            </div>
            <div className="mt-2 text-[11px] space-y-1">
              <div className="bj-fade" style={{ ...t(1.6), color: SOL.base01 }}>clean: read under the trigger, nobody woken</div>
              <div className="bj-fade font-bold" style={{ ...t(2.0), color: SOL.red }}>failed, silent, or --needs-attention: wakes the arming session</div>
              <div className="bj-fade pt-1" style={{ ...t(2.3), color: SOL.base01 }}>Right for a standing duty that repeats. The prompt carries everything the run needs.</div>
            </div>
          </div>
        </div>
      </div>
    </Stage>
  );
}
