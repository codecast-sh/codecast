// The role icon generator's pipeline (shared/contracts/roleIcon, S13): three
// drawers in parallel, each candidate parsed, validated and checked against
// the boundary's other icons, a contact sheet of the survivors, and a vision
// judge that picks one or sends a critique back for one more round.
//
// Pure apart from `ask`, the model call the caller supplies: the action
// (roleIcons.ts) posts through lib/anthropic on the deployment's key, a local
// script posts with its own key, and the tests answer from fixtures.

import {
  ROLE_ICON_LANGUAGE, normalizeConcept, parseRoleIconSvg, roleIconProblems, roleIconSvg,
  type RoleIcon, type RoleIconAccent,
} from "@codecast/shared/contracts/roleIcon";
import { parseJsonBlock } from "@codecast/shared/contracts/modelCall";
import { Canvas, SHEET_THEMES, SILHOUETTE_TOO_CLOSE, iconMask, maskIoU, paintLabel, paintTile } from "./roleIconRaster";

export const ICON_MODEL = "claude-opus-5-5";
const DRAW_MAX_TOKENS = 12_000;
const JUDGE_MAX_TOKENS = 6_000;
const CHARTER_CHARS = 2_000;

export type IconSibling = { title: string; handle?: string; icon: RoleIcon };
export type IconBrief = {
  role_id: string;
  title: string;
  handle: string;
  /** The charter doc's text, else the row's short charter. */
  charter?: string;
  /** A person's steer ("not a wrench", "something botanical"). */
  hint?: string;
  /** The live roles in the same boundary that already wear an icon. */
  siblings: IconSibling[];
  /** The house style references; the role's own title is left out so a drawer never copies an answer. */
  examples: ReadonlyArray<{ title: string; icon: RoleIcon }>;
  accent: RoleIconAccent;
};

export type AskRequest = { label: string; system: string; prompt: string; max_tokens: number; image?: Uint8Array };
export type AskReply = { text: string | null; usage: { input_tokens: number; output_tokens: number } | null; error?: string };
export type Ask = (req: AskRequest) => Promise<AskReply>;

// ── Drawing ─────────────────────────────────────────────────────────────────

/** What each of the three drawers is asked to try, so the judge chooses among different ideas rather than three takes on one. */
export const DIRECTIONS = [
  "Draw the single most literal, widely understood object for this role's domain: the picture most people would sketch if asked to draw it.",
  "Draw a DIFFERENT object from the most obvious one: the second most literal picture of the domain, still recognisable in a glance. Name the obvious one in your reasoning and avoid it.",
  "Draw what the role's work protects or produces rather than the tool it works with (a house rather than a hammer, a calm eye rather than a phone): consider at least four such pictures, judge each for how well it reads at 18 px in grayscale, and draw the one that wins.",
] as const;

const svgOf = (icon: RoleIcon) => roleIconSvg(icon).replace(/ xmlns="[^"]*"/, "");

function listing(rows: ReadonlyArray<{ title: string; icon: RoleIcon }>): string {
  return rows.map((r) => `- ${r.title}: "${r.icon.concept}"\n  ${svgOf(r.icon)}`).join("\n");
}

export function drawRequest(brief: IconBrief, direction: number, critique?: string): AskRequest {
  const charter = (brief.charter ?? "").trim().slice(0, CHARTER_CHARS);
  const taken = brief.siblings.map((s) => `"${s.icon.concept}"`).join(", ");
  const prompt = [
    `Draw the role icon for this role.`,
    ``,
    `Role: ${brief.title} (@${brief.handle})`,
    charter ? `Charter (what the role looks after):\n${charter}` : `It has no charter yet; read its domain from the title.`,
    brief.hint ? `\nA person's steer for this icon, which wins over your own taste: ${brief.hint}` : null,
    ``,
    `House style: these icons were drawn by hand and checked at 18, 22 and 44 px. Match their weight, corner radius, proportions and density exactly; they are the quality bar.`,
    listing(brief.examples),
    ``,
    brief.siblings.length
      ? `Taken in this workspace (concepts and silhouettes you must NOT repeat or echo): ${taken}\n${listing(brief.siblings)}`
      : `No other role in this workspace has an icon yet.`,
    ``,
    `Your direction: ${DIRECTIONS[direction % DIRECTIONS.length]}`,
    critique ? `\nA judge rejected the last round's drawings for this role. Their critique, which your drawing must answer:\n${critique}` : null,
    ``,
    `Craft: plan the geometry on the 24 grid before writing it. Use whole or half units. Keep the glyph's bounding box near 3..21 on its longer axis and centred, as the house icons are. Prefer rect, circle, line and simple arcs over freehand curves. Check every pair of parallel strokes is at least 2.5 units apart centre to centre, and that nothing reads as a letter.`,
    ``,
    `Answer with one JSON object and nothing else:`,
    `{"concept": "<one or two words naming the object>", "reasoning": "<two sentences: why this picture says this role, and how it differs from the taken icons>", "svg": "<svg viewBox=\\"0 0 24 24\\">...shapes only...</svg>"}`,
  ].filter((line) => line !== null).join("\n");
  return { label: "role-icon-draw", system: ROLE_ICON_LANGUAGE, prompt, max_tokens: DRAW_MAX_TOKENS };
}

export type RawCandidate = { concept: string; reasoning: string; svg: string };

/** A drawer's reply, or null when it holds no usable object. */
export function parseCandidate(text: string | null | undefined): RawCandidate | null {
  if (!text) return null;
  const v = parseJsonBlock(text) as any;
  if (!v || typeof v !== "object" || typeof v.svg !== "string" || typeof v.concept !== "string") return null;
  return { concept: v.concept.trim(), reasoning: typeof v.reasoning === "string" ? v.reasoning.trim() : "", svg: v.svg };
}

export type Vetted =
  | { ok: true; icon: RoleIcon; reasoning: string; closest: { title: string; iou: number } | null }
  | { ok: false; concept: string; problems: string[] };

/**
 * Turns a raw drawing into an icon, or says everything wrong with it: SVG the
 * parser refuses, shapes the contract refuses, a concept a sibling holds, or
 * a silhouette too close to a sibling's at 24 px.
 */
export function vetCandidate(raw: RawCandidate, siblings: readonly IconSibling[], accent: RoleIconAccent): Vetted {
  const parsed = parseRoleIconSvg(raw.svg);
  const icon: RoleIcon = { v: 1, concept: raw.concept, accent, shapes: parsed.shapes };
  const problems = [...parsed.problems, ...roleIconProblems(icon)];
  if (problems.length) return { ok: false, concept: raw.concept, problems };
  const norm = normalizeConcept(raw.concept);
  const holder = siblings.find((s) => normalizeConcept(s.icon.concept) === norm);
  if (holder) return { ok: false, concept: raw.concept, problems: [`"${raw.concept}" is already ${holder.title}'s icon`] };
  let closest: { title: string; iou: number } | null = null;
  try {
    const mine = iconMask(icon);
    for (const s of siblings) {
      const iou = maskIoU(mine, iconMask(s.icon));
      if (!closest || iou > closest.iou) closest = { title: s.title, iou };
    }
  } catch (err) {
    return { ok: false, concept: raw.concept, problems: [`the path could not be drawn: ${String((err as Error).message ?? err)}`] };
  }
  if (closest && closest.iou > SILHOUETTE_TOO_CLOSE) {
    return { ok: false, concept: raw.concept, problems: [`its silhouette overlaps ${closest.title}'s icon ${Math.round(closest.iou * 100)}% at 24 px; draw a different shape`] };
  }
  return { ok: true, icon, reasoning: raw.reasoning, closest };
}

// ── The contact sheet ───────────────────────────────────────────────────────

export const SHEET_LETTERS = ["A", "B", "C", "D", "E", "F"] as const;
const SCALE = 2; // a retina screen, which is how people see the sidebar
const GAP = 12;
const SIZES = [18, 22, 64] as const;
const STRIP_TILE = 22;
const STRIP_STEP = 30;

/**
 * Each candidate's row: its letter, then on the light half its tile at 18,
 * 22 and 64 px and the sibling strip at 22 px with the candidate last
 * (outlined by position: the strip's final tile), then the same on the dark
 * half. Drawn at 2x, as a retina sidebar shows it.
 */
export function contactSheet(candidates: readonly RoleIcon[], siblings: readonly IconSibling[]): Uint8Array {
  const label = 20;
  const sizesW = SIZES.reduce((n, s) => n + s + GAP, 0);
  const stripW = (siblings.length + 1) * STRIP_STEP + GAP * 2;
  const halfW = label + GAP + sizesW + stripW;
  const rowH = SIZES[SIZES.length - 1] + 20;
  const W = halfW * 2, H = Math.max(1, candidates.length) * rowH + 8;
  const cv = new Canvas(W * SCALE, H * SCALE, SHEET_THEMES.light.bg);
  cv.rect(halfW * SCALE, 0, halfW * SCALE, H * SCALE, SHEET_THEMES.dark.bg);
  candidates.forEach((icon, row) => {
    (["light", "dark"] as const).forEach((name, half) => {
      const theme = SHEET_THEMES[name];
      const top = 8 + row * rowH;
      let x = half * halfW + 8;
      paintLabel(cv, SHEET_LETTERS[row], x * SCALE, (top + rowH / 2 - 12) * SCALE, 12 * SCALE, theme.text);
      x += label + GAP;
      for (const s of SIZES) {
        paintTile(cv, icon, x * SCALE, (top + (SIZES[SIZES.length - 1] - s) / 2) * SCALE, s * SCALE, theme, s);
        x += s + GAP;
      }
      x += GAP;
      const stripTop = top + (SIZES[SIZES.length - 1] - STRIP_TILE) / 2;
      for (const sib of siblings) {
        paintTile(cv, sib.icon, x * SCALE, stripTop * SCALE, STRIP_TILE * SCALE, theme, STRIP_TILE);
        x += STRIP_STEP;
      }
      paintTile(cv, icon, (x + 4) * SCALE, stripTop * SCALE, STRIP_TILE * SCALE, theme, STRIP_TILE);
    });
  });
  return cv.png();
}

// ── Judging ─────────────────────────────────────────────────────────────────

export type Verdict = { winner: number | null; rationale: string; critique: string };

export function judgeRequest(brief: IconBrief, candidates: ReadonlyArray<{ icon: RoleIcon; reasoning: string }>): AskRequest {
  const letters = candidates.map((_, n) => SHEET_LETTERS[n]);
  const prompt = [
    `You are the art director for a family of role icons. Pick the best candidate icon for this role, or reject them all.`,
    ``,
    `Role: ${brief.title} (@${brief.handle})`,
    brief.charter ? `Charter: ${brief.charter.trim().slice(0, 800)}` : null,
    brief.hint ? `A person's steer: ${brief.hint}` : null,
    ``,
    `The attached contact sheet, drawn at 2x as a retina screen shows it: one row per candidate, labelled ${letters.join(", ")} at the left. The left half is the light theme, the right half the dark theme. In each half: the candidate's tile at 18, 22 and 64 px, then the workspace's other role icons at 22 px with the candidate as the LAST tile of that strip.`,
    ``,
    `Candidates:`,
    ...candidates.map((c, n) => `${letters[n]}: "${c.icon.concept}". The drawer's reasoning: ${c.reasoning || "(none)"}`),
    brief.siblings.length ? `\nThe other icons in the strip, left to right: ${brief.siblings.map((s) => `${s.title} ("${s.icon.concept}")`).join(", ")}.` : null,
    ``,
    `Judge, in this order of weight:`,
    `1. Legibility at 18 to 22 px: can you name the object at the small sizes, in grayscale, with no strokes merging or details lost?`,
    `2. Metaphor: would someone who sees only the tile guess what THIS role looks after? A clever but obscure metaphor loses to a plain clear one.`,
    `3. Distinctness: could it be mistaken for any icon in the strip, by shape or by idea?`,
    `4. House style: same weight, corner radius, size and density as the strip; it should look like one hand drew the whole set.`,
    ``,
    `Accept a candidate only if it is at least as good as the weakest icon in the strip on every point. Otherwise reject all and write the critique a drawer needs for one more attempt: what failed and what to try instead (a concrete metaphor or geometry change).`,
    ``,
    `Answer with one JSON object and nothing else:`,
    `{"winner": "${letters.join('" | "')}" | null, "rationale": "<one or two sentences a person reads: why this icon says this role>", "critique": "<when winner is null: what to draw instead; else empty>"}`,
  ].filter((l) => l !== null).join("\n");
  return { label: "role-icon-judge", system: "You judge small UI icons with a sharp, practical eye. You answer with JSON only.", prompt, max_tokens: JUDGE_MAX_TOKENS };
}

export function parseVerdict(text: string | null | undefined, count: number): Verdict | null {
  if (!text) return null;
  const v = parseJsonBlock(text) as any;
  if (!v || typeof v !== "object") return null;
  const letter = typeof v.winner === "string" ? v.winner.trim().toUpperCase() : null;
  const index = letter ? SHEET_LETTERS.indexOf(letter as any) : -1;
  return {
    winner: index >= 0 && index < count ? index : null,
    rationale: typeof v.rationale === "string" ? v.rationale.trim() : "",
    critique: typeof v.critique === "string" ? v.critique.trim() : "",
  };
}

// ── The loop ────────────────────────────────────────────────────────────────

export type RoundLog = {
  round: number;
  drawn: Array<{ concept: string; problems: string[] } | { concept: string; closest: { title: string; iou: number } | null }>;
  sheet: Uint8Array | null;
  verdict: Verdict | null;
};

export type GenerateResult =
  | { ok: true; icon: RoleIcon; rationale: string; preview: Uint8Array; rounds: RoundLog[]; usage: { input_tokens: number; output_tokens: number }; calls: number }
  | { ok: false; reason: string; rounds: RoundLog[]; usage: { input_tokens: number; output_tokens: number }; calls: number };

const ROUNDS = 2;

/**
 * Draws, vets, judges; on a rejection or nothing usable, one more round with
 * what went wrong fed back. The answer carries the preview sheet (the winner
 * beside its siblings) and every round, so a caller can show its work.
 */
export async function generateRoleIcon(brief: IconBrief, ask: Ask): Promise<GenerateResult> {
  const usage = { input_tokens: 0, output_tokens: 0 };
  let calls = 0;
  const call = async (req: AskRequest) => {
    calls++;
    const reply = await ask(req);
    if (reply.usage) { usage.input_tokens += reply.usage.input_tokens; usage.output_tokens += reply.usage.output_tokens; }
    return reply;
  };
  const rounds: RoundLog[] = [];
  let critique: string | undefined;
  for (let round = 1; round <= ROUNDS; round++) {
    const replies = await Promise.all(DIRECTIONS.map((_, n) => call(drawRequest(brief, n, critique))));
    const vetted = replies.map((r) => {
      const raw = parseCandidate(r.text);
      return raw ? vetCandidate(raw, brief.siblings, brief.accent) : ({ ok: false, concept: "?", problems: [r.error ?? "the reply held no JSON object with concept and svg"] } as Vetted);
    });
    // Two drawers can land on one idea; the judge sees it once.
    const seen = new Set<string>();
    const survivors = vetted.filter((c): c is Extract<Vetted, { ok: true }> => {
      if (!c.ok) return false;
      const key = normalizeConcept(c.icon.concept);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const log: RoundLog = {
      round,
      drawn: vetted.map((c) => (c.ok ? { concept: c.icon.concept, closest: c.closest } : { concept: c.concept, problems: c.problems })),
      sheet: null,
      verdict: null,
    };
    rounds.push(log);
    if (!survivors.length) {
      critique = `None of the drawings could be used: ${vetted.map((c) => (c.ok ? "" : `"${c.concept}": ${c.problems.join("; ")}`)).filter(Boolean).join(" | ")}`;
      continue;
    }
    const sheet = contactSheet(survivors.map((c) => c.icon), brief.siblings);
    log.sheet = sheet;
    const verdict = parseVerdict((await call({ ...judgeRequest(brief, survivors), image: sheet })).text, survivors.length);
    log.verdict = verdict;
    if (verdict?.winner != null) {
      const won = survivors[verdict.winner];
      return { ok: true, icon: won.icon, rationale: verdict.rationale || won.reasoning, preview: contactSheet([won.icon], brief.siblings), rounds, usage, calls };
    }
    critique = verdict?.critique || "The judge rejected every candidate without saying why; try plainer, more literal metaphors drawn with fewer strokes.";
  }
  const last = rounds[rounds.length - 1];
  return { ok: false, reason: last?.verdict ? `the judge rejected every drawing: ${last.verdict.critique}` : `no drawing could be used: ${critique}`, rounds, usage, calls };
}
