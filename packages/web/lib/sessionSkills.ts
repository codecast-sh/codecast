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

// A slash command opens at the start of the text or of any word, so a skill
// can be named mid-sentence; a "/" inside a word (a path, "and/or") is prose.
export const SLASH_TRIGGER_RE = /(?:^|\s)\/([\w:.-]*)$/;
export const SLASH_QUERY_RE = /^[\w:.-]*/;

/** The slash command being typed at the caret: where its "/" sits and the query after it, or null. */
export function slashQueryAt(textBeforeCaret: string): { start: number; query: string } | null {
  const m = textBeforeCaret.match(SLASH_TRIGGER_RE);
  return m ? { start: textBeforeCaret.length - m[1].length - 1, query: m[1].toLowerCase() } : null;
}

/** The skills a typed query names, in list order. */
export function matchSlashSkills(skills: SkillItem[] | undefined, query: string, limit = 30): SkillItem[] {
  return (skills ?? []).filter((s) => s.name.toLowerCase().includes(query)).slice(0, limit);
}

/** The text with the slash token at `start` replaced by the picked command (its whole token, so a mid-word pick leaves no tail), and where the caret lands. */
export function applySlashSkill(text: string, start: number, name: string): { text: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(start + 1).replace(SLASH_QUERY_RE, "").replace(/^ /, "");
  const inserted = `/${name} `;
  return { text: before + inserted + after, caret: before.length + inserted.length };
}
