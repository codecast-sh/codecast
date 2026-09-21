import { afterAll, beforeAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { sanitizeCanvasHtml } from "../../canvasSanitize";
import { hydrateCharts } from "../../castChart";

const previousWindow = globalThis.window;
const previousCustomEvent = globalThis.CustomEvent;
let dom: JSDOM;
beforeAll(() => {
  dom = new JSDOM("", { url: "https://codecast.sh" });
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.CustomEvent = dom.window.CustomEvent as typeof CustomEvent;
});
afterAll(() => {
  globalThis.window = previousWindow;
  globalThis.CustomEvent = previousCustomEvent;
  dom.window.close();
});

async function render(spec: unknown) {
  const root = dom.window.document.createElement("div");
  const placeholder = dom.window.document.createElement("div");
  placeholder.className = "cast-chart";
  placeholder.setAttribute("data-spec", JSON.stringify(spec));
  root.innerHTML = sanitizeCanvasHtml(placeholder.outerHTML);
  await hydrateCharts(root, 400);
  expect(root.textContent).not.toContain("⚠");
  return root;
}

test("actual sanitizer and Plot pipeline strips per-row script links and keeps safe SVG links", async () => {
  const root = await render({ marks: [{ type: "dot", data: [
    { x: 1, url: "javascript:window.__chartExecuted=1" },
    { x: 2, url: "https://example.com/chart" },
    { x: 3, url: "data:text/html,unsafe" },
    { x: 4, url: "/tasks/ct-1" },
  ], x: "x", href: "url", target: "_self" }] });
  const links = [...root.querySelectorAll("a[href]")];
  expect(links.map(a => a.getAttribute("href"))).toEqual(["https://example.com/chart", "/tasks/ct-1"]);
  for (const link of links) {
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  }
  expect(root.querySelector("[xlink\\:href]")).toBeNull();
  expect(root.querySelectorAll("circle")).toHaveLength(4);
});

test("per-row and constant image channels obey the image policy before insertion", async () => {
  const root = await render({ marks: [
    { type: "image", data: [{ x: 1, src: "https://forbidden.invalid/row.png" }, { x: 2, src: "data:image/png;base64,iVBOR" }], x: "x", y: 0, src: "src" },
    { type: "image", data: [1], x: 1, y: 0, src: "https://forbidden.invalid/constant.png" },
  ] });
  expect(root.querySelectorAll("image")).toHaveLength(1);
  expect(root.querySelector("image")?.getAttribute("href")).toStartWith("data:image/png");
  expect(root.querySelector("svg")?.outerHTML).not.toContain("forbidden.invalid");
});

test("transforms, legends, bars and safe ordinary links survive the full pipeline", async () => {
  const root = await render({ color: { legend: true }, marks: [{ type: "barY", data: [{ label: "A", n: 2 }, { label: "B", n: 3 }], x: "label", y: "n", fill: "label", transform: { kind: "groupX", out: { y: "sum" } } }] });
  expect(root.querySelector("svg")).not.toBeNull();
  expect(root.querySelectorAll("rect").length).toBeGreaterThanOrEqual(2);
  expect(sanitizeCanvasHtml('<a href="https://example.com">Ordinary</a>')).toContain('rel="noopener noreferrer"');
});

test("non-mark Plot exports cannot be selected", async () => {
  const root = dom.window.document.createElement("div");
  root.innerHTML = '<div class="cast-chart" data-spec=\'{"marks":[{"type":"plot"}]}\'></div>';
  await hydrateCharts(root, 400);
  expect(root.textContent).toContain('unknown mark "plot"');
});

test("pointer-generated tips and crosshairs stay sanitized after hydration", async () => {
  const root = await render({ marks: [
    { type: "dot", data: [{ x: 1, y: 1, url: "javascript:window.__chartExecuted=1" }], x: "x", y: "y", href: "url", tip: { href: "url", pathFilter: "url(https://forbidden.invalid/filter)" } },
    { type: "crosshair", data: [{ x: 1, y: 1, paint: "url(https://forbidden.invalid/paint)", url: "javascript:window.__chartExecuted=1" }], x: "x", y: "y", ruleStroke: "paint", channels: { href: "url" } },
  ] });
  const svg = root.querySelector("svg")!;
  const dot = svg.querySelector("circle")!;
  svg.dispatchEvent(new dom.window.MouseEvent("pointermove", { clientX: Number(dot.getAttribute("cx")), clientY: Number(dot.getAttribute("cy")), bubbles: true }));
  expect(svg.querySelector('[aria-label="tip"]')?.textContent).toContain("1");
  expect(svg.outerHTML).not.toContain("javascript:");
  expect(svg.outerHTML).not.toContain("forbidden.invalid");
  expect(svg.querySelectorAll('g[aria-label^="crosshair"] line').length).toBeGreaterThan(0);
});
