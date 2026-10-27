// Role icons: the practical face of a role (docs/architecture/org-staffing.md
// S13). Every role carries two faces, an animal character (orgAvatars) and a
// drawn icon (this module); each viewer's `show_characters` setting chooses
// which one they see. The icon says WHAT the role looks after at a glance (a
// database for infrastructure, a coin for finance) in one consistent family.
//
// An icon is stored as validated vector shapes on a 24 unit grid, never as raw
// SVG, and every renderer draws it through `roleIconSvg`, which builds the
// markup from those shapes alone. So the web (innerHTML) and the phone
// (SvgXml) draw the same canonical markup, and nothing a model or an agent
// wrote reaches either one unchecked.

export const ROLE_ICON_GRID = 24;
export const ROLE_ICON_MAX_SHAPES = 8;
export const ROLE_ICON_MAX_PATH_CHARS = 1200;

/** The tile's tint, one of the theme's accents. Distinct across a boundary's
 *  roles where the set allows, so two roles differ by hue as well as glyph on
 *  a colour screen; the glyph alone carries identity on a grayscale one. */
export const ROLE_ICON_ACCENTS = ["blue", "cyan", "green", "yellow", "orange", "red", "magenta", "violet"] as const;
export type RoleIconAccent = (typeof ROLE_ICON_ACCENTS)[number];

export type RoleIconShape =
  | { t: "path"; d: string }
  | { t: "circle"; cx: number; cy: number; r: number; fill?: boolean }
  | { t: "ellipse"; cx: number; cy: number; rx: number; ry: number }
  | { t: "rect"; x: number; y: number; width: number; height: number; rx?: number }
  | { t: "line"; x1: number; y1: number; x2: number; y2: number }
  | { t: "polyline"; points: number[] }
  | { t: "polygon"; points: number[] };

export type RoleIcon = {
  v: 1;
  /** One or two words naming the metaphor ("database", "coin stack"). Two
   *  roles in a boundary never share one. */
  concept: string;
  accent: RoleIconAccent;
  shapes: RoleIconShape[];
};

/** The brief every drawer works from, a model in the generator or an agent
 *  drawing by hand through `cast role icon`. */
export const ROLE_ICON_LANGUAGE = `Role icon design language (codecast)

Purpose: a role icon tells a person, at 18 to 22 px in a sidebar, WHAT a long-running agent role looks after. It sits inside a rounded-square tile (the tile shape itself means "standing role"; people and ad-hoc sessions are circles). The reader should name the role's domain from the glyph alone, in grayscale, without a label.

Grid and stroke
- 24 x 24 unit viewBox. Keep every point inside the live area 2..22 on both axes; the heaviest mass sits on the optical centre (12, 12).
- Outline style: stroke only, 2 units, round caps and round joins, no fills. The single exception is a solid dot (a circle with fill, radius 2 or less) used as an accent point.
- Draw with the minimum strokes that read: 2 to 5 shapes is typical, never more than 8. Small details vanish at 18 px; anything closer than 2 units to a parallel stroke merges into it.
- Prefer whole, simple geometry (circles, rounded rects, straight runs, gentle arcs) over freehand curves. Keep corners consistent: rounded rect radius 2 to 3.

Metaphor
- One clear object or symbol per icon, the most literal widely understood picture of the role's domain: a cylinder database for infrastructure, a coin or dollar sign for finance, a megaphone for marketing, a shield with a check for quality, a magnifier over a chart for research.
- No letters, digits or words. No faces, animals or people unless the domain is literally people (then a simple head-and-shoulders bust).
- It must be DISTINCT from the sibling icons listed with the brief: a different concept AND a different silhouette. If the obvious metaphor is taken, pick the next most literal one rather than a variation of the same shape.
- Match the house style of the siblings so the set reads as one family: same weight, same corner radius, similar visual density.

Output: the SVG elements only (path, circle, ellipse, rect, line, polyline, polygon) with geometry attributes; no transforms, groups, styles, colours or text.`;

const NUM = /^-?\d+(\.\d+)?$/;
const PATH_D = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+\-eE]+$/;
// Plain words only: a concept reaches terminals and model prompts.
const CONCEPT = /^[a-z][a-z \-']{0,39}$/i;
const SHAPE_TAGS = new Set(["path", "circle", "ellipse", "rect", "line", "polyline", "polygon"]);

const inGrid = (n: number) => Number.isFinite(n) && n >= 0 && n <= ROLE_ICON_GRID;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** One straight piece of a flattened path, x1 y1 x2 y2 on the grid. */
export type RoleIconSegment = [number, number, number, number];

const CURVE_STEPS = 16;
const ARC_STEPS = 48;

/** A path's `d`, read with a cursor so arc flags written without separators ("a2 2 0 012 2") parse. */
function flattenInto(d: string, out: RoleIconSegment[]): void {
  let i = 0;
  const skip = () => { while (i < d.length && /[\s,]/.test(d[i])) i++; };
  const num = (): number => {
    skip();
    const m = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(d.slice(i));
    if (!m) throw new Error(`a number is missing at character ${i + 1}`);
    i += m[0].length;
    return Number(m[0]);
  };
  const flag = (): number => { skip(); const ch = d[i++]; if (ch !== "0" && ch !== "1") throw new Error(`an arc flag must be 0 or 1 at character ${i}`); return Number(ch); };

  let x = 0, y = 0, sx = 0, sy = 0;
  let cx2 = 0, cy2 = 0; // last control point, for S and T
  let prev = "";
  const line = (nx: number, ny: number) => { out.push([x, y, nx, ny]); x = nx; y = ny; };
  const cubic = (x1: number, y1: number, x2: number, y2: number, nx: number, ny: number) => {
    const x0 = x, y0 = y;
    for (let k = 1; k <= CURVE_STEPS; k++) {
      const t = k / CURVE_STEPS, u = 1 - t;
      line(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * nx, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ny);
    }
    cx2 = x2; cy2 = y2;
  };
  const quad = (x1: number, y1: number, nx: number, ny: number) => {
    const x0 = x, y0 = y;
    for (let k = 1; k <= CURVE_STEPS; k++) {
      const t = k / CURVE_STEPS, u = 1 - t;
      line(u * u * x0 + 2 * u * t * x1 + t * t * nx, u * u * y0 + 2 * u * t * y1 + t * t * ny);
    }
    cx2 = x1; cy2 = y1;
  };
  for (;;) {
    skip();
    if (i >= d.length) break;
    let cmd = d[i];
    if (/[a-zA-Z]/.test(cmd)) i++;
    else if (prev && prev.toLowerCase() !== "z") cmd = prev === "M" ? "L" : prev === "m" ? "l" : prev; // implicit repeat
    else throw new Error(`a command letter is missing at character ${i + 1}`);
    if (!prev && cmd !== "M" && cmd !== "m") throw new Error("a path must start with M");
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case "M": { x = num() + ox; y = num() + oy; sx = x; sy = y; break; }
      case "L": line(num() + ox, num() + oy); break;
      case "H": line(num() + ox, y); break;
      case "V": line(x, num() + oy); break;
      case "C": { const a = num() + ox, b = num() + oy, c = num() + ox, e = num() + oy; cubic(a, b, c, e, num() + ox, num() + oy); break; }
      case "S": {
        const smooth = /[CcSs]/.test(prev);
        const a = smooth ? 2 * x - cx2 : x, b = smooth ? 2 * y - cy2 : y;
        const c = num() + ox, e = num() + oy;
        cubic(a, b, c, e, num() + ox, num() + oy);
        break;
      }
      case "Q": { const a = num() + ox, b = num() + oy; quad(a, b, num() + ox, num() + oy); break; }
      case "T": {
        const smooth = /[QqTt]/.test(prev);
        quad(smooth ? 2 * x - cx2 : x, smooth ? 2 * y - cy2 : y, num() + ox, num() + oy);
        break;
      }
      case "A": {
        const rx = num(), ry = num(), rot = num(), large = flag(), sweep = flag();
        arcTo(x, y, rx, ry, rot, large, sweep, num() + ox, num() + oy, line);
        break;
      }
      case "Z": line(sx, sy); break;
      default: throw new Error(`"${cmd}" is not a path command`);
    }
    prev = cmd;
  }
}

// SVG arc from endpoint form (SVG 1.1 appendix F.6.5), flattened.
function arcTo(x1: number, y1: number, rx: number, ry: number, rotDeg: number, large: number, sweep: number, x2: number, y2: number, line: (x: number, y: number) => void) {
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) { line(x2, y2); return; }
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = (rotDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * y1p) / ry, cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const steps = Math.max(4, Math.ceil((Math.abs(dt) / (2 * Math.PI)) * ARC_STEPS));
  for (let k = 1; k <= steps; k++) {
    const t = t1 + (dt * k) / steps;
    line(k === steps ? x2 : cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, k === steps ? y2 : cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos);
  }
}

/**
 * A path's `d` as straight segments (curves and arcs sampled): the one
 * reading of a path that validation (`roleIconProblems`) and every
 * rasterizer share, so a path that validates always draws. Throws, with
 * where, on anything it cannot read.
 */
export function flattenRoleIconPath(d: string): RoleIconSegment[] {
  const out: RoleIconSegment[] = [];
  flattenInto(d, out);
  return out;
}

/** Everything wrong with an icon, as sentences an agent can act on; empty when valid. */
export function roleIconProblems(icon: unknown): string[] {
  const problems: string[] = [];
  const i = icon as Partial<RoleIcon> | null;
  if (!i || typeof i !== "object") return ["icon must be an object"];
  if (i.v !== 1) problems.push("icon.v must be 1");
  if (typeof i.concept !== "string" || !normalizeConcept(i.concept)) problems.push("concept must name the metaphor in a word or two");
  else if (!CONCEPT.test(i.concept)) problems.push("concept must be letters, spaces, hyphens or apostrophes, starting with a letter, 40 characters at most");
  if (!ROLE_ICON_ACCENTS.includes(i.accent as RoleIconAccent)) problems.push(`accent must be one of ${ROLE_ICON_ACCENTS.join(", ")}`);
  if (!Array.isArray(i.shapes) || i.shapes.length === 0) return [...problems, "an icon needs at least one shape"];
  if (i.shapes.length > ROLE_ICON_MAX_SHAPES) problems.push(`an icon has at most ${ROLE_ICON_MAX_SHAPES} shapes (got ${i.shapes.length})`);
  let pathChars = 0;
  i.shapes.forEach((s, n) => {
    const at = `shape ${n + 1} (${(s as { t?: string })?.t ?? "?"})`;
    switch (s?.t) {
      case "path": {
        if (typeof s.d !== "string" || !s.d.trim() || !PATH_D.test(s.d)) { problems.push(`${at}: d must be path commands and numbers only`); break; }
        pathChars += s.d.length;
        // Validated by drawing it: the reading every renderer uses, so a
        // path that passes always draws, and every point it reaches (curves
        // and arcs sampled) must sit on the grid.
        let segs: RoleIconSegment[];
        try { segs = flattenRoleIconPath(s.d); } catch (err) { problems.push(`${at}: ${(err as Error).message}`); break; }
        if (!segs.every((g) => g.every(inGrid))) problems.push(`${at}: every point must sit inside the 24 grid`);
        break;
      }
      case "circle":
        if (![s.cx, s.cy].every(inGrid) || !finite(s.r) || s.r <= 0 || s.r > 11) problems.push(`${at}: centre inside 0..24 and radius 0..11`);
        if (s.fill && s.r > 2) problems.push(`${at}: only a dot (radius 2 or less) may be filled`);
        break;
      case "ellipse":
        if (![s.cx, s.cy].every(inGrid) || ![s.rx, s.ry].every((r) => finite(r) && r > 0 && r <= 11)) problems.push(`${at}: centre inside 0..24 and radii 0..11`);
        break;
      case "rect":
        if (![s.x, s.y].every(inGrid) || !finite(s.width) || !finite(s.height) || s.width <= 0 || s.height <= 0 || !inGrid(s.x + s.width) || !inGrid(s.y + s.height)) problems.push(`${at}: must sit inside the 24 grid`);
        if (s.rx !== undefined && (!finite(s.rx) || s.rx < 0 || s.rx > 6)) problems.push(`${at}: rx must be 0..6`);
        break;
      case "line":
        if (![s.x1, s.y1, s.x2, s.y2].every(inGrid)) problems.push(`${at}: endpoints must sit inside the 24 grid`);
        break;
      case "polyline":
      case "polygon":
        if (!Array.isArray(s.points) || s.points.length < 4 || s.points.length % 2 !== 0 || !s.points.every(inGrid)) problems.push(`${at}: points must be x,y pairs inside the 24 grid`);
        break;
      default:
        problems.push(`${at}: unknown shape; use ${[...SHAPE_TAGS].join(", ")}`);
    }
  });
  if (pathChars > ROLE_ICON_MAX_PATH_CHARS) problems.push(`paths total ${pathChars} characters; keep them under ${ROLE_ICON_MAX_PATH_CHARS} (simpler geometry reads better small)`);
  return problems;
}

export function isRoleIcon(x: unknown): x is RoleIcon {
  return roleIconProblems(x).length === 0;
}

/** "Coin Stack!" and "coin-stack" are one concept. */
export function normalizeConcept(concept: string): string {
  return (concept ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** The stroke width, in grid units, for a tile of `px`: a little heavier as
 *  the tile shrinks, so the line never renders thinner than about 0.9 px. */
export function roleIconStroke(px: number): number {
  return px < 18 ? 2.6 : px < 26 ? 2.3 : 1.9;
}

/** The tile's geometry as fractions of its side. */
export const ROLE_ICON_TILE = { radius: 0.28, glyph: 0.76 } as const;

const fmt = (n: number) => String(Math.round(n * 100) / 100);
const pts = (p: number[]) => p.map(fmt).join(" ");

function shapeMarkup(s: RoleIconShape): string {
  switch (s.t) {
    case "path": return `<path d="${s.d.replace(/\s+/g, " ").trim()}"/>`;
    case "circle": return `<circle cx="${fmt(s.cx)}" cy="${fmt(s.cy)}" r="${fmt(s.r)}"${s.fill ? ` fill="currentColor" stroke="none"` : ""}/>`;
    case "ellipse": return `<ellipse cx="${fmt(s.cx)}" cy="${fmt(s.cy)}" rx="${fmt(s.rx)}" ry="${fmt(s.ry)}"/>`;
    case "rect": return `<rect x="${fmt(s.x)}" y="${fmt(s.y)}" width="${fmt(s.width)}" height="${fmt(s.height)}"${s.rx ? ` rx="${fmt(s.rx)}"` : ""}/>`;
    case "line": return `<line x1="${fmt(s.x1)}" y1="${fmt(s.y1)}" x2="${fmt(s.x2)}" y2="${fmt(s.y2)}"/>`;
    case "polyline": return `<polyline points="${pts(s.points)}"/>`;
    case "polygon": return `<polygon points="${pts(s.points)}"/>`;
  }
}

/**
 * The one renderer: canonical SVG markup built only from validated shapes.
 * Throws on an invalid icon, so a caller can never draw unchecked input;
 * readers that may hold a bad row check `isRoleIcon` first and fall back to
 * the monogram.
 */
export function roleIconSvg(icon: RoleIcon, opts: { strokeWidth?: number; color?: string } = {}): string {
  const problems = roleIconProblems(icon);
  if (problems.length) throw new Error(`invalid role icon: ${problems[0]}`);
  const stroke = opts.color && /^[#a-zA-Z0-9(),.%\s-]+$/.test(opts.color) ? opts.color : "currentColor";
  const body = icon.shapes.map(shapeMarkup).join("").replace(/currentColor/g, stroke);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="${fmt(opts.strokeWidth ?? 2)}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

const ATTR = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const TAG = /<\s*([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*?)\/?\s*>/g;
const IGNORED_TAGS = new Set(["svg", "g", "title", "desc"]);
const GEOMETRY: Record<string, readonly string[]> = {
  path: ["d"], circle: ["cx", "cy", "r"], ellipse: ["cx", "cy", "rx", "ry"],
  rect: ["x", "y", "width", "height", "rx"], line: ["x1", "y1", "x2", "y2"],
  polyline: ["points"], polygon: ["points"],
};
// Presentation attributes a drawer habitually writes. They are dropped (the
// house style replaces them), never obeyed.
const PRESENTATION = new Set(["stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "fill", "class", "id", "xmlns", "viewbox"]);

/**
 * Reads hand-drawn SVG (a model's or an agent's) into shapes. Only the seven
 * shape elements survive; geometry attributes are kept, presentation is
 * dropped, and anything that could move or restyle a shape (transform, style,
 * href, an event handler, a group with attributes) is a problem rather than
 * silently ignored, so the drawer learns why.
 */
export function parseRoleIconSvg(svg: string): { shapes: RoleIconShape[]; problems: string[] } {
  const shapes: RoleIconShape[] = [];
  const problems: string[] = [];
  const text = String(svg ?? "").replace(/<!--[\s\S]*?-->/g, "");
  if (/<\s*(script|style|foreignObject|image|use|text)\b/i.test(text)) problems.push("only path, circle, ellipse, rect, line, polyline and polygon are allowed");
  for (const m of text.matchAll(TAG)) {
    const tag = m[1].toLowerCase();
    const attrs: Record<string, string> = {};
    for (const a of m[2].matchAll(ATTR)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? "";
    if (IGNORED_TAGS.has(tag)) {
      if (tag === "g" && Object.keys(attrs).some((k) => !PRESENTATION.has(k))) problems.push("groups may not carry transforms or styles; draw shapes directly on the grid");
      if (tag === "svg" && attrs.viewbox && attrs.viewbox.trim().replace(/\s+/g, " ") !== "0 0 24 24") problems.push(`viewBox must be 0 0 24 24 (got ${attrs.viewbox})`);
      continue;
    }
    if (!SHAPE_TAGS.has(tag)) { problems.push(`<${tag}> is not allowed`); continue; }
    const allowed = new Set(GEOMETRY[tag]);
    const stray = Object.keys(attrs).filter((k) => !allowed.has(k) && !PRESENTATION.has(k));
    if (stray.length) problems.push(`<${tag}> may not carry ${stray.join(", ")}`);
    const num = (k: string) => {
      const raw = (attrs[k] ?? "").trim();
      if (!NUM.test(raw)) { problems.push(`<${tag}> ${k}="${attrs[k] ?? ""}" must be a number`); return NaN; }
      return Number(raw);
    };
    const list = (k: string) => (attrs[k] ?? "").trim().split(/[\s,]+/).filter(Boolean).map(Number);
    const filled = attrs.fill !== undefined && !/^(none|transparent)$/i.test(attrs.fill.trim());
    switch (tag) {
      case "path": shapes.push({ t: "path", d: attrs.d ?? "" }); break;
      case "circle": shapes.push({ t: "circle", cx: num("cx"), cy: num("cy"), r: num("r"), ...(filled ? { fill: true } : {}) }); break;
      case "ellipse": shapes.push({ t: "ellipse", cx: num("cx"), cy: num("cy"), rx: num("rx"), ry: num("ry") }); break;
      case "rect": shapes.push({ t: "rect", x: num("x"), y: num("y"), width: num("width"), height: num("height"), ...(attrs.rx !== undefined ? { rx: num("rx") } : {}) }); break;
      case "line": shapes.push({ t: "line", x1: num("x1"), y1: num("y1"), x2: num("x2"), y2: num("y2") }); break;
      case "polyline": case "polygon": shapes.push({ t: tag, points: list("points") }); break;
    }
  }
  if (!shapes.length && !problems.length) problems.push("no shapes found");
  return { shapes, problems };
}

/** The accent a new icon takes: the one its siblings use least, ties broken
 *  by a stable hash of `seed`, so a boundary's tiles spread across the hues. */
export function pickRoleIconAccent(siblings: readonly RoleIconAccent[], seed: string): RoleIconAccent {
  const used = new Map<RoleIconAccent, number>(ROLE_ICON_ACCENTS.map((a) => [a, 0]));
  for (const a of siblings) if (used.has(a)) used.set(a, used.get(a)! + 1);
  const least = Math.min(...used.values());
  const open = ROLE_ICON_ACCENTS.filter((a) => used.get(a) === least);
  let h = 5381;
  for (const ch of seed) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return open[h % open.length];
}

const FILLER = new Set(["head", "of", "the", "chief", "lead", "and", "a", "an", "for", "s"]);

/** The letter a role without an icon wears in its tile, from its title:
 *  "Infrastructure lead" is I, "Head of Growth" is G. */
export function roleMonogram(title: string): string {
  const words = (title ?? "").split(/[^A-Za-z0-9]+/).filter(Boolean);
  const word = words.find((w) => !FILLER.has(w.toLowerCase())) ?? words[0] ?? "?";
  return word[0].toUpperCase();
}

/** How long a pinned session's icon request holds off the next
 *  (convex/sessionIcons.ts): the pin asks again each window while it has none. */
export const SESSION_ICON_RETRY_MS = 6 * 60 * 60_000;
