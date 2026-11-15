/**
 * Which SessionStart sources lose the conversation a task lived in. A leaf, so
 * the session start hook (cli stableContext.ts) can ask without loading the
 * task graph that formatting the resume block needs (resume.ts).
 */

const TASK_RESUME_SOURCES = ["compact", "resume"] as const;

export function restoresTaskContext(source: unknown): boolean {
  return (TASK_RESUME_SOURCES as readonly unknown[]).includes(source);
}
