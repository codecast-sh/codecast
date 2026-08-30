import { EyeOff, BarChart2, FileText, BookOpen } from "lucide-react";

export type TeamVisibility = "hidden" | "activity" | "summary" | "full";

/** The four levels a member can pick for how their work shows to the team.
 *  Defined once; the setup dialog and the create team flow both render it
 *  through components/team/VisibilityPicker. Lives in lib/ so the picker
 *  stays a clean Fast Refresh boundary (component-only exports). */
export const VISIBILITY_LEVELS = [
  {
    value: "full" as const,
    label: "Full access",
    Icon: BookOpen,
    accent: "sol-green",
    description: "Teammates can read your full sessions",
    detail:
      "Nothing is held back. Best for code review, shared debugging, and learning from each other.",
    preview: "Full conversation history visible",
    recommended: true,
  },
  {
    value: "summary" as const,
    label: "Summary",
    Icon: FileText,
    accent: "sol-cyan",
    description: "Teammates see titles and short summaries",
    detail:
      "Teammates see what you worked on and how it went, not the conversation itself.",
    preview: '"Fix auth bug — Updated login flow, added error handling"',
  },
  {
    value: "activity" as const,
    label: "Activity only",
    Icon: BarChart2,
    accent: "sol-yellow",
    description: "Teammates see workspace names and session counts",
    detail:
      "Like a status light. Teammates see that you are working, not what you are working on.",
    preview: '"3 sessions in codecast today"',
  },
  {
    value: "hidden" as const,
    label: "Hidden",
    Icon: EyeOff,
    accent: "sol-base01",
    description: "Teammates see none of your work",
    detail:
      "You still see what teammates share. They see nothing of yours. Good for private work.",
    preview: "Teammates see: nothing",
  },
];
