"use client";
// The facts a trial card is decided against that live outside its own words:
// the rule the case breaks as the project words it now, an unmerged fix the
// proof ran on top of, and other open cards whose fix touches the same code.
// One row each, label then fact, so a reader sees what else is in play
// before answering. Change and proposal cards both draw it.
import { useTaskHref } from "../../lib/taskHrefContext";
import Link from "next/link";
import { overlapNote } from "../../lib/trialEvidence";

export type CardFactsProps = {
  rule?: { id: string; text: string } | null;
  /** The rule's label: "Rule", or on a judge-review card "Rule the judge applied". */
  ruleLabel?: string;
  builds?: { ref: string; saw: string } | null;
  /** `how`: the card's own line on how the two fixes meet (ProposalCard.alongside); shown in place of the place they share. */
  overlaps?: Array<{ card: string; task: string; title: string; where: string; on?: "code" | "rule"; how?: string }>;
  /** Waiting cards this one was measured on top of: they publish first (a judge fix's builds_on). `where` is what they edit. */
  after?: Array<{ card: string; title?: string; where: string }>;
};

export function CardFacts({ rule, ruleLabel = "Rule", builds, overlaps = [], after = [] }: CardFactsProps) {
  const taskHref = useTaskHref();
  if (!rule && !builds && !overlaps.length && !after.length) return null;
  const first = after.map((a) => ({ ...a, title: a.title ?? overlaps.find((o) => o.card === a.card)?.title ?? "" }));
  const sameCode = overlaps.filter((o) => o.on !== "rule" && !after.some((a) => a.card === o.card));
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
          <dd><Link href={taskHref(builds.ref)} className="ccd-fact-id hover:underline">{builds.ref}</Link> unmerged fix{builds.saw ? <span className="text-sol-text-dim"> · {builds.saw}</span> : null}</dd>
        </div>
      )}
      {first.length > 0 && (
        <div data-card-after>
          <dt>Publishes after</dt>
          <dd>
            {first.map((o) => (
              <span key={o.card} className="block" title={o.where}>
                <Link href={`/trial?card=${o.card}`} className="ccd-fact-id hover:underline">{o.card}</Link> {o.title}
                <span className="text-sol-text-dim"> · {o.where}</span>
              </span>
            ))}
          </dd>
        </div>
      )}
      {/* A line that concludes the two cannot conflict is no warning: it reads as a muted note. The id is the link, so the line drops its own copy of it and any file reference. */}
      {sameCode.length > 0 && (
        <div className={sameCode.every((o) => overlapNote(o).clear) ? undefined : "is-warn"} data-card-overlaps>
          <dt>Same code as</dt>
          <dd>
            {sameCode.map((o) => {
              const note = overlapNote(o);
              return (
                <span key={o.card} className={note.clear ? "block text-sol-text-dim" : "block"} title={`${o.title} · ${o.where}`} data-card-overlap={note.clear ? "clear" : "open"}>
                  {note.clear ? <>no conflict with <Link href={`/trial?card=${o.card}`} className="ccd-fact-id hover:underline">{o.card}</Link></> : <><Link href={`/trial?card=${o.card}`} className="ccd-fact-id hover:underline">{o.card}</Link>{" "}<span data-card-overlap-how>{note.text}</span></>}
                </span>
              );
            })}
          </dd>
        </div>
      )}
      {/* Other open fixes for the same rule and the same behaviour, each with its title, so a reader sees what they are and checks they do not pull opposite ways. */}
      {sameRule.length > 0 && (
        <div className="is-warn" data-card-same-rule>
          <dt>Same rule as</dt>
          <dd>
            {sameRule.map((o) => (
              <span key={o.card} className="block">
                <Link href={`/trial?card=${o.card}`} className="ccd-fact-id hover:underline">{o.card}</Link> {o.title}
              </span>
            ))}
          </dd>
        </div>
      )}
    </dl>
  );
}
