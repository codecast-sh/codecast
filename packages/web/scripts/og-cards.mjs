/**
 * Social card images for the marketing routes: one 1200x630 PNG per SEO route,
 * in the site's Solarized-light palette. A route with a picture (a feature
 * page's hero, captured by scripts/capture-og-art.ts into scripts/og-art; a
 * blog post's cover; the landing hero) shows it on a panel in the route's
 * color beside its name; any other route gets its heading set large. Called by scripts/prerender.mjs, which points og:image at each
 * card it managed to write (lib/seoRoutes.ts cardImagePath).
 *
 * satori lays the card out to SVG and resvg rasterises it (wasm, so the build
 * needs no native binary). Fonts are committed static TTFs of JetBrains Mono,
 * the marketing site's heading face (scripts/og-fonts, SIL OFL).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  orange: "#cb4b16",
  magenta: "#d33682",
  violet: "#6c71c4",
  blue: "#268bd2",
  cyan: "#2aa198",
  green: "#859900",
};

const SECTIONS = [
  ["/blog/", "blog", "#cb4b16"],
  ["/documentation/", "docs", "#268bd2"],
  ["/compare/", "compare", "#2aa198"],
  ["/features/", "feature", "#6c71c4"],
];

function sectionOf(path) {
  const hit = SECTIONS.find(([prefix]) => path.startsWith(prefix));
  return hit ? { label: hit[1], color: hit[2] } : null;
}

/** `color` mixed with `into` at `amount` of `color` (0..1); satori has no color-mix. */
function mix(color, into, amount) {
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [a, b] = [rgb(color), rgb(into)];
  return `rgb(${a.map((v, i) => Math.round(v * amount + b[i] * (1 - amount))).join(",")})`;
}
/** A wash of `color` on the paper. */
const tint = (color, amount) => mix(color, SOL.base3, amount);
/** `color` darkened toward base03, for text on paper. */
const shade = (color, amount) => mix(color, SOL.base03, 1 - amount);

/** Pixel size of a PNG or JPEG, read from its header. */
function imageSize(buf) {
  if (buf.subarray(1, 4).toString() === "PNG") return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  for (let i = 2; i < buf.length; ) {
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error("not a PNG or JPEG");
}

/** Loads a route's card picture, or null when it has none (or none captured yet). */
function loadArt(rel) {
  if (!rel || !/\.(png|jpe?g)$/i.test(rel)) return null;
  const file = join(HERE, "..", rel);
  if (!existsSync(file)) return null;
  const buf = readFileSync(file);
  const mime = buf.subarray(1, 4).toString() === "PNG" ? "image/png" : "image/jpeg";
  return { src: `data:${mime};base64,${buf.toString("base64")}`, ...imageSize(buf) };
}

/** "Org: an org chart your agents work inside" -> name "Org", rest "An org chart…". */
function splitHeading(heading) {
  const at = heading.indexOf(": ");
  if (at <= 0 || at > 24) return { name: heading, rest: null };
  const rest = heading.slice(at + 2);
  return { name: heading.slice(0, at), rest: rest.charAt(0).toUpperCase() + rest.slice(1) };
}

function sizeFor(text, steps) {
  return (steps.find(([max]) => text.length <= max) ?? steps[steps.length - 1])[1];
}

const h = (type, style, ...all) => {
  const children = all.filter((c) => c != null);
  return { type, props: { style, ...(children.length > 0 && { children: children.length === 1 ? children[0] : children }) } };
};

const GRID = {
  backgroundImage: `linear-gradient(${SOL.base2} 1px, transparent 1px), linear-gradient(90deg, ${SOL.base2} 1px, transparent 1px)`,
  backgroundSize: "36px 36px",
};

function brand(logo) {
  return h(
    "div",
    { display: "flex", alignItems: "center", gap: 14 },
    { type: "img", props: { src: logo, width: 44, height: 44, style: { borderRadius: 10 } } },
    h("div", { fontSize: 26, fontWeight: 700, color: SOL.base03 }, "codecast"),
  );
}

function chip(label, color) {
  return h(
    "div",
    { display: "flex", alignItems: "center", gap: 10, fontSize: 20, color, padding: "5px 14px 5px 10px", borderRadius: 8, backgroundColor: tint(color, 0.12) },
    h("div", { width: 12, height: 12, borderRadius: 3, backgroundColor: color }),
    label,
  );
}

const urlOf = (path) => `codecast.sh${path === "/" ? "" : path}`;

/** A route with a picture: words on the left, the picture on a panel in the route's color. */
function artCard({ path, heading, logo, art, color, section }) {
  const { name, rest } = splitHeading(heading);
  const PANEL_X = 486;
  // A wide picture grows past the right edge so its detail stays legible.
  const ratio = art.width / art.height;
  const FRAME = { left: PANEL_X + 46, top: 58, width: Math.round(Math.max(760, Math.min(960, 440 * ratio))) };
  const fitHeight = Math.round(FRAME.width / ratio);
  const room = CARD_HEIGHT - FRAME.top;
  // A short picture sits centred on the panel; a tall one runs off the bottom edge.
  const top = fitHeight < room - 40 ? Math.round((CARD_HEIGHT - fitHeight) / 2) : FRAME.top;
  return h(
    "div",
    { width: CARD_WIDTH, height: CARD_HEIGHT, display: "flex", position: "relative", backgroundColor: SOL.base3, fontFamily: "JetBrains Mono", ...GRID },
    h("div", { position: "absolute", left: PANEL_X, top: 0, width: CARD_WIDTH - PANEL_X, height: CARD_HEIGHT, backgroundColor: tint(color, 0.2), borderLeft: `3px solid ${color}` }),
    h(
      "div",
      { position: "absolute", left: FRAME.left, top, width: FRAME.width, height: fitHeight, display: "flex", borderRadius: 14, overflow: "hidden", border: `1px solid ${tint(color, 0.45)}`, boxShadow: `0 24px 48px -20px ${tint(SOL.base03, 0.55)}`, backgroundColor: SOL.base3 },
      { type: "img", props: { src: art.src, width: FRAME.width, height: fitHeight, style: { objectFit: "cover" } } },
    ),
    h(
      "div",
      { position: "absolute", left: 0, top: 0, width: PANEL_X, height: CARD_HEIGHT, display: "flex", flexDirection: "column", padding: "48px 40px 44px 56px" },
      brand(logo),
      h(
        "div",
        { display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center", gap: 18 },
        section ? h("div", { display: "flex" }, chip(section.label, color)) : h("div", { display: "flex" }),
        h("div", { display: "block", fontSize: rest || name.length <= 16 ? Math.max(44, Math.min(96, Math.floor(388 / (name.length * 0.62)))) : sizeFor(name, [[44, 42], [70, 36], [999, 31]]), fontWeight: 700, color: SOL.base03, lineHeight: 1.08, letterSpacing: "-0.03em", lineClamp: rest ? 2 : 6 }, name),
        rest ? h("div", { display: "block", fontSize: sizeFor(rest, [[34, 32], [52, 28], [999, 25]]), fontWeight: 700, color: shade(color, 0.3), lineHeight: 1.25, lineClamp: 4 }, rest) : null,
      ),
      h("div", { display: "block", fontSize: 19, color: SOL.base01, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, urlOf(path)),
    ),
  );
}

/** A route with no picture: the heading set large on grid paper. */
function textCard({ path, heading, description, logo, color, section }) {
  return h(
    "div",
    { width: CARD_WIDTH, height: CARD_HEIGHT, display: "flex", flexDirection: "column", backgroundColor: SOL.base3, padding: "48px 64px 48px 64px", fontFamily: "JetBrains Mono", borderLeft: `14px solid ${color}`, ...GRID },
    h("div", { display: "flex", alignItems: "center", justifyContent: "space-between" }, brand(logo), section ? chip(section.label, color) : h("div", {})),
    h(
      "div",
      { display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center", gap: 24 },
      h("div", { display: "block", fontSize: sizeFor(heading, [[26, 72], [44, 62], [70, 52], [999, 44]]), fontWeight: 700, color: SOL.base03, lineHeight: 1.1, letterSpacing: "-0.03em", lineClamp: 3 }, heading),
      h("div", { display: "block", fontSize: 25, color: SOL.base01, lineHeight: 1.45, lineClamp: 3, maxWidth: 1000 }, description),
    ),
    h("div", { display: "flex", fontSize: 21, color }, urlOf(path)),
  );
}

function card(props) {
  return props.art ? artCard(props) : textCard(props);
}

/** resvg's wasm may be initialized once per process. */
let wasmReady = null;

/**
 * Writes <outDir><cardImagePath(path)> for every entry and returns the set of
 * paths that got a card. A route whose card fails keeps the site default image.
 */
export async function renderCards({ entries, cardHeading, cardImagePath, outDir, logoPath }) {
  wasmReady ??= initWasm(readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm")));
  await wasmReady;
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
        card({
          path: entry.path,
          heading: cardHeading(entry),
          description: entry.description,
          logo,
          art: loadArt(entry.card?.art),
          section: sectionOf(entry.path),
          color: SOL[entry.card?.color] ?? entry.card?.color ?? sectionOf(entry.path)?.color ?? SOL.cyan,
        }),
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
