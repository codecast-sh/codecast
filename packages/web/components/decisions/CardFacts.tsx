"use client";
// The facts a trial card is decided against that live outside its own words:
// the rule the case breaks as the project words it now, an unmerged fix the
// proof ran on top of, and other open cards whose fix touches the same code.
// One row each, label then fact, so a reader sees what else is in play
// before answering. Change and proposal cards both draw it.
import Link from "next/link";

export type CardFactsProps = {
  rule?: { id: string; text: string } | null;
  /** The rule's label: "Rule", or on a judge-review card "Rule the judge applied". */
  ruleLabel?: string;
  builds?: { ref: string; saw: string } | null;
  overlaps?: Array<{ card: string; task: string; title: string; where: string }>;
};

export function CardFacts({ rule, ruleLabel = "Rule", builds, overlaps = [] }: CardFactsProps) {
  if (!rule && !builds && !overlaps.length) return null;
  return (
    <dl className="ccd-facts" data-card-facts>
      {rule && (
        <div data-card-rule>
          <dt>{ruleLabel}</dt>
          <dd><code className="ccd-fact-id">{rule.id}</code> {rule.text}</dd>
        </div>
      )}
      {builds && (
        <div className="is-warn" data-card-builds>
          <dt>Builds on</dt>
          <dd><Link href={`/tasks/${builds.ref}`} className="ccd-fact-id hover:underline">{builds.ref}</Link> unmerged fix{builds.saw ? <span className="text-sol-text-dim"> · {builds.saw}</span> : null}</dd>
        </div>
      )}
      {overlaps.length > 0 && (
        <div className="is-warn" data-card-overlaps>
          <dt>Same code as</dt>
          <dd>
            {overlaps.map((o) => (
              <span key={o.card} className="block" title={o.where}>
                <Link href={`/trial?card=${o.card}`} className="ccd-fact-id hover:underline">{o.card}</Link> {o.title}
                <span className="text-sol-text-dim"> · {o.where}</span>
              </span>
            ))}
          </dd>
        </div>
      )}
    </dl>
  );
}
