// Where a pull request stands in production, on its own page (deploys.md
// DP16). A merged one: a chip beside its state that says whether it is live,
// and a band under the figures with one row per target it touches: the
// state, the deploy that took it there (or what runs instead), the commits
// waiting with it, and the press that sends them. An open one: the targets it
// will go to once it merges. The rule is lib/deploys/prDeploy; this draws it.
import Link from "next/link";
import { ArrowUpRight, Check, CircleDashed, X } from "lucide-react";
import type { PrDeployModel } from "../../hooks/usePrDeploy";
import { entityRoute } from "../../lib/entityLinks";
import { REACH_LOOK, deployAgo } from "../../lib/deploys/deployPill";
import { FAILED_ICON, REACH_ICON, TONE_ACCENT, TONE_TEXT } from "../../lib/deploys/deployLook";
import { CI_WORDS, deployLabel, prRowParts, type PrDeployRow } from "../../lib/deploys/prDeploy";
import type { DeployTargetRow } from "../../lib/deploys/targets";
import { deploysFocusHref } from "../../lib/deploys/focus";
import type { ExternalEventAccent } from "../../lib/externalEvents";
import type { ReachState } from "@codecast/shared/contracts/deployReach";

/** The chip beside a merged pull request's state: live, or what holds it; it opens the Deploys page at the PR. */
export function PRReachChip({ model, Chip }: { model: PrDeployModel; Chip: (p: { accent: ExternalEventAccent; title?: string; children: React.ReactNode }) => React.ReactNode }) {
  const h = model.headline;
  if (!h) return null;
  const look = REACH_LOOK[h.state];
  const Icon = REACH_ICON[h.state];
  const chip = (
    <Chip accent={TONE_ACCENT[look.tone]} title={model.teamId ? "Open on the Deploys page" : "Where this change runs in production"}>
      <Icon className={`w-3.5 h-3.5 ${h.state === "failed" ? FAILED_ICON : ""}`} />
      {h.words}
    </Chip>
  );
  // A reader outside the team (a public PR) has no Deploys page to open.
  if (!model.teamId) return <span data-pr-reach-chip={h.state} className="contents">{chip}</span>;
  // The target that needs the reader first (the band's first row), so the page opens where the headline is about.
  return (
    <Link href={deploysHrefOf(model, model.rows[0]?.target ?? null)} data-pr-reach-chip={h.state} className="no-underline rounded-full transition-[filter] hover:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sol-blue">
      {chip}
    </Link>
  );
}

const POLICY_WORDS: Record<string, string> = { auto: "on green CI", release: "with a release", press: "on a press" };
const policyWords = (t: DeployTargetRow) => (t.runs === "push" ? "when main moves" : POLICY_WORDS[t.policy] ?? "");

/** An open pull request's targets: where it goes once merged, grouped by how each one sends it; idle ones dim. */
export function PRShipsTo({ model }: { model: PrDeployModel }) {
  if (!model.open || !model.declares || !model.shipsTo) return null;
  if (!model.shipsTo.length) return <span className="text-sol-text-dim" data-pr-ships-to="none">Nothing it deploys</span>;
  const groups = new Map<string, typeof model.shipsTo>();
  for (const x of model.shipsTo) {
    const how = x.idle ? "idle" : policyWords(x.target);
    groups.set(how, [...(groups.get(how) ?? []), x]);
  }
  return (
    <span className="flex items-baseline gap-x-3 gap-y-1 flex-wrap" data-pr-ships-to={model.shipsTo.map((x) => x.target.name).join(",")}>
      {[...groups].map(([how, xs]) => (
        <span key={how} className={`whitespace-nowrap ${how === "idle" ? "opacity-60" : ""}`} title={how === "idle" ? "Shipped nothing this week" : undefined}>
          {xs.map((x, i) => (
            <span key={x.target._id}>
              {i > 0 && <span className="text-sol-text-dim">, </span>}
              <Link href={deploysHrefOf(model, x.target.name)} className="text-sol-text no-underline hover:underline">{x.target.name}</Link>
            </span>
          ))}
          <span className="ml-1 text-sol-text-dim">{how}</span>
        </span>
      ))}
    </span>
  );
}

/** A target on the Deploys page with the pull request highlighted: merged, in the queue or the deploy that took it; open, on its way. */
const deploysHrefOf = (model: Pick<PrDeployModel, "teamId" | "repository" | "number">, target: string | null) =>
  deploysFocusHref({ team: model.teamId, repository: model.repository, target, focus: { kind: "pr", pr: model.number } });

function CiWord({ ci, url }: { ci: keyof typeof CI_WORDS; url: string | null }) {
  const word = CI_WORDS[ci];
  const mark = ci === "passed" ? <Check className="w-3 h-3" strokeWidth={3} /> : ci === "failed" ? <X className="w-3 h-3" strokeWidth={3} /> : <i className="pr-deploy-ci-run" />;
  const body = <span className={`pr-deploy-ci inline-flex items-center gap-1 ${ci === "passed" ? "text-sol-green" : ci === "failed" ? "text-sol-red" : "text-sol-yellow"}`} data-ci={ci} title="CI on what a deploy now would send">{mark}{word}</span>;
  return url ? <a href={url} target="_blank" rel="noreferrer" className="no-underline hover:underline">{body}</a> : body;
}

/** A deploy in a row: its short sha in mono, a step to the deploy, with its dp-N on hover. */
function Dp({ d }: { d: { short_id: string; sha?: string | null } | null }) {
  if (!d) return null;
  return (
    <Link href={entityRoute("deploy", d.short_id) ?? "#"} className="pr-deploy-dp" title={`${d.short_id}${d.sha ? ` · ${d.sha.slice(0, 7)}` : ""}`} data-pr-deploy-dp={d.short_id}>
      {deployLabel(d)}
    </Link>
  );
}

/** What a row says after its state (lib/deploys/prDeploy prRowParts, the phone's words too), a deploy as its link. */
function RowDetail({ row, now, mergedAt }: { row: PrDeployRow; now: number; mergedAt: number | null }) {
  const parts = prRowParts(row, now, mergedAt);
  // Each part carries its own separator; the one that starts a wrapped line is clipped away (pr.css).
  return (
    <span className="pr-deploy-detail">
      <span className="pr-deploy-parts">
        {parts.map((p) => (
          <span key={p.key} className="pr-deploy-part" data-pr-deploy-part={p.key}>
            {p.kind === "ci" ? (
              <CiWord ci={p.ci} url={p.url} />
            ) : p.kind === "deploy" ? (
              <span className={`inline-flex items-baseline gap-1 ${p.tone === "dim" ? "text-sol-text-dim" : ""}`}>
                {p.before.trim()} <Dp d={p.deploy} />{p.after ?? ""}
              </span>
            ) : (
              <span className={p.tone === "dim" ? "text-sol-text-dim" : p.tone === "strong" ? "text-sol-text" : ""}>{p.text}</span>
            )}
          </span>
        ))}
      </span>
    </span>
  );
}

function StateWord({ state }: { state: ReachState }) {
  const look = REACH_LOOK[state];
  const Icon = REACH_ICON[state];
  return (
    <span className={`pr-deploy-state ${TONE_TEXT[look.tone]}`} data-reach={state}>
      <Icon aria-hidden className={`w-3.5 h-3.5 shrink-0 ${state === "failed" ? FAILED_ICON : ""}`} />
      {look.word}
    </span>
  );
}

/** A merged pull request's production band: one row per target, the one that needs the reader first. */
export function PRDeployBand({ model }: { model: PrDeployModel }) {
  const { rows, dormant, now, press } = model;
  if (!model.merged || (!rows.length && !dormant.length)) return null;
  return (
    <section className="pr-rise pr-deploy mt-3" style={{ ["--d" as string]: "240ms" }} data-pr-deploy aria-label="Production">
      <span className="pr-deploy-label text-mark uppercase tracking-wider text-sol-text-dim">Production</span>
      <ul className="pr-deploy-rows">
        {rows.map((row, i) => (
          <li key={`${row.target}#${i}`} className="pr-deploy-row" data-pr-deploy-target={row.target} data-state={row.state}>
            <Link href={deploysHrefOf(model, row.target)} className="pr-deploy-name" title={`Open ${row.target} on the Deploys page`}>
              {row.target}
            </Link>
            <StateWord state={row.state} />
            <RowDetail row={row} now={now} mergedAt={model.mergedAt} />
            {row.note && <span className="pr-deploy-note text-sol-red" title={row.note}>{row.note}</span>}
            <span className="pr-deploy-act">
              {row.press ? (
                <button type="button" className="pr-deploy-go" data-ci={row.press.queue.head_ci === "failed" ? "failed" : undefined} data-pr-deploy-go={row.target} onClick={() => press.open({ target: row.press!, action: "deploy", of: null })}>
                  {row.pressWords}
                </button>
              ) : row.blocked ? (
                <span className="text-sol-text-dim" data-pr-deploy-blocked>{row.blocked}</span>
              ) : null}
              <Link href={deploysHrefOf(model, row.target)} className="pr-deploy-open" aria-label={`Open ${row.target} on the Deploys page`} title="Open on the Deploys page">
                <ArrowUpRight className="w-3.5 h-3.5" />
              </Link>
            </span>
          </li>
        ))}
        {dormant.map((t, i) => (
          <li key={`${t.target}#idle${i}`} className="pr-deploy-row pr-deploy-row--idle" data-pr-deploy-target={t.target} data-state="idle" title="Shipped nothing this week: it does not hold the change back from live">
            <Link href={deploysHrefOf(model, t.target)} className="pr-deploy-name">{t.target}</Link>
            <span className="pr-deploy-state text-sol-text-dim"><CircleDashed aria-hidden className="w-3.5 h-3.5 shrink-0" />idle</span>
            <span className="pr-deploy-detail text-sol-text-dim">{t.at ? `last deploy ${deployAgo(t.at, now)}` : "no deploy known"}</span>
            <span />
          </li>
        ))}
      </ul>
      {press.review}
    </section>
  );
}
