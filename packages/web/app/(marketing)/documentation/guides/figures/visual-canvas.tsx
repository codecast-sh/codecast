"use client";

import { useRef, useState } from "react";
import { HtmlSnippet } from "@/components/HtmlSnippet";
import { useNearViewport } from "@/hooks/useNearViewport";
import { useWatchEffect } from "@/hooks/useWatchEffect";
import { SOL } from "../../../blog/blogChrome";

/**
 * The figure for the visual canvas guide. The gallery renders real canvases
 * through the app's own HtmlSnippet, inside the same theme classes the app
 * puts on <html>, so what a reader sees is exactly what a conversation shows.
 */

// ─── The canvases ──────────────────────────────────────────────────────────
// Written the way the snippet asks agents to write them: --sol-* tokens only.

const COMPARISON = `<div data-canvas-title="Retry strategy: fixed vs exponential">
<style>
.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.c{background:var(--sol-card);border:1px solid color-mix(in srgb,var(--sol-border) 45%,transparent);border-radius:8px;padding:14px}
.h{font-weight:700;font-size:13px;display:flex;align-items:center;gap:8px}
.dot{width:8px;height:8px;border-radius:2px;flex-shrink:0}
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
<div class="cast-chart" data-spec='{"height":220,"color":{"legend":true,"domain":["before","after"]},"fx":{"label":null,"domain":["before","after"]},"x":{"label":null,"domain":["9am", "10am", "11am", "noon", "1pm", "2pm"]},"y":{"grid":true,"label":"failures"},"marks":[{"type":"barY","data":[
{"h":"9am","n":14,"s":"before"},
{"h":"10am","n":22,"s":"before"},
{"h":"11am","n":31,"s":"before"},
{"h":"noon","n":18,"s":"before"},
{"h":"1pm","n":26,"s":"before"},
{"h":"2pm","n":9,"s":"before"},
{"h":"9am","n":2,"s":"after"},
{"h":"10am","n":1,"s":"after"},
{"h":"11am","n":4,"s":"after"},
{"h":"noon","n":0,"s":"after"},
{"h":"1pm","n":3,"s":"after"},
{"h":"2pm","n":1,"s":"after"}
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
