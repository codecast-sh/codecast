// How the proposal ledger draws (ProposalSubjectCard, ChangeChips): its tones
// and sizes, and a record's status as the record's own pages draw it.
import { TASK_STATUS, type TaskStatus } from "../TaskStatusBadge";
import { PLAN_STATUS_CONFIG } from "../../lib/planStatus";
import { PROJECT_STATUS, type ProjectStatus } from "../../lib/projectStatus";

export const TEXT = "text-[color:var(--sol-text)]";
export const SOFT = "text-[color:var(--sol-text-secondary)]";
export const MUTED = "text-[color:var(--sol-text-muted)]";
export const QUIET = "text-[color:var(--ink-quiet)]";
export const RED = "text-[color:var(--ink-red)]";
export const STRUCK = "line-through decoration-1";
export const EASE = "transition-colors duration-200 motion-reduce:transition-none";
/** The three sizes of this area: sentences and titles, values, labels. */
export const SENTENCE = "text-[13.5px] leading-[20px]";
export const VALUE = "text-[12.5px] leading-[20px]";
export const LABEL = "text-[11px] leading-[20px]";

/** The kind of record a status field moves, which picks its vocabulary. */
export type RecordKind = "task" | "plan" | "project";

/** A record's status as the record's own pages draw it: glyph, word, colour. Null for a word none of them knows. */
export function statusLook(record: RecordKind | undefined, words: string) {
  const key = words.trim().replace(/ /g, "_");
  const look = record === "plan" ? PLAN_STATUS_CONFIG[key] : record === "project" ? PROJECT_STATUS[key as ProjectStatus] : TASK_STATUS[key as TaskStatus];
  return look ? { Icon: look.icon, label: look.label, color: look.color } : null;
}

export const CHIP = "inline-flex items-center gap-1.5 rounded-md px-2 py-[2px] no-underline";
