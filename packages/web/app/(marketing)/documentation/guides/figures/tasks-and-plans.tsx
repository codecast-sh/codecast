"use client";

import { SOL } from "../../../blog/blogChrome";
import { PanelHead, Stage, t } from "../../../blog/figureKit";
import { Box, Label, Sheet, Term } from "../figureParts";

/**
 * Figures for the tasks and plans guide. Statuses are the categories in
 * shared/tasks/statuses.ts; ownership follows convex/lib/taskOwner.ts; the
 * context output follows `cast task context` in packages/cli/src/index.ts.
 */

// ─── The status workflow and the commands that move it ─────────────────────

const STATUSES = [
  { id: "backlog", x: 16 },
  { id: "open", x: 166 },
  { id: "in_progress", x: 316 },
  { id: "in_review", x: 466 },
  { id: "done", x: 616 },
];
const NW = 104;
const NY = 96;
const NH = 40;

const STEPS = [
  { label: "-s open", at: 0.8 },
  { label: "cast task start", at: 1.3, ink: SOL.green },
  { label: "-s in_review", at: 3.0 },
  { label: "cast task done", at: 3.4 },
];

/** Six statuses, and which command moves a task between them. */
export function TaskLifecycleFigure() {
  return (
    <Stage minWidth={640}>
      <Sheet w={740} h={300} label="A task moves from backlog to open, cast task start makes it in progress and binds the session, comments log progress, and cast task done closes it">
        {(arrow) => (
          <>
            {STATUSES.map((s, i) => (
              <Box
                key={s.id}
                x={s.x} y={NY} w={NW} h={NH}
                title={s.id}
                ink={s.id === "in_progress" ? "green" : "base1"}
                bold={s.id === "in_progress" ? 1.6 : 1.1}
                fill={s.id === "done" ? `${SOL.green}1f` : SOL.base3}
                className="bj-pop" style={t(0.1 + i * 0.12)}
              />
            ))}
            {STEPS.map((e, i) => {
              const x1 = STATUSES[i].x + NW + 3;
              const x2 = STATUSES[i + 1].x - 5;
              return (
                <g key={e.label}>
                  <path d={`M${x1} ${NY + NH / 2}H${x2}`} pathLength={1} stroke={e.ink ?? SOL.base1} strokeWidth={1.4} fill="none" markerEnd={arrow(e.ink ? "green" : "base1")} className="bj-draw" style={t(e.at, 0.3)} />
                  <Label x={(x1 + x2) / 2} y={74} lines={[e.label]} anchor="middle" ink={e.ink ? "green" : "base01"} weight={e.ink ? 700 : undefined} className="bj-fade" style={t(e.at)} />
                </g>
              );
            })}

            {/* start binds the session */}
            <g className="bj-pop" style={t(1.6)}>
              <rect x={300} y={18} width={136} height={26} rx={13} fill={`${SOL.green}1a`} stroke={SOL.green} />
              <text x={368} y={35} textAnchor="middle" fontSize="10.5" fill={SOL.green}>this session ⇢ task</text>
            </g>
            <path d="M368 46V58" stroke={SOL.green} strokeDasharray="2 2" className="bj-fade" style={t(1.7)} />

            {/* progress comments while in progress */}
            <path d="M352 138C340 192 400 192 388 140" pathLength={1} fill="none" stroke={SOL.blue} strokeWidth={1.4} markerEnd={arrow("blue")} className="bj-draw" style={t(2.0, 0.5)} />
            {[0, 1, 2].map((k) => (
              <circle key={k} cx={356 + k * 14} cy={176} r={3} fill={SOL.blue} className="bj-pop" style={t(2.3 + k * 0.2)} />
            ))}
            <Label x={370} y={204} lines={["cast task comment -t progress"]} anchor="middle" ink="blue" className="bj-fade" style={t(2.3)} />

            {/* straight to done, with the summary of what was verified */}
            <path d="M412 138Q540 250 664 140" pathLength={1} fill="none" stroke={SOL.base01} strokeWidth={1.3} markerEnd={arrow("base01")} className="bj-draw" style={t(4.0, 0.6)} />
            <Label x={548} y={216} lines={["cast task done -m \"what was verified\""]} anchor="middle" className="bj-fade" style={t(4.3)} />

            {/* dropped */}
            <Box x={16} y={214} w={NW} h={NH} title="dropped" fill={`${SOL.base1}26`} dashed className="bj-pop" style={t(4.7)} />
            <path d="M68 138V210" pathLength={1} stroke={SOL.base1} strokeDasharray="3 3" fill="none" markerEnd={arrow()} className="bj-draw" style={t(4.6, 0.3)} />
            <Label x={130} y={240} lines={["from any status"]} ink="base1" className="bj-fade" style={t(4.9)} />

            <g className="bj-fade" style={t(5.1)}>
              <rect x={470} y={278} width={9} height={9} rx={2} fill={`${SOL.green}40`} stroke={SOL.base1} />
              <text x={484} y={286.5} fontSize="10" fill={SOL.base01}>done and dropped close the task</text>
            </g>
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── One owning session ────────────────────────────────────────────────────

const OWN_STEPS = [
  { at: 0.4, who: "jx7aaaa", cmd: "cast task start ct-4102", what: "claims the task, binds the session", ink: SOL.green },
  { at: 1.7, who: "jx7bbbb", cmd: "cast task start ct-4102", what: "refused while the owner is working", ink: SOL.red },
  { at: 3.0, who: "jx7bbbb", cmd: "cast task start ct-4102 --take", what: "binding moves, a note lands on the task", ink: SOL.blue },
];

/** A second start is refused while the owner works; --take moves the binding. */
export function OwnershipFigure() {
  return (
    <Stage minWidth={640}>
      <Sheet w={760} h={250} label="Session A starts the task and owns it. Session B's start is refused while A is working. B's start with --take moves the binding and releases A">
        {(arrow) => (
          <g transform="translate(0,-56)">
            <Box x={30} y={96} w={150} h={48} title="session jx7aaaa" sub="working" ink="green" className="bj-pop" style={t(0.1)} />
            <Box x={310} y={92} w={140} h={56} title="ct-4102" sub="one owning session" ink="base01" bold={1.5} className="bj-pop" style={t(0.2)} />
            <Box x={580} y={96} w={150} h={48} title="session jx7bbbb" sub="started later" ink="blue" className="bj-pop" style={t(1.4)} />

            {/* 1: A owns */}
            <path d="M183 118H306" pathLength={1} stroke={SOL.green} strokeWidth={2} fill="none" markerEnd={arrow("green")} className="bj-draw" style={t(0.5, 0.4)} />
            <Label x={244} y={110} lines={["owner"]} anchor="middle" ink="green" className="bj-fade" style={t(0.8)} />

            {/* 2: B refused */}
            <path d="M577 132H454" pathLength={1} stroke={SOL.red} strokeWidth={1.4} strokeDasharray="4 3" fill="none" markerEnd={arrow("red")} className="bj-draw" style={t(1.8, 0.4)} />
            <g className="bj-pop" style={t(2.2)}>
              <circle cx={515} cy={132} r={8} fill={SOL.base3} stroke={SOL.red} />
              <path d="M511 128l8 8M519 128l-8 8" stroke={SOL.red} strokeWidth={1.6} />
            </g>
            <Label x={730} y={172} lines={["ct-4102 is owned by session jx7aaaa,", "which is still working · cast send jx7aaaa"]} anchor="end" ink="red" className="bj-fade" style={t(2.3)} />

            {/* 3: --take moves it */}
            <path d="M183 118H306" stroke={SOL.base1} strokeWidth={2.4} className="bj-fade" style={t(3.3)} />
            <Label x={244} y={136} lines={["released"]} anchor="middle" ink="base1" className="bj-fade" style={t(3.4)} />
            <path d="M577 112H454" pathLength={1} stroke={SOL.blue} strokeWidth={2} fill="none" markerEnd={arrow("blue")} className="bj-draw" style={t(3.1, 0.4)} />
            <Label x={515} y={104} lines={["owner"]} anchor="middle" ink="blue" className="bj-fade" style={t(3.4)} />

            {OWN_STEPS.map((s, i) => (
              <g key={i} className="bj-rise" style={t(s.at)}>
                <circle cx={40} cy={214 + i * 20} r={7} fill={s.ink} />
                <text x={40} y={217.5 + i * 20} textAnchor="middle" fontSize="9.5" fontWeight={700} fill={SOL.base3}>{i + 1}</text>
                <text x={56} y={218 + i * 20} fontSize="10.5" fill={SOL.base02}>
                  <tspan fontWeight={700}>{s.who}</tspan>
                  <tspan x={124}>{s.cmd}</tspan>
                  <tspan x={360} fill={SOL.base01}>{s.what}</tspan>
                </text>
              </g>
            ))}
            <Label x={30} y={286} lines={["An owner with no heartbeat and nothing written for 15 minutes is released without asking."]} ink="base1" size={10} className="bj-fade" style={t(4.0)} />
          </g>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── Context recovery after compaction ─────────────────────────────────────

const LOST = [
  { text: "the acceptance criteria", ink: SOL.blue },
  { text: "the reviewer's last comment", ink: SOL.magenta },
  { text: "which subtask is still open", ink: SOL.orange },
  { text: "who else worked on it", ink: SOL.cyan },
];

const CONTEXT_OUT: { text: string; dim?: boolean; mark?: number }[] = [
  { text: "$ cast task context --current", dim: true },
  { text: "# Retry queue for failed webhooks" },
  { text: "ID: ct-4182 | Status: in_progress | Priority: high" },
  { text: "Labels: webhooks" },
  { text: "┌ task ct-4182: description, criteria", mark: 0 },
  { text: "│ and the newest comments, fenced", mark: 1 },
  { text: "Project: Webhook reliability" },
  { text: "## Subtasks (1/3 done)", mark: 2 },
  { text: "- ct-4191: Dead-letter after attempt 5 [in_progress]" },
  { text: "Blocked by: ct-4183" },
  { text: "## Sessions (newest last · cast read <id>)", mark: 3 },
];

/** A compacted session forgets the details; one command reads them back. */
export function ContextRecoveryFigure() {
  return (
    <Stage>
      <div className="grid grid-cols-1 *:min-w-0 md:grid-cols-[1fr_1.35fr]">
        <div className="border-b md:border-b-0 md:border-r" style={{ borderColor: SOL.base2 }}>
          <PanelHead title="After compaction" sub="A summary survives. The specifics the work depends on do not." color={SOL.red} />
          <div className="m-4 space-y-2 font-mono text-[12px]">
            <div className="rounded-md px-3 py-2 bj-rise" style={{ ...t(0.1), backgroundColor: SOL.base2, color: SOL.base01 }}>
              summary: “retry queue mostly built, tests passing”
            </div>
            {LOST.map((l, i) => (
              <div key={l.text} className="flex items-center gap-2 rounded-md px-3 py-1.5 bj-rise" style={{ ...t(0.4 + i * 0.15), border: `1px dashed ${SOL.base1}`, color: SOL.base1 }}>
                <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: l.ink }} />
                <span style={{ textDecoration: "line-through" }}>{l.text}</span>
              </div>
            ))}
            <div className="text-[11px] pt-1 bj-fade" style={{ ...t(1.2), color: SOL.base01 }}>
              <code>--current</code> reads the task this session started; <code>cast task start</code> recorded it.
            </div>
          </div>
        </div>
        <div>
          <PanelHead title="One command reads it back" sub="The work item itself, with comments and linked sessions, from the server." color={SOL.green} />
          <Term size={11.5} style={{ color: SOL.base2 }}>
            {CONTEXT_OUT.map((l, i) => (
              <div key={i} className="bj-rise flex items-center gap-2" style={t(1.4 + i * 0.1)}>
                <span style={{ color: l.dim ? SOL.base01 : SOL.base2 }}>{l.text}</span>
                {l.mark !== undefined && (
                  <span className="inline-block w-2 h-2 rounded-full shrink-0 bj-pop" style={{ ...t(2.6 + l.mark * 0.15), backgroundColor: LOST[l.mark].ink }} />
                )}
              </div>
            ))}
          </Term>
        </div>
      </div>
    </Stage>
  );
}
