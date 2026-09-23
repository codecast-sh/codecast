import { EyeOff } from "lucide-react";
import { Switch } from "../ui/switch";
import { teamVisibilityOption, type TeamVisibilityLevel } from "../../lib/teamVisibility";
import {
  describeShareSpan,
  describeTeammates,
  listNames,
  type ShareImpact,
} from "../../lib/team/shareImpact";
import "./teamFlow.css";

export type ShareImpactBandProps = {
  teamName: string;
  memberCount?: number;
  visibility: TeamVisibilityLevel;
  /** Short names of the selected repos, for the sentence. */
  selectedNames: string[];
  impact: ShareImpact;
  includePast: boolean;
  onIncludePastChange: (value: boolean) => void;
  className?: string;
};

/**
 * What a share exposes, said before it happens: who sees how much of which
 * repos, how many sessions that is and from when, and the one switch that
 * keeps the past private. Every share control renders this same band, so a
 * person reads the same sentence in setup, in settings and in the CLI.
 */
export function ShareImpactBand({
  teamName,
  memberCount,
  visibility,
  selectedNames,
  impact,
  includePast,
  onIncludePastChange,
  className = "",
}: ShareImpactBandProps) {
  if (impact.repos === 0) {
    return (
      <p className={`flex items-center gap-1.5 text-xs text-sol-text-dim ${className}`} aria-live="polite">
        <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
        Nothing selected. Your sessions stay private to you.
      </p>
    );
  }
  const level = teamVisibilityOption(visibility);
  const hidden = visibility === "hidden";
  const hasPast = impact.sessions > 0 || !impact.exact;
  return (
    <div
      className={`tf-accent-card rounded-lg border px-4 py-3 space-y-2 ${className}`}
      role="status"
      aria-live="polite"
      data-testid="share-impact"
    >
      <p className="text-sm text-sol-text leading-relaxed">
        <span className="font-semibold">{teamName}</span>
        <span className="text-sol-text-muted"> ({describeTeammates(memberCount)})</span>
        {" will see "}
        <span className="font-semibold">{level.sees}</span>
        {" for "}
        <span className="font-medium">{listNames(selectedNames)}</span>.
      </p>
      {hidden ? (
        <p className="text-xs text-sol-yellow">
          Your level for this team is Hidden, so nothing shows until you raise it.
        </p>
      ) : (
        <p className="text-xs text-sol-text-muted tabular-nums">
          {describeShareSpan(impact, includePast)}
          {!impact.exact && <span className="text-sol-text-dim"> Still counting.</span>}
        </p>
      )}
      {hasPast && !hidden && (
        <label className="flex items-center justify-between gap-3 pt-1 text-xs text-sol-text cursor-pointer">
          <span>Include past sessions</span>
          <Switch
            checked={includePast}
            onCheckedChange={onIncludePastChange}
            aria-label="Include past sessions"
          />
        </label>
      )}
    </div>
  );
}
