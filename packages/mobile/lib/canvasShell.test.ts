import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCanvasShell } from "./canvasShell";
import { CANVAS_POLICY_SOURCE } from "./vendor/canvasPolicySource";

test("mobile WebView document uses the shared sanitizer and keeps tabs, tables and local SVG", () => {
  const html = buildCanvasShell(String.raw`<style>@import "https://evil.invalid/a";.x{--a:u\72l(https://evil.invalid/a);color:red}</style><script>window.__executed=1</script><video src="https://evil.invalid/video" poster="https://evil.invalid/poster"></video><div class="cast-tabs"><section data-tab="One">one</section><section data-tab="Two">two</section></div><table class="cast-table"><thead><tr><th>N</th></tr></thead><tbody><tr><td>2</td></tr><tr><td>1</td></tr></tbody></table><svg><defs><path id="p" /></defs><use href="#p" /></svg><div class="cast-chart"></div>`, "--sol-text:#111", "https://convex.test");
  const script = `
    const {JSDOM}=require(${JSON.stringify(new URL("../../web/node_modules/jsdom/lib/api.js", import.meta.url).pathname)});
    const html=require('node:fs').readFileSync(process.argv[1],'utf8');
    const dom=new JSDOM(html,{runScripts:'dangerously',url:'https://canvas.test'});
    const d=dom.window.document,root=d.querySelector('#root');
    root.querySelectorAll('.cast-tabs-bar button')[1].click();
    root.querySelector('th').click();
    require("node:fs").writeFileSync(process.argv[2], JSON.stringify({html:root.innerHTML,marker:dom.window.__executed??null,secondHidden:root.querySelectorAll('section')[1].hidden,firstCell:root.querySelector('tbody td').textContent,svg:root.querySelector('use').getAttribute('href'),chart:root.querySelector('.cast-chart').textContent,policy:d.querySelector('meta[http-equiv="Content-Security-Policy"]').content,nonces:[...d.querySelectorAll('script[nonce]')].map(s=>s.nonce)}));
    dom.window.close();
  `;
  const directory = mkdtempSync(join(tmpdir(), "canvas-shell-test-"));
  let result: any;
  try {
    const input = join(directory, "shell.html");
    writeFileSync(input, html);
    const output = join(directory, "result.json");
    const run = Bun.spawnSync({ cmd: ["node", "-e", script, input, output], stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 25_000 });
    expect({ exitCode: run.exitCode, stderr: run.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
    result = JSON.parse(readFileSync(output, "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  expect(result.html).not.toContain("evil.invalid");
  expect(result.marker).toBeNull();
  expect(result.svg).toBe("#p");
  expect(result.secondHidden).toBe(false);
  expect(result.firstCell).toBe("1");
  expect(result.chart).toContain("view on web");
  expect(result.policy).toContain("default-src 'none'");
  expect(result.policy).toContain("connect-src 'none'");
  const nonce = result.policy.match(/'nonce-([^']+)'/)![1];
  expect(nonce.length).toBeGreaterThan(20);
  expect(result.nonces).toEqual([nonce, nonce]);
}, 30_000);

test("mobile policy bundle is generated from the current shared sanitizer", async () => {
  const build = await Bun.build({ entrypoints: [new URL("./vendor/canvasPolicy.entry.ts", import.meta.url).pathname], target: "browser", minify: true });
  expect(build.success).toBe(true);
  expect(await build.outputs[0].text()).toBe(CANVAS_POLICY_SOURCE);
}, 30_000);
