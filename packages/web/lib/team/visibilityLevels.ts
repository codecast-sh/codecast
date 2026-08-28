import { EyeOff, BarChart2, FileText, BookOpen } from "lucide-react";

export type TeamVisibility = "hidden" | "activity" | "summary" | "full";

/** The four levels a member can pick for how their work shows to the team.
 *  Defined once; the setup dialog and the create team flow both render it
 *  through components/team/VisibilityPicker. Lives in lib/ so the picker
 *  stays a clean Fast Refresh boundary (component-only exports). */
export const VISIBILITY_LEVELS = [
  {
    value: "full" as const,
    label: "Full Access",
    Icon: BookOpen,
    accent: "sol-green",
    description: "Teammates can read complete session transcripts",
    detail:
      "Maximum transparency. Great for code review, knowledge sharing, and collaborative debugging.",
    preview: "Full conversation history visible",
    recommended: true,
  },
  {
    value: "summary" as const,
    label: "Summary",
    Icon: FileText,
    accent: "sol-cyan",
    description: "Teammates see titles and AI-generated summaries",
    detail:
      "Share what you worked on and the outcomes without revealing full conversations. Balances transparency with privacy.",
    preview: '"Fix auth bug — Updated login flow, added error handling"',
  },
  {
    value: "activity" as const,
    label: "Activity Only",
    Icon: BarChart2,
    accent: "sol-yellow",
    description: "Teammates see workspace names and session counts",
    detail:
      'Like a status light — teammates know you\'re active in a workspace, but can\'t see any session content.',
    preview: '"3 sessions in codecast today"',
  },
  {
    value: "hidden" as const,
    label: "Hidden",
    Icon: EyeOff,
    accent: "sol-base01",
    description: "Your work is invisible to the team",
    detail:
      "You can see teammates' shared sessions, but they won't see any of yours. Good for confidential or personal workspaces.",
    preview: "Teammates see: nothing",
  },
];
