import { Fragment, useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Workflow } from "lucide-react";
import { prWords, waitLine } from "@codecast/shared/tasks";
import { waitRoute } from "../lib/taskBlockers";
import { waitStateStyle } from "../lib/taskWaitStyle";
import { boardOrderedStatuses, taskStatusOf, useTeamTaskStatusList } from "../lib/taskStatuses";
import {
  AGENT_HALT,
  agentHalt,
  CHAR_EM,
  edgeDraw,
  edgePath,
  fits,
  HALT_BORDER,
  HOLDING,
  HOLDING_DASH,
  NODE_H,
  NODE_W,
  nodeStyle,
  keyFamilies,
  planGraphKey,
  planGraphLayout,
  TITLE_SIZE,
  tint,
  waitNodeLabel,
  WAIT_H,
  WAIT_SIZE,
  WAIT_W,
  wrapTitle,
  type KeyMark,
  type PlanGraphTask,
} from "../lib/planGraphLayout";
import { useCoarseNow } from "../hooks/useCoarseNow";

/** One key swatch, drawn with the mark's own tone, dash and opacity. */
function Swatch({ item }: { item: KeyMark }) {
  if (item.mark === "line") {
    const { tone, dash, strokeOpacity, opacity } = item.draw;
    return (
      <svg width="16" height="4" aria-hidden>
        <line x1="0" y1="2" x2="16" y2="2" style={{ stroke: `var(${tone})` }} strokeWidth={1.5} strokeDasharray={dash} strokeOpacity={strokeOpacity} opacity={opacity} />
      </svg>
    );
  }
  if (item.mark === "status") {
    return (
      <svg width="16" height="10" aria-hidden>
        <rect x="0.75" y="0.75" width="14.5" height="8.5" rx="2.5" style={{ fill: tint(item.tone, 14), stroke: `var(${item.tone})` }} strokeWidth={1.5} />
      </svg>
    );
  }
  if (item.mark === "pill") {
    return (
      <svg width="16" height="10" aria-hidden>
        <rect x="0.5" y="0.5" width="15" height="9" rx="4.5" style={{ fill: tint(item.tone, 14), stroke: `var(${item.tone})` }} strokeWidth={1} />
      </svg>
    );
  }
  return (
    <svg width="16" height="10" aria-hidden>
      <rect x="1" y="1" width="14" height="8" rx="3" fill="none" style={{ stroke: `var(${item.tone})` }} strokeWidth={HALT_BORDER.width} strokeDasharray={HALT_BORDER.dash} />
    </svg>
  );
}

/** One family of key entries. */
function KeyGroup({ items }: { items: KeyMark[] }) {
  return (
    <div className="flex items-center gap-4 flex-wrap">
      {items.map((item) => (
        <span key={`${item.mark}:${item.word}`} className="flex items-center gap-1.5">
          <Swatch item={item} />
          {item.word}
        </span>
      ))}
    </div>
  );
}

/** The frame every state of this tab sits in, so switching to Graph on a plan
 *  with no tasks still shows the panel the other tabs show. */
function GraphFrame({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-sol-border/15 bg-sol-bg-alt/30">{children}</div>;
}

export function PlanGraphView({ tasks }: { tasks: PlanGraphTask[] }) {
  const { positions, edges, waitNodes, width, height } = useMemo(() => planGraphLayout(tasks), [tasks]);
  // A six-wave plan is ~1,700px wide and the panel holding it is usually far
  // narrower, so the graph is fitted to the panel by default: the shape of the
  // whole thing is what a graph is for, and a view opening on its leftmost
  // wave with nothing to say the picture continues shows none of it. 1:1 is
  // the reading mode, scrollable, for when the words matter more than the
  // shape. `maxWidth` keeps a small graph at its own size rather than blowing
  // it up to fill the panel.
  const [fit, setFit] = useState(true);
  // What a wait pill's accessible name calls the task it holds: the pills are
  // drawn before the task nodes, so a keyboard reader meets every one of them
  // first, and a name that said only what it waits FOR left the connector as
  // the only thing tying the two together.
  const titleOf = useMemo(() => new Map(tasks.map((t) => [t.short_id, t.title])), [tasks]);
  const router = useRouter();
  const now = useCoarseNow(60_000);
  // A plan's tasks share one workspace, so one status list answers for all of
  // them; the first task that names its team names it for the graph.
  const statuses = useTeamTaskStatusList(tasks.find((t) => t.team_id)?.team_id ?? null);
  const styleOf = useCallback((t: PlanGraphTask) => nodeStyle(taskStatusOf(t, statuses)), [statuses]);
  // Drawn in the order the layout put them, left to right and down each
  // column, so tabbing through the nodes walks the picture.
  const drawn = useMemo(
    () => tasks
      .filter((t) => positions.has(t.short_id))
      .sort((a, b) => {
        const pa = positions.get(a.short_id)!;
        const pb = positions.get(b.short_id)!;
        return pa.x - pb.x || pa.y - pb.y;
      }),
    [tasks, positions],
  );

  // Each halt the picture draws, once: the key names them in its own order,
  // so a task's agent reporting never re-sorts the legend.
  const halts = useMemo(
    () => [...new Set(drawn.map((t) => agentHalt(t.execution_status)).filter((h): h is NonNullable<typeof h> => h !== null))],
    [drawn],
  );
  // The key's statuses read in the team's PIPELINE order (backlog → dropped),
  // not the layout's: a legend that re-sorts itself whenever a status change
  // relayouts the graph is harder to use than one whose order never moves.
  // `useTeamTaskStatusList` hands them back in the pickers' order, which leads
  // with Done, so the board's own order is applied here.
  const statusOrder = useMemo(() => boardOrderedStatuses(statuses).map((s) => s.name), [statuses]);
  const families = useMemo(
    () => keyFamilies(planGraphKey({ edges, waitNodes, halts, nodes: drawn.map(styleOf), statusOrder })),
    [edges, waitNodes, halts, drawn, styleOf, statusOrder],
  );

  // Fitted: the viewBox does the scaling, `aspect-ratio` gives the box its
  // height from the width Tailwind's `w-full` hands it, and `maxWidth` stops a
  // two-task graph being enlarged past 1:1. At 1:1 the SVG is its own size and
  // the container scrolls.
  const svgProps = fit
    ? {
        viewBox: `0 0 ${width} ${height}`,
        preserveAspectRatio: "xMinYMin meet",
        className: "block w-full",
        style: { maxWidth: width, aspectRatio: `${width} / ${height}` },
      }
    : { width, height, className: "block" };

  if (tasks.length === 0) {
    return (
      <GraphFrame>
        <div className="flex flex-col items-center gap-2 py-8 text-xs text-sol-text-dim">
          <Workflow className="w-8 h-8 opacity-30" />
          This plan has no tasks yet
        </div>
      </GraphFrame>
    );
  }

  return (
    <GraphFrame>
      {/* The graph's chrome: a key for the marks it makes in colour and dash
          alone, each swatch drawn exactly as the thing it names and named only
          when the graph actually makes it — a key for a mark nobody can see
          explains nothing. The pills and nodes carry their own words. One
          family per kind of mark (`keyFamilies`), divided rather than run
          together: the statuses are names and the rest are phrases, and
          "still blocking" (an edge) against "still waiting" (a wait pill)
          leaves two 10px swatches to carry the whole distinction. */}
      <div className="flex items-start gap-4 flex-wrap px-3 py-1.5 border-b border-sol-border/15 text-[10px] text-sol-text-dim" data-plan-graph-key>
        {families.map((items, i) => (
          <Fragment key={items[0]!.word}>
            {i > 0 && <span aria-hidden className="self-stretch border-l border-sol-border/30" />}
            <KeyGroup items={items} />
          </Fragment>
        ))}
        {/* The fit control sits with the key, the graph's other piece of
            chrome, so one row explains the picture and one row sizes it. */}
        {/* The label names the ACTION ("1:1" while fitted), so the button
            carries no pressed state: "1:1, not pressed" would say 1:1 is off
            while it is the thing about to happen. Its accessible name is the
            title, the one string that explains what the press does. */}
        <button
          onClick={() => setFit((f) => !f)}
          aria-label={fit ? "Draw the graph at its own size and scroll it" : "Fit the whole graph to the panel"}
          title={fit ? "Draw the graph at its own size and scroll it" : "Fit the whole graph to the panel"}
          data-plan-graph-fit={fit ? "fit" : "full"}
          className="ml-auto flex-shrink-0 px-1.5 py-0.5 rounded border border-sol-border/30 font-mono text-sol-text-muted hover:text-sol-text hover:border-sol-border/60 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-sol-cyan focus-visible:outline-offset-1"
        >
          {fit ? "1:1" : "Fit"}
        </button>
      </div>
      {/* Capped, so a tall graph pans inside its own box and the key — the only
          place the colours and dashes are explained — stays on screen while
          the reader moves around the picture. Fitted, only the height can
          overflow; at 1:1 both axes scroll. */}
      <div className={`max-h-[70vh] ${fit ? "overflow-x-hidden overflow-y-auto" : "overflow-auto"}`}>
        <svg {...svgProps}>
          <defs>
            {[["arrowhead", "--sol-text-dim"], ["arrowhead-holding", HOLDING]].map(([id, tone]) => (
              <marker key={id} id={id} markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                <polygon points="0 0, 8 3, 0 6" style={{ fill: `var(${tone})` }} />
              </marker>
            ))}
          </defs>

          {/* An edge that still gates pickup draws as a waiting wait does; one
              into a task being worked is grey, and a settled one fades. */}
          {edges.map((edge) => {
            const draw = edgeDraw(edge);
            return (
              <path
                key={`${edge.from}>${edge.to}`}
                d={edgePath(edge.points)}
                fill="none"
                style={{ stroke: `var(${draw.tone})` }}
                strokeWidth={1.5}
                strokeOpacity={draw.strokeOpacity}
                strokeDasharray={draw.dash}
                opacity={draw.opacity}
                markerEnd={`url(#${edge.holding ? "arrowhead-holding" : "arrowhead"})`}
              />
            );
          })}

          {waitNodes.map((n) => {
            const to = positions.get(n.task)!;
            // Drawn as the task page and the row mark draw it: dim once it
            // holds nothing. The tone and the token are one decision
            // (`waitStateStyle`), read here rather than re-paired.
            const { tone, token } = waitStateStyle(n.wait.state, n.status);
            const holding = tone === "waiting";
            // The node says what it waits for, or what settled it — including
            // a failed one's cause, which keeps blocking (TG2) and so is never
            // drawn as dismissed.
            const label = waitNodeLabel(n.wait, { now });
            const x1 = n.x + WAIT_W;
            const y1 = n.y + WAIT_H / 2;
            const y2 = to.y + n.inY;
            // The node's label is clipped to 208px, so a PR there stays bare
            // ("PR #4213 to merge") and two repositories' PRs draw the same
            // picture. The title has unlimited room, so it takes the rule for
            // a surface with no checkout to read refs in (`prWords(null)`:
            // always in full) and is the one affordance that tells them apart.
            const held = titleOf.get(n.task);
            // Present tense only while the wait is one: a failed wait keeps
            // blocking (TG2), so it still "holds" its task, and a met or dim
            // one is the single state that released it — "PR #42 merged —
            // holds ct-12" would contradict itself. The tone the node is
            // already drawn in is the same decision, so it picks the clause.
            const title = `${waitLine(n.wait, { now, ...prWords(null) })} — ${holding || tone === "failed" ? "holds" : "on"} ${n.task}${held ? ` ${held}` : ""}`;
            // The node is drawn as a pill, the chrome every clickable
            // reference in the app wears (EntityIdPill), and it names the one
            // thing that explains why a whole wave is stuck — so it opens what
            // it names, by pointer and by keyboard, like the task nodes beside
            // it. A time wait names nothing to open, and neither does a PR
            // codecast cannot place (`waitRoute`): those stay inert, as they
            // are on the task page, where a time draws in the pill's chrome
            // with no link either.
            const href = waitRoute(n.wait);
            const open = href ? () => router.push(href) : null;
            return (
              <Fragment key={n.key}>
                {/* The curve from the pill to the task it holds, drawn OUTSIDE
                    the link: it reaches across the picture, and a click landing
                    on it is not a click on the pill. */}
                <path
                  d={`M ${x1} ${y1} C ${x1 + 14} ${y1}, ${to.x - 14} ${y2}, ${to.x} ${y2}`}
                  fill="none"
                  style={{ stroke: `var(${token})` }}
                  strokeWidth={1.25}
                  strokeOpacity={0.7}
                  strokeDasharray={holding ? HOLDING_DASH : undefined}
                />
                <g
                  {...(open
                    ? {
                        role: "link",
                        tabIndex: 0,
                        onClick: open,
                        onKeyDown: (e: React.KeyboardEvent) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            open();
                          }
                        },
                        className: "group cursor-pointer focus-visible:outline-none",
                      }
                    : {})}
                >
                  {/* The accessible name, with no aria-label over it: the full
                      words are already here, and `role="link"` is what says it
                      opens. */}
                  <title>{title}</title>
                  <rect
                    x={n.x}
                    y={n.y}
                    width={WAIT_W}
                    height={WAIT_H}
                    rx={WAIT_H / 2}
                    style={{ fill: tint(token, 14), stroke: `var(${token})` }}
                    strokeWidth={1}
                    className={open ? "transition-[stroke-width] group-hover:[stroke-width:2] group-focus-visible:[stroke-width:2]" : undefined}
                  />
                  {/* Keyboard focus, the halo the task nodes use. */}
                  {open && (
                    <rect
                      x={n.x - 3}
                      y={n.y - 3}
                      width={WAIT_W + 6}
                      height={WAIT_H + 6}
                      rx={WAIT_H / 2 + 3}
                      fill="none"
                      style={{ stroke: "var(--sol-cyan)" }}
                      strokeWidth={1.5}
                      className="opacity-0 group-focus-visible:opacity-100 transition-opacity pointer-events-none"
                    />
                  )}
                  {/* One rule for every node in the picture: the state lives in
                      the chrome (stroke and fill), the text stays neutral. A
                      pill's 10px is the smallest type on screen, and tinted text
                      on a wash of its own hue was the worst contrast in it. */}
                  <text x={n.x + 8} y={n.y + 12.5} fontSize={WAIT_SIZE} style={{ fill: `var(${tone === "dim" ? "--sol-text-muted" : "--sol-text"})` }}>
                    {label}
                  </text>
                </g>
              </Fragment>
            );
          })}

          {drawn.map(task => {
            const p = positions.get(task.short_id)!;
            const { tone, label, dim } = styleOf(task);
            const text = dim ? "var(--sol-text-dim)" : "var(--sol-text)";
            // The dash and the words come from one decision (`agentHalt`), so
            // a node can never be drawn in the colour of failure and called
            // something else: a task whose agent asked a person for context
            // draws and reads as "needs context", in the orange its board
            // badge uses.
            const halt = agentHalt(task.execution_status);
            const mark = halt ? AGENT_HALT[halt] : null;
            const open = () => router.push(`/tasks/${task.short_id}`);
            const width = fits(NODE_W, TITLE_SIZE);
            const [line1, line2] = wrapTitle(task.title, width - task.short_id.length - 1, width);

            return (
              <g
                key={task.short_id}
                role="link"
                tabIndex={0}
                // The status is the graph's loudest encoding and the dashed
                // border its one alarm, so both belong in the accessible name:
                // an aria-label overrides the <title> below, which would
                // otherwise leave them to hover alone.
                aria-label={`Open task ${task.short_id}: ${task.title} — ${label}${mark ? `, ${mark.name}` : ""}`}
                onClick={open}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    open();
                  }
                }}
                className="group cursor-pointer focus-visible:outline-none"
              >
                <title>{`${task.short_id} ${task.title} — ${label}${mark ? `, ${mark.name}` : ""}`}</title>
                <rect
                  x={p.x}
                  y={p.y}
                  width={NODE_W}
                  height={NODE_H}
                  rx={6}
                  style={{ fill: tint(tone, 14), stroke: `var(${mark ? mark.tone : tone})` }}
                  strokeWidth={mark ? HALT_BORDER.width : 1.5}
                  strokeDasharray={mark ? HALT_BORDER.dash : undefined}
                  className="transition-[stroke-width] group-hover:[stroke-width:2.5] group-focus-visible:[stroke-width:2.5]"
                />
                {/* Keyboard focus: a cyan halo outside the node, so hover reads
                    as "pointable" and focus as "here you are". */}
                <rect
                  x={p.x - 3}
                  y={p.y - 3}
                  width={NODE_W + 6}
                  height={NODE_H + 6}
                  rx={9}
                  fill="none"
                  style={{ stroke: "var(--sol-cyan)" }}
                  strokeWidth={1.5}
                  className="opacity-0 group-focus-visible:opacity-100 transition-opacity pointer-events-none"
                />
                {/* The id and the title share a line; a long title goes on below. */}
                <text x={p.x + 8} y={p.y + (line2 ? 18 : 26)} style={{ fill: text }} fontSize={TITLE_SIZE}>
                  <tspan opacity={0.6}>{task.short_id}</tspan>
                  <tspan dx={TITLE_SIZE * CHAR_EM} fontWeight={500}>{line1}</tspan>
                </text>
                {line2 && (
                  <text x={p.x + 8} y={p.y + 33} style={{ fill: text }} fontSize={TITLE_SIZE} fontWeight={500}>
                    {line2}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </GraphFrame>
  );
}
