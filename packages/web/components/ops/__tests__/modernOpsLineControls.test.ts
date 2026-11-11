// Ops and Flows draw their controls from their own stylesheets (.ops-*,
// .osx-*, .mx-*, .iss-*, .rp-*, .lw-*, .fs-*), so the Modern style reaches
// them there: under .modern-style each control class points at the
// primitives' tokens (control radius and heights, the one focus ring, the
// popover surface, the accent). This loads the real stylesheets into jsdom,
// whose cascade resolves which rule wins, and checks both sides: in Modern a
// control resolves to the tokens; in Classic every control resolves exactly
// as it did before the Modern rules (the snapshot was taken from the
// unmodified stylesheets).
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const WEB = join(import.meta.dir, "..", "..", "..");
const SHEETS = [
  "components/ops/opsLayout.css",
  "components/ops/ops.css",
  "components/ops/opsHome.css",
  "components/ops/issues.css",
  "components/ops/metrics.css",
  "components/ops/metricPage.css",
  "components/ops/replays.css",
  "components/line/workspace/workspace.css",
  "components/line/workspace/views/flows/flowsStage.css",
];
// jsdom's CSS parser cannot follow @import or read @container/@layer bodies
// it does not know; the control rules are plain, so a failed block is skipped.
const css = SHEETS.map((f) => readFileSync(join(WEB, f), "utf8")).join("\n");

const MARKUP = `
<div class="ops-area">
  <button class="ops-btn" data-k="ops-btn">Run</button>
  <button class="ops-btn" data-tone="primary" data-k="ops-btn-primary">Fix</button>
  <button class="ops-btn" data-tone="danger" data-k="ops-btn-danger">Delete</button>
  <div class="ops-seg" data-k="ops-seg"><button data-k="ops-seg-on" data-on="true">All</button><button data-k="ops-seg-off" data-on="false">New</button></div>
  <button class="ops-chip" data-k="ops-chip">tag</button>
  <button class="ops-chip" data-on="true" data-k="ops-chip-on">tag</button>
  <button class="ops-source-chip" data-k="ops-source-chip">web</button>
  <button class="ops-source-chip" data-on="true" data-k="ops-source-chip-on">web</button>
  <div class="ops-tabs"><a class="ops-tab" data-active="true" data-k="ops-tab-on">Issues</a><a class="ops-tab" data-k="ops-tab-off">Metrics</a></div>
  <span class="ops-pill" data-k="ops-pill">new</span>
  <div class="mx-seg" data-k="mx-seg"><button aria-pressed="true" data-k="mx-seg-on">1h</button><button aria-pressed="false" data-k="mx-seg-off">1d</button></div>
  <input class="mx-input" data-k="mx-input" />
  <input class="mx-search" data-k="mx-search" />
  <button class="mx-icon-btn" data-k="mx-icon-btn">x</button>
  <span class="mx-chip" data-k="mx-chip">a</span>
  <button class="mxp-chip" data-k="mxp-chip">p95</button>
  <button class="mxp-chip" data-on="" data-k="mxp-chip-on">p95</button>
  <label class="iss-search" data-k="iss-search"><input /></label>
  <div class="iss-lane-tabs" data-k="iss-lane-tabs"><button data-on="true" data-k="iss-lane-on">New</button><button data-on="false" data-k="iss-lane-off">All</button></div>
  <div class="rp-rail-tabs" data-k="rp-rail-tabs"><button data-on="true" data-k="rp-tab-on">Events</button><button data-k="rp-tab-off">Errors</button></div>
</div>
<div class="lw">
  <div class="lw-seg" data-k="lw-seg"><button aria-selected="true" data-k="lw-seg-on">Map</button><button aria-selected="false" data-k="lw-seg-off">List</button></div>
  <button class="lw-chip" data-k="lw-chip">3 waiting</button>
  <button class="lw-chip" data-tone="ask" data-k="lw-chip-ask">ask</button>
  <button class="lw-iconbtn" data-k="lw-iconbtn">x</button>
  <button class="lw-act" data-k="lw-act">Open</button>
  <button class="lw-act" data-primary="" data-k="lw-act-primary">Ship</button>
  <button class="lw-act" data-hot="" data-k="lw-act-hot">Start</button>
  <button class="lw-filter" aria-pressed="false" data-k="lw-filter">all</button>
  <button class="lw-filter" aria-pressed="true" data-k="lw-filter-on">mine</button>
  <div class="lw-pop lw-filter-pop" data-k="lw-pop"><button data-k="lw-pop-row">One</button></div>
  <div class="fs-rail-f" data-k="fs-rail-f"><button aria-selected="true" data-k="fs-rail-on">All</button><button data-k="fs-rail-off">Late</button></div>
</div>`;

const PROPS = ["height", "min-height", "padding", "border-radius", "font-size", "font-weight", "background-color", "background", "border-color", "border-width", "color", "box-shadow", "gap"] as const;

const dom = new JSDOM(`<!doctype html><html><head><style>${css}</style></head><body>${MARKUP}</body></html>`, { pretendToBeVisual: true });
afterAll(() => dom.window.close());
const doc = dom.window.document;

function resolved(): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const el of doc.querySelectorAll("[data-k]")) {
    const cs = dom.window.getComputedStyle(el);
    out[el.getAttribute("data-k")!] = Object.fromEntries(PROPS.map((p) => [p, cs.getPropertyValue(p)]));
  }
  return out;
}
const setModern = (on: boolean) => doc.documentElement.classList.toggle("modern-style", on);

describe("Ops and Flows controls in Modern", () => {
  test("Classic resolves every control as it did before the Modern rules", () => {
    setModern(false);
    expect(resolved()).toMatchSnapshot();
  });

  test("in Modern the controls resolve to the primitives' tokens", () => {
    setModern(true);
    const r = resolved();
    setModern(false);
    const radius = (k: string) => r[k]["border-radius"];
    for (const k of ["ops-btn", "ops-seg", "ops-chip", "ops-source-chip", "mx-seg", "mx-input", "mx-search", "mx-icon-btn", "mxp-chip", "iss-search", "lw-seg", "lw-chip", "lw-iconbtn", "lw-act", "lw-filter", "lw-pop-row"]) {
      expect(`${k} ${radius(k)}`).toBe(`${k} var(--radius-control)`);
    }
    for (const k of ["ops-btn", "lw-act", "lw-chip", "lw-iconbtn", "mx-input", "mx-search", "iss-search"]) expect(`${k} ${r[k].height}`).toBe(`${k} var(--control-sm)`);
    // The open tab is raised in white on the hairline; the primary act is the accent.
    for (const k of ["ops-seg-on", "mx-seg-on", "lw-seg-on", "iss-lane-on", "rp-tab-on", "fs-rail-on"]) expect(`${k} ${r[k]["background-color"]}`).toBe(`${k} var(--sol-card)`);
    for (const k of ["ops-btn-primary", "lw-act-primary"]) expect(`${k} ${r[k]["background-color"]}`).toBe(`${k} var(--sol-class-cyan)`);
    // On-chips take the accent's soft tint.
    for (const k of ["ops-chip-on", "ops-source-chip-on", "mxp-chip-on", "lw-filter-on"]) expect(`${k} ${r[k].color}`).toBe(`${k} var(--sol-class-cyan)`);
    expect(r["lw-pop"]["border-radius"]).toBe("var(--radius-card)");
    expect(r["lw-pop"]["box-shadow"]).toBe("var(--shadow-popover)");
  });

  test("every Modern rule in these sheets is scoped to .modern-style", () => {
    for (const f of SHEETS) {
      const text = readFileSync(join(WEB, f), "utf8");
      const start = text.indexOf("/* ── Modern");
      if (start < 0) continue;
      const block = text.slice(start).replace(/\/\*[\s\S]*?\*\//g, "");
      const selectors = [...block.matchAll(/(^|})\s*([^{}@]+)\{/g)].map((m) => m[2].trim());
      for (const sel of selectors) for (const part of sel.split(",")) expect(`${f}: ${part.trim()}`).toMatch(/^\S+: \.modern-style /);
    }
  });
});
