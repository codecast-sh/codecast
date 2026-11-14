import type { SwitchLedger } from "../components/consequential/ConsequentialSwitch";

export const HAND_AGENTS = [
  { type: "claude_code", label: "Claude Code" },
  { type: "codex", label: "Codex" },
] as const;

export const handAgentLabel = (type: string) => HAND_AGENTS.find((a) => a.type === type)?.label ?? HAND_AGENTS[0].label;
export const handAgentType = (label: string) => HAND_AGENTS.find((a) => a.label === label)?.type ?? HAND_AGENTS[0].type;

export type HandFacts = {
  place: string;
  preview: string;
  lines: number;
  agentType: string;
  folder?: string;
  machine?: string | null;
  machineOffline?: boolean;
  rebind?: string | null;
  held?: boolean;
  privateRoom?: boolean;
};

export const HAND_BRIEF_MAX_LINES = 41;

const clip = (text: string, n: number) => {
  const words = text.trim().replace(/\s+/g, " ");
  return words.length > n ? `${words.slice(0, n - 1)}…` : words;
};

export function handLedger(f: HandFacts): SwitchLedger {
  return {
    name: "Hand to agent",
    subject: f.place,
    shift: null,
    figures: [
      { value: "1", label: "new session", tone: "warn" },
      { value: String(Math.min(f.lines, HAND_BRIEF_MAX_LINES)), label: f.lines === 1 ? "line as its brief" : "lines as its brief" },
    ],
    pick: { k: "Agent", options: HAND_AGENTS.map((a) => a.label), value: handAgentLabel(f.agentType) },
    rows: [
      { k: "Thread", v: clip(f.preview || "(attachment)", 120) },
      { k: "Answers", v: "Here, as a reply" },
      { k: "Replies", v: f.privateRoom ? "Only yours reach it" : "Yours, and others' if it's shared" },
      ...(f.machine && f.machineOffline ? [{ k: "Starts", v: `When ${f.machine} is back online`, tone: "warn" as const }] : []),
      ...(f.rebind ? [{ k: "Takes over", v: f.rebind, tone: "warn" as const }] : []),
    ],
    stop: "Stop it from its session",
    confirm: "Start agent",
    keep: "Cancel",
    ...(f.held ? { blocked: "Handed to someone else's session" } : !f.machine ? { blocked: "No machine to run it on" } : !f.folder ? { blocked: "Pick a folder" } : {}),
  };
}
