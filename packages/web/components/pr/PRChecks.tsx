import { CheckCircle2, CircleSlash, ExternalLink, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { accentSoft, accentVar } from "../../lib/externalEvents";
import { relTimeShort } from "../../lib/utils";
import {
  CHECK_OUTCOME_ACCENT,
  checkOutcome,
  compareChecks,
  foldChecks,
  type CheckOutcome,
  type PrCheck,
} from "../../lib/prView";

// The Checks tab. Failures first, because that is the only reason anyone opens
// it. Each row is one check run or commit status on the head commit.

const OUTCOME_ICON: Record<CheckOutcome, typeof CheckCircle2> = {
  passed: CheckCircle2,
  failed: XCircle,
  pending: Loader2,
  skipped: CircleSlash,
};

export function PRChecks({ checks }: { checks: PrCheck[] | undefined }) {
  const rows = [...(checks ?? [])].sort(compareChecks);
  const fold = foldChecks(checks);

  if (rows.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 px-8 text-center">
        <ShieldCheck className="w-8 h-8 text-sol-text-dim/40" />
        <p className="text-[13px] text-sol-text-muted">No checks on this pull request</p>
        <p className="text-[12px] text-sol-text-dim max-w-sm">
          Check runs appear once the codecast GitHub app has permission to read them. Grant it in
          the repository settings and the next push fills this in.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-5 py-4" data-main-scroll>
      <div className="mb-3 text-[11px] text-sol-text-dim">
        {fold.failed > 0 && <span className="text-sol-red">{fold.failed} failed · </span>}
        {fold.pending > 0 && <span className="text-sol-yellow">{fold.pending} running · </span>}
        {fold.passed} passed of {fold.total}
      </div>
      <div className="space-y-1.5">
        {rows.map((check) => {
          const outcome = checkOutcome(check);
          const accent = CHECK_OUTCOME_ACCENT[outcome];
          const Icon = OUTCOME_ICON[outcome];
          const body = (
            <>
              <Icon
                className={`w-4 h-4 shrink-0 ${outcome === "pending" ? "animate-spin" : ""}`}
                style={{ color: accentVar(accent) }}
              />
              <span className="font-mono text-[12px] text-sol-text truncate">{check.name}</span>
              <span className="text-[11px]" style={{ color: accentVar(accent) }}>
                {(check.conclusion || check.status || "").replace(/_/g, " ")}
              </span>
              <span className="ml-auto text-[11px] text-sol-text-dim shrink-0">
                {relTimeShort(check.updated_at)}
              </span>
              {check.url && <ExternalLink className="w-3 h-3 text-sol-text-dim shrink-0" />}
            </>
          );
          const className =
            "pr-rise flex items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors hover:border-sol-border";
          const style = { borderColor: accentSoft(accent, 25), background: accentSoft(accent, 5) };
          return check.url ? (
            <a
              key={check.name}
              href={check.url}
              target="_blank"
              rel="noopener noreferrer"
              className={className}
              style={style}
            >
              {body}
            </a>
          ) : (
            <div key={check.name} className={className} style={style}>
              {body}
            </div>
          );
        })}
      </div>
    </div>
  );
}
