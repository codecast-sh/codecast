// A problem's score and family as the lists read them (tasks.cause.scored,
// shared/contracts/problemScore.ts): the value of fixing it next, and the
// family its cause belongs to. Pure.

/** A problem's score and family (tasks.cause.scored, problemScore.ts), as the lists read them. */
export type ProblemScoreFacts = {
  /** 1 to 100: the value of fixing it next. */
  score: number;
  /** The family its cause belongs to; null while it has none ("other" is a family of its own). */
  family: { key: string; name: string } | null;
  reason: string;
};

type Scored = { score: number; reason: string; cluster_key?: string; cluster_name?: string };
/** A task as far as its score is read: any task row, whose cause may carry `scored`. */
export type ScoredTask = { cause?: object | null };

/** A task's score and family, or null when nothing scored it yet. */
export function scoreOf(task: ScoredTask | null | undefined): ProblemScoreFacts | null {
  const s = (task?.cause as { scored?: Scored | null } | null | undefined)?.scored;
  if (!s || typeof s.score !== "number") return null;
  return { score: s.score, reason: s.reason, family: s.cluster_key ? { key: s.cluster_key, name: s.cluster_name ?? s.cluster_key } : null };
}

/** A score's band, for its color: what is worth fixing next stands out. */
export const scoreBand = (s: number): "high" | "mid" | "low" => (s >= 70 ? "high" : s >= 40 ? "mid" : "low");
