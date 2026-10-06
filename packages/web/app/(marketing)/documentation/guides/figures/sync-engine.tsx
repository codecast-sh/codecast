"use client";

import { SOL } from "../../../blog/blogChrome";
import { Stage, t } from "../../../blog/figureKit";
import { Sheet } from "../figureParts";

/**
 * Figures for the sync engine guide: a write and a stale push meeting the
 * pending lock, a change travelling through the outbox and the log to a
 * client, and one window syncing for the rest.
 */

// ─── The lock ──────────────────────────────────────────────────────────────

/** A local write paints at once and locks its field; a stale push cannot undo it, and the echo retires the lock. */
export function PendingLockFigure() {
  const X0 = 150;
  const lane = { server: 60, store: 150, screen: 236 };
  const at = { write: 0.4, dispatch: 0.9, stale: 1.8, echo: 3.0 };
  const xs = { write: 200, stale: 380, echo: 590 };
  return (
    <Stage minWidth={700}>
      <Sheet w={760} h={300} label="A status change paints immediately and sets a pending lock; a stale server push keeps the old status out while other fields apply; the server's echo of the new value retires the lock">
        {(arrow) => (
          <>
            <g fontSize="10.5" fontWeight={700} fill={SOL.base02}>
              <text x={16} y={lane.server + 4}>Convex</text>
              <text x={16} y={lane.store + 4}>the store</text>
              <text x={16} y={lane.screen + 4}>the screen</text>
            </g>
            <text x={16} y={lane.store + 18} fontSize="9.5" fill={SOL.base1}>IndexedDB behind it</text>
            {Object.values(lane).map((y) => (
              <line key={y} x1={X0 - 10} x2={744} y1={y} y2={y} stroke={SOL.base2} strokeWidth={1.2} />
            ))}

            {/* the write */}
            <g className="bj-pop" style={t(at.write)}>
              <rect x={xs.write - 50} y={lane.store - 13} width={100} height={26} rx={5} fill={SOL.base3} stroke={SOL.blue} strokeWidth={1.4} />
              <text x={xs.write} y={lane.store + 4} fontSize="10.5" textAnchor="middle" fill={SOL.base02}>status: done</text>
            </g>
            <text x={xs.write + 12} y={lane.store - 20} fontSize="9.5" textAnchor="end" fill={SOL.blue} className="bj-fade" style={t(at.write)}>action() draft</text>
            <path d={`M${xs.write} ${lane.store + 14}V${lane.screen - 14}`} pathLength={1} stroke={SOL.blue} strokeWidth={1.3} markerEnd={arrow()} className="bj-draw" style={t(at.write + 0.15, 0.2)} />
            <g className="bj-pop" style={t(at.write + 0.35)}>
              <rect x={xs.write - 40} y={lane.screen - 11} width={80} height={22} rx={11} fill={`${SOL.green}22`} stroke={SOL.green} />
              <text x={xs.write} y={lane.screen + 4} fontSize="10.5" textAnchor="middle" fill={SOL.green}>done</text>
            </g>
            <text x={xs.write + 48} y={lane.screen + 4} fontSize="9.5" fill={SOL.base01} className="bj-fade" style={t(at.write + 0.4)}>same tick</text>
            <path d={`M${xs.write + 20} ${lane.store - 14}L${xs.write + 60} ${lane.server + 10}`} pathLength={1} stroke={SOL.base1} strokeWidth={1.2} strokeDasharray="3 3" markerEnd={arrow()} className="bj-draw" style={t(at.dispatch, 0.3)} />
            <text x={xs.write + 66} y={lane.server + 20} fontSize="9.5" fill={SOL.base01} className="bj-fade" style={t(at.dispatch + 0.2)}>dispatch</text>

            {/* the lock */}
            <rect x={xs.write + 50} y={lane.store - 4} width={xs.echo - xs.write - 50} height={8} rx={2} fill={SOL.yellow} opacity={0.6} className="bj-grow" style={t(at.write + 0.3, at.echo - at.write)} />
            <text x={xs.write + 60} y={lane.store + 22} fontSize="9.5" fill={SOL.yellow} className="bj-fade" style={t(at.write + 0.5)}>pending["tasks:&lt;id&gt;:status"] = "done"</text>

            {/* the stale push */}
            <g className="bj-pop" style={t(at.stale)}>
              <rect x={xs.stale - 62} y={lane.server - 13} width={124} height={26} rx={5} fill={SOL.base3} stroke={SOL.orange} />
              <text x={xs.stale} y={lane.server + 4} fontSize="10" textAnchor="middle" fill={SOL.base02}>status: todo, title</text>
            </g>
            <text x={xs.stale - 62} y={lane.server - 20} fontSize="9.5" fill={SOL.orange} className="bj-fade" style={t(at.stale)}>a push computed before the write landed</text>
            <path d={`M${xs.stale} ${lane.server + 14}V${lane.store - 10}`} pathLength={1} stroke={SOL.orange} strokeWidth={1.3} markerEnd={arrow()} className="bj-draw" style={t(at.stale + 0.2, 0.3)} />
            <g className="bj-pop" style={t(at.stale + 0.55)}>
              <circle cx={xs.stale - 12} cy={lane.store - 22} r={7} fill={SOL.red} />
              <path d={`M${xs.stale - 15} ${lane.store - 25}l6 6M${xs.stale - 9} ${lane.store - 25}l-6 6`} stroke={SOL.base3} strokeWidth={1.6} strokeLinecap="round" />
            </g>
            <text x={xs.stale + 8} y={lane.store - 30} fontSize="9.5" fill={SOL.red} className="bj-fade" style={t(at.stale + 0.6)}>status kept local</text>
            <text x={xs.stale + 8} y={lane.store - 18} fontSize="9.5" fill={SOL.green} className="bj-fade" style={t(at.stale + 0.7)}>title accepted</text>

            {/* the echo */}
            <g className="bj-pop" style={t(at.echo)}>
              <rect x={xs.echo - 50} y={lane.server - 13} width={100} height={26} rx={5} fill={SOL.base3} stroke={SOL.green} />
              <text x={xs.echo} y={lane.server + 4} fontSize="10.5" textAnchor="middle" fill={SOL.base02}>status: done</text>
            </g>
            <path d={`M${xs.echo} ${lane.server + 14}V${lane.store - 10}`} pathLength={1} stroke={SOL.green} strokeWidth={1.3} markerEnd={arrow()} className="bj-draw" style={t(at.echo + 0.2, 0.3)} />
            <text x={xs.echo + 10} y={lane.store + 4} fontSize="10" fill={SOL.green} className="bj-fade" style={t(at.echo + 0.55)}>lock retires</text>
            <text x={xs.echo + 10} y={lane.store + 18} fontSize="9.5" fill={SOL.base01} className="bj-fade" style={t(at.echo + 0.65)}>or once delivery covers it</text>
            <text x={16} y={286} fontSize="10" fill={SOL.base01} className="bj-fade" style={t(at.echo + 0.9)}>
              The middleware derives the lock from the draft's patches; no action writes one by hand.
            </text>
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── Through the outbox and the log ────────────────────────────────────────

const STEPS = [
  { x: 16, w: 130, title: "save", lines: ["the task row", "+ outbox slot"], note: "one transaction", color: SOL.blue },
  { x: 166, w: 140, title: "delivery worker", lines: ["head 42 → 43", "action at 43"], note: "its own transaction", color: SOL.violet },
  { x: 326, w: 130, title: "getHeads", lines: ["{ position: 43 }", "a few integers"], note: "the one live query", color: SOL.cyan },
  { x: 476, w: 120, title: "wait 1500 ms", lines: ["collect the", "burst"], note: "", color: SOL.base1 },
  { x: 616, w: 128, title: "getRange", lines: ["after cursor 40", "≤ 500 or 1 MB"], note: "one shot", color: SOL.green },
];

/** One task edit, from the save to a client's cursor. */
export function SyncLogFigure() {
  const Y = 50;
  const H = 74;
  return (
    <Stage minWidth={720}>
      <Sheet w={760} h={300} label="A save writes an outbox slot; a worker assigns the next position; the client's heads subscription moves, it waits 1500 ms, reads the range and advances its cursor; the access stamp decides which scopes receive it">
        {(arrow) => (
          <>
            {STEPS.map((s, i) => {
              const at = 0.2 + i * 0.6;
              return (
                <g key={s.title}>
                  <g className="bj-pop" style={t(at)}>
                    <rect x={s.x} y={Y} width={s.w} height={H} rx={7} fill={SOL.base3} stroke={s.color} strokeWidth={1.5} />
                    <text x={s.x + 10} y={Y + 20} fontSize="11" fontWeight={700} fill={SOL.base02}>{s.title}</text>
                    {s.lines.map((l, j) => (
                      <text key={l} x={s.x + 10} y={Y + 40 + j * 14} fontSize="10" fill={SOL.base01}>{l}</text>
                    ))}
                  </g>
                  {s.note && <text x={s.x + s.w / 2} y={Y + H + 16} fontSize="9.5" textAnchor="middle" fill={s.color} className="bj-fade" style={t(at + 0.1)}>{s.note}</text>}
                  {i > 0 && (
                    <path d={`M${STEPS[i - 1].x + STEPS[i - 1].w + 2} ${Y + H / 2}H${s.x - 4}`} pathLength={1} stroke={SOL.base1} strokeWidth={1.3} markerEnd={arrow()} className="bj-draw" style={t(at - 0.25, 0.25)} />
                  )}
                </g>
              );
            })}
            <text x={16} y={30} fontSize="10" fill={SOL.base1}>server</text>
            <text x={326} y={30} fontSize="10" fill={SOL.base1}>client</text>
            <line x1={316} x2={316} y1={20} y2={150} stroke={SOL.base2} strokeDasharray="3 3" />

            {/* cursor */}
            <g className="bj-rise" style={t(3.3)}>
              <rect x={476} y={168} width={268} height={40} rx={7} fill={SOL.base03} />
              <text x={488} y={186} fontSize="10" fill={SOL.base1}>syncMeta  synclog:v1:team:acme</text>
              <text x={488} y={200} fontSize="10.5" fill={SOL.green}>cursor 40 → 43, through syncTable</text>
            </g>
            <path d="M680 148V164" pathLength={1} stroke={SOL.green} strokeWidth={1.3} markerEnd={arrow()} className="bj-draw" style={t(3.2, 0.2)} />

            {/* fan-out by stamp */}
            <g className="bj-rise" style={t(1.2)}>
              <text x={166} y={170} fontSize="10" fill={SOL.violet}>the access stamp picks the scopes</text>
              {[
                { k: "user:ada", why: "owner" },
                { k: "team:acme", why: "key names a team" },
                { k: "user:sam", why: "assignee grant" },
              ].map((s, i) => (
                <g key={s.k}>
                  <rect x={166} y={180 + i * 26} width={92} height={20} rx={4} fill={`${SOL.violet}14`} stroke={SOL.violet} />
                  <text x={174} y={194 + i * 26} fontSize="10" fill={SOL.base02}>{s.k}</text>
                  <text x={266} y={194 + i * 26} fontSize="9.5" fill={SOL.base01}>{s.why}</text>
                </g>
              ))}
            </g>
            <path d="M236 148V162" pathLength={1} stroke={SOL.violet} strokeWidth={1.2} markerEnd={arrow()} className="bj-draw" style={t(1.1, 0.2)} />
            <text x={16} y={286} fontSize="10" fill={SOL.base01} className="bj-fade" style={t(3.6)}>
              A task private inside a team has the key user:&lt;owner&gt;, so it never enters the team scope at all.
            </text>
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── One window syncs ──────────────────────────────────────────────────────

function Win({ x, y, title, host, at }: { x: number; y: number; title: string; host?: boolean; at: number }) {
  return (
    <g className="bj-pop" style={t(at)}>
      <rect x={x} y={y} width={180} height={96} rx={9} fill={SOL.base3} stroke={host ? SOL.green : SOL.base1} strokeWidth={host ? 1.8 : 1.1} />
      <circle cx={x + 12} cy={y + 12} r={3} fill={SOL.base2} />
      <circle cx={x + 22} cy={y + 12} r={3} fill={SOL.base2} />
      <text x={x + 34} y={y + 16} fontSize="10" fill={SOL.base01}>{title}</text>
      <text x={x + 12} y={y + 40} fontSize="11.5" fontWeight={700} fill={host ? SOL.green : SOL.base02}>{host ? "host" : "follower"}</text>
      <text x={x + 12} y={y + 58} fontSize="9.5" fill={SOL.base01}>{host ? "global feeders, IDB writes" : "no global feeders"}</text>
      <text x={x + 12} y={y + 72} fontSize="9.5" fill={SOL.base01}>{host ? "holds codecast-sync-host" : "own pending, own dispatch"}</text>
    </g>
  );
}

/** The lock holder syncs and broadcasts; followers apply its stream and offer their writes back. */
export function SyncHostFigure() {
  return (
    <Stage minWidth={700}>
      <Sheet w={760} h={320} label="The window holding the codecast-sync-host lock subscribes and persists, then broadcasts row updates to follower windows; a follower's own write reaches the host as a mut message; when the host closes, the next window takes the lock">
        {(arrow) => (
          <>
            <g className="bj-pop" style={t(0.1)}>
              <rect x={290} y={14} width={180} height={34} rx={8} fill={SOL.base03} />
              <text x={380} y={36} fontSize="11" textAnchor="middle" fill={SOL.base3}>Convex</text>
            </g>
            <Win x={290} y={92} title="main window" host at={0.3} />
            <path d="M380 50V88" pathLength={1} stroke={SOL.green} strokeWidth={1.5} markerEnd={arrow()} className="bj-draw" style={t(0.6, 0.3)} />
            <text x={388} y={74} fontSize="9.5" fill={SOL.green} className="bj-fade" style={t(0.8)}>~25 subscriptions, once</text>

            <Win x={30} y={196} title="detached tab" at={0.5} />
            <Win x={550} y={196} title="palette" at={0.6} />

            {/* broadcast */}
            <path d="M290 160C220 160 160 170 130 192" pathLength={1} fill="none" stroke={SOL.cyan} strokeWidth={1.6} markerEnd={arrow()} className="bj-draw" style={t(1.2, 0.4)} />
            <path d="M470 160C540 160 600 170 630 192" pathLength={1} fill="none" stroke={SOL.cyan} strokeWidth={1.6} markerEnd={arrow()} className="bj-draw" style={t(1.2, 0.4)} />
            <text x={150} y={128} fontSize="9.5" fill={SOL.cyan} className="bj-fade" style={t(1.5)}>
              <tspan x={146}>BroadcastChannel</tspan>
              <tspan x={146} dy={12}>{"{ hostId, seq } + rows"}</tspan>
            </text>
            <text x={536} y={128} fontSize="9.5" fill={SOL.cyan} className="bj-fade" style={t(1.5)}>
              <tspan x={536}>a gap or a new hostId:</tspan>
              <tspan x={536} dy={12}>fresh snapshot, ≤256 rows a batch</tspan>
            </text>

            {/* a follower's write */}
            <path d="M210 250C250 250 260 200 300 192" pathLength={1} fill="none" stroke={SOL.magenta} strokeWidth={1.4} strokeDasharray="4 3" markerEnd={arrow()} className="bj-draw" style={t(2.0, 0.4)} />
            <text x={218} y={276} fontSize="9.5" fill={SOL.magenta} className="bj-fade" style={t(2.3)}>
              <tspan x={218}>mut: only the fields</tspan>
              <tspan x={218} dy={12}>the action wrote</tspan>
            </text>
            <path d="M100 196C100 120 200 60 286 34" pathLength={1} fill="none" stroke={SOL.magenta} strokeOpacity={0.5} strokeWidth={1.2} markerEnd={arrow()} className="bj-draw" style={t(2.2, 0.5)} />
            <text x={40} y={70} fontSize="9.5" fill={SOL.magenta} className="bj-fade" style={t(2.5)}>
              <tspan x={30}>and its own dispatch</tspan>
              <tspan x={30} dy={12}>to the server</tspan>
            </text>

            <text x={380} y={312} fontSize="10" textAnchor="middle" fill={SOL.base01} className="bj-fade" style={t(2.9)}>
              Host closes: the browser frees the lock, the next window becomes host and resumes the cursors.
            </text>
          </>
        )}
      </Sheet>
    </Stage>
  );
}
