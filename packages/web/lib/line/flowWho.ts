// Who does each kind of flow step, as the diagram and the station panel say it.
import { Bot, Sparkles, SquareTerminal, User, type LucideIcon } from "lucide-react";
import type { DiagramStep } from "./flowDiagram";

/** Who does a step, said on the step itself. */
export const WHO: Record<DiagramStep["kind"], { icon: LucideIcon; word: string }> = {
  agent: { icon: Bot, word: "An agent session does this" },
  script: { icon: SquareTerminal, word: "A command runs this" },
  person: { icon: User, word: "A person decides this" },
  call: { icon: Sparkles, word: "One model call answers this" },
  segment: { icon: Bot, word: "A segment" },
  parallel: { icon: Bot, word: "These run side by side" },
  join: { icon: Bot, word: "Waits for every branch" },
};
