// A pull request's pill (changes.md CH4): its glyph is its state (open, draft,
// merged or closed), and its change's track and glyph follow its name. The
// lifecycle's word is kept for the label and hover title. The web and phone
// pills both read a pull request through this. Pure, with relative imports only.
import type { Lifecycle } from "./lifecycle";
import { isMerged, type ChangePullRequest } from "./pullRequest";

export type PrGlyph = "open" | "draft" | "merged" | "closed";
export type PrPillLook = { glyph: PrGlyph; word: string | null };

export function prPillLook(pr: Pick<ChangePullRequest, "state" | "draft" | "merged_at">, lifecycle: Lifecycle | null): PrPillLook {
  const glyph: PrGlyph = isMerged(pr) ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open";
  return { glyph, word: lifecycle?.now.word ?? null };
}
