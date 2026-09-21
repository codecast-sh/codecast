import { toolVisual, type ToolColorToken } from "@codecast/shared/render";

export function assistantLabel(agentType?: string): string {
  if (!agentType) return "Assistant";
  if (agentType === "codex") return "Codex";
  if (agentType === "cursor") return "Cursor";
  if (agentType === "gemini") return "Gemini";
  if (agentType === "opencode") return "OpenCode";
  if (agentType === "pi") return "pi";
  if (agentType === "grok") return "Grok";
  if (agentType === "muse") return "Muse Spark";
  return "Claude";
}

const TOOL_COLOR_CLASS: Record<ToolColorToken, string> = {
  green: "text-sol-green/80",
  blue: "text-sol-blue/80",
  violet: "text-sol-violet/80",
  orange: "text-sol-orange/80",
  cyan: "text-sol-cyan/80",
  magenta: "text-sol-magenta/80",
  red: "text-sol-red/80",
  textDim: "text-sol-text-dim",
  emerald: "text-emerald-500/80",
  amber: "text-amber-500/80",
};

export function toolColorClass(name: string): string {
  return TOOL_COLOR_CLASS[toolVisual(name).color];
}

export const agentColorMap: Record<string, string> = {
  blue: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  red: "bg-red-500/20 text-red-400 border-red-500/30",
  green: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  yellow: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  purple: "bg-violet-500/20 text-violet-400 border-violet-500/30",
  cyan: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
  orange: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  pink: "bg-pink-500/20 text-pink-400 border-pink-500/30",
};

// Text-only companion to agentColorMap, for chrome that carries the sender's
// color without a chip around it.
export const agentTextMap: Record<string, string> = {
  blue: "text-blue-400",
  red: "text-red-400",
  green: "text-emerald-400",
  yellow: "text-amber-400",
  purple: "text-violet-400",
  cyan: "text-cyan-400",
  orange: "text-orange-400",
  pink: "text-pink-400",
};

export const agentBorderMap: Record<string, string> = {
  blue: "border-blue-500/30",
  red: "border-red-500/30",
  green: "border-emerald-500/30",
  yellow: "border-amber-500/30",
  purple: "border-violet-500/30",
  cyan: "border-cyan-500/30",
  orange: "border-orange-500/30",
  pink: "border-pink-500/30",
};
