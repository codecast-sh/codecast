// The whole dashboard as a file: a PNG drawn from the page as laid out (card
// boxes, every line of text in its own font and color, each chart's canvas),
// and a one-page PDF around that image. No DOM-to-image library: the
// dashboard is boxes, text and canvases, and drawing those directly keeps the
// output exact and the bundle unchanged.

const SCALE = 2;

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
    ctx.fillText(line, x - origin.left, r.top + r.height / 2 - origin.top);
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
  const box = root.getBoundingClientRect();
  // The picture ends where the content does, not at the page's bottom padding.
  const content = [...root.children].filter((c) => !(c as HTMLElement).dataset?.exportSkip).reduce((b, c) => Math.max(b, c.getBoundingClientRect().bottom), box.top);
  const height = Math.min(box.height, content - box.top + 28);
  // Everything below draws relative to `origin`: the root's corner, pushed down under the title band.
  const origin = new DOMRect(box.left, box.top - HEAD, box.width, height + HEAD);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(origin.width * SCALE);
  canvas.height = Math.ceil(origin.height * SCALE);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(SCALE, SCALE);
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

/** A one-page PDF holding a JPEG at the page's size: the PDF objects written by hand, the image embedded as DCT. */
export async function pdfFromCanvas(canvas: HTMLCanvasElement): Promise<Blob> {
  const jpeg = new Uint8Array(await (await canvasBlob(canvas, "image/jpeg", 0.92)).arrayBuffer());
  const w = canvas.width / SCALE;
  const h = canvas.height / SCALE;
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
  const draw = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
  push("%PDF-1.4\n");
  obj(() => push("<< /Type /Catalog /Pages 2 0 R >>"));
  obj(() => push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"));
  obj(() => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`));
  obj(() => {
    push(`<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
    push(jpeg);
    push("\nendstream");
  });
  obj(() => push(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`));
  const xref = length;
  push(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`);
  push(`trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as BlobPart[], { type: "application/pdf" });
}
