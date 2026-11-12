// The whole dashboard as a file: a PNG drawn from the page as laid out (card
// boxes, every line of text in its own font and color, each chart's canvas),
// and a one-page PDF around that image. No DOM-to-image library: the
// dashboard is boxes, text and canvases, and drawing those directly keeps the
// output exact and the bundle unchanged.

import { clearChartHover } from "./exportBlock";

const SCALE = 2;
/** The tallest canvas browsers reliably draw. */
const MAX_PX = 16_000;

const transparent = (c: string) => !c || c === "transparent" || /rgba\([^)]*,\s*0\)$/.test(c);

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function visible(el: Element): boolean {
  const anyEl = el as Element & { checkVisibility?: (o: object) => boolean };
  return anyEl.checkVisibility ? anyEl.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true;
}

/** Text in a node, laid onto the line boxes the browser gave it. A leading space keeps its width, so words beside a live number stay apart. */
function drawText(ctx: CanvasRenderingContext2D, node: Text, origin: DOMRect) {
  const text = node.data.replace(/\s+/g, " ");
  if (!text.trim()) return;
  const lead = text.startsWith(" ");
  const parent = node.parentElement;
  if (!parent || !visible(parent)) return;
  const st = getComputedStyle(parent);
  const range = document.createRange();
  range.selectNodeContents(node);
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  if (!rects.length) return;
  ctx.font = `${st.fontStyle} ${st.fontWeight} ${st.fontSize} ${st.fontFamily}`;
  ctx.fillStyle = st.color;
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = st.letterSpacing === "normal" ? "0px" : st.letterSpacing;
  ctx.textBaseline = "middle";
  const words = text.trim().split(" ");
  let w = 0;
  rects.forEach((r, ri) => {
    let line = "";
    while (w < words.length) {
      const next = line ? `${line} ${words[w]}` : words[w];
      // The canvas measures a little differently from the page; the last line box always takes the words that remain.
      if (line && ri < rects.length - 1 && ctx.measureText(next).width > r.width + 2) break;
      line = next;
      w++;
    }
    const pad = ri === 0 && lead ? ctx.measureText(" ").width : 0;
    const x = st.textAlign === "right" || st.textAlign === "end" ? r.right - ctx.measureText(line).width : r.left + pad;
    // The canvas measures some faces a little wider than the page (tabular, semibold): held to its line box, a word never runs into the next one.
    ctx.fillText(line, x - origin.left, r.top + r.height / 2 - origin.top, Math.max(1, r.right - x + 1));
  });
}

/** The box an element is visible in: its scrolling and clipping ancestors (a table that scrolls inside its card) cut it. */
function clipBox(el: Element, root: HTMLElement, cache: Map<Element, DOMRect | null>): DOMRect | null {
  if (el === root || !el.parentElement) return null;
  if (cache.has(el)) return cache.get(el)!;
  const parent = clipBox(el.parentElement, root, cache);
  const st = getComputedStyle(el);
  let box = parent;
  if (st.overflowX !== "visible" || st.overflowY !== "visible") {
    const r = el.getBoundingClientRect();
    box = parent ? new DOMRect(Math.max(r.left, parent.left), Math.max(r.top, parent.top), Math.max(0, Math.min(r.right, parent.right) - Math.max(r.left, parent.left)), Math.max(0, Math.min(r.bottom, parent.bottom) - Math.max(r.top, parent.top))) : r;
  }
  cache.set(el, box);
  return box;
}

/** An inline SVG icon as an image, its currentColor resolved to the color it shows in. */
function svgImage(svg: SVGSVGElement): Promise<HTMLImageElement | null> {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const color = getComputedStyle(svg).color;
  const r = svg.getBoundingClientRect();
  copy.setAttribute("width", String(r.width));
  copy.setAttribute("height", String(r.height));
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const xml = new XMLSerializer().serializeToString(copy).replace(/currentColor/g, color);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  });
}

const HEAD = 64;

/** Draw `root` (and everything laid out inside it) at twice its size, under a band with the title and when it was taken. */
export async function renderPng(root: HTMLElement, head: { title: string; note?: string }): Promise<HTMLCanvasElement> {
  await document.fonts?.ready;
  // What the picture leaves out (the filter bar, hover buttons, check marks) leaves no hole: it is taken out of the layout while the page is drawn, then put back.
  clearChartHover();
  const skipped = [...root.querySelectorAll<HTMLElement>("[data-export-skip]")];
  const before = skipped.map((el) => el.style.display);
  skipped.forEach((el) => (el.style.display = "none"));
  try {
    return await draw(root, head);
  } finally {
    skipped.forEach((el, i) => (el.style.display = before[i]));
  }
}

async function draw(root: HTMLElement, head: { title: string; note?: string }): Promise<HTMLCanvasElement> {
  const box = root.getBoundingClientRect();
  // The picture ends where the content does, not at the page's bottom padding.
  const content = [...root.children].filter((c) => !(c as HTMLElement).dataset?.exportSkip).reduce((b, c) => Math.max(b, c.getBoundingClientRect().bottom), box.top);
  const height = Math.min(box.height, content - box.top + 28);
  // Everything below draws relative to `origin`: the root's corner, pushed down under the title band.
  const origin = new DOMRect(box.left, box.top - HEAD, box.width, height + HEAD);
  const canvas = document.createElement("canvas");
  // Browsers cap a canvas near 16,000px a side: a tall dashboard is drawn at 1x instead of failing, and only a page past the cap is refused.
  if (origin.height > MAX_PX) throw new Error("This dashboard is too tall for one picture; download blocks one at a time");
  const scale = origin.height * SCALE > MAX_PX ? 1 : SCALE;
  canvas.width = Math.ceil(origin.width * scale);
  canvas.height = Math.ceil(origin.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  const rootStyle = getComputedStyle(document.documentElement);
  const page = rootStyle.getPropertyValue("--sol-bg").trim();
  ctx.fillStyle = page || getComputedStyle(document.body).backgroundColor || "#fff";
  ctx.fillRect(0, 0, origin.width, origin.height);
  const bodyFont = getComputedStyle(root).fontFamily;
  const pad = parseFloat(getComputedStyle(root).paddingLeft) || 32;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = rootStyle.getPropertyValue("--sol-text").trim() || "#111";
  ctx.font = `700 22px ${bodyFont}`;
  ctx.fillText(head.title, pad, 36);
  if (head.note) {
    ctx.fillStyle = rootStyle.getPropertyValue("--sol-text-dim").trim() || "#888";
    ctx.font = `400 12px ${bodyFont}`;
    ctx.fillText(head.note, pad, 56);
  }
  const clips = new Map<Element, DOMRect | null>();
  const clipTo = (el: Element) => {
    const c = clipBox(el, root, clips);
    ctx.save();
    if (c) {
      ctx.beginPath();
      ctx.rect(c.left - origin.left, c.top - origin.top, c.width, c.height);
      ctx.clip();
    }
  };

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if (n.nodeType !== Node.ELEMENT_NODE) return NodeFilter.FILTER_ACCEPT;
      const el = n as Element;
      // An icon draws whole from its <svg>; its paths are not separate boxes.
      if (el.parentElement instanceof SVGElement) return NodeFilter.FILTER_REJECT;
      return !visible(el) || (el as HTMLElement).dataset?.exportSkip !== undefined ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n: Node | null = walker.currentNode; n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      if (!n.parentElement) continue;
      clipTo(n.parentElement);
      drawText(ctx, n as Text, origin);
      ctx.restore();
      continue;
    }
    const el = n as HTMLElement;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const x = r.left - origin.left;
    const y = r.top - origin.top;
    clipTo(el);
    if (el instanceof HTMLCanvasElement) {
      ctx.drawImage(el, x, y, r.width, r.height);
      ctx.restore();
      continue;
    }
    if (el instanceof SVGSVGElement) {
      const img = await svgImage(el);
      if (img) ctx.drawImage(img, x, y, r.width, r.height);
      ctx.restore();
      continue;
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      ctx.restore();
      continue;
    }
    const st = getComputedStyle(el);
    const radius = parseFloat(st.borderTopLeftRadius) || 0;
    if (!transparent(st.backgroundColor)) {
      ctx.fillStyle = st.backgroundColor;
      roundRect(ctx, x, y, r.width, r.height, radius);
      ctx.fill();
    }
    const bw = parseFloat(st.borderTopWidth) || 0;
    if (bw > 0 && st.borderTopStyle !== "none" && !transparent(st.borderTopColor)) {
      ctx.strokeStyle = st.borderTopColor;
      ctx.lineWidth = bw;
      roundRect(ctx, x + bw / 2, y + bw / 2, r.width - bw, r.height - bw, radius);
      ctx.stroke();
    } else {
      // A row divider is a bottom border alone (a table row, a list item); draw it as the line it is.
      const bb = parseFloat(st.borderBottomWidth) || 0;
      if (bb > 0 && st.borderBottomStyle !== "none" && !transparent(st.borderBottomColor)) {
        ctx.fillStyle = st.borderBottomColor;
        ctx.fillRect(x, y + r.height - bb, r.width, bb);
      }
    }
    ctx.restore();
  }
  return canvas;
}

export function canvasBlob(canvas: HTMLCanvasElement, type: "image/png" | "image/jpeg", quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The dashboard could not be drawn"))), type, quality));
}

/**
 * A PDF of US Letter pages (612 x 792 pt), the picture cut into page-high
 * slices: it prints, and it reads page by page. The PDF objects are written
 * by hand, each slice embedded as a JPEG.
 */
export async function pdfFromCanvas(canvas: HTMLCanvasElement): Promise<Blob> {
  const PAGE_W = 612;
  const PAGE_H = 792;
  const MARGIN = 24;
  const availH = PAGE_H - MARGIN * 2;
  let fit = (PAGE_W - MARGIN * 2) / canvas.width;
  // A last page holding only a sliver (the bottom edge of a card) is folded back: the whole picture shrinks a little to need one page fewer.
  const pages = Math.ceil((canvas.height * fit) / availH);
  const tail = canvas.height * fit - (pages - 1) * availH;
  if (pages > 1 && tail < availH * 0.25) fit = Math.min(fit, (availH * (pages - 1)) / canvas.height);
  const sliceH = Math.floor(availH / fit);
  const slices: Array<{ jpeg: Uint8Array; w: number; h: number }> = [];
  for (let y = 0; y < canvas.height; y += sliceH) {
    const h = Math.min(sliceH, canvas.height - y);
    const c = document.createElement("canvas");
    c.width = canvas.width;
    c.height = h;
    c.getContext("2d")!.drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
    slices.push({ jpeg: new Uint8Array(await (await canvasBlob(c, "image/jpeg", 0.92)).arrayBuffer()), w: canvas.width, h });
  }
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (p: Uint8Array | string) => {
    const bytes = typeof p === "string" ? enc.encode(p) : p;
    parts.push(bytes);
    length += bytes.length;
  };
  const obj = (body: () => void) => {
    offsets.push(length);
    push(`${offsets.length} 0 obj\n`);
    body();
    push("\nendobj\n");
  };
  // Objects: 1 catalog, 2 page tree, then three per page (page, image, drawing).
  const pageId = (k: number) => 3 + k * 3;
  push("%PDF-1.4\n");
  obj(() => push("<< /Type /Catalog /Pages 2 0 R >>"));
  obj(() => push(`<< /Type /Pages /Kids [${slices.map((_, k) => `${pageId(k)} 0 R`).join(" ")}] /Count ${slices.length} >>`));
  slices.forEach((sl, k) => {
    const w = sl.w * fit;
    const h = sl.h * fit;
    const draw = `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${MARGIN} ${(PAGE_H - MARGIN - h).toFixed(2)} cm /Im0 Do Q`;
    obj(() => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /XObject << /Im0 ${pageId(k) + 1} 0 R >> >> /Contents ${pageId(k) + 2} 0 R >>`));
    obj(() => {
      push(`<< /Type /XObject /Subtype /Image /Width ${sl.w} /Height ${sl.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${sl.jpeg.length} >>\nstream\n`);
      push(sl.jpeg);
      push("\nendstream");
    });
    obj(() => push(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`));
  });
  const xref = length;
  push(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`);
  push(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as BlobPart[], { type: "application/pdf" });
}
