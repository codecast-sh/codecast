// Throwaway harness: mounts the real HtmlSnippet with a fixture exercising
// widgets (tabs, sortable table, tooltip), the collapse cap, and egress
// stripping. Served by vite at /_canvastest.html. DELETE before finishing.
import { createRoot } from "react-dom/client";
import "./app/globals.css";
import { HtmlSnippet } from "./components/HtmlSnippet";

const FIXTURE = `
<div data-canvas-title="Widget test — tabs, table, tooltip, collapse">
<div class="cast-tabs">
  <section data-tab="Overview">
    <p>Overview panel. <span data-tip="I am a tooltip" style="border-bottom:1px dotted var(--sol-blue);color:var(--sol-blue)">hover me</span></p>
    <img src="https://evil.example/pixel.png" alt="should be stripped">
    <p>The image above must NOT render (remote src stripped).</p>
  </section>
  <section data-tab="Numbers">
    <table class="cast-table" style="width:100%;border-collapse:collapse">
      <thead><tr><th style="text-align:left;padding:4px 8px">Service</th><th style="text-align:right;padding:4px 8px">p95 ms</th><th style="text-align:right;padding:4px 8px">Cost</th></tr></thead>
      <tbody>
        <tr><td style="padding:4px 8px">gateway</td><td style="text-align:right;padding:4px 8px">120</td><td style="text-align:right;padding:4px 8px">$1,400</td></tr>
        <tr><td style="padding:4px 8px">auth</td><td style="text-align:right;padding:4px 8px">45</td><td style="text-align:right;padding:4px 8px">$90</td></tr>
        <tr><td style="padding:4px 8px">search</td><td style="text-align:right;padding:4px 8px">310</td><td style="text-align:right;padding:4px 8px">$3,200</td></tr>
      </tbody>
    </table>
  </section>
  <section data-tab="Tall">
    <div style="height:900px;background:linear-gradient(var(--sol-bg-alt), color-mix(in srgb, var(--sol-blue) 20%, transparent));border:1px solid var(--sol-border);border-radius:8px;padding:12px">
      900px tall block — the canvas should collapse with a Show all control when this tab is active.
    </div>
  </section>
</div>
</div>`;

createRoot(document.getElementById("root")!).render(<HtmlSnippet code={FIXTURE} />);
