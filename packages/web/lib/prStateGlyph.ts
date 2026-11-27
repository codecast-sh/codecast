// A pull request's state as every surface draws it: the inbox chips, the panel
// above the composer, an inline reference and the phone pill. Glyphs, never
// words on the chip or pill; the words are the tooltip and the screen reader's.
// Relative imports only: the phone reads this too.
import {
  Check, CheckCheck, CircleX, Clock, Eye, FilePen, GitCompareArrows, GitMerge, GitPullRequest, GitPullRequestClosed,
  GitPullRequestDraft, TriangleAlert, type LucideIcon,
} from "lucide-react";
import type { ReachState } from "@codecast/shared/contracts/deployReach";
import { shepherdStyle, type ExternalEventAccent } from "./externalEvents";
import { REACH_ICON } from "./deploys/deployLook";
import { REACH_LOOK, type DeployTone } from "./deploys/deployPill";

/**
 * The PR glyph a state calls for, and the glyph after the number for what it waits on. Every state a pull request can
 * wear (a shepherd's, or one read off its row) is here; its words stay in shepherdStyle for tooltips and screen readers.
 */
export const PR_STATE_GLYPH: Record<string, { pr?: LucideIcon; after?: LucideIcon }> = {
  review_pending: { after: Eye },
  changes_requested: { after: FilePen },
  ci_pending: { after: Clock },
  ci_red: { after: CircleX },
  behind: { after: GitCompareArrows },
  conflicts: { after: TriangleAlert },
  approved: { after: Check },
  ready: { after: CheckCheck },
  draft: { pr: GitPullRequestDraft },
  merged: { pr: GitMerge },
  closed: { pr: GitPullRequestClosed },
};

/**
 * A pull request as drawn: `Pr` says where it is in its life (open, draft, merged, closed), `After` what it waits on,
 * `accent` whose problem that is (red broke, orange and yellow wait on a person or on checks, green is clear), and
 * `settled` that nothing is left to happen (closed, or merged and live or deploying nothing), which dims it like an
 * answered decision. `mark` and `afterMark` are the glyphs' ids in the mark legend (lib/marks/work.ts).
 */
export type PrFace = {
  state: string;
  Pr: LucideIcon;
  After?: LucideIcon;
  accent: ExternalEventAccent;
  phrase: string;
  settled: boolean;
  mark: string;
  afterMark?: string;
};

// A pull request's own states, where the shepherd table speaks for a shepherd: merged is a quiet green, like the rest.
const OWN: Record<string, { accent: ExternalEventAccent; phrase: string }> = {
  open: { accent: "green", phrase: "open" },
  draft: { accent: "muted", phrase: "draft" },
  merged: { accent: "green", phrase: "merged" },
};

const TONE_ACCENT: Record<DeployTone, ExternalEventAccent> = { green: "green", yellow: "yellow", red: "red", orange: "orange", muted: "muted", dim: "muted" };

/** A state's face. A merged one with its deploy reach read says how far it got until it is live. */
export function prFace(state: string | null | undefined, reach?: ReachState | null): PrFace {
  const key = state || "open";
  const glyph = PR_STATE_GLYPH[key] ?? {};
  const style = OWN[key] ?? shepherdStyle(key);
  const life = glyph.pr ? key : "open";
  const face: PrFace = {
    state: key,
    Pr: glyph.pr ?? GitPullRequest,
    After: glyph.after,
    accent: style.accent,
    phrase: style.phrase,
    settled: key === "closed",
    mark: `pr.${life}`,
    afterMark: glyph.after ? (key === "ci_red" ? "pr.failing" : `pr.${key}`) : undefined,
  };
  if (key !== "merged") return face;
  if (!reach || reach === "live") return { ...face, phrase: reach === "live" ? "merged and live" : "merged", settled: true };
  const look = REACH_LOOK[reach];
  return { ...face, After: REACH_ICON[reach], afterMark: `deploy.${reach}`, accent: TONE_ACCENT[look.tone], phrase: `merged, ${look.word}` };
}
