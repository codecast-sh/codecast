// One accent per agent client, shared by every surface that paints an agent
// chip: the Cmd+K agent rows, the header session control panel's chips, and
// any future picker. Tailwind needs literal class names, so each entry spells
// the text and ring classes out rather than deriving them.
//
// Keyed by the convex agent_type ("claude_code", "codex", …). Unknown types
// fall back to violet, the palette's long-standing default.

export interface AgentAccent {
  /** Icon / label color. */
  text: string;
  /** Active ring around a selected chip. */
  ring: string;
}

const ACCENTS: Record<string, AgentAccent> = {
  claude_code: { text: "text-amber-400", ring: "ring-amber-400/70" },
  codex: { text: "text-blue-400", ring: "ring-blue-400/70" },
  cursor: { text: "text-purple-400", ring: "ring-purple-400/70" },
  gemini: { text: "text-amber-400", ring: "ring-amber-400/70" },
  opencode: { text: "text-orange-400", ring: "ring-orange-400/70" },
  pi: { text: "text-teal-400", ring: "ring-teal-400/70" },
  grok: { text: "text-sol-text", ring: "ring-sol-text/60" },
  muse: { text: "text-emerald-400", ring: "ring-emerald-400/70" },
};

const FALLBACK: AgentAccent = { text: "text-sol-violet", ring: "ring-sol-violet/70" };

export function agentAccent(agentType: string | undefined | null): AgentAccent {
  return (agentType && ACCENTS[agentType]) || FALLBACK;
}
