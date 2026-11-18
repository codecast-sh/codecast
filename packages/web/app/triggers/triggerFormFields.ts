// What the trigger form sends for a trigger's prompt, title, mode, agent and
// checkout. A new trigger states them all. An edit sends only what the person
// changed from the form's own starting values: the form shows any stored agent
// it does not offer (grok, gemini, an unset one) as claude, so restating every
// field turned a schedule-only save into an agent change, and changing what a
// trigger runs is for the account that runs it alone (convex agentTasks
// assertMayRewrite), so a teammate's save was refused for a field never touched.
import { HOSTED_AGENT_TYPE } from "@codecast/shared/contracts/assistant";

export type TriggerRunValues = { prompt: string; title: string; mode: "propose" | "apply"; agent: "claude" | "codex"; project: string };

/** A stored trigger as the form shows it: the starting values an edit is
 *  compared against. A new trigger starts in apply mode on claude. */
export function runValuesOf(t: { prompt?: string; title?: string; mode?: string; agent_type?: string; project_path?: string } | undefined): TriggerRunValues {
  if (!t) return { prompt: "", title: "", mode: "apply", agent: "claude", project: "" };
  return { prompt: t.prompt ?? "", title: t.title ?? "", mode: t.mode === "apply" ? "apply" : "propose", agent: t.agent_type === "codex" ? "codex" : "claude", project: t.project_path ?? "" };
}

export function triggerFormFields(init: TriggerRunValues, now: TriggerRunValues, opts: { isEdit: boolean; hosted: boolean }): Record<string, any> {
  const prompt = now.prompt.trim();
  const title = now.title.trim() || undefined;
  const project = now.project.trim();
  if (!opts.isEdit) {
    return { prompt, title, mode: now.mode, agent_type: opts.hosted ? HOSTED_AGENT_TYPE : now.agent, ...(opts.hosted ? {} : { project_path: project || undefined }) };
  }
  const out: Record<string, any> = {};
  if (prompt !== init.prompt.trim()) out.prompt = prompt;
  if (now.title.trim() !== init.title.trim()) out.title = title;
  if (now.mode !== init.mode) out.mode = now.mode;
  if (!opts.hosted && now.agent !== init.agent) out.agent_type = now.agent;
  if (!opts.hosted && project !== init.project.trim()) out.project_path = project;
  return out;
}
