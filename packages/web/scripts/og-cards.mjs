/**
 * Social card images for the marketing routes: one 1200x630 PNG per SEO route,
 * drawn from the route's own heading and description in the site's
 * Solarized-light palette, with the landing page's terminal motif carrying the
 * page URL. Called by scripts/prerender.mjs, which points og:image at each
 * card it managed to write (lib/seoRoutes.ts cardImagePath).
 *
 * satori lays the card out to SVG and resvg rasterises it (wasm, so the build
 * needs no native binary). Fonts are committed static TTFs of JetBrains Mono,
 * the marketing site's heading face (scripts/og-fonts, SIL OFL).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import satori from "satori";
import { initWasm, Resvg } from "@resvg/resvg-wasm";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

// Same values as SOL in app/(marketing)/blog/blogChrome.tsx.
const SOL = {
  base03: "#002b36",
  base02: "#073642",
  base01: "#586e75",
  base00: "#657b83",
  base0: "#839496",
  base2: "#eee8d5",
  base3: "#fdf6e3",
  red: "#dc322f",
  yellow: "#b58900",
  green: "#859900",
};

const SECTIONS = [
  ["/blog/", "blog"],
  ["/documentation/", "docs"],
  ["/compare/", "compare"],
];

function sectionOf(path) {
  return SECTIONS.find(([prefix]) => path.startsWith(prefix))?.[1] ?? null;
}

function headingSize(heading) {
  if (heading.length <= 26) return 68;
  if (heading.length <= 44) return 58;
  if (heading.length <= 70) return 50;
  return 44;
}

const h = (type, style, ...children) => ({
  type,
  props: { style, ...(children.length > 0 && { children: children.length === 1 ? children[0] : children }) },
});

function card({ path, heading, description, logo }) {
  const section = sectionOf(path);
  const dot = (backgroundColor) => h("div", { width: 14, height: 14, borderRadius: 7, backgroundColor });
  return h(
    "div",
    {
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      display: "flex",
      flexDirection: "column",
      backgroundColor: SOL.base3,
      padding: "52px 64px 56px",
      fontFamily: "JetBrains Mono",
    },
    h(
      "div",
      { display: "flex", alignItems: "center", justifyContent: "space-between" },
      h(
        "div",
        { display: "flex", alignItems: "center", gap: 16 },
        { type: "img", props: { src: logo, width: 56, height: 56, style: { borderRadius: 12 } } },
        h("div", { fontSize: 30, fontWeight: 700, color: SOL.base03 }, "codecast"),
      ),
      section ? h("div", { fontSize: 24, color: SOL.base01, padding: "6px 16px", borderRadius: 8, backgroundColor: SOL.base2 }, section) : h("div", {}),
    ),
    h(
      "div",
      { display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center", gap: 22 },
      h("div", { display: "block", fontSize: headingSize(heading), fontWeight: 700, color: SOL.base03, lineHeight: 1.15, letterSpacing: "-0.02em", lineClamp: 3 }, heading),
      h("div", { display: "block", fontSize: 25, color: SOL.base00, lineHeight: 1.45, lineClamp: 3 }, description),
    ),
    h(
      "div",
      { display: "flex", alignItems: "center", gap: 22, backgroundColor: SOL.base03, borderRadius: 14, padding: "18px 26px" },
      h("div", { display: "flex", gap: 9 }, dot(SOL.red), dot(SOL.yellow), dot(SOL.green)),
      h(
        "div",
        { display: "flex", fontSize: 24 },
        h("span", { color: SOL.green }, "$"),
        h("span", { color: SOL.base0, marginLeft: 14 }, `open codecast.sh${path === "/" ? "" : path}`),
      ),
    ),
  );
}

/**
 * Writes <outDir><cardImagePath(path)> for every entry and returns the set of
 * paths that got a card. A route whose card fails keeps the site default image.
 */
export async function renderCards({ entries, cardHeading, cardImagePath, outDir, logoPath }) {
  await initWasm(readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm")));
  const fonts = [400, 700].map((weight) => ({
    name: "JetBrains Mono",
    weight,
    style: "normal",
    data: readFileSync(join(HERE, "og-fonts", `JetBrainsMono-${weight}.ttf`)),
  }));
  const logo = `data:image/png;base64,${readFileSync(logoPath).toString("base64")}`;
  const written = new Set();
  for (const entry of entries) {
    try {
      const svg = await satori(
        card({ path: entry.path, heading: cardHeading(entry), description: entry.description, logo }),
        { width: CARD_WIDTH, height: CARD_HEIGHT, fonts },
      );
      const png = new Resvg(svg, { fitTo: { mode: "width", value: CARD_WIDTH } }).render().asPng();
      const file = join(outDir, ...cardImagePath(entry.path).split("/").filter(Boolean));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, png);
      written.add(entry.path);
    } catch (err) {
      console.error(`social card FAILED for ${entry.path} (it keeps the default image):`, err?.message ?? err);
    }
  }
  return written;
}
