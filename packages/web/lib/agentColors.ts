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
  /** A selected agent chip in a new-conversation picker: fill, text, border. */
  chip: string;
}

const ACCENTS: Record<string, AgentAccent> = {
  claude_code: { text: "text-amber-400", ring: "ring-amber-400/70", chip: "bg-sol-yellow/20 text-sol-yellow border-sol-yellow/50" },
  codex: { text: "text-blue-400", ring: "ring-blue-400/70", chip: "bg-emerald-500/20 text-emerald-400 border-emerald-500/50" },
  cursor: { text: "text-purple-400", ring: "ring-purple-400/70", chip: "bg-purple-500/20 text-purple-400 border-purple-500/50" },
  gemini: { text: "text-amber-400", ring: "ring-amber-400/70", chip: "bg-blue-500/20 text-blue-400 border-blue-500/50" },
  opencode: { text: "text-orange-400", ring: "ring-orange-400/70", chip: "bg-orange-500/20 text-orange-400 border-orange-500/50" },
  pi: { text: "text-teal-400", ring: "ring-teal-400/70", chip: "bg-teal-500/20 text-teal-400 border-teal-500/50" },
  grok: { text: "text-sol-text", ring: "ring-sol-text/60", chip: "bg-sol-text/15 text-sol-text border-sol-text/40" },
  muse: { text: "text-emerald-400", ring: "ring-emerald-400/70", chip: "bg-emerald-500/15 text-emerald-400 border-emerald-500/40" },
  // The hosted Codecast assistant.
  codecast: { text: "text-sol-cyan", ring: "ring-sol-cyan/70", chip: "bg-sol-cyan/15 text-sol-cyan border-sol-cyan/45" },
};

const FALLBACK: AgentAccent = { text: "text-sol-violet", ring: "ring-sol-violet/70", chip: "bg-sol-violet/15 text-sol-violet border-sol-violet/40" };

export function agentAccent(agentType: string | undefined | null): AgentAccent {
  return (agentType && ACCENTS[agentType]) || FALLBACK;
}
