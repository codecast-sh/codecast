// The project a session works in, as the session reads it at start
// (docs/architecture/session-projects.md SP6): its charter, its standing
// instructions, its memory (the project's pinned docs) and its main session.
// Served inside org.where (convex/orgWhere.ts) and by projectContext.forSession;
// rendered once here, injected by stable context at start and by the task
// context hook after compaction or a resume.
import { escapeForeignControlChars, inlineForeignText, capForeignText, fenceNonce } from "./fence";

export type ProjectMemoryItem = { id: string; title: string; gist: string };

export type ProjectContext = {
  id: string;
  short_id: string | null;
  title: string;
  goal: string | null;
  success_metrics: string[];
  instructions: string | null;
  /** The project's pinned docs, newest first, at most PROJECT_MEMORY_SHOWN. */
  memory: ProjectMemoryItem[];
  /** Pinned docs past the ones listed. */
  memory_more: number;
  main_session: { short_id: string | null; title: string | null } | null;
  /** The reading session is the project's main session. */
  is_main: boolean;
};

/** The most a project's instructions may hold, in UTF-8 bytes (projects.update refuses more). */
export const PROJECT_INSTRUCTIONS_MAX = 16_000;
/** How much of the instructions the injected block carries, in UTF-8 bytes; a session start shares a ~9KB hook budget. */
export const PROJECT_INSTRUCTIONS_SHOWN = 3_500;
/** The fewest bytes of instructions a block keeps however tight its room. */
const INSTRUCTIONS_FLOOR = 200;
/** How many memory docs the block lists. */
export const PROJECT_MEMORY_SHOWN = 12;
const GIST_CHARS = 140;
const METRICS_SHOWN = 6;

/** Text length as the hook budgets count it. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** `text` capped to at most `maxBytes` UTF-8 bytes, marker included, cut on a character. */
function capForeignTextBytes(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  let lo = 0, hi = Math.min(text.length, maxBytes);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8Bytes(capForeignText(text, mid)) <= maxBytes) lo = mid; else hi = mid - 1;
  }
  return capForeignText(text, lo);
}

/** The first line of a doc's body that is not its title heading, as one short line. */
export function memoryGist(content: string, title: string): string {
  for (const raw of (content ?? "").split("\n")) {
    const line = raw.trim().replace(/^#+\s*/, "").replace(/^[-*>]\s+/, "");
    if (!line || line === title.trim()) continue;
    return capForeignText(inlineForeignText(line), GIST_CHARS);
  }
  return "";
}

const ref = (p: { short_id: string | null; id: string }) => p.short_id ?? p.id;

export function projectContextLines(p: ProjectContext): string[] {
  const id = ref(p);
  const out = [`Project: ${id} ${inlineForeignText(p.title)}`];
  out.push(p.goal ? `Goal: ${inlineForeignText(p.goal)}` : "Goal: not set");
  if (p.success_metrics.length) {
    out.push("Success is checked by:");
    for (const m of p.success_metrics.slice(0, METRICS_SHOWN)) out.push(`  - ${inlineForeignText(m)}`);
    if (p.success_metrics.length > METRICS_SHOWN) out.push(`  +${p.success_metrics.length - METRICS_SHOWN} more: cast project show ${id}`);
  } else out.push("Success is checked by: not set");
  const main = p.main_session;
  out.push(main
    ? `Main session: ${[main.short_id, main.title && inlineForeignText(main.title)].filter(Boolean).join(" ")}${p.is_main ? " (this session)" : ""}`
    : "Main session: none yet");
  return out;
}

/** The block injected for a session in a project. `nonce` keeps text inside it from closing it;
 *  `instructionsBytes` narrows how much of the instructions it carries, to fit a hook's budget. */
export function projectContextBlock(p: ProjectContext, opts: { nonce?: string; instructionsBytes?: number } = {}): string {
  const nonce = opts.nonce ?? fenceNonce();
  const id = ref(p);
  const lines = [`<project-context-${nonce} project="${id}">`, "The project this session works in, read at session start.", "", ...projectContextLines(p)];

  if (p.instructions?.trim()) {
    const text = escapeForeignControlChars(p.instructions.trim());
    const room = Math.max(INSTRUCTIONS_FLOOR, Math.min(PROJECT_INSTRUCTIONS_SHOWN, opts.instructionsBytes ?? PROJECT_INSTRUCTIONS_SHOWN));
    const shown = utf8Bytes(text) > room
      ? `${capForeignTextBytes(text, room)}\nThe rest: cast project show ${id}`
      : text;
    lines.push("", "The project's instructions, which every session in it follows:", `<instructions-${nonce}>`, shown, `</instructions-${nonce}>`);
  }

  const total = p.memory.length + p.memory_more;
  lines.push("");
  if (total) {
    lines.push(`Project memory (${total} pinned doc${total === 1 ? "" : "s"}; cast doc show <id> opens one):`);
    for (const m of p.memory) lines.push(`  - ${m.id} ${inlineForeignText(m.title)}${m.gist ? `: ${m.gist}` : ""}`);
    if (p.memory_more) lines.push(`  +${p.memory_more} more: cast project memory ${id}`);
  } else lines.push("Project memory: empty.");

  lines.push(
    "",
    `The project memory is shared by every session in this project. When you learn something every session here should know (a decision, a constraint, a fact about the work that is not in the code), record it once with cast project remember "<fact>"; cast project forget <doc> takes out one that no longer holds.`,
    p.is_main
      ? "This is the project's main session: findings that change the project's direction come here, and the goal, instructions and memory are yours to keep current."
      : p.main_session?.short_id
        ? `A finding that changes the whole project's direction goes to its main session (cast send ${p.main_session.short_id}), not only into your own work.`
        : "A finding that changes the whole project's direction goes to the person, and into the project memory.",
  );
  if (!p.goal && p.is_main) {
    lines.push(`The project's goal and how success will be checked are not set. Before building, work them out with the person, interviewing them where it helps, and record them with cast project update ${id} --goal and --metric.`);
  }
  lines.push(`</project-context-${nonce}>`);
  return lines.join("\n");
}

/** The block in at most `roomBytes` UTF-8 bytes where it can be: its instructions
 *  give way first, down to a floor; the rest of the block is always whole. */
export function fitProjectContextBlock(p: ProjectContext, roomBytes: number, opts: { nonce?: string } = {}): string {
  const nonce = opts.nonce ?? fenceNonce();
  const full = projectContextBlock(p, { nonce });
  if (!p.instructions?.trim() || utf8Bytes(full) <= roomBytes) return full;
  let lo = INSTRUCTIONS_FLOOR, hi = PROJECT_INSTRUCTIONS_SHOWN;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8Bytes(projectContextBlock(p, { nonce, instructionsBytes: mid })) <= roomBytes) lo = mid; else hi = mid - 1;
  }
  return projectContextBlock(p, { nonce, instructionsBytes: lo });
}
