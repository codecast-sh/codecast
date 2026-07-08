import { getBuiltinCommands } from "./builtinCommands";
import { extractSkillsFromMessages, type SkillItem } from "./conversationProcessor";

/**
 * Resolve the slash-command list for a session's compose box: the user's
 * available skills (global + project-scoped, synced by the daemon into
 * currentUser.available_skills) merged with the agent's built-in commands.
 *
 * Pure and shared so the in-conversation input (ConversationView) and the
 * floating new-session popup (ComposeView) derive the SAME list — previously the
 * popup passed no skills at all, so typing "/" there showed nothing.
 *
 * `availableSkills` is the raw currentUser.available_skills JSON: either a flat
 * array (legacy) or a map keyed by project_path with a "global" bucket.
 */
export function resolveSessionSkills(opts: {
  availableSkills?: string | null;
  projectPath?: string | null;
  agentType?: string | null;
  messages?: unknown[];
}): SkillItem[] {
  const { availableSkills, projectPath, agentType, messages } = opts;
  let extracted: SkillItem[] = [];
  if (availableSkills) {
    try {
      const parsed = JSON.parse(availableSkills);
      if (Array.isArray(parsed)) {
        extracted = parsed;
      } else {
        const global: SkillItem[] = parsed["global"] || [];
        const project: SkillItem[] = projectPath ? parsed[projectPath] || [] : [];
        const seen = new Set<string>();
        for (const s of [...global, ...project]) {
          if (!seen.has(s.name)) {
            seen.add(s.name);
            extracted.push(s);
          }
        }
      }
    } catch {}
  }
  if (!extracted.length && messages) {
    extracted = extractSkillsFromMessages(messages as any);
  }
  const builtins = getBuiltinCommands(agentType || undefined);
  const names = new Set(extracted.map((s) => s.name.toLowerCase()));
  return [...extracted, ...builtins.filter((b) => !names.has(b.name.toLowerCase()))];
}
