// Export a board (or a selection) as SVG or PNG. The picture is drawn from the
// elements, not screenshotted from the page, so it is whole at any size and
// leaves out the chrome: no grid, handles, cursors or toolbars. Theme colors
// are resolved from the live page, so an export matches the theme it was
// made in. Illustrations and images are inlined as data URLs: an SVG drawn
// into a canvas loads nothing from the network.
import {
  boardArtFor,
  connectorGeometry,
  elbowObstacles,
  elementBounds,
  elementBox,
  shapeOutline,
  smoothPath,
  stickyLayout,
  unflatten,
  unionBox,
  type Box,
} from "@codecast/shared/artifacts/board";
import { BOARD_ART_URLS } from "./boardArtUrls";
import { wrapRuns, type Run } from "./boardMarks";
import { colorToken, stickyFill, tint } from "./boardColors";
import { drawOrder } from "./boardFrame";
import type { BoardEl } from "./boardTypes";

const PAD = 40;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A CSS color value (a var(), a color-mix) as the page computes it right now. */
function resolver(root: HTMLElement): (css: string) => string {
  const probe = document.createElement("span");
  probe.style.display = "none";
  root.appendChild(probe);
  const cache = new Map<string, string>();
  return (css: string) => {
    if (css === "transparent") return css;
    let v = cache.get(css);
    if (v === undefined) {
      probe.style.color = "";
      probe.style.color = css;
      v = getComputedStyle(probe).color || css;
      cache.set(css, v);
    }
    return v;
  };
}

async function dataUrl(url: string): Promise<string | null> {
  try {
    const blob = await (await fetch(url)).blob();
    return await new Promise((ok) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result));
      r.onerror = () => ok(null);
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

type Line = Run[];
/** `titleLines`: how many leading lines are a sticky's title (bold); the lines after it are its body (muted). */
type BlockOpts = { color: string; link: string; anchor?: "start" | "middle" | "end"; titleLines?: number; weight?: number; listX?: number };

/** One run as an SVG span: bold, italic, struck, or a link (underlined, in the link color, clickable in a viewer). */
function span(r: Run, link: string): string {
  const attrs = [r.b ? ` font-weight="700"` : "", r.i ? ` font-style="italic"` : "", r.s ? ` text-decoration="line-through"` : "", r.href ? ` text-decoration="underline" fill="${link}"` : ""].join("");
  const body = `<tspan${attrs}>${esc(r.t)}</tspan>`;
  return r.href ? `<a href="${esc(r.href)}" target="_blank">${body}</a>` : body;
}

/** Lines of styled runs as SVG text, one <text> per line, the way the canvas stacks them. */
function textBlock(ls: (Line | string)[], x: number, y: number, size: number, o: BlockOpts): string {
  const lh = size * 1.3;
  return ls.map((l, i) => {
    const runs = typeof l === "string" ? [{ t: l }] : l;
    const title = o.titleLines !== undefined && i < o.titleLines;
    const weight = title ? 650 : o.weight;
    const muted = o.titleLines !== undefined && i >= o.titleLines ? ` fill-opacity="0.72"` : "";
    // List lines sit at the left edge, as the canvas lays them out, even inside centered text.
    const list = o.listX !== undefined && /^(• |\d+\. )$/.test(runs[0]?.t ?? "");
    return `<text x="${list ? o.listX : x}" y="${y + i * lh + size * 0.95}" font-size="${size}" fill="${o.color}"${muted} text-anchor="${list ? "start" : o.anchor ?? "start"}" xml:space="preserve"${weight ? ` font-weight="${weight}"` : ""}>${runs.map((r) => span(r, o.link)).join("")}</text>`;
  }).join("");
}

export type ExportInput = { elements: BoardEl[]; byKey: Map<string, BoardEl>; root: HTMLElement; only?: string[] };

/** The board (or the elements in `only`, with the arrows between them) as a standalone SVG document. */
export async function boardSvg({ elements, byKey, root, only }: ExportInput): Promise<string> {
  const c = resolver(root);
  const keep = only?.length ? new Set(only) : null;
  const els = drawOrder(elements).filter((e) => !keep || keep.has(e.key) || (e.kind === "connector" && keep.has(String(e.from)) && keep.has(String(e.to))));
  const boxes: Box[] = els.map((e) => (e.kind === "connector" ? connectorGeometry(e, (k) => byKey.get(k))?.box : e.kind === "frame" ? { ...elementBox(e), y: elementBox(e).y - 28, h: elementBox(e).h + 28 } : elementBounds(e))).filter(Boolean) as Box[];
  const all = unionBox(boxes) ?? { x: 0, y: 0, w: 400, h: 300 };
  const vb = { x: Math.floor(all.x - PAD), y: Math.floor(all.y - PAD), w: Math.ceil(all.w + PAD * 2), h: Math.ceil(all.h + PAD * 2) };
  const font = getComputedStyle(root).fontFamily || "monospace";
  // Wrap by the page's own font, measured, so an export breaks lines where the board does.
  const ctx = document.createElement("canvas").getContext("2d");
  const lines = (t: string, size: number, width: number, weight = 400): Line[] => wrapRuns(t, width, (str, r) => {
    if (!ctx) return str.length * size * 0.6;
    ctx.font = `${r.i ? "italic " : ""}${r.b ? 700 : weight} ${size}px ${font}`;
    return ctx.measureText(str).width;
  });
  const link = c("var(--sol-blue)");
  const widthOf = (l: Line, size: number, weight: number) => l.reduce((n, r) => {
    if (!ctx) return n + r.t.length * size * 0.6;
    ctx.font = `${r.i ? "italic " : ""}${r.b ? 700 : weight} ${size}px ${font}`;
    return n + ctx.measureText(r.t).width;
  }, 0);
  const ink = c("var(--board-ink)");
  const text = c("var(--sol-text)");
  const obstacles = elbowObstacles(elements);
  const art = new Map<string, string | null>();
  for (const e of els) {
    const a = boardArtFor(e.kind === "stamp" ? e.emoji : e.icon);
    if (a && !art.has(a)) art.set(a, await dataUrl(BOARD_ART_URLS[a]));
    if (e.kind === "image" && typeof e.src === "string" && !art.has(e.src)) art.set(e.src, await dataUrl(e.src));
  }

  const out: string[] = [];
  for (const e of els) {
    const b = elementBox(e);
    const rot = typeof e.rot === "number" && e.rot ? ` transform="rotate(${e.rot} ${b.x + b.w / 2} ${b.y + b.h / 2})"` : "";
    switch (e.kind) {
      case "frame": {
        const title = typeof e.title === "string" ? e.title : "";
        out.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="10" fill="${c(tint(e.color ?? "gray", 7))}" stroke="${c(tint(e.color ?? "gray", 34))}"/>`);
        if (title) out.push(textBlock([title], b.x + 2, b.y - 24, 13, { link, color: c(e.color ? colorToken(e.color) : "var(--sol-text-muted)"), weight: 600 }));
        break;
      }
      case "sticky": {
        const t = typeof e.text === "string" ? e.text : "";
        const a = boardArtFor(e.icon);
        const { iconH, size } = stickyLayout(t, b.w, b.h, e.icon, !!a);
        // A card with more than one line has a title (its first line, bold) over a body.
        const nl = t.indexOf("\n");
        const titleLs = nl > 0 ? lines(t.slice(0, nl), size, b.w - 28, 650) : [];
        const ls = nl > 0 ? [...titleLs, ...lines(t.slice(nl + 1), size, b.w - 28)] : lines(t, size, b.w - 28);
        const blockH = (iconH ? iconH + 6 : 0) + ls.length * size * 1.3;
        let y = b.y + Math.max(14, (b.h - blockH) / 2);
        const g = [`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="3" fill="${c(stickyFill(e.color))}" filter="url(#sh)"/>`];
        if (a && art.get(a)) g.push(`<image href="${art.get(a)}" x="${b.x + (b.w - iconH) / 2}" y="${y}" width="${iconH}" height="${iconH}"/>`);
        else if (iconH && typeof e.icon === "string") g.push(`<text x="${b.x + b.w / 2}" y="${y + iconH * 0.8}" font-size="${iconH * 0.8}" text-anchor="middle">${esc(e.icon)}</text>`);
        if (iconH) y += iconH + 6;
        g.push(textBlock(ls, b.x + b.w / 2, y, size, { link, color: ink, anchor: "middle", listX: b.x + 14, ...(nl > 0 ? { titleLines: titleLs.length } : {}) }));
        out.push(`<g${rot}>${g.join("")}</g>`);
        break;
      }
      case "shape": {
        const shape = typeof e.shape === "string" ? e.shape : "rect";
        const col = c(colorToken(e.color, "blue"));
        const solid = e.solid === true;
        const fill = solid ? col : c(tint(e.color, 16));
        const stroke = solid ? "none" : col;
        const outline = shapeOutline(shape, b.w, b.h);
        const body = outline
          ? `<path transform="translate(${b.x} ${b.y})" d="${outline}" fill="${fill}" stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round"/>`
          : `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${shape === "pill" ? b.h / 2 : 6}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
        const t = typeof e.text === "string" ? e.text : "";
        const size = shape === "pill" ? Math.min(15, b.h * 0.46) : Math.min(18, Math.max(11, b.h / 6));
        const ls = t ? lines(t, size, b.w - 24) : [];
        const ty = b.y + (b.h - ls.length * size * 1.3) / 2;
        // An illustration sits left of the words, the pair centered, as the canvas draws it.
        const a = boardArtFor(e.icon);
        const ic = a && art.get(a) ? size * 1.6 : 0;
        const tw = Math.max(0, ...ls.map((l) => widthOf(l, size, shape === "pill" ? 650 : 500)));
        const x0 = b.x + b.w / 2 - (ic ? ic + size * 0.4 + tw : tw) / 2;
        const icon = ic ? `<image href="${art.get(a!)}" x="${x0}" y="${b.y + (b.h - ic) / 2}" width="${ic}" height="${ic}"/>` : "";
        const words = ic
          ? textBlock(ls, x0 + ic + size * 0.4, ty, size, { link, color: solid ? c("var(--board-on-solid)") : text, weight: shape === "pill" ? 650 : 500 })
          : textBlock(ls, b.x + b.w / 2, ty, size, { link, color: solid ? c("var(--board-on-solid)") : text, anchor: "middle", weight: shape === "pill" ? 650 : 500 });
        out.push(`<g${rot}>${body}${icon}${words}</g>`);
        break;
      }
      case "text": {
        const size = typeof e.size === "number" ? e.size : 20;
        const t = typeof e.text === "string" ? e.text : "";
        const anchor = e.align === "center" ? "middle" : e.align === "right" ? "end" : "start";
        const x = anchor === "middle" ? b.x + b.w / 2 : anchor === "end" ? b.x + b.w : b.x;
        out.push(`<g${rot}>${textBlock(lines(t, size, b.w), x, b.y, size, { link, color: c(e.color ? colorToken(e.color) : "var(--sol-text)"), anchor, weight: e.weight === "bold" ? 650 : undefined })}</g>`);
        break;
      }
      case "connector": {
        const g = connectorGeometry(e, (k) => byKey.get(k), e.curve === "elbow" ? obstacles : undefined);
        if (!g) break;
        const col = c(colorToken(e.color, "gray"));
        const w = typeof e.width === "number" ? e.width : 2;
        const head = 9 + w * 1.5;
        const tip = (p: { x: number; y: number }, ang: number) => {
          const a1 = ang + Math.PI - 0.45, a2 = ang + Math.PI + 0.45;
          return `<polygon points="${p.x},${p.y} ${p.x + Math.cos(a1) * head},${p.y + Math.sin(a1) * head} ${p.x + Math.cos(a2) * head},${p.y + Math.sin(a2) * head}" fill="${col}"/>`;
        };
        const arrow = typeof e.arrow === "string" ? e.arrow : "end";
        out.push(`<path d="${g.d}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round"${e.dash ? ` stroke-dasharray="${w * 3} ${w * 3}"` : ""}/>`);
        if (arrow === "end" || arrow === "both") out.push(tip(g.b, g.angleEnd));
        if (arrow === "both") out.push(tip(g.a, g.angleStart));
        if (typeof e.label === "string" && e.label) {
          const lw = widthOf([{ t: e.label }], 15, 500) + 16;
          out.push(`<rect x="${g.mid.x - lw / 2}" y="${g.mid.y - 12}" width="${lw}" height="24" rx="5" fill="${c("var(--sol-bg)")}"/>`, textBlock([e.label], g.mid.x, g.mid.y - 10, 15, { link, color: text, anchor: "middle", weight: 500 }));
        }
        break;
      }
      case "pen": {
        const x = typeof e.x === "number" ? e.x : 0, y = typeof e.y === "number" ? e.y : 0;
        out.push(`<path transform="translate(${x} ${y})" d="${smoothPath(unflatten(e.points))}" fill="none" stroke="${c(colorToken(e.color, "gray"))}" stroke-opacity="${typeof e.opacity === "number" ? e.opacity : 1}" stroke-width="${typeof e.width === "number" ? e.width : 4}" stroke-linecap="round" stroke-linejoin="round"/>`);
        break;
      }
      case "image": {
        const src = typeof e.src === "string" ? art.get(e.src) : null;
        if (src) out.push(`<image href="${src}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" preserveAspectRatio="xMidYMid slice"${rot}/>`);
        break;
      }
      case "stamp": {
        const a = boardArtFor(e.emoji);
        if (a && art.get(a)) out.push(`<image href="${art.get(a)}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"${rot}/>`);
        else out.push(`<text x="${b.x + b.w / 2}" y="${b.y + b.h * 0.82}" font-size="${b.w * 0.78}" text-anchor="middle"${rot}>${esc(typeof e.emoji === "string" ? e.emoji : "👍")}</text>`);
        break;
      }
      case "card":
        out.push(`<g${rot}><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="10" fill="${c("var(--sol-card)")}" stroke="${c("var(--sol-border)")}"/>${textBlock([String(e.ref ?? "")], b.x + 16, b.y + 16, 14, { link, color: text, weight: 600 })}</g>`);
        break;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" width="${vb.w}" height="${vb.h}" font-family="${esc(font)}">`
    + `<defs><filter id="sh" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.18"/></filter></defs>`
    + `<rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" fill="${c("var(--sol-bg)")}"/>`
    + out.join("")
    + `</svg>`;
}

/** An SVG document rasterized at `scale` (2 for a sharp PNG on a retina screen). */
export async function svgToPng(svg: string, scale = 2): Promise<Blob> {
  const m = /width="(\d+)" height="(\d+)"/.exec(svg);
  const w = Number(m?.[1] ?? 800), h = Number(m?.[2] ?? 600);
  // Browsers cap a canvas near 16k px a side: big boards come out at a smaller scale rather than not at all.
  const k = Math.min(scale, 16000 / w, 16000 / h);
  const img = new Image();
  img.src = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * k);
  canvas.height = Math.round(h * k);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(img.src);
  return await new Promise((ok, no) => canvas.toBlob((b) => (b ? ok(b) : no(new Error("could not draw the board"))), "image/png"));
}
