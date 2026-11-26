// A change run's page (flows.md, pl-1077): its headline, where the change stands and what it waits on, read from the
// journey the run card draws (journey.ts), and the change's own facts as links: the pull request, its CI, its review,
// the commit it merged and the deploys that carry it, each read from what the run's stations recorded. Pure, with
// relative imports only: the phone's run page reads a run here too.
import { segmentTopOf } from "@codecast/shared/contracts/flowPool";
import { entityRoute } from "@codecast/shared/entities";
import { targetsFromLine, verdictsOf, type Journey, type TargetState } from "./journey";
import { gateWaitWords, holdWords, journeyWords, sentBackWords, stopWords, type JourneyTone } from "./journeyWords";
import { landedSha } from "./runRecord";
import { deploysFocusHref, deploysHref, runFocus, runTeam } from "../deploys/focus";

type Status = { node_id: string; status?: string; result_preview?: string | null; started_at?: number; session?: { _id: string; title?: string | null } | null };

/** The run row's parts the page reads: what the PR, CI, review and merge stations recorded on it (convex workflow_runs). */
export type ChangeRun = {
  status?: string;
  workspace?: string | null;
  spawner_conversation_id?: string | null;
  pr?: { number: number; repository: string; head_sha?: string | null } | null;
  ci_verdict?: { green: boolean; head_sha?: string | null } | null;
  review_verdict?: { verdict: string; head_sha?: string | null } | null;
  merge?: { sha?: string | null; pr_url?: string | null } | null;
  current_node_id?: string | null;
  waiting_on_session?: { node_id: string } | null;
  gate_node_id?: string | null;
  gate_decision_short_id?: string | null;
  node_statuses?: ReadonlyArray<Status> | null;
};

/** `words`: where the change stands; `waits`: what it waits on, when something does, and `href` where to act on it
 *  (the session fixing it, the card someone else answers, the deploy it waits for). A card the viewer answers is on the
 *  page already, under the head. */
export type ChangeHeadline = { words: string; waits: string | null; href: string | null; tone: JourneyTone };

/** "web, cli and mobile". */
const listWords = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** What CI and the review found when they sent the change back, from the verdicts the run recorded. */
function foundWords(run: ChangeRun): string | null {
  const red = run.ci_verdict ? !run.ci_verdict.green : null;
  const review = run.review_verdict?.verdict;
  const said = [red ? "CI red" : null, review === "changes" ? "review asked for changes" : review === "rejected" ? "review rejected it" : null].filter(Boolean) as string[];
  if (!said.length) return null;
  const s = said.join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The page's headline for a change run: where the change stands now, and what it waits on. */
export function changeHeadline(j: Journey, run: ChangeRun): ChangeHeadline {
  const n = j.now;
  const { tone } = journeyWords(j);
  const session = (id: string | null | undefined) => (id ? `/conversation/${id}` : null);
  const head = (words: string, waits: string | null = null, href: string | null = null, t: JourneyTone = tone): ChangeHeadline => ({ words, waits, href: waits ? href : null, tone: t });
  switch (n.kind) {
    case "idle": return head("Not started");
    case "starting": return head("Starting");
    case "working": return head(journeyWords(j).words);
    case "session": {
      const fixer = session(n.conversation ?? run.spawner_conversation_id);
      if (n.blocked) return head(n.ask?.mine ? "Waiting on your answer" : sentBackWords(n), n.ask?.question ?? (n.note || null), n.ask ? (n.ask.mine ? null : `/decisions/${n.ask.short_id ?? n.ask.id}`) : fixer);
      const found = n.what ? null : foundWords(run);
      return head(n.what ?? found ?? sentBackWords(n), `Waiting on its session's fix${n.round && n.max ? `, round ${n.round} of ${n.max}` : ""}`, fixer, found ? "bad" : tone);
    }
    // The viewer's own card is answered right under the head, its question its title.
    case "gate": return n.mine ? head("Waiting on your decision") : head(gateWaitWords(n.holder, n.who), n.prompt, n.decisionId ? `/decisions/${run.gate_decision_short_id ?? n.decisionId}` : null);
    case "landed": return head(`Merged ${n.sha.slice(0, 7)}`, holdWords(n.hold).words, deploysHref(run, n.line));
    case "deploying": {
      const going = n.targets.length ? n.targets : targetsFromLine(n.line).filter((t) => t.state !== "live").map((t) => t.name);
      return head(going.length ? `Deploying to ${listWords(going)}` : "Deploying");
    }
    case "live": {
      const on = n.targets.length ? n.targets : targetsFromLine(n.line).map((t) => t.name);
      return head(on.length ? `Live on ${listWords(on)}` : "Live");
    }
    case "merged": return head(`${n.end ?? "Merged"} ${n.sha.slice(0, 7)}`, n.why ?? null);
    case "passed": return head("Done");
    case "unlanded": return head("Not merged", n.why);
    case "stopped":
    case "failed":
      return head(n.kind === "failed" && !n.end ? `Failed${n.stage ? ` at ${n.stage}` : ""}` : stopWords(n), n.why,
        n.fix === "session" ? session(n.session) : n.fix === "deploy" ? deploysHref(run, n.why) : null);
  }
}

export type ChangeLinkKind = "pr" | "ci" | "review" | "merged" | "deploy";
/** One fact about the change, as a link to where it lives. `tone`: ok (passed, live), bad (red, failed), wait (under way). */
export type ChangeLink = { kind: ChangeLinkKind; label: string; href: string; external: boolean; tone: "ok" | "bad" | "wait" | "default"; title: string };

/** The newest step of a station (by its top-level id), however its segment named the step. */
const newestOf = (run: ChangeRun, station: string): Status | undefined =>
  [...(run.node_statuses ?? [])].filter((n) => segmentTopOf(n.node_id) === station).sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))[0];

const PR_URL = /https:\/\/github\.com\/([^/\s"]+\/[^/\s"]+)\/pull\/(\d+)/;

/** The pull request the run opened: what it recorded on the run, else the PR station's report, else the merge's link. */
export function changePr(run: ChangeRun): { repository: string; number: number } | null {
  if (run.pr?.repository && run.pr.number) return { repository: run.pr.repository, number: run.pr.number };
  const m = PR_URL.exec(newestOf(run, "pr")?.result_preview ?? "") ?? PR_URL.exec(run.merge?.pr_url ?? "");
  return m ? { repository: m[1], number: Number(m[2]) } : null;
}

/** The Deploy station's line that names targets ("Live: 31ccbb8 on web dp-12, cli dp-13."), newest first. */
export function deployLine(run: ChangeRun): string | null {
  const steps = [...(run.node_statuses ?? [])].filter((n) => segmentTopOf(n.node_id) === "deploy" && n.result_preview).sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0));
  return steps.find((n) => targetsFromLine(n.result_preview).length)?.result_preview ?? null;
}

/** CI as the run knows it: under way while its station runs, else the verdict it recorded, else the verdicts step's word. */
function ciState(run: ChangeRun): { label: string; tone: ChangeLink["tone"] } | null {
  const node = newestOf(run, "ci");
  if (node?.status === "running") return { label: "CI running", tone: "wait" };
  if (run.ci_verdict) return run.ci_verdict.green ? { label: "CI green", tone: "ok" } : { label: "CI red", tone: "bad" };
  const said = [...(run.node_statuses ?? [])].reverse().map((n) => verdictsOf(n.result_preview)?.ci).find(Boolean);
  if (said === "green") return { label: "CI green", tone: "ok" };
  if (said === "red") return { label: "CI red", tone: "bad" };
  if (said === "blocked_by_main") return { label: "CI red on main", tone: "bad" };
  if (said === "timed_out") return { label: "CI timed out", tone: "bad" };
  return node ? { label: "CI", tone: "default" } : null;
}

const REVIEW_WORDS: Record<string, { label: string; tone: ChangeLink["tone"] }> = {
  ship: { label: "Review passed", tone: "ok" },
  changes: { label: "Review asked for changes", tone: "wait" },
  rejected: { label: "Review rejected", tone: "bad" },
};

/**
 * The change's facts as links, in the order the change meets them: its pull request, the CI on it, its review (the
 * reviewer's session), the commit it merged, and each deploy that carries it (`targets`: where the deploy records put
 * the merged commit, else the Deploy station's own line). Each appears once the run has it.
 */
export function changeLinks(run: ChangeRun, targets: ReadonlyArray<TargetState> = []): ChangeLink[] {
  const out: ChangeLink[] = [];
  const pr = changePr(run);
  const prGithub = pr ? `https://github.com/${pr.repository}/pull/${pr.number}` : null;
  if (pr) out.push({ kind: "pr", label: `PR #${pr.number}`, href: entityRoute("pr", `${pr.repository}#${pr.number}`) ?? prGithub!, external: false, tone: "default", title: `${pr.repository}#${pr.number}` });
  const ci = ciState(run);
  if (ci && prGithub) out.push({ kind: "ci", ...ci, href: `${prGithub}/checks`, external: true, title: "The checks on the pull request, on GitHub" });
  const review = newestOf(run, "review");
  if (review?.session?._id) {
    const words = review.status === "running" ? { label: "In review", tone: "wait" as const } : REVIEW_WORDS[run.review_verdict?.verdict ?? ""] ?? { label: "Review", tone: "default" as const };
    out.push({ kind: "review", ...words, href: `/conversation/${review.session._id}`, external: false, title: review.session.title ?? "The reviewer's session" });
  }
  const sha = landedSha(run);
  const team = runTeam(run);
  if (sha) {
    const repo = pr?.repository ?? null;
    out.push({ kind: "merged", label: `Merged ${sha.slice(0, 7)}`, href: (repo && entityRoute("commit", `${repo}@${sha}`)) || deploysFocusHref({ team, focus: { kind: "sha", sha: sha.toLowerCase() } }), external: false, tone: "ok", title: sha });
  }
  const reach = targets.length ? targets : targetsFromLine(deployLine(run));
  for (const t of reach) {
    const route = t.deploy ? entityRoute("deploy", t.deploy) : null;
    out.push({
      kind: "deploy",
      label: t.deploy ? `${t.name} ${t.deploy}` : `${t.name} waiting`,
      href: route ?? deploysFocusHref({ team, target: t.name, focus: runFocus(run) }),
      external: false,
      tone: t.state === "live" ? "ok" : t.state === "failed" ? "bad" : t.state === "deploying" ? "wait" : "default",
      title: t.state === "live" ? `Live on ${t.name}` : t.state === "deploying" ? `Going out to ${t.name}` : t.state === "failed" ? `Failed on ${t.name}` : `Not on ${t.name} yet`,
    });
  }
  return out;
}
