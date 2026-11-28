"use client";
// /deploys (deploys.md DP10 to DP12): every place the team's code goes live, and for the one picked, what is shipping
// toward main, what waits there, what went out and a way back (components/deploys/DeploysBoard draws it). In the
// viewer's own workspace it lists projects instead (lib/deploys/projects): every one on at first, one board drawing
// the ones on together. This shell reads the store and the queries and hands the board plain data; a press paints at
// once and the confirm flow (components/consequential) carries its weight.
import { useEffect, useMemo, useState } from "react";
import { Check, CircleDashed, Loader2, Pause, X } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { activeWorkspaceKeyOf, strictWorkspaceKey } from "../../lib/workspaceScope";
import { teamHasFeature } from "../../lib/teamFeatureRule";
import { useDeployTargets } from "../../hooks/useSyncDeployTargets";
import { useCheckouts, useSyncCheckouts } from "../../hooks/useSyncCheckouts";
import { useDeployLines, useSyncDeployLines } from "../../hooks/useDeployLines";
import { useShipping } from "../../hooks/useSyncShipping";
import { isGoing, orderTargets, productionOf, recordTargets, targetNow, targetTone, type DeployTargetRow, type TargetTone } from "../../lib/deploys/targets";
import { projectsOf, projectsOn, toggleProject, type ProjectTone } from "../../lib/deploys/projects";
import { useSyncRepoIcons } from "../../hooks/useSyncRepoIcons";
import type { BoardView } from "../../lib/deploys/board";
import { useOpenPullRequests, useOpenPullRequestsIn, useSyncOpenPullRequests } from "../../hooks/useSyncTimeline";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useDeployPress } from "../../hooks/useDeployPress";
import { FOCUS_PARAMS, PERSONAL_PROJECTS_FILTER, focusRef, focusRepository, focusSettled, focusTarget, pickTarget, reachAnyDeploy, targetKey, type DeployFocus } from "../../lib/deploys/focus";
import { useDeployReach } from "../../hooks/useDeployReach";
import { focusTargets } from "../../lib/deploys/spot";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useDeploysCacheFresh } from "../../hooks/useDeploysCacheFresh";
import { rememberFilters } from "../../lib/rememberedFilters";
import { DeploysBoard } from "./DeploysBoard";
import { RepoFace } from "./RepoFace";
import { PageHeader } from "../ui/page-header";
import { useIsModernStyle } from "../../hooks/useVisualStyle";
import "./deploys.css";

/** Change the page's address in place, so a copied link opens the view on screen; a null drops the param. */
function rewriteAddress(set: Record<string, string | null>) {
  const url = new URL(window.location.href);
  for (const [k, v] of Object.entries(set)) v === null ? url.searchParams.delete(k) : url.searchParams.set(k, v);
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}

export function DeploysPage({ initialTarget, initialTeam, initialDeploy, initialFocus, initialShow, initialMine, initialRepo, initialProjects }: { initialTarget?: string | null; initialTeam?: string | null; initialDeploy?: string | null; initialFocus?: DeployFocus | null; initialShow?: BoardView; initialMine?: boolean; initialRepo?: string | null; initialProjects?: string | null }) {
  // A PR or commit named with its repository (a pill's link) knows its reach before the team is known.
  const namedReach = useDeployReach(initialRepo ? focusRef(initialFocus ?? null, initialRepo) : null) ?? null;
  // A deploy named in the address (a dp-N pill), or one the named change's reach names, opens on its own team, wherever the viewer was.
  const whereRef = initialDeploy ?? reachAnyDeploy(namedReach);
  const where = useQueryNoThrow((api as any).deployRefs.whereIs, whereRef ? { ref: whereRef } : "skip").data as { team_id: string | null; target: string; repository: string | null } | null | undefined;
  const activeSpace = useInboxStore(activeWorkspaceKeyOf);
  const teams = useInboxStore((s) => (s.teams ?? []) as Array<{ _id: string; name: string }>);
  const me = useInboxStore((s) => (s.currentUser as { _id?: string } | null)?._id ?? null);
  const own = me ? `user:${String(me)}` : null;
  // The page reads one workspace: a team's (`team:<id>`), or the viewer's own (`user:<id>`). Picking another here never
  // moves the app's active team; a deploy named in the address opens on its own workspace.
  const [spacePick, setSpacePick] = useState<string | null>(initialTeam ? `team:${initialTeam}` : null);
  const workspace = strictWorkspaceKey(spacePick ?? (where ? (where.team_id ? `team:${where.team_id}` : own) : null) ?? activeSpace);
  const personal = !!workspace?.startsWith("user:");
  const teamId = workspace?.startsWith("team:") ? workspace.slice(5) : null;
  const { targets, deploys, productions, ready } = useDeployTargets(workspace);
  const now = useCoarseNow(30_000);
  // Declared targets, then any target the workspace's deploy records name that no checkout declared yet.
  const allTargets = useMemo(() => (workspace ? [...targets, ...recordTargets(targets, deploys, teamId ?? "")] : targets), [targets, deploys, workspace, teamId]);
  const ordered = useMemo(() => orderTargets(allTargets, deploys), [allTargets, deploys]);
  // What the link pointed at stays highlighted until the viewer clears it; the switch's view and Mine ride the address.
  const [focus, setFocus] = useState<DeployFocus | null>(initialFocus ?? null);
  // The switch's view and Mine open as the route read them (the link's, else the viewer's last: lib/rememberedFilters).
  // Each touch writes both to the address (defaults left out), so a copied link opens as they see it, and remembers them.
  // A personal page's projects ride its address and are remembered apart, so a team page never names them: null is
  // every one on (the default), "" none, else the `owner/name` keys on.
  const savedProjects = useInboxStore((s) => (s.clientState.ui as { page_filters?: Record<string, string> } | undefined)?.page_filters?.[PERSONAL_PROJECTS_FILTER]);
  const [picks, setPicks] = useState<{ show: BoardView; mine: boolean; projects: string | null } | null>(null);
  const show = picks?.show ?? initialShow ?? "sessions";
  const mine = picks?.mine ?? !!initialMine;
  const projectsParam = picks ? picks.projects : initialProjects ?? (savedProjects === undefined ? null : new URLSearchParams(savedProjects).get("projects"));
  const pickFilters = (v: BoardView, on: boolean, projects: string | null) => {
    setPicks({ show: v, mine: on, projects });
    const set = { show: v === "sessions" ? null : v, mine: on ? "1" : null };
    rememberFilters("deploys", set);
    if (personal) rememberFilters(PERSONAL_PROJECTS_FILTER, { projects });
    rewriteAddress(personal ? { ...set, projects } : set);
  };
  const pickShow = (v: BoardView) => pickFilters(v, mine, projectsParam);
  const pickMine = (on: boolean) => pickFilters(show, on, projectsParam);
  const meLogin = useInboxStore((s) => (s.currentUser as { github_username?: string } | null)?.github_username ?? null);
  // Shipping paints from the store; a run whose PR has not opened finds its repository by the checkout it runs in.
  // Web goes live before the backend that answers it: a failed read with nothing stored reads as unavailable.
  const fed = useShipping(workspace);
  // A cache paints before the feeds answer only when this browser held them live moments ago (useDeploysCacheFresh):
  // an older one holds counts, a live deploy and runs that have moved on since, so the page reads until they answer.
  const fresh = useDeploysCacheFresh(workspace, ready && fed.live, now);
  const shipping = fed.live || fresh ? fed : { ...fed, shipping: null };
  // Each deploy card shown reads its own commits' lines from the store; the board says which are shown, and one feeder
  // per card keeps them current.
  const [lineIds, setLineIds] = useState<string[]>([]);
  const linesByDeploy = useDeployLines(lineIds);
  useSyncCheckouts(workspace);
  const checkouts = useCheckouts(workspace);
  // A personal workspace's projects, each with its face (fed once here, read by every RepoFace).
  useSyncRepoIcons(personal ? workspace : null);
  const runs = shipping.shipping?.runs;
  const projects = useMemo(() => (personal && workspace ? projectsOf(allTargets, deploys, runs ?? [], checkouts, workspace, now) : []), [personal, workspace, allTargets, deploys, runs, checkouts, now]);
  const on = projectsOn(projectsParam);
  const shown = projects.filter((x) => !on || on.has(x.key));
  const pickProject = (key: string) => pickFilters(show, mine, toggleProject(projects, on, key));
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
    if (!settled || !focusAt || personal) return;
    setPicked(focusAt._id);
    rewriteAddress({ target: focusAt.name, ...(new Set(allTargets.map((t) => t.repository)).size > 1 ? { repo: focusAt.repository } : {}) });
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps -- pins once, the first time it settles
  // A deploy link opens at that deploy's target; a change's link opens where its reach says (focusAt), not at the deploy that found the team.
  const want = pickedId ?? (initialDeploy && where ? targetKey(where.target, where.repository) : null) ?? focusAt?._id ?? null;
  const picked = pickTarget(ordered, want);
  // Every open pull request of the picked target's repository, whether or not a Ship run carries it (Shipping draws
  // the ones no run does). The timeline's feeder reads a repository's open PRs whole.
  const { prs, failed: prsFailed } = useOpenPullRequests(!personal && picked && !picked.record_only ? picked.repository : null);
  // A personal page reads the open pull requests of every project on: one feeder each (OpenPrsFeed) says when its
  // answer is in, and the rows show once every one has answered.
  const [prFeeds, setPrFeeds] = useState<Record<string, { live: boolean; failed: boolean }>>({});
  const onPrFeed = (repository: string, st: { live: boolean; failed: boolean } | null) =>
    setPrFeeds((was) => {
      if (!st) { const { [repository]: _gone, ...rest } = was; return repository in was ? rest : was; }
      return was[repository]?.live === st.live && was[repository]?.failed === st.failed ? was : { ...was, [repository]: st };
    });
  const shownRepos = personal ? shown.map((x) => x.repository) : [];
  const personalPrs = useOpenPullRequestsIn(shownRepos, shownRepos.every((r) => prFeeds[r]?.live));
  const personalPrsFailed = shownRepos.some((r) => prFeeds[r]?.failed);
  // The targets the linked change is on are outlined, the rest dimmed: a run's change reads across every target it goes to.
  const onFocus = useMemo(() => focusTargets(allTargets, deploys, focus, reach), [allTargets, deploys, focus, reach]);
  const press = useDeployPress(teamId, deploys, productions);
  const modern = useIsModernStyle();
  const repos = new Set(allTargets.map((t) => t.repository).filter(Boolean));

  // A viewer with teams opens either their own deploys or a team's.
  const teamPicker = teams.length > 0 && own ? (
    <select className="dpp-team" value={workspace ?? ""} onChange={(e) => { setSpacePick(e.target.value); setPicked(null); }} aria-label="Workspace" data-deploys-team>
      <option value={own}>Personal</option>
      {teams.map((t) => <option key={t._id} value={`team:${t._id}`}>{t.name}</option>)}
    </select>
  ) : null;
  // `dpp-frame` is the page's own width (deploys.css): it decides one column or two, never the window.
  // Classic and Minimal: the page's name at the start of the targets row.
  // Modern: the page header over the targets and the target.
  const header = <PageHeader legacy={null} title="Deploys" count={ready || fresh ? (personal ? projects.length : allTargets.length) || null : null} actions={teamPicker} />;
  const railTitle = !modern && <div className="dpp-title-row"><h1 className="dpp-title">Deploys</h1>{teamPicker}</div>;
  const frame = modern ? "dpp-frame dpp-frame--headed" : "dpp-frame";
  if (personal) {
    if (!ready && (!fresh || projects.length === 0)) return <div className={frame}>{header}<div className="dpp" aria-busy><nav className="dpp-targets">{railTitle}</nav><div className="dpp-main dpp-cold" /></div></div>;
    if (projects.length === 0) return <div className={frame}>{header}<div className="dpp" data-deploys-none><nav className="dpp-targets">{railTitle}</nav><div className="dpp-empty">No deploys yet</div></div></div>;
    const drawn = shown.flatMap((x) => x.targets);
    return (
      <div className={frame}>
      {header}
      <div className="dpp" data-deploys-page data-deploys-personal>
        <nav className="dpp-targets" aria-label="Projects">
          {railTitle}
          <ul>
            {projects.map((x) => (
              <li key={x.repository}>
                <button type="button" className="dpp-target dpp-project" aria-pressed={!on || on.has(x.key)} data-tone={x.tone} onClick={() => pickProject(x.key)} title={PROJECT_WORDS[x.tone]} data-deploy-project-chip={x.key}>
                  <RepoFace workspace={workspace!} repository={x.repository} size={18} />
                  <span className="dpp-target-name">{x.name}</span>
                  <ToneMark tone={x.tone} />
                  <span className="dpp-target-n" title="Went live in the last 30 days" data-deploy-project-live={x.live30}>{x.live30}</span>
                </button>
              </li>
            ))}
            {on && shown.length < projects.length ? <li><button type="button" className="dpp-target dpp-project-all" onClick={() => pickFilters(show, mine, null)} data-deploy-projects-all>All</button></li> : null}
          </ul>
        </nav>
        {drawn.length === 0 ? <div className="dpp-empty" data-deploys-none-picked>No projects selected</div> : (
          <DeploysBoard
            key={drawn.length === 1 ? drawn[0]._id : "projects"} target={drawn[0]} projects={drawn.length > 1 ? drawn : undefined} personal production={undefined} deploys={deploys}
            heading={shown.length === 1 ? shown[0].name : shown.length === projects.length ? "All projects" : `${shown.length} projects`}
            shipping={shipping.shipping} shippingError={shipping.error || shipping.failed} prs={personalPrs} prsFailed={personalPrsFailed} meLogin={meLogin} linesByDeploy={linesByDeploy} onLinesWanted={setLineIds} checkouts={checkouts}
            me={me ? String(me) : null} now={now} priorities={false} focus={focus} reach={reach} openDeploy={initialDeploy ?? null}
            show={show} mine={false} onShow={pickShow} onMine={pickMine} onClearFocus={clearFocus}
            onPress={press.open} onRollback={press.openRollback} onPause={() => {}} onLift={() => {}}
          />
        )}
        {lineIds.map((id) => <LinesFeed key={id} deployId={id} />)}
        {shownRepos.map((r) => <OpenPrsFeed key={r} repository={r} onState={onPrFeed} />)}
      </div>
      </div>
    );
  }
  if (!ready && (!fresh || allTargets.length === 0)) return <div className={frame}>{header}<div className="dpp" aria-busy><nav className="dpp-targets">{railTitle}</nav><div className="dpp-main dpp-cold" /></div></div>;
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
            const waiting = t.queue.known && !t.queue.reading ? t.queue.commits : 0;
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
          shipping={shipping.shipping} shippingError={shipping.error || shipping.failed} prs={prs} prsFailed={prsFailed} meLogin={meLogin} linesByDeploy={linesByDeploy} onLinesWanted={setLineIds} checkouts={checkouts}
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

/** Feeds one project's open pull requests into the store (hooks/useSyncTimeline) and says when its answer is in. */
function OpenPrsFeed({ repository, onState }: { repository: string; onState: (repository: string, st: { live: boolean; failed: boolean } | null) => void }) {
  const { live, failed } = useSyncOpenPullRequests(repository);
  useWatchEffect(() => {
    onState(repository, { live, failed });
    return () => onState(repository, null);
  }, [repository, live, failed]);
  return null;
}

/** Feeds one shown deploy card's lines into the store (hooks/useDeployLines), whether or not its rows are drawn. */
function LinesFeed({ deployId }: { deployId: string }) {
  useSyncDeployLines(deployId);
  return null;
}

const PROJECT_WORDS: Record<ProjectTone, string> = { going: "going out", failed: "last deploy failed", current: "live", unknown: "nothing live known" };

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
