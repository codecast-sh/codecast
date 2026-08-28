import { EyeOff, BarChart2, FileText, BookOpen } from "lucide-react";

export type TeamVisibility = "hidden" | "activity" | "summary" | "full";

/** The four levels a member can pick for how their work shows to the team.
 *  Defined once; the setup dialog and the create team flow both render it. */
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

/** Controlled list of visibility cards. The parent owns the value. */
export function VisibilityPicker({
  value,
  onChange,
  className = "",
}: {
  value: TeamVisibility;
  onChange: (value: TeamVisibility) => void;
  className?: string;
}) {
  return (
    <div className={`space-y-2.5 ${className}`}>
      {VISIBILITY_LEVELS.map((level) => {
        const selected = value === level.value;
        const Icon = level.Icon;
        return (
          <button
            key={level.value}
            type="button"
            onClick={() => onChange(level.value)}
            className={`w-full rounded-xl border px-5 py-4 text-left transition-all relative ${
              selected
                ? "border-sol-cyan bg-sol-cyan/[0.06] ring-1 ring-sol-cyan/30"
                : "border-sol-border hover:border-sol-base01 hover:bg-sol-bg-alt/40"
            }`}
          >
            {level.recommended && (
              <span className="absolute top-3 right-4 text-[10px] uppercase tracking-wider font-semibold text-sol-cyan">
                Recommended
              </span>
            )}
            <div className="flex items-start gap-4">
              <div
                className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors ${
                  selected
                    ? "bg-sol-cyan/15 text-sol-cyan"
                    : "bg-sol-bg-alt text-sol-base01"
                }`}
              >
                <Icon className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-sol-text">
                  {level.label}
                </div>
                <div className="mt-0.5 text-sm text-sol-base1">
                  {level.description}
                </div>
                <div className="mt-2 text-xs text-sol-text-dim leading-relaxed">
                  {level.detail}
                </div>
                <div className="mt-2 rounded-md bg-sol-bg-alt/60 border border-sol-border/50 px-3 py-1.5 text-xs text-sol-base1 font-mono">
                  {level.preview}
                </div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
