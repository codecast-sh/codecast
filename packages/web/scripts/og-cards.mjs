/**
 * Social card images for the marketing routes: one 1200x630 PNG per SEO route
 * in the site's Solarized-light palette, each in one accent color with the
 * one-color codecast mark. A route with a picture (a feature page's hero,
 * captured by scripts/capture-og-art.ts into scripts/og-art; a blog cover; the
 * landing hero) shows it on a panel of that color beside its name; any other
 * route sets its heading large beside the mark, drawn huge in that color.
 * Called by scripts/prerender.mjs, which points og:image at each card it
 * managed to write (lib/seoRoutes.ts cardImagePath).
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
  ["/blog/", "blog"],
  ["/documentation/", "docs"],
  ["/compare/", "compare"],
  ["/features/", "feature"],
];

function sectionOf(path) {
  return SECTIONS.find(([prefix]) => path.startsWith(prefix))?.[1] ?? null;
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

/** The one-color codecast mark, `width` wide. */
function markSvg(mark, width, color) {
  const [, , w, hgt] = mark.viewBox.split(" ").map(Number);
  return {
    type: "svg",
    props: {
      width,
      height: Math.round((width * hgt) / w),
      viewBox: mark.viewBox,
      fill: color,
      children: mark.paths.map((d) => ({ type: "path", props: { d } })),
    },
  };
}

function brand(mark) {
  return h(
    "div",
    { display: "flex", alignItems: "center", gap: 14 },
    markSvg(mark, 40, SOL.base03),
    h("div", { fontSize: 30, fontWeight: 700, color: SOL.base03, letterSpacing: "-0.02em" }, "codecast"),
  );
}

function chip(label, color) {
  return h(
    "div",
    { display: "flex", alignItems: "center", gap: 10, fontSize: 20, fontWeight: 700, color: shade(color, 0.15), padding: "5px 14px 5px 10px", borderRadius: 8, backgroundColor: tint(color, 0.16) },
    h("div", { width: 12, height: 12, borderRadius: 3, backgroundColor: color }),
    label,
  );
}

/** The page address as a dark key, the way the site's buttons look. */
function urlKey(path, color, maxWidth) {
  return h(
    "div",
    { display: "flex", alignItems: "center", gap: 12, maxWidth, fontSize: 20, color: SOL.base3, backgroundColor: SOL.base03, padding: "10px 18px", borderRadius: 10, boxShadow: `0 4px 0 ${shade(SOL.base03, 0.5)}` },
    h("div", { display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, `codecast.sh${path === "/" ? "" : path}`),
    h("div", { color, flexShrink: 0 }, "→"),
  );
}

/** A route with a picture: words on the left, the picture on a panel in the route's color. */
function artCard({ path, heading, mark, art, color, section }) {
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
    h("div", { position: "absolute", left: PANEL_X, top: 0, width: CARD_WIDTH - PANEL_X, height: CARD_HEIGHT, backgroundColor: color }),
    h(
      "div",
      { position: "absolute", left: FRAME.left, top, width: FRAME.width, height: fitHeight, display: "flex", borderRadius: 14, overflow: "hidden", border: `3px solid ${SOL.base03}`, boxShadow: `16px 16px 0 ${SOL.base03}`, backgroundColor: SOL.base3 },
      { type: "img", props: { src: art.src, width: FRAME.width, height: fitHeight, style: { objectFit: "cover" } } },
    ),
    h(
      "div",
      { position: "absolute", left: 0, top: 0, width: PANEL_X, height: CARD_HEIGHT, display: "flex", flexDirection: "column", padding: "48px 40px 44px 56px" },
      brand(mark),
      h(
        "div",
        { display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center", gap: 18 },
        section ? h("div", { display: "flex" }, chip(section, color)) : h("div", { display: "flex" }),
        h("div", { display: "block", fontSize: rest || name.length <= 16 ? Math.max(44, Math.min(96, Math.floor(388 / (name.length * 0.62)))) : sizeFor(name, [[30, 48], [50, 42], [70, 37], [999, 33]]), fontWeight: 700, color: SOL.base03, lineHeight: 1.08, letterSpacing: "-0.03em", lineClamp: rest ? 2 : 6 }, name),
        rest ? h("div", { display: "block", fontSize: sizeFor(rest, [[34, 32], [52, 28], [999, 25]]), fontWeight: 700, color: shade(color, 0.3), lineHeight: 1.25, lineClamp: 4 }, rest) : null,
      ),
      h("div", { display: "flex" }, urlKey(path, color, PANEL_X - 96)),
    ),
  );
}

/** "Codecast vs Paradev (formerly Superset)" -> { rival: "Paradev", aside: "formerly Superset" }. */
function rivalOf(heading) {
  const m = heading.match(/^Codecast vs (.+?)(?: \((.+)\))?$/);
  return m && { rival: m[1], aside: m[2] ?? null };
}

/**
 * A route with no picture: the heading set large beside the mark, drawn huge
 * in the route's color over an offset print of itself, running off the edge.
 */
function textCard({ path, heading, description, mark, color, section }) {
  const vs = rivalOf(heading);
  const MARK = { left: 752, top: 92, width: 600 };
  const { name, rest } = splitHeading(heading);
  const words = vs
    ? h(
        "div",
        { display: "flex", flexDirection: "column", gap: 6 },
        h("div", { display: "flex", alignItems: "center", gap: 22 },
          h("div", { fontSize: 64, fontWeight: 700, color: SOL.base03, letterSpacing: "-0.04em" }, "Codecast"),
          h("div", { fontSize: 30, fontWeight: 700, color: SOL.base3, backgroundColor: color, padding: "2px 16px 6px", borderRadius: 10 }, "vs"),
        ),
        h("div", { display: "block", fontSize: sizeFor(vs.rival, [[10, 92], [16, 76], [24, 60], [999, 50]]), fontWeight: 700, color: shade(color, 0.2), letterSpacing: "-0.04em", lineHeight: 1.05, lineClamp: 2 }, vs.rival),
        vs.aside ? h("div", { fontSize: 24, color: SOL.base01, marginTop: 6 }, vs.aside) : null,
      )
    : h(
        "div",
        { display: "flex", flexDirection: "column", gap: 14 },
        h("div", { display: "block", fontSize: sizeFor(name, [[12, 100], [22, 80], [34, 66], [48, 56], [999, 48]]), fontWeight: 700, color: SOL.base03, lineHeight: 1.04, letterSpacing: "-0.04em", lineClamp: 4 }, name),
        rest ? h("div", { display: "block", fontSize: sizeFor(rest, [[30, 38], [50, 32], [999, 28]]), fontWeight: 700, color: shade(color, 0.2), lineHeight: 1.2, letterSpacing: "-0.02em", lineClamp: 2 }, rest) : null,
      );
  return h(
    "div",
    { width: CARD_WIDTH, height: CARD_HEIGHT, display: "flex", position: "relative", backgroundColor: SOL.base3, fontFamily: "JetBrains Mono", ...GRID },
    h("div", { position: "absolute", left: MARK.left + 18, top: MARK.top + 18, display: "flex" }, markSvg(mark, MARK.width, SOL.base03)),
    h("div", { position: "absolute", left: MARK.left, top: MARK.top, display: "flex" }, markSvg(mark, MARK.width, color)),
    h(
      "div",
      { position: "absolute", left: 0, top: 0, width: CARD_WIDTH, height: CARD_HEIGHT, display: "flex", flexDirection: "column", padding: "52px 64px 52px 64px" },
      brand(mark),
      h(
        "div",
        { display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center", gap: 22, maxWidth: 640 },
        section ? h("div", { display: "flex" }, chip(section, color)) : null,
        words,
        vs || rest || name.length > 40 ? null : h("div", { display: "block", fontSize: 23, color: SOL.base01, lineHeight: 1.45, lineClamp: 2 }, description),
      ),
      h("div", { display: "flex" }, urlKey(path, color, 620)),
    ),
  );
}

/** A text card's color when the route names none: one Solarized accent per path, so neighbours differ. */
const ACCENTS = ["blue", "violet", "magenta", "orange", "cyan", "red", "green", "yellow"];
function accentFor(path) {
  let n = 0;
  for (const c of path) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return SOL[ACCENTS[n % ACCENTS.length]];
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
export async function renderCards({ entries, cardHeading, cardImagePath, outDir, mark }) {
  wasmReady ??= initWasm(readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm")));
  await wasmReady;
  const fonts = [400, 700].map((weight) => ({
    name: "JetBrains Mono",
    weight,
    style: "normal",
    data: readFileSync(join(HERE, "og-fonts", `JetBrainsMono-${weight}.ttf`)),
  }));
  const written = new Set();
  for (const entry of entries) {
    try {
      const svg = await satori(
        card({
          path: entry.path,
          heading: cardHeading(entry),
          description: entry.description,
          mark,
          art: loadArt(entry.card?.art),
          section: sectionOf(entry.path),
          color: SOL[entry.card?.color] ?? entry.card?.color ?? accentFor(entry.path),
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
