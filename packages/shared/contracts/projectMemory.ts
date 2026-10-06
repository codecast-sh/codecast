/**
 * Project memory: the corrections and decisions a project's sessions have
 * accumulated, read back at session start. Rows are consolidated in plain
 * code from the session insight (one Haiku call that already runs), so this
 * costs no inference of its own.
 */

/** The words a human uses to redirect an agent. The same words the
 *  cast-lessons skill searches for (`cast search "don't|do not|..."`): a user
 *  turn matching this is kept when the insight context samples its turns. */
export const REDIRECT_WORDS = ["don't", "do not", "never", "stop", "wrong", "not like that", "instead", "revert"] as const;
export const REDIRECT_PATTERN = new RegExp(REDIRECT_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");

export type ProjectMemoryKind = "correction" | "decision";

export interface ProjectMemoryItem {
  id: string;
  kind: ProjectMemoryKind;
  /** The correction's guidance, or the decision's title. */
  text: string;
  /** What the human said (corrections) or why (decisions). */
  detail?: string;
  count: number;
  sessions: number;
  first_seen: number;
  last_seen: number;
  promoted: boolean;
}

export interface ProjectMemoryResponse {
  project_path: string | null;
  items: ProjectMemoryItem[];
}

export const PROJECT_MEMORY_BLOCK_LIMIT = 10;

/** The `<project-memory>` block injected at session start, or "" when the
 *  project has nothing promoted. At most ten corrections and ten decisions,
 *  one line each. */
export function projectMemoryBlock(items: ProjectMemoryItem[]): string {
  const promoted = items.filter((i) => i.promoted);
  const corrections = promoted.filter((i) => i.kind === "correction").slice(0, PROJECT_MEMORY_BLOCK_LIMIT);
  const decisions = promoted.filter((i) => i.kind === "decision").slice(0, PROJECT_MEMORY_BLOCK_LIMIT);
  if (!corrections.length && !decisions.length) return "";
  const line = (i: ProjectMemoryItem) => `- ${i.text}${i.detail ? ` (${i.detail})` : ""}`;
  const sections = [
    corrections.length ? `Corrections:\n${corrections.map(line).join("\n")}` : "",
    decisions.length ? `Decisions:\n${decisions.map(line).join("\n")}` : "",
  ].filter(Boolean);
  return `<project-memory>
These are prior corrections and decisions for this project; honor them unless the human says otherwise.

${sections.join("\n\n")}
</project-memory>`;
}
