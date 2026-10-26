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
const SHAPE_TAGS = new Set(["path", "circle", "ellipse", "rect", "line", "polyline", "polygon"]);

const inGrid = (n: number) => Number.isFinite(n) && n >= 0 && n <= ROLE_ICON_GRID;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** Everything wrong with an icon, as sentences an agent can act on; empty when valid. */
export function roleIconProblems(icon: unknown): string[] {
  const problems: string[] = [];
  const i = icon as Partial<RoleIcon> | null;
  if (!i || typeof i !== "object") return ["icon must be an object"];
  if (i.v !== 1) problems.push("icon.v must be 1");
  if (typeof i.concept !== "string" || !normalizeConcept(i.concept)) problems.push("concept must name the metaphor in a word or two");
  else if (i.concept.length > 40) problems.push("concept must be 40 characters or fewer");
  if (!ROLE_ICON_ACCENTS.includes(i.accent as RoleIconAccent)) problems.push(`accent must be one of ${ROLE_ICON_ACCENTS.join(", ")}`);
  if (!Array.isArray(i.shapes) || i.shapes.length === 0) return [...problems, "an icon needs at least one shape"];
  if (i.shapes.length > ROLE_ICON_MAX_SHAPES) problems.push(`an icon has at most ${ROLE_ICON_MAX_SHAPES} shapes (got ${i.shapes.length})`);
  let pathChars = 0;
  i.shapes.forEach((s, n) => {
    const at = `shape ${n + 1} (${(s as { t?: string })?.t ?? "?"})`;
    switch (s?.t) {
      case "path":
        if (typeof s.d !== "string" || !s.d.trim() || !PATH_D.test(s.d)) problems.push(`${at}: d must be path commands and numbers only`);
        else pathChars += s.d.length;
        break;
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
  return px < 18 ? 2.5 : px < 26 ? 2.1 : 1.8;
}

/** The tile's geometry as fractions of its side. */
export const ROLE_ICON_TILE = { radius: 0.28, glyph: 0.66 } as const;

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
const PRESENTATION = new Set(["stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "fill", "class", "id", "xmlns", "viewbox", "ry"]);

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
    const allowed = new Set([...GEOMETRY[tag], ...(tag === "ellipse" ? ["ry"] : [])]);
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
