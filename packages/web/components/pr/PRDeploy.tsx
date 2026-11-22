// Where a pull request stands in production, on its own page (deploys.md
// DP16). A merged one: a chip beside its state that says whether it is live,
// and a band under the figures with one row per target it touches: the
// state, the deploy that took it there (or what runs instead), the commits
// waiting with it, and the press that sends them. An open one: the targets it
// will go to once it merges. The rule is lib/deploys/prDeploy; this draws it.
import { useMemo } from "react";
import Link from "next/link";
import { ArrowUpRight, Check, CircleDashed, X } from "lucide-react";
import { useDeployReach } from "../../hooks/useDeployReach";
import { useDeployTargets } from "../../hooks/useSyncDeployTargets";
import { useDeployPress } from "../../hooks/useDeployPress";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { entityRoute, repoObjectId } from "../../lib/entityLinks";
import { REACH_LOOK, deployAgo, type DeployTone } from "../../lib/deploys/deployPill";
import { FAILED_ICON, REACH_ICON, TONE_TEXT } from "../../lib/deploys/deployLook";
import { prDeployRows, prReachHeadline, prShipsTo, type PrDeployRow } from "../../lib/deploys/prDeploy";
import type { DeployTargetRow } from "../../lib/deploys/targets";
import type { ExternalEventAccent } from "../../lib/externalEvents";
import type { CommitCiState } from "@codecast/shared/contracts/deployTargets";
import type { ReachState } from "@codecast/shared/contracts/deployReach";

export const TONE_ACCENT: Record<DeployTone, ExternalEventAccent> = { green: "green", yellow: "yellow", red: "red", orange: "orange", muted: "muted", dim: "muted" };

export type PrDeployModel = ReturnType<typeof usePrDeploy>;

/** Everything the page says about production, read once for the chip and the band. */
export function usePrDeploy(pr: any, repository: string, authed: boolean) {
  const merged = pr.state === "merged";
  const open = pr.state === "open";
  const reach = useDeployReach(merged ? repoObjectId({ type: "pr", repository, number: pr.number }) : null);
  // The team's targets carry each one's queue and press. A closed pull request goes nowhere, and a public reader
  // reads no team.
  const teamId = authed && (merged || open) ? ((pr.team_id as string | undefined) ?? null) : null;
  const { targets, deploys } = useDeployTargets(teamId, repository);
  const now = useCoarseNow(30_000);
  const { rows, dormant } = useMemo(() => prDeployRows(reach, targets, deploys, repository, now), [reach, targets, deploys, repository, now]);
  const files: string[] | undefined = useMemo(() => pr.files?.map((f: { filename: string }) => f.filename), [pr.files]);
  const shipsTo = useMemo(() => (open ? prShipsTo(targets, deploys, repository, files, now) : null), [open, targets, deploys, repository, files, now]);
  const declares = targets.some((t) => t.repository.toLowerCase() === repository.toLowerCase() && !t.record_only);
  const press = useDeployPress(teamId, deploys);
  return { merged, open, teamId, rows, dormant, shipsTo, declares, headline: prReachHeadline(reach?.state, rows), press, now, mergedAt: (pr.merged_at as number | undefined) ?? null };
}

/** The chip beside a merged pull request's state: live, or what holds it. */
export function PRReachChip({ model, Chip }: { model: PrDeployModel; Chip: (p: { accent: ExternalEventAccent; title?: string; children: React.ReactNode }) => React.ReactNode }) {
  const h = model.headline;
  if (!h) return null;
  const look = REACH_LOOK[h.state];
  const Icon = REACH_ICON[h.state];
  return (
    <span data-pr-reach-chip={h.state} className="contents">
      <Chip accent={TONE_ACCENT[look.tone]} title="Where this change runs in production">
        <Icon className={`w-3.5 h-3.5 ${h.state === "failed" ? FAILED_ICON : ""}`} />
        {h.words}
      </Chip>
    </span>
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
              <Link href={deploysHrefOf(model.teamId, x.target.name)} className="text-sol-text no-underline hover:underline">{x.target.name}</Link>
            </span>
          ))}
          <span className="ml-1 text-sol-text-dim">{how}</span>
        </span>
      ))}
    </span>
  );
}

const deploysHrefOf = (teamId: string | null, target: string) =>
  `/deploys?${teamId ? `team=${teamId}&` : ""}target=${encodeURIComponent(target)}`;

function CiWord({ ci, url }: { ci: CommitCiState; url: string | null }) {
  if (ci === "none") return null;
  const word = ci === "passed" ? "CI passed" : ci === "failed" ? "CI failed" : "CI running";
  const mark = ci === "passed" ? <Check className="w-3 h-3" strokeWidth={3} /> : ci === "failed" ? <X className="w-3 h-3" strokeWidth={3} /> : <i className="pr-deploy-ci-run" />;
  const body = <span className={`pr-deploy-ci inline-flex items-center gap-1 ${ci === "passed" ? "text-sol-green" : ci === "failed" ? "text-sol-red" : "text-sol-yellow"}`} data-ci={ci} title="CI on what a deploy now would send">{mark}{word}</span>;
  return url ? <a href={url} target="_blank" rel="noreferrer" className="no-underline hover:underline">{body}</a> : body;
}

/** A deploy in a row: its short sha in mono, a step to the deploy, with its dp-N on hover. */
function Dp({ d }: { d: { short_id: string; sha?: string | null } | null }) {
  if (!d) return null;
  return (
    <Link href={entityRoute("deploy", d.short_id) ?? "#"} className="pr-deploy-dp" title={`${d.short_id}${d.sha ? ` · ${d.sha.slice(0, 7)}` : ""}`} data-pr-deploy-dp={d.short_id}>
      {d.sha ? d.sha.slice(0, 7) : d.short_id}
    </Link>
  );
}

const since = (at: number, now: number) => deployAgo(at, now).replace(/ ago$/, "");

/** What a row says after its state: the deploy, when, and what it waits on. */
function RowDetail({ row, now, mergedAt }: { row: PrDeployRow; now: number; mergedAt: number | null }) {
  const d = row.deploy;
  const parts: React.ReactNode[] = [];
  const at = (verb: string) => d && <span key="t">{verb} {deployAgo(d.at, now)}</span>;
  switch (row.state) {
    case "live":
      parts.push(<span key="d" className="inline-flex items-baseline gap-1">in <Dp d={d} /></span>, at("went live"));
      if (d && mergedAt && d.at > mergedAt) parts.push(<span key="lag" className="text-sol-text-dim">{since(mergedAt, d.at)} after merge</span>);
      break;
    case "going_out":
      parts.push(<span key="d" className="inline-flex items-baseline gap-1">in <Dp d={d} /></span>, at("started"));
      break;
    case "queued":
      parts.push(<span key="d" className="inline-flex items-baseline gap-1">in <Dp d={d} /></span>, at("asked for"));
      break;
    case "failed":
      parts.push(<span key="d" className="inline-flex items-baseline gap-1">in <Dp d={d} /></span>, at("failed"));
      break;
    case "rolled_back":
      parts.push(<span key="w" className="inline-flex items-baseline gap-1">was live in <Dp d={d} /></span>, row.now && <span key="n" className="inline-flex items-baseline gap-1">rolled back to <Dp d={row.now} /> {deployAgo(row.now.at, now)}</span>);
      break;
    case "waiting":
      if (mergedAt) parts.push(<span key="w" className="text-sol-text" data-pr-deploy-waiting>waiting {since(mergedAt, now)}</span>);
      break;
  }
  if (row.queue) {
    const o = row.queue.others;
    const plus = row.queue.atLeast ? "+" : "";
    parts.push(<span key="q" data-pr-deploy-queue={o ?? "?"}>{o == null ? "with older commits" : o === 0 && !plus ? "the only commit waiting" : `with ${o}${plus} other ${o === 1 && !plus ? "commit" : "commits"}`}</span>);
    parts.push(<CiWord key="ci" ci={row.queue.ci} url={row.queue.ciUrl} />);
  }
  if (row.state === "waiting" || row.state === "failed") {
    if (row.now) parts.push(<span key="n" className="inline-flex items-baseline gap-1 text-sol-text-dim">live now <Dp d={row.now} /></span>);
  }
  const shown = parts.filter(Boolean);
  // Each part carries its own separator; the one that starts a wrapped line is clipped away (pr.css).
  return (
    <span className="pr-deploy-detail">
      <span className="pr-deploy-parts">
        {shown.map((p, i) => <span key={i} className="pr-deploy-part">{p}</span>)}
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
  const { rows, dormant, now, teamId, press } = model;
  if (!model.merged || (!rows.length && !dormant.length)) return null;
  return (
    <section className="pr-rise pr-deploy mt-3" style={{ ["--d" as string]: "240ms" }} data-pr-deploy aria-label="Production">
      <span className="pr-deploy-label text-mark uppercase tracking-wider text-sol-text-dim">Production</span>
      <ul className="pr-deploy-rows">
        {rows.map((row, i) => (
          <li key={`${row.target}#${i}`} className="pr-deploy-row" data-pr-deploy-target={row.target} data-state={row.state}>
            <Link href={deploysHrefOf(teamId, row.target)} className="pr-deploy-name" title={`Open ${row.target} on the Deploys page`}>
              {row.target}
            </Link>
            <StateWord state={row.state} />
            <RowDetail row={row} now={now} mergedAt={model.mergedAt} />
            {row.note && <span className="pr-deploy-note text-sol-red" title={row.note}>{row.note}</span>}
            <span className="pr-deploy-act">
              {row.press ? (
                <button type="button" className="pr-deploy-go" data-pr-deploy-go={row.target} onClick={() => press.open({ target: row.press!, action: "deploy", of: null })}>
                  {row.pressWords}
                </button>
              ) : row.blocked ? (
                <span className="text-sol-text-dim" data-pr-deploy-blocked>{row.blocked}</span>
              ) : null}
              <Link href={deploysHrefOf(teamId, row.target)} className="pr-deploy-open" aria-label={`Open ${row.target} on the Deploys page`} title="Open on the Deploys page">
                <ArrowUpRight className="w-3.5 h-3.5" />
              </Link>
            </span>
          </li>
        ))}
        {dormant.map((t, i) => (
          <li key={`${t.target}#idle${i}`} className="pr-deploy-row pr-deploy-row--idle" data-pr-deploy-target={t.target} data-state="idle" title="Shipped nothing this week: it does not hold the change back from live">
            <Link href={deploysHrefOf(teamId, t.target)} className="pr-deploy-name">{t.target}</Link>
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
