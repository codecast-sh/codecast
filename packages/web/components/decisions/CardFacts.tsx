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
  overlaps?: Array<{ card: string; task: string; title: string; where: string; on?: "code" | "rule" }>;
};

export function CardFacts({ rule, ruleLabel = "Rule", builds, overlaps = [] }: CardFactsProps) {
  if (!rule && !builds && !overlaps.length) return null;
  const sameCode = overlaps.filter((o) => o.on !== "rule");
  const sameRule = overlaps.filter((o) => o.on === "rule");
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
      {sameCode.length > 0 && (
        <div className="is-warn" data-card-overlaps>
          <dt>Same code as</dt>
          <dd>
            {sameCode.map((o) => (
              <span key={o.card} className="block" title={o.where}>
                <Link href={`/trial?card=${o.card}`} className="ccd-fact-id hover:underline">{o.card}</Link> {o.title}
                <span className="text-sol-text-dim"> · {o.where}</span>
              </span>
            ))}
          </dd>
        </div>
      )}
      {/* Other open fixes for the same rule: ids only, the proposal a hover away, so a reader checks they do not pull opposite ways. */}
      {sameRule.length > 0 && (
        <div className={sameRule.length === 1 ? "is-warn" : undefined} data-card-same-rule>
          <dt>Same rule as</dt>
          <dd className="flex flex-wrap gap-x-2">
            {sameRule.map((o) => <Link key={o.card} href={`/trial?card=${o.card}`} className="ccd-fact-id hover:underline" title={o.title}>{o.card}</Link>)}
            {sameRule.length === 1 && <span className="text-sol-text-dim">{sameRule[0].title}</span>}
          </dd>
        </div>
      )}
    </dl>
  );
}
