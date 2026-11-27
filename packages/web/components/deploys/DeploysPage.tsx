"use client";
// /deploys (deploys.md DP10 to DP12): every place the team's code goes live, and for the one picked, what is shipping
// toward main, what waits there, what went out and a way back (components/deploys/DeploysBoard draws it). This shell
// reads the store and the queries and hands the board plain data; a press paints at once and the confirm flow
// (components/consequential) carries its weight.
import { useEffect, useMemo, useState } from "react";
import { Check, CircleDashed, Loader2, Pause, X } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { activeTeamIdOf } from "../../lib/activeTeam";
import { teamHasFeature } from "../../lib/teamFeatureRule";
import { useDeployTargets } from "../../hooks/useSyncDeployTargets";
import { useCheckouts, useSyncCheckouts } from "../../hooks/useSyncCheckouts";
import { useDeployLines, useSyncDeployLines } from "../../hooks/useDeployLines";
import { useShipping } from "../../hooks/useSyncShipping";
import { isGoing, orderTargets, productionOf, recordTargets, targetNow, targetTone, type DeployTargetRow, type TargetTone } from "../../lib/deploys/targets";
import type { BoardView, OpenPr } from "../../lib/deploys/board";
import { normalizeRepository } from "@codecast/shared/contracts";
import { useSyncCollection } from "../../hooks/useSyncCollection";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { useDeployPress } from "../../hooks/useDeployPress";
import { FOCUS_PARAMS, focusRef, focusRepository, focusSettled, focusTarget, pickTarget, reachAnyDeploy, targetKey, type DeployFocus } from "../../lib/deploys/focus";
import { useDeployReach } from "../../hooks/useDeployReach";
import { focusTargets } from "../../lib/deploys/spot";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { rememberFilters } from "../../lib/rememberedFilters";
import { DeploysBoard } from "./DeploysBoard";
import { PageHeader } from "../ui/page-header";
import { useIsModernStyle } from "../../hooks/useVisualStyle";
import "./deploys.css";

/** Change the page's address in place, so a copied link opens the view on screen; a null drops the param. */
function rewriteAddress(set: Record<string, string | null>) {
  const url = new URL(window.location.href);
  for (const [k, v] of Object.entries(set)) v === null ? url.searchParams.delete(k) : url.searchParams.set(k, v);
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}

export function DeploysPage({ initialTarget, initialTeam, initialDeploy, initialFocus, initialShow, initialMine, initialRepo }: { initialTarget?: string | null; initialTeam?: string | null; initialDeploy?: string | null; initialFocus?: DeployFocus | null; initialShow?: BoardView; initialMine?: boolean; initialRepo?: string | null }) {
  // A PR or commit named with its repository (a pill's link) knows its reach before the team is known.
  const namedReach = useDeployReach(initialRepo ? focusRef(initialFocus ?? null, initialRepo) : null) ?? null;
  // A deploy named in the address (a dp-N pill), or one the named change's reach names, opens on its own team, wherever the viewer was.
  const whereRef = initialDeploy ?? reachAnyDeploy(namedReach);
  const where = useQueryNoThrow((api as any).deployRefs.whereIs, whereRef ? { ref: whereRef } : "skip").data as { team_id: string | null; target: string; repository: string | null } | null | undefined;
  const activeTeam = useInboxStore((s) => activeTeamIdOf(s) ?? null);
  const teams = useInboxStore((s) => (s.teams ?? []) as Array<{ _id: string; name: string }>);
  // The page reads one team's targets; picking another here never moves the app's active team.
  const [teamPick, setTeamPick] = useState<string | null>(initialTeam ?? null);
  const teamId = teamPick ?? where?.team_id ?? activeTeam;
  const { targets, deploys, productions, ready } = useDeployTargets(teamId);
  const now = useCoarseNow(30_000);
  // Declared targets, then any target the team's deploy records name that no checkout declared yet.
  const allTargets = useMemo(() => (teamId ? [...targets, ...recordTargets(targets, deploys, teamId)] : targets), [targets, deploys, teamId]);
  const ordered = useMemo(() => orderTargets(allTargets, deploys), [allTargets, deploys]);
  // What the link pointed at stays highlighted until the viewer clears it; the switch's view and Mine ride the address.
  const [focus, setFocus] = useState<DeployFocus | null>(initialFocus ?? null);
  // The switch's view and Mine open as the route read them (the link's, else the viewer's last: lib/rememberedFilters).
  // Each touch writes both to the address (defaults left out), so a copied link opens as they see it, and remembers them.
  const [picks, setPicks] = useState<{ show: BoardView; mine: boolean } | null>(null);
  const show = picks?.show ?? initialShow ?? "sessions";
  const mine = picks?.mine ?? !!initialMine;
  const pickFilters = (v: BoardView, on: boolean) => {
    setPicks({ show: v, mine: on });
    const set = { show: v === "sessions" ? null : v, mine: on ? "1" : null };
    rememberFilters("deploys", set);
    rewriteAddress(set);
  };
  const pickShow = (v: BoardView) => pickFilters(v, mine);
  const pickMine = (on: boolean) => pickFilters(show, on);
  const me = useInboxStore((s) => (s.currentUser as { _id?: string } | null)?._id ?? null);
  const meLogin = useInboxStore((s) => (s.currentUser as { github_username?: string } | null)?.github_username ?? null);
  // Shipping paints from the store; a run whose PR has not opened finds its repository by the checkout it runs in.
  // Web goes live before the backend that answers it: a failed read with nothing stored reads as unavailable.
  const shipping = useShipping(teamId);
  // Each deploy card shown reads its own commits' lines from the store; the board says which are shown, and one feeder
  // per card keeps them current.
  const [lineIds, setLineIds] = useState<string[]>([]);
  const linesByDeploy = useDeployLines(lineIds);
  useSyncCheckouts(teamId);
  const checkouts = useCheckouts(teamId);
  const priorities = useInboxStore((s) => teamHasFeature(s.teams as any[], teamId, "priorities"));
  const clearFocus = () => {
    // The target the link opened stays open once the highlight goes.
    setPicked((was) => was ?? picked?._id ?? null);
    setFocus(null);
    rewriteAddress(Object.fromEntries([...FOCUS_PARAMS, "repo"].map((k) => [k, null])));
  };
  // A target named in the address is held as `owner/repo#name` when the address names its repository too.
  const [pickedId, setPicked] = useState<string | null>(targetKey(initialTarget, initialRepo));
  // A PR or commit's own reach says where it went out, so a deploy that listed only its newest commits still finds it.
  const inferredReach = useDeployReach(initialRepo ? null : focusRef(focus, focusRepository(null, allTargets))) ?? null;
  const reach = focus ? (initialRepo ? namedReach : inferredReach) : null;
  const focusAt = useMemo(() => (pickedId ? null : focusTarget(allTargets, deploys, focus, reach)), [pickedId, allTargets, deploys, focus, reach]);
  // Once the link's target is settled, pin it, and write it into the address so a copy opens there too: a change that
  // waits on two targets and goes out to one must not move the page to the other while it is being read.
  const settled = !pickedId && !!focusAt && focusSettled(allTargets, focus, reach);
  // eslint-disable-next-line no-restricted-syntax -- pins the linked target once, the first time the page settles, and writes it to the address
  useEffect(() => {
    if (!settled || !focusAt) return;
    setPicked(focusAt._id);
    rewriteAddress({ target: focusAt.name, ...(new Set(allTargets.map((t) => t.repository)).size > 1 ? { repo: focusAt.repository } : {}) });
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps -- pins once, the first time it settles
  // A deploy link opens at that deploy's target; a change's link opens where its reach says (focusAt), not at the deploy that found the team.
  const want = pickedId ?? (initialDeploy && where ? targetKey(where.target, where.repository) : null) ?? focusAt?._id ?? null;
  const picked = pickTarget(ordered, want);
  // Every open pull request of the picked target's repository, whether or not a Ship run carries it (Shipping draws
  // the ones no run does). The timeline's feeder reads a repository's open PRs whole.
  const prs = useOpenPullRequests(picked && !picked.record_only ? picked.repository : null);
  // The targets the linked change is on are outlined, the rest dimmed: a run's change reads across every target it goes to.
  const onFocus = useMemo(() => focusTargets(allTargets, deploys, focus, reach), [allTargets, deploys, focus, reach]);
  const press = useDeployPress(teamId, deploys, productions);
  const modern = useIsModernStyle();
  const repos = new Set(allTargets.map((t) => t.repository).filter(Boolean));

  if (!teamId) return modern ? <div className="dpp-frame dpp-frame--headed"><PageHeader legacy={null} title="Deploys" /><div className="min-h-0 flex-1"><div className="dpp-empty">Deploys belong to a team.</div></div></div> : <div className="dpp-empty">Deploys belong to a team.</div>;
  const teamPicker = teams.length > 1 ? (
    <select className="dpp-team" value={teamId} onChange={(e) => { setTeamPick(e.target.value); setPicked(null); }} aria-label="Team" data-deploys-team>
      {teams.map((t) => <option key={t._id} value={t._id}>{t.name}</option>)}
    </select>
  ) : null;
  // `dpp-frame` is the page's own width (deploys.css): it decides one column or two, never the window.
  // Classic and Minimal: the page's name at the start of the targets row.
  // Modern: the page header over the targets and the target.
  const header = <PageHeader legacy={null} title="Deploys" count={allTargets.length || null} actions={teamPicker} />;
  const railTitle = !modern && <div className="dpp-title-row"><h1 className="dpp-title">Deploys</h1>{teamPicker}</div>;
  const frame = modern ? "dpp-frame dpp-frame--headed" : "dpp-frame";
  if (!ready && allTargets.length === 0) return <div className={frame}>{header}<div className="dpp" aria-busy><nav className="dpp-targets">{railTitle}</nav><div className="dpp-main dpp-cold" /></div></div>;
  if (allTargets.length === 0) return <div className={frame}>{header}<div className="dpp" data-deploys-none><nav className="dpp-targets">{railTitle}</nav><div className="dpp-empty">No deploys yet</div></div></div>;

  return (
    <div className={frame}>
    {header}
    <div className="dpp" data-deploys-page>
      <nav className="dpp-targets" aria-label="Deploy targets">
        {railTitle}
        <ul>
          {ordered.map((t) => {
            const n = targetNow(t, deploys);
            const tone = targetTone(t, n);
            const waiting = t.queue.known ? t.queue.commits : 0;
            const pause = productionOf(productions, t)?.pause;
            return (
              <li key={t._id}>
                <button type="button" className="dpp-target" aria-current={picked?._id === t._id ? "true" : undefined} data-tone={tone} data-paused={pause ? "" : undefined} data-focus-on={onFocus.has(t.name) ? "" : undefined} data-focus-off={onFocus.size && !onFocus.has(t.name) ? "" : undefined} onClick={() => setPicked(t._id)} title={pause ? `paused by ${pause.by}` : targetWords(t, n, tone)} data-deploy-target={t.name}>
                  {pause ? <Pause className="dpp-mark" aria-label="Paused" /> : <ToneMark tone={tone} asked={!!n.open && !isGoing(n.open)} />}
                  <span className="dpp-target-name">{t.name}{repos.size > 1 ? <span className="dpp-repo">{t.repository.split("/").pop()}</span> : null}</span>
                  {waiting ? <span className="dpp-target-n" data-deploy-target-waiting={waiting}>{waiting}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      {picked ? (
        <DeploysBoard
          key={picked._id} target={picked} production={productionOf(productions, picked)} deploys={deploys}
          shipping={shipping.shipping} shippingError={shipping.error} prs={prs} meLogin={meLogin} linesByDeploy={linesByDeploy} onLinesWanted={setLineIds} checkouts={checkouts}
          me={me ? String(me) : null} now={now} priorities={priorities} focus={focus} reach={reach} openDeploy={initialDeploy ?? null}
          show={show} mine={mine} onShow={pickShow} onMine={pickMine} onClearFocus={clearFocus}
          onPress={press.open} onRollback={press.openRollback} onPause={() => press.openPause(picked, allTargets)} onLift={() => press.lift(picked)}
        />
      ) : null}
      {lineIds.map((id) => <LinesFeed key={id} deployId={id} />)}
      {press.review}
    </div>
    </div>
  );
}

/** What a pull request's card draws: a change to any of it redraws the column. */
const openPrSig = (p: OpenPr) => `${p.state}|${p.title}|${p.updated_at}|${p.draft ? 1 : 0}|${p.checks_state ?? ""}|${p.review_decision ?? ""}|${p.mergeable_state ?? ""}|${p.behind_by ?? ""}|${p.head_ref ?? ""}`;

/**
 * One repository's open pull requests from the store, with the feeder mounted; null while nothing is held and unread.
 * A repository's answer holds every one of its open PRs (pull_requests.getPRsForTimeline), so a row the store still
 * holds as open that the answer lacks has closed out of sight: it leaves rather than stand as a card forever.
 */
function useOpenPullRequests(repository: string | null): OpenPr[] | null {
  const repo = repository ? normalizeRepository(repository) : null;
  const isOpenHere = useMemo(() => (p: OpenPr) => !!repo && p.state === "open" && typeof p.title === "string" && normalizeRepository(p.repository) === repo, [repo]);
  const { ready } = useSyncCollection("pullRequests", api.pull_requests.getPRsForTimeline, repository ? { repository } : "skip", { dropAbsent: isOpenHere });
  const where = isOpenHere;
  const rows = useCollectionRows<OpenPr>("pullRequests", { where, sig: openPrSig });
  return ready || rows.length ? rows : null;
}

/** Feeds one shown deploy card's lines into the store (hooks/useDeployLines), whether or not its rows are drawn. */
function LinesFeed({ deployId }: { deployId: string }) {
  useSyncDeployLines(deployId);
  return null;
}

function targetWords(t: DeployTargetRow, n: ReturnType<typeof targetNow>, tone: TargetTone): string {
  if (tone === "going") return n.open && isGoing(n.open) ? "going out" : "asked for";
  if (tone === "failed") return "last deploy failed";
  if (tone === "unknown") return n.live ? "live" : "not tracked yet";
  if (tone === "current") return "up to date";
  return `${t.queue.commits} ${t.queue.commits === 1 ? "commit" : "commits"} waiting`;
}

function ToneMark({ tone, asked = false }: { tone: TargetTone; asked?: boolean }) {
  // A deploy asked for with no commit yet sends nothing anyone can name: a still mark, never the spinner of one going out.
  if (tone === "going" && asked) return <i className="dpp-mark dpp-mark-dot" aria-hidden />;
  if (tone === "going") return <Loader2 className="dpp-mark animate-spin" aria-hidden />;
  if (tone === "failed") return <X className="dpp-mark" strokeWidth={3} aria-hidden />;
  if (tone === "current") return <Check className="dpp-mark" strokeWidth={3} aria-hidden />;
  if (tone === "unknown") return <CircleDashed className="dpp-mark" aria-hidden />;
  return <i className="dpp-mark dpp-mark-dot" aria-hidden />;
}
