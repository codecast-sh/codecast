import { expect, test } from "bun:test";
import { sanitizeCanvasCss } from "./canvasCss";

test("CSS parser blocks escaped URLs, imports, media functions, malformed and custom-property egress", () => {
  for (const css of [
    String.raw`background:u\72l(https://evil.invalid/a)`,
    String.raw`--x:u\72l(https://evil.invalid/a);background:var(--x)`,
    'background:image-set("https://evil.invalid/a" 1x)',
    '--img:"https://evil.invalid/a";background:image-set(var(--img) 1x)',
    'cursor:url(https://evil.invalid/a),auto',
    'background:url("unterminated',
  ]) {
    const clean = sanitizeCanvasCss(css, "declarationList");
    expect(clean).not.toContain("background:image-set");
    expect(clean).not.toContain("url(");
    expect(clean).not.toContain(String.raw`u\72l`);
  }
  expect(sanitizeCanvasCss('@import "https://evil.invalid/a";.x{color:red}')).toBe('.x{color:red}');
});

test("safe gradients, theme variables, keyframes, media queries and local SVG paint survive", () => {
  const css = '.x{--accent:var(--sol-blue);background:linear-gradient(90deg,var(--accent),red);clip-path:url(#local);transform:translateX(1px)}@keyframes pulse{50%{opacity:.5}}@media(max-width:400px){.x{display:grid}}';
  const clean = sanitizeCanvasCss(css);
  for (const fragment of ["--accent:var(--sol-blue)", "linear-gradient", "url(#local)", "@keyframes", "@media"]) expect(clean).toContain(fragment);
});
