import { MIN_LINE_MATCH_LEN } from "../blame";

// A comment on prose (a block of an assistant message, a paragraph or bullet of
// a doc or plan) is written against one version of the text, and the text
// moves on: an agent rewrites its plan, a doc gets edited, a paragraph is split
// in two. A block index alone then points at whatever sits there now. So a
// prose anchor keeps the block's own text, its neighbours' text and its index,
// and a reader finds the block again by content, the same way a code comment
// finds its lines (codeAnchor.ts): equal text first, then equal ignoring
// whitespace, then a scored near match.
//
// Resolving never guesses: when two blocks are equally good homes it says so,
// and when the text is gone it says outdated and names the nearest neighbour
// that survived, so the comment can be drawn there with its original quote.

/**
 * Where a prose comment points. `text` is the commented block (or the quoted
 * part of it), `before` / `after` the blocks either side, `index` the block's
 * position in the document when the comment was written. Plain strings and a
 * number, so a Convex validator describes it as
 * `{ text: v.string(), before: v.optional(v.string()), after: v.optional(v.string()), index: v.number() }`.
 */
export type ProseAnchor = {
  text: string;
  before?: string;
  after?: string;
  index: number;
};

export const PROSE_ANCHOR_MAX_CHARS = 1000;
export const PROSE_NEIGHBOUR_MAX_CHARS = 200;
/** Dice similarity a block needs to count as the commented block, edited. */
export const PROSE_NEAR_THRESHOLD = 0.6;
/** Neighbour text this similar still counts as the same neighbour. */
const NEIGHBOUR_NEAR = 0.8;
/** Scores closer than this are a tie. */
const TIE = 0.01;
/** Most blocks a split paragraph or a cross-block quote is looked for across. */
const MAX_RUN = 4;

const norm = (text: string) => text.replace(/[​-‍﻿]/g, "").replace(/\s+/g, " ").trim();
const clipText = (text: string) => text.slice(0, PROSE_ANCHOR_MAX_CHARS);
const clipNeighbour = (text: string) => text.slice(0, PROSE_NEIGHBOUR_MAX_CHARS);
const distinctive = (text: string) => norm(text).length >= MIN_LINE_MATCH_LEN;

/**
 * The anchor for block `index` of `blocks`, or undefined when there is no such
 * block. `text` is the quoted part when the comment quotes a selection rather
 * than the whole block. Text is capped at 1000 characters and each neighbour at
 * 200; matching clips the current blocks the same way.
 */
export function captureProseAnchor(blocks: readonly string[], index: number, text?: string): ProseAnchor | undefined {
  if (!Number.isInteger(index) || index < 0 || index >= blocks.length) return undefined;
  const anchor: ProseAnchor = { text: clipText(text ?? blocks[index]), index };
  if (index > 0) anchor.before = clipNeighbour(blocks[index - 1]);
  if (index + 1 < blocks.length) anchor.after = clipNeighbour(blocks[index + 1]);
  return anchor;
}

/** How the block was found: by equal text, equal ignoring whitespace, as the
 *  first of the blocks it was split into, as text inside a block (a quoted
 *  selection, or a block merged into another), or by similarity. */
export type ProseMatch = "exact" | "normalized" | "split" | "contained" | "near";

export type ProsePlacement =
  /** The block is still at its index. */
  | { state: "current"; index: number; match: ProseMatch }
  | { state: "moved"; index: number; from: number; match: ProseMatch }
  /** Several blocks fit equally well; drawn at its old index, clamped. */
  | { state: "ambiguous"; index: number; from: number; candidates: number[] }
  /** The block is gone. Drawn beside the neighbour that survived (`beside`),
   *  else at its old index clamped; `index` is null only for an empty document. */
  | { state: "outdated"; index: number | null; from: number; beside: "previous" | "next" | null };

/** Sørensen–Dice similarity of two strings over character bigrams, 0..1. */
export function proseSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const n = grams.get(g);
    if (n) {
      shared++;
      grams.set(g, n - 1);
    }
  }
  return (2 * shared) / (a.length + b.length - 2);
}

/** A candidate home: blocks `index..end` (one block unless split or quoted across). */
type Candidate = { index: number; end: number; base: number };

const sameNeighbour = (stored: string | undefined, block: string | undefined) => {
  if (stored === undefined || block === undefined) return false;
  const a = norm(stored);
  const b = norm(clipNeighbour(block));
  return a === b || proseSimilarity(a, b) >= NEIGHBOUR_NEAR;
};

/**
 * Where the commented block is in `blocks` now. Tries, in order: equal text,
 * equal ignoring whitespace, a run of blocks that together are the text (a
 * split), the text inside a block or a run starting at it (a quoted selection,
 * a merge), then the most similar block above the threshold. The first tier
 * with any candidate decides. The block at the old index wins its tier; among
 * others the neighbours break ties, and a tie they cannot break is ambiguous.
 */
export function resolveProseAnchor(anchor: ProseAnchor, blocks: readonly string[]): ProsePlacement {
  const from = anchor.index;
  const text = clipText(anchor.text);
  const want = norm(text);
  const normBlocks = blocks.map((b) => norm(clipText(b)));
  // Blocks i..i+k as one text.
  const run = (i: number, k: number) => blocks.slice(i, i + k + 1).join("\n");

  const tiers: Array<[ProseMatch, () => Candidate[]]> = [
    ["exact", () => blocks.flatMap((b, i) => (clipText(b) === text ? [{ index: i, end: i, base: 1 }] : []))],
    ["normalized", () => normBlocks.flatMap((b, i) => (b === want ? [{ index: i, end: i, base: 1 }] : []))],
    ["split", () => {
      const found: Candidate[] = [];
      for (let i = 0; i < blocks.length; i++) {
        for (let k = 1; k < MAX_RUN && i + k < blocks.length; k++) {
          if (norm(clipText(run(i, k))) === want) found.push({ index: i, end: i + k, base: 1 });
        }
      }
      return found;
    }],
    ["contained", () => {
      if (!want) return [];
      const found: Candidate[] = [];
      for (let i = 0; i < blocks.length; i++) {
        // Text this short is everywhere; it only confirms the block it was on.
        if (i !== from && !distinctive(want)) continue;
        const own = norm(blocks[i]);
        if (own.includes(want)) {
          found.push({ index: i, end: i, base: 1 });
          continue;
        }
        // A selection can run past the end of the block it started in.
        for (let k = 1; k < MAX_RUN && i + k < blocks.length; k++) {
          const at = norm(run(i, k)).indexOf(want);
          if (at >= 0) {
            if (at < own.length) found.push({ index: i, end: i + k, base: 1 });
            break;
          }
        }
      }
      return found;
    }],
    ["near", () => {
      if (!distinctive(want)) return [];
      return normBlocks.flatMap((b, i) => {
        const sim = proseSimilarity(want, b);
        return sim >= PROSE_NEAR_THRESHOLD ? [{ index: i, end: i, base: sim }] : [];
      });
    }],
  ];

  for (const [match, find] of tiers) {
    const found = find();
    if (found.length === 0) continue;
    const scored = found.map((c) => ({
      ...c,
      score: c.base
        + (sameNeighbour(anchor.before, blocks[c.index - 1]) ? 0.5 : 0)
        + (sameNeighbour(anchor.after, blocks[c.end + 1]) ? 0.5 : 0),
    }));
    const best = Math.max(...scored.map((c) => c.score));
    // A discrete tier trusts the block at its old index outright; a scored one
    // only while it is as good as the best.
    const home = scored.find((c) => c.index === from && (match !== "near" || best - c.score < TIE));
    if (home) return { state: "current", index: from, match };
    const top = scored.filter((c) => best - c.score < TIE);
    if (top.length === 1) return { state: "moved", index: top[0].index, from, match };
    return { state: "ambiguous", index: clampIndex(from, blocks.length)!, from, candidates: top.map((c) => c.index) };
  }

  return outdated(anchor, normBlocks);
}

const clampIndex = (i: number, length: number) => (length === 0 ? null : Math.min(Math.max(0, i), length - 1));

function outdated(anchor: ProseAnchor, normBlocks: string[]): ProsePlacement {
  const from = anchor.index;
  // The surviving neighbour nearest where it used to be.
  const locate = (stored: string | undefined, near: number) => {
    if (stored === undefined || !distinctive(stored)) return -1;
    const want = norm(stored);
    let best = -1;
    normBlocks.forEach((b, i) => {
      if (norm(clipNeighbour(b)) === want && (best < 0 || Math.abs(i - near) < Math.abs(best - near))) best = i;
    });
    return best;
  };
  const prev = locate(anchor.before, from - 1);
  if (prev >= 0) return { state: "outdated", index: prev, from, beside: "previous" };
  const next = locate(anchor.after, from + 1);
  if (next >= 0) return { state: "outdated", index: next, from, beside: "next" };
  return { state: "outdated", index: clampIndex(from, normBlocks.length), from, beside: null };
}

/** "moved" | "outdated" | "", for a comment chip. An ambiguous block cannot be
 *  placed, so it reads as outdated. */
export function prosePlacementLabel(placement: ProsePlacement | null): string {
  if (placement?.state === "moved") return "moved";
  if (placement?.state === "outdated" || placement?.state === "ambiguous") return "outdated";
  return "";
}
