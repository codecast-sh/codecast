"use client";

import { SOL } from "../../blog/blogChrome";
import { Body, C, Section } from "./ui";

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

/** The guide's example graph, drawn with DOT's own shapes: Mdiamond, box, parallelogram, hexagon, Msquare. */
function Graph() {
  const y = 120;
  return (
    <svg viewBox="8 30 612 202" className="w-full h-auto" role="img" aria-label="Workflow graph: start, implement, verify, review gate, exit, with a failure loop and a revise loop back to implement">
      <defs>
        <marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill={SOL.base01} />
        </marker>
      </defs>

      {/* edges */}
      <g fill="none" strokeWidth="1.8">
        <line x1="62" y1={y} x2="112" y2={y} stroke={SOL.base01} markerEnd="url(#wf-arrow)" />
        <line x1="212" y1={y} x2="262" y2={y} stroke={SOL.base01} markerEnd="url(#wf-arrow)" />
        <line x1="368" y1={y} x2="418" y2={y} stroke={SOL.green} className="tg-flow" markerEnd="url(#wf-arrow)" />
        <line x1="512" y1={y} x2="566" y2={y} stroke={SOL.green} markerEnd="url(#wf-arrow)" />
        <path d={`M315 ${y - 26} C 300 40, 190 40, 168 ${y - 24}`} stroke={SOL.red} strokeDasharray="5 4" markerEnd="url(#wf-arrow)" />
        <path d={`M465 ${y + 28} C 450 222, 190 222, 165 ${y + 24}`} stroke={SOL.orange} strokeDasharray="5 4" markerEnd="url(#wf-arrow)" />
      </g>
      <g fontFamily={MONO} fontSize="11">
        <text x="390" y={y - 10} textAnchor="middle" fill={SOL.green}>success</text>
        <text x="240" y="46" textAnchor="middle" fill={SOL.red}>outcome = failure</text>
        <text x="540" y={y - 30} textAnchor="middle" fill={SOL.green}>[A] Approve</text>
        <text x="315" y="226" textAnchor="middle" fill={SOL.orange}>[R] Revise</text>
      </g>

      {/* start: Mdiamond */}
      <g>
        <path d={`M38 ${y - 22} L60 ${y} L38 ${y + 22} L16 ${y} Z`} fill={SOL.base3} stroke={SOL.base01} strokeWidth="1.5" />
        <line x1="28" y1={y - 12} x2="48" y2={y - 12} stroke={SOL.base01} />
        <line x1="28" y1={y + 12} x2="48" y2={y + 12} stroke={SOL.base01} />
        <text x="38" y={y + 42} textAnchor="middle" fontFamily={MONO} fontSize="11" fill={SOL.base1}>start</text>
      </g>
      {/* implement: agent box */}
      <g>
        <rect x="114" y={y - 26} width="98" height="52" rx="8" fill={SOL.base03} />
        <text x="163" y={y - 4} textAnchor="middle" fontFamily={MONO} fontSize="12" fill={SOL.base2}>Implement</text>
        <text x="163" y={y + 13} textAnchor="middle" fontFamily={MONO} fontSize="10" fill={SOL.cyan}>backend=claude</text>
      </g>
      {/* verify: parallelogram = shell */}
      <g>
        <path d={`M276 ${y - 26} L368 ${y - 26} L354 ${y + 26} L262 ${y + 26} Z`} fill="#fffbf0" stroke={SOL.base01} strokeWidth="1.5" />
        <text x="315" y={y - 4} textAnchor="middle" fontFamily={MONO} fontSize="12" fill={SOL.base02}>Verify</text>
        <text x="315" y={y + 13} textAnchor="middle" fontFamily={MONO} fontSize="10" fill={SOL.base1}>tsc --noEmit</text>
      </g>
      {/* review: hexagon = human gate */}
      <g>
        <path d={`M434 ${y - 28} L496 ${y - 28} L512 ${y} L496 ${y + 28} L434 ${y + 28} L418 ${y} Z`} fill={`color-mix(in srgb, ${SOL.orange} 14%, ${SOL.base3})`} stroke={SOL.orange} strokeWidth="1.8" />
        <text x="465" y={y - 4} textAnchor="middle" fontFamily={MONO} fontSize="12" fill={SOL.base02}>Review</text>
        <text x="465" y={y + 13} textAnchor="middle" fontFamily={MONO} fontSize="10" fill={SOL.orange}>you decide</text>
      </g>
      {/* exit: Msquare */}
      <g>
        <rect x="568" y={y - 20} width="40" height="40" fill={SOL.base3} stroke={SOL.base01} strokeWidth="1.5" />
        <path d={`M568 ${y - 12} L576 ${y - 20} M600 ${y - 20} L608 ${y - 12} M568 ${y + 12} L576 ${y + 20} M600 ${y + 20} L608 ${y + 12}`} stroke={SOL.base01} />
        <text x="588" y={y + 42} textAnchor="middle" fontFamily={MONO} fontSize="11" fill={SOL.base1}>exit</text>
      </g>
    </svg>
  );
}

const DOT = `digraph my_flow {
  graph [goal="$task_title"]
  start [shape=Mdiamond]
  implement [label="Implement", backend=claude, prompt="..."]
  verify [label="Verify", shape=parallelogram, script="npx tsc --noEmit"]
  review [label="Review", shape=hexagon]
  exit [shape=Msquare]
  start -> implement -> verify
  verify -> review [condition="outcome = success"]
  verify -> implement [condition="outcome = failure"]
  review -> exit [label="[A] Approve"]
  review -> implement [label="[R] Revise"]
}`;

/** Light DOT highlighting: keywords, strings, arrows. */
function Dot() {
  const parts = DOT.split(/("[^"]*"|->|\bdigraph\b|\bgraph\b|\bshape\b|\bbackend\b|\bscript\b|\bcondition\b|\blabel\b|\bprompt\b|\bgoal\b)/g);
  return (
    <pre className="p-4 font-mono text-[11px] leading-relaxed">
      {parts.map((p, i) => {
        if (!p) return null;
        const color = p.startsWith('"') ? SOL.cyan : p === "->" ? SOL.orange : /^(digraph|graph)$/.test(p) ? SOL.green : /^[a-z_]+$/.test(p) && i % 2 === 1 ? SOL.yellow : SOL.base0;
        return <span key={i} style={{ color }}>{p}</span>;
      })}
    </pre>
  );
}

export function Workflow() {
  return (
    <Section
      id="workflows"
      title="When one prompt is not enough: workflows"
      lede={<>A trigger runs one prompt. Some work has a shape: implement, verify, loop on failure, stop for a person before anything ships. A workflow writes that shape down as a DOT graph and binds it to a task or plan.</>}
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="rounded-2xl p-4 sm:p-6" style={{ backgroundColor: "#fffbf0", border: `1px solid ${SOL.base2}` }}>
          <div className="-mx-1 overflow-x-auto px-1">
            <div className="min-w-[540px]"><Graph /></div>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-x-6 gap-y-1.5 text-[12.5px] sm:grid-cols-2" style={{ color: SOL.base01 }}>
            <span><span className="font-mono" style={{ color: SOL.base02 }}>box</span> agent session</span>
            <span><span className="font-mono" style={{ color: SOL.base02 }}>parallelogram</span> shell command</span>
            <span><span className="font-mono" style={{ color: SOL.orange }}>hexagon</span> human gate</span>
            <span><span className="font-mono" style={{ color: SOL.base02 }}>condition</span> routes on outcome</span>
          </div>
        </div>
        <div className="min-w-0 rounded-2xl overflow-x-auto" style={{ backgroundColor: SOL.base03 }}>
          <div className="px-4 pt-3 font-mono text-[11px]" style={{ color: SOL.base01 }}>flow.cast</div>
          <Dot />
        </div>
      </div>
      <div className="mt-8 grid gap-6 md:grid-cols-2">
        <Body>
          <C>cast workflow run flow.cast --task ct-4102</C> starts a run. Each agent node is its own session, streamed live with the graph&apos;s progress beside it. A gate holds the run and shows its choices as buttons in the dashboard, with a push notification to your phone and desktop. Your answer goes to the next node.
        </Body>
        <Body>
          The split is simple. A trigger decides when something runs. A workflow decides what runs in what order, with the same steps and the same gates every time. <C>cast workflow list</C> shows the templates, <C>cast workflow runs</C> what is in flight and which gate it waits on.
        </Body>
      </div>
    </Section>
  );
}
