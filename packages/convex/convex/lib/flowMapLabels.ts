// What a flow map row is called, what notices its problems, and which group it
// sits in. A finder's own declaration (the line profile's label, what, group)
// wins; these are the fallbacks: judges by name, event sources by name and
// kind, and the fixed sources codecast itself files. Pure.
import type { FlowMapGroup } from "@codecast/shared/contracts/flowMap";

export type RowWords = { label: string; what: string; group: FlowMapGroup };

const FIXED: Record<string, RowWords> = {
  person: { label: "Teammate reports", what: "Someone on the team reports a problem", group: "people" },
  "judge-review": { label: "Judge mistakes", what: "A finding marked wrong, so the judge that made it gets fixed", group: "pipeline" },
  agentwatch: { label: "AgentWatch findings", what: "AgentWatch notices a problem in its own pipeline", group: "pipeline" },
  lesson: { label: "Lessons", what: "A lesson a finished run wrote down", group: "pipeline" },
  evals: { label: "Eval reds", what: "An eval scenario turns red", group: "product" },
};

/** What each transition an event source announces is, as a row reads it. */
const TRANSITION_WORDS: Record<string, { noun: string; what: string }> = {
  new: { noun: "new issues", what: "New or regressed issues" },
  regressed: { noun: "regressions", what: "Issues that came back" },
  check_failed: { noun: "failing checks", what: "Checks that fail" },
  job_failed: { noun: "failed jobs", what: "Background jobs that fail" },
  metric_alert: { noun: "metric alerts", what: "A watched metric leaves its band" },
};

/** A label as a row shows it: a name that falls back to a judge's or a source's own starts with a capital. */
const capFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** An event source as the row of what it files ("sdk:union-errors"): its name and provider. */
export function eventSourceWords(src: { name: string; provider: string }, transition?: string): RowWords {
  const t = transition ? TRANSITION_WORDS[transition] : null;
  if (t) return { label: capFirst(`${src.name} ${t.noun}`), what: `${t.what}, from ${src.provider} source ${src.name}`, group: "product" };
  return { label: capFirst(src.name), what: `Issues the ${src.provider} source ${src.name} opens`, group: "product" };
}

/** A finding source's fallback words; `finder` is its line profile declaration, when one names it. */
export function sourceWords(key: string, finder?: { label?: string; what?: string; group?: FlowMapGroup } | null, src?: { name: string; provider: string } | null): RowWords {
  const base: RowWords =
    FIXED[key] ??
    (key.startsWith("eval") ? FIXED.evals : null) ??
    (key.startsWith("judge:") ? { label: `${key.slice(6)} judge`, what: `The ${key.slice(6)} judge reads each moment and files what went wrong`, group: "conversations" } : null) ??
    (src ? eventSourceWords(src) : { label: key, what: "", group: "product" });
  return { label: capFirst(finder?.label?.trim() || base.label), what: finder?.what?.trim() || base.what, group: finder?.group ?? base.group };
}
