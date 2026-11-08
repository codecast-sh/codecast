"use client";

import { useRef, useState } from "react";
import { Card, PersonGlyph, Section } from "./kit";
import { INK, MUTED, at, usePlayOnView } from "./base";
import "./autonomy.css";

// The library of pool flows on /features/flows (workflow/templates): each
// flow drawn the way the Flows page draws it, its steps by kind and its ways out.

type Kind = "shell" | "agent" | "person";
type Tone = "good" | "live" | "bad" | "back" | "plain" | "loop" | "warn";
/** `cont`: a way out that carries on (a way back, a loop, Already landed in Change), so not an end of the flow. */
type End = { name: string; tone: Tone; cont?: boolean };
type Step = { name: string; kind: Kind; sub?: string; n?: number; opt?: boolean; ends?: End[] };
/** `ends` on a step hang under it, the way the Flows page draws them; `more` are ways out not tied to one step. */
type LibFlow = { id: string; name: string; from?: string; steps: Step[]; exit: End; more?: End[] };

const step = (kind: Kind) => (name: string, ends?: End[], o?: { sub?: string; n?: number; opt?: boolean }): Step => ({ name, kind, ends, ...o });
const S = step("shell");
const A = step("agent");
const P = step("person");
const way = (name: string): End => ({ name, tone: "back", cont: true });
const asked = (name: string): End => ({ name, tone: "back" });
const bad = (name: string): End => ({ name, tone: "bad" });
const plain = (name: string, cont?: boolean): End => ({ name, tone: "plain", cont });
const loop = (name: string): End => ({ name, tone: "loop", cont: true });
const good = (name: string): End => ({ name, tone: "good" });
const LIVE: End = { name: "Live", tone: "live" };

const LIBRARY: LibFlow[] = [
  {
    id: "line", name: "line", exit: good("Exit"),
    steps: [
      A("Ground", [plain("Park")]), A("Plan", undefined, { opt: true }), A("Analyze"), A("Prove"), S("Red"), A("Implement"), S("Verify"), S("Green"),
      S("Eval", [plain("Unscored")]), A("Review", [bad("Rejected")]), S("Card draft"), A("Present"), S("Card"),
      P("Decide", [way("Revise"), bad("Drop")]), S("Rebase"), S("Ship"), S("Watch"),
    ],
    more: [plain("Dissolve"), plain("Unproven"), bad("Stopped")],
  },
  {
    id: "prove", name: "Prove, then implement", exit: good("Built and green"),
    steps: [A("Prove"), S("Red"), A("Implement"), S("Verify"), S("Green")],
    more: [loop("no miss shown"), loop("checks failed"), loop("still red"), plain("Dissolved"), plain("Unproven"), bad("Cannot build")],
  },
  {
    id: "change", name: "Change", from: "Session", exit: LIVE,
    steps: [
      S("Check", [way("Fix check")]),
      A("Review", [way("Address review"), bad("Rejected")]),
      P("Decide", [way("Revise"), bad("Dropped")]),
      S("Land", [plain("Already landed", true), way("Resolve conflict"), bad("Not shipped")], { sub: "2 steps", n: 2 }),
      S("Deploy", [bad("Deploy failed")]),
    ],
  },
  {
    id: "quick", name: "Quick", from: "Session", exit: LIVE,
    steps: [S("Check", [way("Fix check")]), A("Review", [way("Address review"), bad("Rejected")]), S("Land", [way("Resolve conflict"), bad("Not shipped")], { sub: "2 steps", n: 2 }), S("Deploy")],
  },
  { id: "check", name: "Check", exit: good("Passed"), steps: [S("Verify", [bad("Checks failed")])] },
  { id: "review", name: "Review", exit: good("Approved"), steps: [A("Review", [asked("Changes asked"), bad("Rejected")])] },
  { id: "eval", name: "Eval", exit: good("Passed"), steps: [S("Eval", [plain("Unscored"), bad("Eval failed")])] },
  { id: "judge", name: "Judge", exit: good("Low risk"), steps: [S("Guidelines"), S("Diff"), A("Judge", [plain("Unscored"), { name: "High risk", tone: "warn" }])] },
  { id: "decide", name: "Decide", exit: good("Ship"), steps: [P("Decide", [asked("Revise"), bad("Dropped")])] },
  { id: "ship", name: "Ship", exit: good("Shipped"), steps: [S("Rebase", [plain("Already landed"), asked("Conflict")]), S("Land", [loop("default branch moved"), bad("Not shipped")])] },
  { id: "deploy", name: "Deploy", exit: LIVE, steps: [S("Wait for live", [bad("Deploy failed")])] },
];

const waysOut = (f: LibFlow) => [...f.steps.flatMap((s) => s.ends ?? []), ...(f.more ?? [])];
/** Steps as run (Land in Change is two), and terminal ends only (the exit plus every way out that stops the run). */
const stepCount = (f: LibFlow) => f.steps.reduce((n, s) => n + (s.n ?? 1), 0);
const endCount = (f: LibFlow) => 1 + waysOut(f).filter((e) => !e.cont).length;
const ROW = 7;

function KindIcon({ kind }: { kind: Kind }) {
  if (kind === "person") return <PersonGlyph size={13} />;
  if (kind === "agent") {
    return (
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden className="shrink-0">
        <rect x="2.5" y="5" width="11" height="8.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 5V2.5M6 9.2h.01M10 9.2h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden className="shrink-0">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.5 6.5l2 1.8-2 1.8M8.5 10.5h3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function EndChip({ end, d }: { end: End; d: number }) {
  return (
    <span className="flx-lib-end flx-lib-in" data-tone={end.tone} style={at(d)}>
      {end.tone === "back" || end.tone === "loop" ? "↺ " : ""}{end.name}
    </span>
  );
}

type Item = { type: "from"; name: string } | { type: "step"; step: Step } | { type: "exit"; end: End };

/**
 * The featured flow. Wide: rows of up to seven nodes, each joined to the next
 * by a connector that touches both, a later row picking up with ↳. Narrow: one
 * column, top to bottom, the same connectors turned downward.
 */
function FlowDrawing({ flow }: { flow: LibFlow }) {
  const items: Item[] = [
    ...(flow.from ? [{ type: "from" as const, name: flow.from }] : []),
    ...flow.steps.map((s) => ({ type: "step" as const, step: s })),
    { type: "exit", end: flow.exit },
  ];
  const rows: Item[][] = [];
  for (let i = 0; i < items.length; i += ROW) rows.push(items.slice(i, i + ROW));
  let k = 0;
  return (
    <div className="flx-lib-big">
      <div className="flx-lib-chain">
        {rows.map((row, ri) => (
          <div key={ri} className="flx-lib-row">
            {ri > 0 ? <span className="flx-lib-cont" aria-hidden>↳</span> : null}
            {row.map((it, ii) => {
              const d = 0.04 * k++;
              const rowEnd = ii === row.length - 1;
              if (it.type === "exit") {
                return (
                  <div key="exit" className="flx-lib-col">
                    <div className="flx-lib-head"><span className="flx-lib-end flx-lib-exit flx-lib-in" data-tone={it.end.tone} style={at(d)}>{it.end.name}</span></div>
                  </div>
                );
              }
              const node = it.type === "from"
                ? <span className="flx-lib-from flx-lib-in" style={at(d)}><PersonGlyph size={13} />{it.name}</span>
                : (
                  <span className="flx-lib-node flx-lib-in" data-kind={it.step.kind} data-opt={it.step.opt ? "" : undefined} style={at(d)}>
                    <KindIcon kind={it.step.kind} />
                    {it.step.name}
                    {it.step.sub ? <small>{it.step.sub}</small> : null}
                  </span>
                );
              const ends = it.type === "step" ? it.step.ends : undefined;
              return (
                <div key={ii} className="flx-lib-col">
                  <div className="flx-lib-head">
                    {node}
                    <span className="flx-lib-link" data-rowend={rowEnd ? "" : undefined} aria-hidden />
                  </div>
                  {ends?.length ? (
                    <div className="flx-lib-hang">
                      {ends.map((e, j) => <EndChip key={e.name} end={e} d={0.25 + 0.04 * (k + j)} />)}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {flow.more?.length ? (
        <div className="flx-lib-ends">
          {flow.more.map((e, i) => <EndChip key={e.name + i} end={e} d={0.3 + 0.03 * i} />)}
        </div>
      ) : null}
    </div>
  );
}

function LibraryFigure() {
  const [ref, playing] = usePlayOnView<HTMLDivElement>();
  const stage = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState("line");
  const flow = LIBRARY.find((f) => f.id === sel) ?? LIBRARY[0];
  const steps = stepCount(flow);
  const ends = endCount(flow);
  return (
    <div ref={ref} data-play={playing ? "" : undefined}>
      <div ref={stage} className="flx-lib-stagewrap">
        <Card className="p-5 sm:p-7">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono font-bold text-[18px]" style={{ color: INK }}>{flow.name}</span>
            <span className="font-mono text-[13px]" style={{ color: MUTED }}>{steps} {steps === 1 ? "step" : "steps"}, {ends} ends</span>
          </div>
          <div className="mt-5">
            <FlowDrawing key={flow.id} flow={flow} />
          </div>
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" role="group" aria-label="Library flows">
        {LIBRARY.map((f, i) => {
          return (
            <button
              key={f.id}
              type="button"
              className="flx-lib-card flx-lib-in"
              data-wide={f.id === "line" ? "" : undefined}
              aria-pressed={sel === f.id}
              style={at(0.05 * i)}
              onMouseEnter={() => setSel(f.id)}
              onFocus={() => setSel(f.id)}
              onClick={() => {
                setSel(f.id);
                // On a narrow screen the drawing sits far above the cards: bring it into view.
                if (window.matchMedia("(max-width: 1023px)").matches) stage.current?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              <span className="flx-lib-card-name">{f.name}</span>
              <span className="flx-lib-mini" aria-hidden>
                {f.from ? <i data-kind="from">{f.from}</i> : null}
                {f.steps.map((s, j) => <i key={j} data-kind={s.kind} data-opt={s.opt ? "" : undefined}>{s.name}</i>)}
                <i data-kind={f.exit.tone === "live" ? "live" : "exit"}>{f.exit.name}</i>
              </span>
              <span className="flx-lib-outs" aria-hidden>
                {waysOut(f).map((e, j) => <i key={j} data-tone={e.tone}>{e.tone === "back" || e.tone === "loop" ? "↺ " : ""}{e.name}</i>)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function LibrarySection() {
  return (
    <Section
      id="library"
      wide
      title="The flow library"
      lede={<p>Flows are built from segments. Change is Check, Review, Decide, Land and Deploy in a row, and Quick is Change without Decide. A team can extend any flow with its own steps or write a new one.</p>}
    >
      <LibraryFigure />
    </Section>
  );
}
