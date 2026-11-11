// Calls and chat draw most of their controls from their own stylesheets
// (.rt-*, .faces-*, .call-controls-*, .ch-*), so the Modern style reaches them
// there: under .modern-style each control class points at the primitives'
// tokens (control radius and heights, the segmented tray, the menu row, the
// tooltip and popover surfaces). This loads the real stylesheets into jsdom,
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
  "components/calls/roomThread.css",
  "components/calls/faces.css",
  "components/calls/callVideoPlayer.css",
  "components/chat/chat.css",
];
const css = SHEETS.map((f) => readFileSync(join(WEB, f), "utf8")).join("\n");

const MARKUP = `
<div class="rt">
  <div class="rt-seg" data-k="rt-seg"><button class="rt-seg-btn" aria-checked="true" data-k="rt-seg-on">A</button><button class="rt-seg-btn" aria-checked="false" data-k="rt-seg-off">B</button></div>
  <button class="rt-seg-btn rt-seg-btn-labeled" aria-checked="true" data-k="rt-seg-labeled">Faces</button>
  <button class="rt-btn rt-btn-violet" data-k="rt-btn-violet">Join</button>
</div>
<button class="faces-btn" data-k="faces-btn">Mute</button>
<div class="call-controls-menu" data-k="cc-menu"><button class="call-controls-menu-item" aria-checked="true" data-k="cc-menu-item">1x</button></div>
<button class="call-controls-chip" data-k="cc-chip">CC</button>
<div class="ch">
  <button class="ch-tool" data-k="ch-tool">+</button>
  <button class="ch-round-btn" data-k="ch-round-btn">Reply</button>
  <span class="ch-round-chip" data-k="ch-round-chip">thread</span>
  <div class="ch-menu"><button class="ch-menu-item" data-k="ch-menu-item">Copy</button></div>
  <div class="ch-rail-tip" data-k="ch-rail-tip">General</div>
  <span class="ch-nm-chip" data-k="ch-nm-chip">Ada</span>
  <button class="ch-search-chip" data-k="ch-search-chip">from</button>
  <button class="ch-search-chip ch-search-chip-on" data-k="ch-search-chip-on">in</button>
  <div class="ch-slack-seg" data-k="ch-slack-seg"><button class="ch-slack-seg-item ch-slack-seg-on" data-k="ch-slack-on">All</button><button class="ch-slack-seg-item" data-k="ch-slack-off">Some</button></div>
</div>`;

const PROPS = ["height", "width", "min-height", "padding", "border-radius", "font-size", "font-family", "font-weight", "background-color", "background", "border-color", "color", "box-shadow", "gap"] as const;

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

describe("calls and chat controls in Modern", () => {
  test("Classic resolves every control as it did before the Modern rules", () => {
    setModern(false);
    expect(resolved()).toMatchSnapshot();
  });

  test("in Modern the controls resolve to the primitives' tokens", () => {
    setModern(true);
    const r = resolved();
    setModern(false);
    for (const k of ["rt-seg", "rt-btn-violet", "faces-btn", "cc-chip", "cc-menu-item", "ch-tool", "ch-round-btn", "ch-round-chip", "ch-menu-item", "ch-rail-tip", "ch-nm-chip", "ch-search-chip", "ch-slack-seg"]) {
      expect(`${k} ${r[k]["border-radius"]}`).toBe(`${k} var(--radius-control)`);
    }
    expect(r["cc-menu"]["border-radius"]).toBe("var(--radius-card)");
    for (const k of ["rt-seg-on", "ch-slack-on"]) expect(`${k} ${r[k]["background-color"]}`).toBe(`${k} var(--sol-card)`);
    expect(r["ch-search-chip-on"].color).toBe("var(--sol-class-cyan)");
    expect(r["ch-menu-item"]["min-height"]).toBe("var(--control-sm)");
    expect(r["ch-rail-tip"]["box-shadow"]).toBe("var(--shadow-popover)");
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
