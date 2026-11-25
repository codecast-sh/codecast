// A pull request's pill (changes.md CH4): one color, its state in the glyph.
// Open, draft, merged and closed each have their own icon; a pull request that
// has stopped moving (live, landed with nothing to deploy, or closed) dims like
// an answered decision; one that broke or was sent back carries a red dot. The
// lifecycle's word is kept for the hover title. The web and phone pills both
// read a pull request through this. Pure, with relative imports only.
import type { Lifecycle } from "./lifecycle";
import { isMerged, type ChangePullRequest } from "./pullRequest";

export type PrGlyph = "open" | "draft" | "merged" | "closed";
export type PrPillLook = { glyph: PrGlyph; settled: boolean; alert: boolean; word: string | null };

export function prPillLook(pr: Pick<ChangePullRequest, "state" | "draft" | "merged_at">, lifecycle: Lifecycle | null): PrPillLook {
  const merged = isMerged(pr);
  const glyph: PrGlyph = merged ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open";
  const now = lifecycle?.now.state;
  // A finished pull request is settled unless its deploy is still moving or went wrong.
  const moving = now === "active" || now === "waiting";
  const alert = now === "failed" || now === "back";
  return { glyph, settled: (merged || glyph === "closed") && !moving && !alert, alert, word: lifecycle?.now.word ?? null };
}
