import { useState } from "react";
import { EyeOff } from "lucide-react";
import { Switch } from "../ui/switch";
import { teamVisibilityOption, type TeamVisibilityLevel } from "../../lib/teamVisibility";
import {
  describeShareSpan,
  describeTeammates,
  listNames,
  startOfDay,
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
  /** The share start: null shares everything, a number keeps older sessions private. */
  since: number | null;
  onSinceChange: (since: number | null) => void;
  /** A switch (past on or off) for setup; radios with a date for a review. */
  controls?: "switch" | "scope";
  className?: string;
};

function dateInputValue(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * What a share exposes, said before it happens: who sees how much of which
 * repos, how many sessions that is and from when, and the control that keeps
 * the past private. Every share control renders this same band, so a person
 * reads the same sentence in setup, in settings and in the CLI.
 */
export function ShareImpactBand({
  teamName,
  memberCount,
  visibility,
  selectedNames,
  impact,
  since,
  onSinceChange,
  controls = "switch",
  className = "",
}: ShareImpactBandProps) {
  // The date field keeps its own text so a half typed date does not move
  // the share start until it parses.
  const [dateText, setDateText] = useState(() => dateInputValue(since ?? Date.now()));
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
  const today = startOfDay();
  const scope: "all" | "today" | "date" =
    since == null ? "all" : since === today ? "today" : "date";
  const pickDate = (text: string) => {
    setDateText(text);
    const parsed = new Date(`${text}T00:00:00`).getTime();
    if (Number.isFinite(parsed)) onSinceChange(parsed);
  };
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
          {describeShareSpan(impact, since)}
          {!impact.exact && <span className="text-sol-text-dim"> Still counting.</span>}
        </p>
      )}
      {hasPast && !hidden && controls === "switch" && (
        <label className="flex items-center justify-between gap-3 pt-1 text-xs text-sol-text cursor-pointer">
          <span>Include past sessions</span>
          <Switch
            checked={since == null}
            onCheckedChange={(on) => onSinceChange(on ? null : today)}
            aria-label="Include past sessions"
          />
        </label>
      )}
      {!hidden && controls === "scope" && (
        <div role="radiogroup" aria-label="Which sessions" className="grid gap-1 pt-1 text-xs text-sol-text">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" name="share-scope" checked={scope === "all"} onChange={() => onSinceChange(null)} className="accent-[var(--tf-acc)]" />
            <span>Everything, past sessions included</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" name="share-scope" checked={scope === "today"} onChange={() => onSinceChange(today)} className="accent-[var(--tf-acc)]" />
            <span>From today on</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" name="share-scope" checked={scope === "date"} onChange={() => pickDate(dateText)} className="accent-[var(--tf-acc)]" />
            <span>Since a date</span>
            <input
              type="date"
              value={dateText}
              max={dateInputValue(Date.now())}
              onChange={(e) => pickDate(e.target.value)}
              onFocus={() => { if (scope !== "date") pickDate(dateText); }}
              aria-label="Share sessions started on or after this date"
              className="ml-1 rounded border border-sol-border bg-sol-bg px-1.5 py-0.5 text-xs text-sol-text"
            />
          </label>
        </div>
      )}
    </div>
  );
}
