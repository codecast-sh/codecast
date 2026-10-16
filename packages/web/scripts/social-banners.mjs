// Social banners in the site's own card style: satori + resvg, JetBrains Mono, Solarized light.
import { readFileSync, writeFileSync } from "node:fs";
import satori from "satori";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
const WEB = "/Users/ashot/src/codecast/packages/web";
const font400 = readFileSync(`${WEB}/scripts/og-fonts/JetBrainsMono-400.ttf`);
const font700 = readFileSync(`${WEB}/scripts/og-fonts/JetBrainsMono-700.ttf`);
const logo = `data:image/png;base64,${readFileSync(`${WEB}/public/logo-final.png`).toString("base64")}`;
await initWasm(readFileSync(`${WEB}/node_modules/@resvg/resvg-wasm/index_bg.wasm`));
const SOL = { base03: "#002b36", base02: "#073642", base01: "#586e75", base00: "#657b83", base1: "#93a1a1", base2: "#eee8d5", base3: "#fdf6e3", red: "#dc322f", yellow: "#b58900", green: "#859900", coral: "#e86c5d" };
const h = (type, props, ...children) => ({ type, props: { ...props, children: children.length === 1 ? children[0] : children } });
function banner(W, H, { safeTop = 0, safeLeft = 0 } = {}) {
  const s = H / 500;
  const pad = Math.round(72 * s);
  return h("div", { style: { width: W, height: H, display: "flex", background: SOL.base3, fontFamily: "JetBrains Mono", position: "relative" } },
    h("div", { style: { position: "absolute", left: 0, top: 0, width: W, height: Math.round(8 * s), background: SOL.coral, display: "flex" } }),
    h("div", { style: { display: "flex", flexDirection: "column", justifyContent: "center", paddingLeft: pad + safeLeft, paddingTop: safeTop, width: W * 0.64 } },
      h("div", { style: { display: "flex", alignItems: "center", gap: Math.round(18 * s) } },
        h("img", { src: logo, width: Math.round(64 * s), height: Math.round(64 * s), style: { borderRadius: Math.round(14 * s) } }),
        h("div", { style: { fontSize: Math.round(44 * s), fontWeight: 700, color: SOL.base03, letterSpacing: -1 } }, "codecast")),
      h("div", { style: { marginTop: Math.round(26 * s), fontSize: Math.round(34 * s), fontWeight: 700, color: SOL.base03, lineHeight: 1.25, display: "flex" } },
        "The workspace for teams and their AI coding agents."),
      h("div", { style: { marginTop: Math.round(16 * s), fontSize: Math.round(20 * s), color: SOL.base00, lineHeight: 1.5, display: "flex" } },
        "See, steer and remember every session. Claude Code, Codex, Cursor and Gemini, any machine.")),
    h("div", { style: { position: "absolute", right: pad, top: Math.round(H * 0.22), width: Math.round(W * 0.27), display: "flex", flexDirection: "column", background: SOL.base03, borderRadius: Math.round(14 * s), padding: Math.round(22 * s), border: `${Math.round(2 * s)}px solid #094959` } },
      h("div", { style: { display: "flex", gap: Math.round(8 * s), marginBottom: Math.round(16 * s) } },
        ...[SOL.red, SOL.yellow, SOL.green].map(c => h("div", { style: { width: Math.round(12 * s), height: Math.round(12 * s), borderRadius: 99, background: c, display: "flex" } }))),
      ...[["$ cast sessions", SOL.base2], ["needs input 3 · working 5", SOL.yellow], ["● jx7a9fd  Inbox redesign", SOL.base1], ["● jx7c9d2  SEO root cause", SOL.base1], ["$ cast blame src/auth.ts", SOL.base2], ["L42  jx7cfw7  Claude Code", SOL.green]]
        .map(([t, c]) => h("div", { style: { fontSize: Math.round(17 * s), color: c, lineHeight: 1.6, display: "flex" } }, t))));
}
const sizes = { x: [1500, 500, {}], linkedin: [1584, 396, { safeLeft: 180 }], bluesky: [3000, 1000, {}] };
for (const [name, [W, H, opts]] of Object.entries(sizes)) {
  const svg = await satori(banner(W, H, opts), { width: W, height: H, fonts: [{ name: "JetBrains Mono", data: font400, weight: 400 }, { name: "JetBrains Mono", data: font700, weight: 700 }] });
  writeFileSync(`public/brand/banner-${name}.png`, new Resvg(svg, { fitTo: { mode: "width", value: W } }).render().asPng());
  console.log("wrote", name, W, H);
}
