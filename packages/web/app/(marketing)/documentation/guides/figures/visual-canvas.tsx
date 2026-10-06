"use client";

import { useRef, useState } from "react";
import { HtmlSnippet } from "@/components/HtmlSnippet";
import { useNearViewport } from "@/hooks/useNearViewport";
import { useWatchEffect } from "@/hooks/useWatchEffect";
import { SOL } from "../../../blog/blogChrome";
import { PanelHead, Stage, t } from "../../../blog/figureKit";

/**
 * Figures for the visual canvas guide. The gallery renders real canvases
 * through the app's own HtmlSnippet, inside the same theme classes the app
 * puts on <html>, so what a reader sees is exactly what a conversation shows.
 */

// ─── The canvases ──────────────────────────────────────────────────────────
// Written the way the snippet asks agents to write them: --sol-* tokens only.

const COMPARISON = `<div data-canvas-title="Retry strategy: fixed vs exponential">
<style>
.g{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.c{background:var(--sol-card);border:1px solid color-mix(in srgb,var(--sol-border) 45%,transparent);border-radius:8px;padding:14px}
.h{font-weight:700;font-size:13px;display:flex;align-items:center;gap:8px}
.dot{width:8px;height:8px;border-radius:2px}
.k{color:var(--sol-text-muted);font-size:11px;margin-top:10px}
.v{font-size:22px;font-weight:700;margin-top:2px}
.bar{height:6px;border-radius:3px;background:var(--sol-bg-alt);margin-top:6px;overflow:hidden}
.bar i{display:block;height:100%}
.pick{margin-top:12px;font-size:12px;padding:8px 10px;border-radius:6px;background:color-mix(in srgb,var(--sol-green) 14%,transparent);color:var(--sol-text)}
</style>
<div class="g">
 <div class="c"><div class="h"><span class="dot" style="background:var(--sol-red)"></span>Fixed 30s</div>
  <div class="k">events lost in the replay</div><div class="v" style="color:var(--sol-red)">3</div>
  <div class="k">ledger restarts</div><div class="bar"><i style="width:70%;background:var(--sol-red)"></i></div>
  <div class="k">p95 recovery</div><div class="bar"><i style="width:45%;background:var(--sol-orange)"></i></div></div>
 <div class="c"><div class="h"><span class="dot" style="background:var(--sol-green)"></span>Exponential, 5 tries</div>
  <div class="k">events lost in the replay</div><div class="v" style="color:var(--sol-green)">0</div>
  <div class="k">ledger restarts</div><div class="bar"><i style="width:8%;background:var(--sol-green)"></i></div>
  <div class="k">p95 recovery</div><div class="bar"><i style="width:62%;background:var(--sol-blue)"></i></div></div>
</div>
<div class="pick">Recommend exponential: no lost events, at the cost of a slower worst case.</div>
</div>`;

const CHART = `<div data-canvas-title="Webhook failures by hour, before and after the fix">
<div class="cast-chart" data-spec='{"height":220,"color":{"legend":true},"y":{"grid":true,"label":"failures"},"marks":[{"type":"barY","data":[
{"h":"09","n":14,"s":"before"},{"h":"10","n":22,"s":"before"},{"h":"11","n":31,"s":"before"},{"h":"12","n":18,"s":"before"},{"h":"13","n":26,"s":"before"},{"h":"14","n":9,"s":"before"},
{"h":"09","n":2,"s":"after"},{"h":"10","n":1,"s":"after"},{"h":"11","n":4,"s":"after"},{"h":"12","n":0,"s":"after"},{"h":"13","n":3,"s":"after"},{"h":"14","n":1,"s":"after"}
],"x":"h","y":"n","fill":"s","fx":"s","tip":true}]}'></div>
</div>`;

const FLOW = `<div data-canvas-title="How a webhook is retried">
<style>
.row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.n{padding:8px 12px;border-radius:6px;background:var(--sol-card);border:1px solid color-mix(in srgb,var(--sol-border) 45%,transparent);font-size:12px}
.n b{display:block;font-size:10px;color:var(--sol-text-muted);font-weight:400}
.a{color:var(--sol-text-dim);font-size:14px}
.ok{border-color:var(--sol-green);color:var(--sol-green)}
.bad{border-color:var(--sol-red);color:var(--sol-red)}
.back{margin:10px 0 0 92px;font-size:11px;color:var(--sol-orange)}
</style>
<div class="row">
 <div class="n"><b>1</b>receive</div><span class="a">→</span>
 <div class="n"><b>2</b>sign + queue</div><span class="a">→</span>
 <div class="n" data-tip="2^attempt seconds, capped at 5 tries"><b>3</b>deliver</div><span class="a">→</span>
 <div class="n ok"><b>2xx</b>done</div>
 <div class="n bad"><b>5xx</b>back off</div>
</div>
<div class="back">↺ 5xx returns to step 3 after 1s, 2s, 4s, 8s, then the dead letter queue</div>
</div>`;

const TABLE = `<div data-canvas-title="Open sessions on billing">
<table class="cast-table">
<thead><tr><th>Session</th><th>Agent</th><th>Messages</th><th>State</th></tr></thead>
<tbody>
<tr><td>Retry failed webhooks</td><td>Claude Code</td><td>9</td><td style="color:var(--sol-blue)">working</td></tr>
<tr><td>Migrate invoices to Postgres 16</td><td>Codex</td><td>41</td><td style="color:var(--sol-yellow)">needs input</td></tr>
<tr><td>Dashboard retry UI</td><td>Cursor</td><td>17</td><td style="color:var(--sol-blue)">working</td></tr>
<tr><td>Ledger reconciliation</td><td>Claude Code</td><td>63</td><td style="color:var(--sol-green)">done</td></tr>
</tbody></table>
</div>`;

const EXAMPLES = [
  { id: "compare", label: "Comparison", html: COMPARISON },
  { id: "chart", label: "Chart", html: CHART },
  { id: "flow", label: "Flow", html: FLOW },
  { id: "table", label: "Sortable table", html: TABLE },
];

/** The app's four themes, as the class list each one puts on <html>. */
const THEMES = [
  { id: "sol-light", label: "Solarized light", cls: "" },
  { id: "sol-dark", label: "Solarized dark", cls: "dark" },
  { id: "min-light", label: "Minimal light", cls: "minimal-style" },
  { id: "min-dark", label: "Minimal dark", cls: "dark minimal-style" },
];

const SWATCHES = ["text", "text-muted", "card", "bg-alt", "border", "blue", "cyan", "green", "yellow", "orange", "red", "magenta", "violet"];

const CYCLE_MS = 3200;

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="font-mono text-[12px] px-2.5 py-1 rounded-md transition-colors"
      style={on ? { backgroundColor: SOL.base03, color: SOL.base3 } : { backgroundColor: SOL.base2, color: SOL.base01 }}
    >
      {children}
    </button>
  );
}

/**
 * Each example canvas, live, under each of the app's themes. Themes cycle on
 * their own once the figure is in view, until the reader picks one.
 */
export function CanvasThemesFigure() {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useNearViewport(ref, "0px 0px -20% 0px");
  const [example, setExample] = useState(0);
  const [theme, setTheme] = useState(0);
  const [auto, setAuto] = useState(true);

  useWatchEffect(() => {
    if (!seen || !auto) return;
    const id = setInterval(() => setTheme((n) => (n + 1) % THEMES.length), CYCLE_MS);
    return () => clearInterval(id);
  }, [seen, auto]);

  const th = THEMES[theme];
  return (
    <div ref={ref}>
      <div className="px-5 pt-4 pb-3 flex flex-wrap items-center gap-2" style={{ borderBottom: `1px solid ${SOL.base2}` }}>
        {EXAMPLES.map((e, i) => (
          <Chip key={e.id} on={i === example} onClick={() => setExample(i)}>{e.label}</Chip>
        ))}
      </div>
      <div className={th.cls}>
        <div className="transition-colors duration-500 px-5 py-4" style={{ backgroundColor: "var(--sol-bg)", color: "var(--sol-text)" }}>
          <HtmlSnippet code={EXAMPLES[example].html} />
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-2">
            {SWATCHES.map((s) => (
              <div key={s} className="flex items-center gap-1.5 font-mono text-[10.5px]" style={{ color: "var(--sol-text-muted)" }}>
                <span
                  className="inline-block w-3.5 h-3.5 rounded-sm transition-colors duration-500"
                  style={{ backgroundColor: `var(--sol-${s})`, boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--sol-text) 15%, transparent)" }}
                />
                --sol-{s}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="px-5 py-3 flex flex-wrap items-center gap-2" style={{ borderTop: `1px solid ${SOL.base2}` }}>
        <span className="font-mono text-[11px] mr-1" style={{ color: SOL.base1 }}>theme</span>
        {THEMES.map((x, i) => (
          <Chip key={x.id} on={i === theme} onClick={() => { setAuto(false); setTheme(i); }}>{x.label}</Chip>
        ))}
        {auto && <span className="font-mono text-[11px] ml-auto bj-pulse" data-play="1" style={{ color: SOL.base1 }}>cycling</span>}
      </div>
    </div>
  );
}

// ─── Anatomy: tokens in the source, colors in the render ───────────────────

const ANATOMY: { line: string; token?: string }[] = [
  { line: `<div data-canvas-title="Fixed vs exponential">` },
  { line: `  <div style="background:var(--sol-card)">`, token: "card" },
  { line: `    <b style="color:var(--sol-red)">3 lost</b>`, token: "red" },
  { line: `    <i style="background:var(--sol-orange)"></i>`, token: "orange" },
  { line: `  </div>` },
  { line: `  <div style="background:var(--sol-card)">`, token: "card" },
  { line: `    <b style="color:var(--sol-green)">0 lost</b>`, token: "green" },
  { line: `    <i style="background:var(--sol-blue)"></i>`, token: "blue" },
  { line: `  </div>` },
  { line: `</div>` },
];

/** Underline each token in the source with the color it paints here. */
const ANATOMY_INK: Record<string, string> = { card: SOL.base1, red: SOL.red, orange: SOL.orange, green: SOL.green, blue: SOL.blue };

/** The agent names a role, never a color; each theme decides what the role looks like. */
export function TokenAnatomyFigure() {
  return (
    <Stage>
      <div className="grid md:grid-cols-[1.25fr_1fr]">
        <div className="border-b md:border-b-0 md:border-r" style={{ borderColor: SOL.base2 }}>
          <PanelHead title="What the agent writes" sub="Roles, not hex values. The snippet forbids hardcoded colors." color={SOL.violet} />
          <pre className="m-4 p-4 rounded-lg font-mono text-[12px] leading-[1.7] overflow-x-auto" style={{ backgroundColor: SOL.base03, color: SOL.base1 }}>
            {ANATOMY.map((a, i) => (
              <div key={i} className="bj-rise" style={t(0.15 + i * 0.12)}>
                {a.token ? (
                  <>
                    {a.line.split(`var(--sol-${a.token})`)[0]}
                    <span className="rounded px-0.5" style={{ color: SOL.base3, backgroundColor: SOL.base02, boxShadow: `inset 0 -2px 0 ${ANATOMY_INK[a.token]}` }}>
                      var(--sol-{a.token})
                    </span>
                    {a.line.split(`var(--sol-${a.token})`)[1]}
                  </>
                ) : a.line}
              </div>
            ))}
          </pre>
        </div>
        <div>
          <PanelHead title="What each theme paints" sub="One source, four results, no edits." color={SOL.cyan} />
          <div className="m-4 grid grid-cols-2 gap-2">
            {THEMES.map((th, ti) => (
              <div key={th.id} className={`${th.cls} rounded-lg overflow-hidden bj-pop`} style={t(1.5 + ti * 0.18)}>
                <div className="p-2.5 h-full" style={{ backgroundColor: "var(--sol-bg)", color: "var(--sol-text)" }}>
                  <div className="font-mono text-[10px] mb-1.5" style={{ color: "var(--sol-text-muted)" }}>{th.label}</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {(["red", "green"] as const).map((c, i) => (
                      <div key={c} className="rounded p-1.5" style={{ backgroundColor: "var(--sol-card)", border: "1px solid color-mix(in srgb, var(--sol-border) 45%, transparent)" }}>
                        <div className="font-mono text-[11px] font-bold" style={{ color: `var(--sol-${c})` }}>{i === 0 ? "3 lost" : "0 lost"}</div>
                        <div className="mt-1 h-1.5 rounded-full" style={{ backgroundColor: `var(--sol-${i === 0 ? "orange" : "blue"})`, width: i === 0 ? "70%" : "45%" }} />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Stage>
  );
}

// ─── The sandbox: what happens between the fence and the screen ────────────

const STAGES = [
  { x: 20, label: "```cast-canvas", sub: "agent's HTML" },
  { x: 205, label: "sanitize", sub: "DOMPurify" },
  { x: 390, label: "shadow root", sub: "styles scoped" },
  { x: 575, label: "hydrate", sub: "tabs, tables, charts" },
];

const STRIPPED = ["<script>", "onclick=", "<iframe>", "remote <img>", "url(https://…)"];

/** The four steps a canvas takes, and what the sanitizer drops on the way. */
export function SandboxPipelineFigure() {
  const W = 150;
  return (
    <Stage minWidth={660}>
      <svg viewBox="0 0 760 250" className="w-full block font-mono" role="img" aria-label="A canvas is sanitized, mounted in a shadow root that inherits the theme tokens, then hydrated">
        <defs>
          <pattern id="vc-grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.9" fill={SOL.base2} />
          </pattern>
          <marker id="vc-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0L8 4L0 8z" fill={SOL.base1} />
          </marker>
        </defs>
        <rect width="760" height="250" fill="url(#vc-grid)" />

        {STAGES.map((s, i) => (
          <g key={s.label} className="bj-pop" style={t(0.2 + i * 0.45)}>
            <rect x={s.x} y={44} width={W} height={56} rx={8} fill={SOL.base3} stroke={i === 2 ? SOL.cyan : SOL.base1} strokeWidth={i === 2 ? 1.6 : 1.1} />
            <text x={s.x + W / 2} y={68} textAnchor="middle" fontSize="12.5" fontWeight={700} fill={SOL.base02}>{s.label}</text>
            <text x={s.x + W / 2} y={86} textAnchor="middle" fontSize="10.5" fill={SOL.base01}>{s.sub}</text>
          </g>
        ))}
        {STAGES.slice(1).map((s, i) => (
          <path key={s.label} d={`M${STAGES[i].x + W + 4} 72H${s.x - 6}`} pathLength={1} stroke={SOL.base1} strokeWidth={1.4} fill="none" markerEnd="url(#vc-arrow)" className="bj-draw" style={t(0.45 + i * 0.45, 0.3)} />
        ))}

        {/* dropped by the sanitizer */}
        {STRIPPED.map((s, i) => (
          <g key={s} className="bj-rise" style={t(1.0 + i * 0.16)}>
            <path d={`M${280} ${100}Q${282 + i * 4} ${130 + i * 6} ${150 + i * 2} ${142 + i * 20}`} pathLength={1} fill="none" stroke={SOL.red} strokeOpacity={0.5} strokeDasharray="3 3" />
            <text x={140 + i * 2} y={146 + i * 20} textAnchor="end" fontSize="11" fill={SOL.red}>
              <tspan textDecoration="line-through">{s}</tspan>
            </text>
          </g>
        ))}
        <text x={20} y={240} fontSize="10.5" fill={SOL.red} className="bj-fade" style={t(1.9)}>dropped: no agent code runs, nothing loads from the network</text>

        {/* tokens flow in from the app */}
        <g className="bj-fade" style={t(1.6)}>
          <rect x={360} y={150} width={210} height={64} rx={8} fill={`${SOL.cyan}14`} stroke={SOL.cyan} strokeDasharray="4 3" />
          <text x={465} y={172} textAnchor="middle" fontSize="11" fontWeight={700} fill={SOL.cyan}>the app's theme</text>
          {["--sol-text", "--sol-card", "--sol-blue …"].map((tok, i) => (
            <text key={tok} x={380 + i * 66} y={196} fontSize="10" fill={SOL.base01}>{tok}</text>
          ))}
        </g>
        <path d="M465 148V104" pathLength={1} stroke={SOL.cyan} strokeWidth={1.6} fill="none" markerEnd="url(#vc-arrow)" className="bj-draw" style={t(1.9, 0.4)} />
        <text x={474} y={130} fontSize="10" fill={SOL.cyan} className="bj-fade" style={t(2.1)}>inherited through the shadow boundary</text>

        <g className="bj-pop" style={t(2.4)}>
          <circle cx={735} cy={72} r={10} fill={SOL.green} />
          <path d="M730 72l3.5 3.5 6.5-7" stroke={SOL.base3} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </g>
        <text x={650} y={128} textAnchor="middle" fontSize="10.5" fill={SOL.base01} className="bj-fade" style={t(2.5)}>
          <tspan x={650}>the behavior is</tspan>
          <tspan x={650} dy={13}>codecast's code,</tspan>
          <tspan x={650} dy={13}>never the agent's</tspan>
        </text>
      </svg>
    </Stage>
  );
}
