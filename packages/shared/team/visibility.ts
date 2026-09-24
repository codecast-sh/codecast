// What each team visibility level means, in the words the settings page, the
// per-session share popover, the share-in-full nudge and `cast sharing` all
// use. The rules (rank, the time split, the transition) live in the convex
// module teamVisibility.ts.

export type TeamVisibilityLevel = "hidden" | "activity" | "summary" | "full";

export type TeamVisibilityOption = {
  value: TeamVisibilityLevel;
  label: string;
  /** What teammates see, as a noun phrase: "titles and short summaries". */
  sees: string;
  /** One sentence for a menu item or a dialog. */
  detail: string;
};

export const TEAM_VISIBILITY_OPTIONS: TeamVisibilityOption[] = [
  {
    value: "hidden",
    label: "Hidden",
    sees: "nothing",
    detail: "Your sessions never appear to this team.",
  },
  {
    value: "activity",
    label: "Activity only",
    sees: "project names and session counts",
    detail: "Teammates see that you are working and where, with no titles or content.",
  },
  {
    value: "summary",
    label: "Summary",
    sees: "titles and short summaries",
    detail: "Teammates see what each session was about, not the conversation itself.",
  },
  {
    value: "full",
    label: "Full",
    sees: "the whole conversation",
    detail: "Teammates can open and read every session you share with this team.",
  },
];

export function teamVisibilityOption(level: string | null | undefined): TeamVisibilityOption {
  return TEAM_VISIBILITY_OPTIONS.find((o) => o.value === level) ?? TEAM_VISIBILITY_OPTIONS[2];
}
