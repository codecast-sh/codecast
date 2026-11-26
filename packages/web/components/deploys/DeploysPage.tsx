"use client";
// /deploys (deploys.md DP10 to DP12): every place the team's code goes live,
// what runs there now, what waits on main to go out (by the session that wrote
// it, with CI), the press that sends it, what is going out now step by step,
// and every deploy with the sessions it carried and a way back. Reads the
// store only (hooks/useSyncDeployTargets); a press paints at once and the
// confirm flow (components/consequential) carries its weight.
import { OnItsWay, type FocusComing } from "../changes/OnItsWay";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, CircleDashed, Loader2, Pause, RotateCcw, X } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { activeTeamIdOf } from "../../lib/activeTeam";
import { useDeployTargets } from "../../hooks/useSyncDeployTargets";
import { isMineCommit, mineOnly, orderTargets, prOfSubject, productionOf, rebuiltOnly, recordTargets, rollbackTarget, sessionWords, sessionsOf, sourceWord, targetNow, targetTone, type DeployProductionRow, type DeployTargetRow, type TeamDeployRow, type TargetTone } from "../../lib/deploys/targets";
import type { Press, RollbackPress } from "./DeployPress";
import { useDeployPress } from "../../hooks/useDeployPress";
import { rollBackHere, rollbackOffer } from "../../lib/deploys/press";
import type { DeployPauseView } from "@codecast/shared/contracts/deployPause";
import { ageShort } from "../../lib/lineFlow";
import { DEPLOY_LABELS, FOCUS_PARAMS, NO_FILTERS, commitMatches, deployMatches, filterParams, focusRef, focusRepository, focusSettled, focusTarget, focusWord, pickTarget, reachAnyDeploy, reachDeployOn, targetKey, type DeployFilters, type DeployFocus, type DeployLabel } from "../../lib/deploys/focus";
import type { ChangeViewer } from "../../lib/changes/rows";
import { useDeployReach } from "../../hooks/useDeployReach";
import { useDeployDetail, useSyncDeployDetail } from "../../hooks/useDeployDetail";
import type { DeployReach } from "@codecast/shared/contracts/deployReach";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { changeGroups, devPushWords, hasChangeNames, originWords, shownNames, type ChangeGroup } from "./deployRecord";
import type { CommitCiState, QueueGroup } from "@codecast/shared/contracts/deployTargets";
import { entityRoute } from "@codecast/shared/entities";
import { ShareControl } from "../ShareControl";
import { EntityIdPill } from "../EntityIdPill";
import { PageHeader } from "../ui/page-header";
import { useIsModernStyle } from "../../hooks/useVisualStyle";
import "./deploys.css";

/** Where a deploy's own log is, named by its host. */
const logWord = (d: Pick<TeamDeployRow, "source" | "url">) => `${sourceWord(d)} log`;
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "—");
const ago = (now: number, at: number | null | undefined) => (at ? ageShort(now - at) : "");

/** The rows a link highlights, most telling first: a commit waiting in the queue, the deploy that took it, its change on its way. */
const FOCUS_ROWS = [".dpp-commit[data-focus]", "[data-focus] > .dpp-dp-row", ".chb-row[data-focus]"];

/** What scrolls an element: its nearest ancestor that scrolls vertically (a column in two columns, else the pane). */
function scrollerOf(el: Element): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
  return null;
}

/** Whether a row sits more than a couple of pixels off the middle of what scrolls it (the window when nothing does). */
function offCentre(row: Element, scroller: Element | null): boolean {
  const r = row.getBoundingClientRect();
  const s = scroller ? scroller.getBoundingClientRect() : { top: 0, height: window.innerHeight };
  return Math.abs(r.top + r.height / 2 - (s.top + s.height / 2)) > 2;
}

/**
 * Land a link: bring each highlighted row to the middle of whatever scrolls it (each column scrolls on its own, so
 * each brings its own; one scroller takes the most telling), and flash each row once as it first appears. Queues,
 * history and what is on its way arrive on their own clocks and can grow above a row after it is found, so it keeps
 * the rows centred as anything moves, for 6s after the first one appeared. The viewer's own scroll, press, key or a
 * focus moving (a screen reader reading on) ends it, and so does 10s with nothing found.
 */
function landFocus(): () => void {
  const pane = document.querySelector("[data-deploy-pane]");
  if (!pane) return () => {};
  const flashed = new WeakSet<Element>();
  let frame = 0;
  let cap: ReturnType<typeof setTimeout> | undefined;
  const sized = new ResizeObserver(() => later());
  const center = () => {
    frame = 0;
    // Sections mount late (each reads its own query): watch each as it appears, so its growth re-centres the rows.
    for (const s of pane.querySelectorAll("[data-deploy-col], [data-deploy-col] > *")) sized.observe(s);
    const rows = FOCUS_ROWS.flatMap((sel) => [...pane.querySelectorAll(sel)]);
    if (!rows.length) return;
    const fresh = rows.filter((r) => !flashed.has(r));
    const centred = new Set<Element | null>();
    for (const r of rows) {
      const scroller = scrollerOf(r);
      if (centred.has(scroller)) continue;
      centred.add(scroller);
      // Anything that pushed the row off the middle (a section growing, a banner arriving above) brings it back.
      if (offCentre(r, scroller)) r.scrollIntoView({ block: "center" });
    }
    for (const r of fresh) {
      flashed.add(r);
      r.setAttribute("data-flash", "");
      const done = (e: Event) => { if (e.target !== r) return; r.removeAttribute("data-flash"); r.removeEventListener("animationend", done); };
      r.addEventListener("animationend", done);
    }
    if (!cap) { clearTimeout(give); cap = setTimeout(stop, 6000); }
  };
  function later() { if (!frame) frame = requestAnimationFrame(center); }
  const grows = new MutationObserver(later);
  grows.observe(pane, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-focus", "data-folded"] });
  const give = setTimeout(stop, 10_000);
  function stop() {
    cancelAnimationFrame(frame);
    grows.disconnect();
    sized.disconnect();
    clearTimeout(cap);
    clearTimeout(give);
    for (const e of ["wheel", "touchstart", "pointerdown", "keydown", "focusin"]) window.removeEventListener(e, stop);
  }
  for (const e of ["wheel", "touchstart", "pointerdown", "keydown", "focusin"]) window.addEventListener(e, stop, { passive: true });
  later();
  return stop;
}

/** Change the page's address in place, so a copied link opens the view on screen; a null drops the param. */
function rewriteAddress(set: Record<string, string | null>) {
  const url = new URL(window.location.href);
  for (const [k, v] of Object.entries(set)) v === null ? url.searchParams.delete(k) : url.searchParams.set(k, v);
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}


/** The viewer as "Mine" reads them: their account, their GitHub login and name, and the devices they own. */
function useViewer(): ChangeViewer {
  const userId = useInboxStore((s) => (s.currentUser as { _id?: string } | null)?._id ?? null);
  const login = useInboxStore((s) => (s.currentUser as { github_username?: string } | null)?.github_username ?? null);
  const name = useInboxStore((s) => (s.currentUser as { name?: string } | null)?.name ?? null);
  const deviceIds = useInboxStore((s) => ((s.machineRoster ?? []) as Array<{ device_id: string }>).map((d) => d.device_id).sort().join(","));
  return useMemo(() => ({ userId: userId ? String(userId) : null, login, name, devices: new Set(deviceIds ? deviceIds.split(",") : []) }), [userId, login, name, deviceIds]);
}

export function DeploysPage({ initialTarget, initialTeam, initialDeploy, initialFocus, initialLabels, initialFilters, initialRepo }: { initialTarget?: string | null; initialTeam?: string | null; initialDeploy?: string | null; initialFocus?: DeployFocus | null; initialLabels?: DeployLabel[]; initialFilters?: DeployFilters; initialRepo?: string | null }) {
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
  // What the link pointed at stays highlighted until the viewer clears it; the IDs the queue shows ride the address.
  const [focus, setFocus] = useState<DeployFocus | null>(initialFocus ?? null);
  const [labels, setLabels] = useState<DeployLabel[]>(initialLabels ?? ["pr", "sha"]);
  const toggleLabel = (l: DeployLabel) =>
    setLabels((was) => DEPLOY_LABELS.map((x) => x.id).filter((id) => (id === l ? !was.includes(id) : was.includes(id))));
  // The address follows the switch once the viewer touches it, so a copied link opens with the same IDs.
  const firstLabels = useRef(labels);
  // eslint-disable-next-line no-restricted-syntax -- keeps the address bar in step with the chosen labels
  useEffect(() => {
    if (labels !== firstLabels.current) rewriteAddress({ show: labels.join(",") });
  }, [labels]);
  // Each column's own filters, kept in the address the same way.
  const [filters, setFilters] = useState<DeployFilters>(initialFilters ?? NO_FILTERS);
  const firstFilters = useRef(filters);
  // eslint-disable-next-line no-restricted-syntax -- keeps the address bar in step with the chosen filters
  useEffect(() => {
    if (filters !== firstFilters.current) rewriteAddress(filterParams(filters));
  }, [filters]);
  const me = useViewer();
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
                <button type="button" className="dpp-target" aria-current={picked?._id === t._id ? "true" : undefined} data-tone={tone} data-paused={pause ? "" : undefined} onClick={() => setPicked(t._id)} title={pause ? `paused by ${pause.by}` : targetWords(t, n, tone)} data-deploy-target={t.name}>
                  {pause ? <Pause className="dpp-mark" aria-label="Paused" /> : <ToneMark tone={tone} />}
                  <span className="dpp-target-name">{t.name}{repos.size > 1 ? <span className="dpp-repo">{t.repository.split("/").pop()}</span> : null}</span>
                  {waiting ? <span className="dpp-target-n" data-deploy-target-waiting={waiting}>{waiting}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      {picked ? <TargetPane key={picked._id} target={picked} production={productionOf(productions, picked)} deploys={deploys} now={now} onPress={press.open} onPause={() => press.openPause(picked, allTargets)} onRollback={press.openRollback} onLift={() => press.lift(picked)} openDeploy={initialDeploy ?? null} focus={focus} reach={reach} onClearFocus={clearFocus} labels={labels} onToggleLabel={toggleLabel} filters={filters} onFilters={setFilters} me={me} /> : null}
      {press.review}
    </div>
    </div>
  );
}

function targetWords(t: DeployTargetRow, n: ReturnType<typeof targetNow>, tone: TargetTone): string {
  if (tone === "going") return n.open?.status === "running" ? "going out" : "asked for";
  if (tone === "failed") return "last deploy failed";
  if (tone === "unknown") return n.live ? "live" : "not tracked yet";
  if (tone === "current") return "up to date";
  return `${t.queue.commits} ${t.queue.commits === 1 ? "commit" : "commits"} waiting`;
}

function ToneMark({ tone }: { tone: TargetTone }) {
  if (tone === "going") return <Loader2 className="dpp-mark animate-spin" aria-hidden />;
  if (tone === "failed") return <X className="dpp-mark" strokeWidth={3} aria-hidden />;
  if (tone === "current") return <Check className="dpp-mark" strokeWidth={3} aria-hidden />;
  if (tone === "unknown") return <CircleDashed className="dpp-mark" aria-hidden />;
  return <i className="dpp-mark dpp-mark-dot" aria-hidden />;
}

function CiMark({ ci, url }: { ci: CommitCiState; url?: string | null }) {
  if (ci === "none") return <span className="dpp-ci" data-ci="none" aria-hidden />;
  const word = ci === "passed" ? "CI passed" : ci === "failed" ? "CI failed" : ci === "running" ? "CI running" : "No CI";
  const mark = <span className="dpp-ci" data-ci={ci} title={word}>{ci === "passed" ? <Check className="w-3 h-3" strokeWidth={3} /> : ci === "failed" ? <X className="w-3 h-3" strokeWidth={3} /> : ci === "running" ? <i className="dpp-ci-run" /> : <i className="dpp-ci-none" />}</span>;
  return url ? <a href={url} target="_blank" rel="noreferrer" className="dpp-ci-link">{mark}</a> : mark;
}

/** CI on what a deploy now would send, in words beside the press. */
function HeadCi({ ci, url }: { ci: CommitCiState; url: string | null }) {
  const word = ci === "passed" ? "CI passed" : ci === "failed" ? "CI failed" : ci === "running" ? "CI running" : "No CI run";
  const body = <><CiMark ci={ci === "none" ? "running" : ci} /><span>{word}</span></>;
  return url ? <a className="dpp-headci" data-ci={ci} href={url} target="_blank" rel="noreferrer" data-deploy-ci>{body}</a> : <span className="dpp-headci" data-ci={ci} data-deploy-ci>{ci === "none" ? word : body}</span>;
}

function TargetPane({ target: t, production, deploys, now, onPress, onPause, onRollback, onLift, openDeploy, focus, reach, onClearFocus, labels, onToggleLabel, filters, onFilters, me }: { target: DeployTargetRow; production: DeployProductionRow | undefined; deploys: ReadonlyArray<TeamDeployRow>; now: number; onPress: (p: Press) => void; onPause: () => void; onRollback: (p: RollbackPress) => void; onLift: () => void; openDeploy: string | null; focus: DeployFocus | null; reach: DeployReach | null; onClearFocus: () => void; labels: DeployLabel[]; onToggleLabel: (l: DeployLabel) => void; filters: DeployFilters; onFilters: (f: DeployFilters) => void; me: ChangeViewer }) {
  const n = targetNow(t, deploys);
  // Where the linked thing is here: waiting in the queue, or on the deploys that took it out (newest first).
  const focusWaiting = !!focus && t.queue.groups.some((g) => g.commits.some((c) => commitMatches(c, focus)));
  // Reach names the one deploy that holds a PR or commit here; anything else is matched on what each deploy carried.
  const held = reachDeployOn(reach, t.name);
  const focusDeploys = !focus ? [] : held ? n.history.filter((d) => d.short_id === held.short_id) : n.history.filter((d) => deployMatches(d, focus));
  const focusOpen = focusWaiting ? null : focusDeploys[0]?.short_id ?? null;
  // An open change is on neither the queue nor a deploy, only on its way (the left column says so).
  const [focusComing, setFocusComing] = useState<FocusComing>(null);
  const [open, setOpen] = useState<string | null>(openDeploy ?? focusOpen);
  // Reach lands after the first paint: once the deploy that took the linked thing is known here, open it, once.
  // Later moves (the commit going out while the page is open) never move the page on their own.
  const opened = useRef(false);
  // eslint-disable-next-line no-restricted-syntax -- opens the linked deploy once its data arrives
  useEffect(() => {
    if (opened.current || !focusOpen || openDeploy) return;
    opened.current = true;
    setOpen(focusOpen);
  }, [focusOpen, openDeploy]);
  // A link brings what it names on screen and flashes it, wherever it is on either side; the rows find themselves.
  const focusKey = focus ? `${focus.kind}:${focusWord(focus)}` : null;
  // eslint-disable-next-line no-restricted-syntax -- scrolls the linked rows into view as their data arrives
  useEffect(() => (focusKey ? landFocus() : undefined), [focusKey]);
  // Mine keeps the commit a link points at, so the highlight is never filtered away.
  const mine = filters.waiting.mine;
  const groups = mine ? mineOnly(t.queue.groups, me, (c) => commitMatches(c, focus)) : t.queue.groups;
  // A column no waiting commit fills takes no room (branches arrive only where a PR or session names one).
  const shownLabels = labels.filter((l) => l !== "branch" || t.queue.groups.some((g) => g.commits.some((c) => c.branch)));
  const back = rollbackTarget(n.history, n.live);
  const waiting = t.queue.commits;
  const sessions = t.queue.groups.filter((g) => g.session).length;
  // A workflow target goes back only through codecast's rollback, which pauses production first (DP19).
  const backPaused = t.workflow ? rollbackOffer(back, t, production, deploys) : null;
  const pause = production?.pause ?? null;
  const blocked = pause ? "Production is paused" : n.open ? `${n.open.short_id || "A deploy"} is going out` : !t.can_deploy ? (t.runs === "push" ? "Deploys itself when main moves" : "No machine publishes it") : waiting === 0 && t.queue.known ? "Nothing waiting" : null;
  return (
    <section className="dpp-main" data-deploy-pane={t.name}>
      <header className="dpp-head">
        <div className="dpp-head-name">
          <h2>{t.name}</h2>
          <span className="dpp-policy" data-policy={t.policy}>{t.record_only ? "from its deploy records" : t.runs === "push" ? "on every push" : t.policy === "auto" ? "on green CI" : t.policy === "release" ? "with every release" : "on a press"}</span>
        </div>
        <div className="dpp-live">
          <span className="dpp-head-sub">{t.repository}</span>
          <span className="dpp-k">Live</span>
          {n.live ? (
            <span className="dpp-v"><code>{short(n.live.sha)}</code>{n.live.version && !(n.live.sha ?? "").startsWith(n.live.version.slice(0, 7)) ? <span className="dpp-ver">{n.live.version}</span> : null}<span className="dpp-dp">{n.live.short_id}</span><span className="dpp-age">{ago(now, n.live.live_at ?? n.live.created_at)}</span></span>
          ) : <span className="dpp-v dpp-dim">no live version known</span>}
          {t.dev_push ? <span className="dpp-devpush" data-deploy-dev-push={t.name}>{devPushWords(t.dev_push, now)}</span> : null}
        </div>
        <div className="dpp-actions">
          {t.record_only ? null : t.runs === "push"
            ? <span className="dpp-auto">goes out when main moves</span>
            : waiting === 0 && !n.open && t.queue.known
              ? <span className="dpp-current" data-deploy-current={t.name}><Check className="w-3.5 h-3.5" strokeWidth={3} aria-hidden />Up to date</span>
              : <button type="button" className="dpp-go" disabled={!!blocked} title={blocked ?? undefined} onClick={() => onPress({ target: t, action: "deploy", of: null })} data-deploy-go={t.name}>
                  {n.open ? "Going out" : !t.queue.known ? "Deploy main" : `Deploy ${waiting} ${waiting === 1 ? "commit" : "commits"}`}
                </button>}
          {waiting ? <HeadCi ci={t.queue.head_ci} url={t.queue.head_ci_url} /> : null}
          {backPaused ? (
            <button type="button" className="dpp-back" aria-haspopup="dialog" onClick={() => onRollback(backPaused)} data-deploy-rollback={t.name}>
              <RotateCcw className="w-3 h-3" aria-hidden />Roll back to {short(backPaused.of.sha)}
            </button>
          ) : !t.workflow && back && (t.can_redeploy_sha || t.can_rollback) && !n.open ? (
            <button type="button" className="dpp-back" onClick={() => onPress({ target: t, action: t.can_rollback ? "rollback" : "redeploy", of: back })} data-deploy-rollback={t.name}>
              <RotateCcw className="w-3 h-3" aria-hidden />Roll back to {short(back.sha)}
            </button>
          ) : null}
          {production?.can_pause && !pause && !t.record_only ? (
            <button type="button" className="dpp-back" aria-haspopup="dialog" onClick={onPause} data-deploy-pause={t.repository}>
              <Pause className="w-3 h-3" aria-hidden />Pause
            </button>
          ) : null}
        </div>
      </header>

      {pause ? <Paused p={pause} canLift={!!production?.can_lift} now={now} onLift={onLift} /> : null}
      {n.open ? <GoingOut d={n.open} now={now} /> : n.failed ? <Failed d={n.failed} /> : null}
      {focus ? <FocusChip focus={focus} repository={t.repository} waiting={focusWaiting} coming={focusComing} deploys={focusDeploys} live={n.live} onClear={onClearFocus} /> : null}

      {/* Before main on the left, main and after on the right: two columns once the page is wide (deploys.css), each its own scroll. */}
      <div className="dpp-body">
      {t.record_only ? null : <div className="dpp-col" data-deploy-col="before"><OnItsWay repository={t.repository} filters={filters.coming} onFilters={(coming) => onFilters({ ...filters, coming })} me={me} focus={focus} onFocusFound={setFocusComing} /></div>}

      <div className="dpp-col" data-deploy-col="after">
      {t.record_only ? null : <section className="dpp-sec" data-deploy-waiting>
        <h3>Waiting on main{t.queue.known ? <span className="dpp-num">{waiting} {waiting === 1 ? "commit" : "commits"}</span> : null}{sessions ? <span className="dpp-h-sub">· {sessions} {sessions === 1 ? "session" : "sessions"}</span> : null}{t.queue.untouched ? <span className="dpp-h-sub" title={`${t.queue.untouched} commits on main change no file ${t.name} ships`}>· {t.queue.untouched} not for {t.name}</span> : null}</h3>
        {t.queue.known && waiting ? (
          <div className="dpp-filters" data-deploy-filters="waiting">
            <button type="button" className="dpp-mine" aria-pressed={mine} onClick={() => onFilters({ ...filters, waiting: { mine: !mine } })} aria-label="Only my commits" data-deploy-mine="waiting">Mine</button>
            <LabelSwitch labels={labels} onToggle={onToggleLabel} />
          </div>
        ) : null}
        {!t.queue.known ? <p className="dpp-none" data-deploy-queue-unknown>Live <code>{short(n.live?.sha)}</code> is not on main, so what waits here can't be counted.</p>
        : waiting === 0 ? <p className="dpp-none">Everything on main is live here.</p>
        : !groups.length ? <p className="dpp-none" data-deploy-none-mine>None of yours</p> : (
          <ul className="dpp-groups">
            {groups.map((g) => <SessionGroup key={g.key} g={g} now={now} repository={t.repository} me={me} labels={shownLabels} focus={focus} />)}
            {!mine && t.queue.commits > t.queue.shown ? <li className="dpp-more">{t.queue.commits - t.queue.shown} older commits</li> : null}
          </ul>
        )}
      </section>}

      <section className="dpp-sec" data-deploy-history>
        <h3>History<span className="dpp-num">{n.history.length}</span></h3>
        <ul className="dpp-history">
          {n.history.map((d) => (
            <li key={d._id} className="dpp-dp-item" data-open={open === d.short_id ? "" : undefined} data-focus={focusDeploys.includes(d) && !focusWaiting ? "" : undefined}>
            <div className="dpp-dp-row" data-status={d.status} data-live-now={d._id === n.live?._id ? "" : undefined} data-deploy-row={d.short_id || d._id}>
              <StatusMark status={d.status} />
              <button type="button" className="dpp-dp-id" aria-expanded={open === d.short_id} onClick={() => setOpen(open === d.short_id ? null : d.short_id)} data-deploy-open={d.short_id}>{d.short_id || "…"}</button>
              <code className="dpp-dp-sha">{short(d.sha)}</code>
              <span className="dpp-dp-by">{d.started_by ?? sourceWord(d)}</span>
              <span className="dpp-age">{ago(now, d.live_at ?? d.created_at)}</span>
              {d._id === n.live?._id ? <span className="dpp-livenow" data-deploy-live-now>Live now</span>
              : rollbackOffer(d, t, production, deploys) ? (
                <button type="button" className="dpp-row-act" aria-haspopup="dialog" onClick={() => onRollback(rollbackOffer(d, t, production, deploys)!)} data-deploy-redeploy={d.short_id}><RotateCcw className="w-3 h-3" aria-hidden />Roll back here</button>
              ) : rollBackHere(d, t, deploys) ? (
                <button type="button" className="dpp-row-act" onClick={() => onPress(rollBackHere(d, t, deploys)!)} data-deploy-redeploy={d.short_id}><RotateCcw className="w-3 h-3" aria-hidden />Roll back here</button>
              ) : <span />}
              <DeployCarried d={d} />
            </div>
            {open === d.short_id ? <DeployDetail d={d} now={now} /> : null}
            </li>
          ))}
        </ul>
      </section>
      </div>
      </div>
    </section>
  );
}

/** One deploy whole: every session it carried, its steps, who sent it, and its own log. */
export function DeployDetail({ d, now }: { d: TeamDeployRow; now: number }) {
  const ss = sessionsOf(d);
  // The row counts what a push added and dropped; the names come with the deploy itself, held in deployDetails.
  useSyncDeployDetail(hasChangeNames(d) ? d.short_id : null);
  const names = useDeployDetail(d._id);
  const origin = originWords(d);
  return (
    <div className="dpp-detail" data-deploy-detail={d.short_id}>
      <dl>
        <dt>Sent</dt><dd><code>{short(d.previous_sha)}</code> → <code>{short(d.sha)}</code>{d.version && !(d.sha ?? "").startsWith(d.version.slice(0, 7)) ? <span className="dpp-ver"> {d.version}</span> : null}</dd>
        <dt>By</dt><dd>{d.started_by ?? sourceWord(d)} · {new Date(d.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}{d.live_at && d.live_at - d.created_at >= 60_000 ? ` · live after ${ageShort(d.live_at - d.created_at)}` : ""}</dd>
        {origin ? <><dt>From</dt><dd data-deploy-origin>{origin}</dd></> : null}
        {changeGroups(d, names).map((g) => <DeployNames key={g.kind} g={g} />)}
        {d.note ? <><dt>Note</dt><dd>{d.note}</dd></> : null}
        {d.steps?.length ? <><dt>Steps</dt><dd><ol className="dpp-steps">{d.steps.map((s) => <li key={s.id} data-status={s.status}>{s.id}</li>)}</ol></dd></> : null}
        {d.tasks?.some((x) => x.short_id) ? <><dt>Tasks</dt><dd><ul className="dpp-detail-sessions">{d.tasks.filter((x) => x.short_id).map((x) => <li key={x.short_id!}><Link className="dpp-detail-task" href={`/tasks/${x.short_id}`}>{x.short_id}<span>{x.title}</span></Link></li>)}</ul></dd></> : null}
        {d.commit_rows?.length ? <><dt>Changes</dt><dd><DeployChanges d={d} /></dd></> : null}
        <dt>Sessions</dt>
        <dd>{ss.length ? <ul className="dpp-detail-sessions">{ss.map((x) => <li key={x.conversation_id}><Link href={`/conversation/${x.conversation_id}`}>{sessionWords(x)}</Link></li>)}</ul> : <span className="dpp-dim">{d.commits ? `${d.commits} commits, none from a session` : "Not recorded"}</span>}</dd>
      </dl>
      {d.url ? <a className="dpp-log" href={d.url} target="_blank" rel="noreferrer">{logWord(d)}</a> : null}
      {d.short_id ? <ShareControl label="deploy" path={entityRoute("deploy", d.short_id)!} /> : null}
      <span className="dpp-age">{ago(now, d.created_at)}</span>
    </div>
  );
}

/** The names a push took off its target or put on it, the first few with the rest a press away. */
function DeployNames({ g }: { g: ChangeGroup }) {
  const [all, setAll] = useState(false);
  const { shown, more } = shownNames(g.names, all);
  return (
    <>
      <dt className="dpp-names-k" data-kind={g.kind}>{g.label}</dt>
      <dd>
        <ul className="dpp-names" data-deploy-names={g.kind}>{shown.map((x) => <li key={x}><code>{x}</code></li>)}</ul>
        {more ? <button type="button" className="dpp-names-more" onClick={() => setAll(true)} data-deploy-names-more={g.kind}>+{more} more</button> : null}
      </dd>
    </>
  );
}

/** What a deploy carried and what came of it, in place under its row: why it failed, the sessions and tasks it took
 *  live, how many commits, and what happened after (errors that started or came back). */
function DeployCarried({ d }: { d: TeamDeployRow }) {
  const tasks = (d.tasks ?? []).filter((x) => x.short_id);
  const back = d.action === "rollback" || d.action === "redeploy";
  const after = d.after;
  const failed = d.status === "failed";
  const empty = !failed && !back && d.status !== "live" && !d.commits && !sessionsOf(d).length && !tasks.length && !after?.open;
  if (empty) return null;
  return (
    <div className="dpp-carried">
      {failed ? <span className="dpp-why">{d.note || "Failed"}</span> : null}
      {back ? <span className="dpp-dim">back to {d.rollback_of ?? short(d.sha)}</span> : null}
      <DeploySessions d={d} />
      {tasks.slice(0, 3).map((x) => <Link key={x.short_id!} className="dpp-task" href={`/tasks/${x.short_id}`} title={x.title ?? undefined}>{x.short_id}</Link>)}
      {d.commits && !sessionsOf(d).length ? <span className="dpp-dim">{d.commits} {d.commits === 1 ? "commit" : "commits"}</span> : null}
      {rebuiltOnly(d) && !tasks.length ? <span className="dpp-dim">rebuilt, nothing new</span> : null}
      {/* A target deploy's window counts every error in the workspace, so only the window still running says it. */}
      {after?.open && !failed ? <AfterMark after={after} /> : null}
    </div>
  );
}

/** What happened after a deploy went live: quiet, or the errors that started or came back in its window. */
function AfterMark({ after }: { after: NonNullable<TeamDeployRow["after"]> }) {
  if (after.quiet) return <span className="dpp-after" data-tone="ok">quiet since</span>;
  const parts = [after.new_errors ? `${after.new_errors} new ${after.new_errors === 1 ? "error" : "errors"}` : null, after.regressions ? `${after.regressions} came back` : null].filter(Boolean);
  return parts.length ? <span className="dpp-after" data-tone="bad" title="Errors that started or came back anywhere in the workspace since this went live">since: {parts.join(" · ")}</span> : null;
}

/** What a deploy took out, change by change, under the session that wrote each. */
function DeployChanges({ d }: { d: TeamDeployRow }) {
  const titles = new Map(sessionsOf(d).map((x) => [x.conversation_id, sessionWords(x)]));
  const groups = new Map<string, NonNullable<TeamDeployRow["commit_rows"]>>();
  for (const c of d.commit_rows ?? []) {
    const k = c.conversation_id ?? "";
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const more = d.commits - (d.commit_rows?.length ?? 0);
  return (
    <div className="dpp-changes">
      {[...groups].sort(([a], [b]) => (a ? 0 : 1) - (b ? 0 : 1)).map(([k, rows]) => (
        <div key={k || "none"} className="dpp-change-group">
          {k ? <Link className="dpp-session" href={`/conversation/${k}`}>{titles.get(k) ?? k.slice(0, 7)}</Link> : <span className="dpp-session dpp-dim">Not from a session</span>}
          <ul>{rows.map((c) => <li key={c.sha}><code>{short(c.sha)}</code><span className="dpp-subject">{c.subject}</span>{c.tasks?.map((t) => <Link key={t} className="dpp-task" href={`/tasks/${t}`}>{t}</Link>)}</li>)}</ul>
        </div>
      ))}
      {more > 0 ? <span className="dpp-dim">{more} more commits</span> : null}
    </div>
  );
}

/** The sessions a deploy carried, each a step from its thread. */
function DeploySessions({ d }: { d: TeamDeployRow }) {
  const ss = sessionsOf(d);
  if (!ss.length) return null;
  const shown = ss.slice(0, 2);
  return (
    <span className="dpp-dp-sessions">
      {shown.map((x) => <Link key={x.conversation_id} className="dpp-dp-session" href={`/conversation/${x.conversation_id}`} title={x.title ?? undefined}>{sessionWords(x)}</Link>)}
      {ss.length > shown.length ? <span className="dpp-dim">+{ss.length - shown.length}</span> : null}
    </span>
  );
}

function StatusMark({ status }: { status: TeamDeployRow["status"] }) {
  return <span className="dpp-status" data-status={status} title={status}>{status === "live" ? <Check className="w-3 h-3" strokeWidth={3} /> : status === "failed" ? <X className="w-3 h-3" strokeWidth={3} /> : status === "cancelled" ? <i className="dpp-ci-none" /> : <Loader2 className="w-3 h-3 animate-spin" />}</span>;
}

/** One session's commits waiting on a target: the session first, then its commits with CI. */
const GROUP_SHOWN = 5;

function SessionGroup({ g, now, repository, me, labels, focus }: { g: QueueGroup; now: number; repository: string; me: { login: string | null; name: string | null }; labels: DeployLabel[]; focus: DeployFocus | null }) {
  // A linked commit past the first few opens the group, so the highlight is on screen.
  const [all, setAll] = useState(() => g.commits.slice(GROUP_SHOWN).some((c) => commitMatches(c, focus)));
  const authors = [...new Set(g.commits.map((c) => c.author).filter(Boolean))] as string[];
  const shown = all ? g.commits : g.commits.slice(0, GROUP_SHOWN);
  return (
    <li className="dpp-group" data-deploy-session={g.session?.conversation_id ?? "none"} data-deploy-group={g.key}>
      <div className="dpp-group-head">
        <CiMark ci={g.ci} />
        {g.session
          ? <><Link className="dpp-session" href={`/conversation/${g.session.conversation_id}`}>{sessionWords(g.session)}</Link>{(g.session as { via?: string }).via === "task" ? <span className="dpp-via" title="These commits name a task, not a session; this is the task's newest session">by its task</span> : null}</>
          : <span className="dpp-session dpp-dim" title="Commits with no Codecast-Session trailer">Not from a session{authors.length ? <span className="dpp-authors"> · {authors.slice(0, 3).join(", ")}{authors.length > 3 ? ` +${authors.length - 3}` : ""}</span> : null}</span>}
        <span className="dpp-group-n">{g.commits.length} {g.commits.length === 1 ? "commit" : "commits"}</span>
      </div>
      <ul className="dpp-commits">
        {shown.map((c) => {
          const { pr, subject } = prOfSubject(c.subject);
          const mine = isMineCommit(c.author, me);
          return (
            <li key={c.sha} className="dpp-commit" data-mine={mine ? "" : undefined} data-focus={commitMatches(c, focus) ? "" : undefined} data-deploy-commit={c.sha}>
              <CiMark ci={c.ci} url={c.ci_url} />
              <span className="dpp-ids">
                {labels.map((l) => <CommitId key={l} kind={l} c={c} pr={pr} repository={repository} />)}
              </span>
              <span className="dpp-subject" title={c.author ?? undefined}>{subject}</span>
              <span className="dpp-age">{ago(now, c.at)}</span>
            </li>
          );
        })}
        {g.commits.length > GROUP_SHOWN ? (
          <li><button type="button" className="dpp-expand" onClick={() => setAll((a) => !a)} data-deploy-group-more>{all ? "Fewer" : `${g.commits.length - GROUP_SHOWN} more`}</button></li>
        ) : null}
      </ul>
    </li>
  );
}

function GoingOut({ d, now }: { d: TeamDeployRow; now: number }) {
  const steps = d.steps ?? [];
  return (
    <section className="dpp-going" data-deploy-going={d.short_id || d._id}>
      <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
      <b>{d.action === "deploy" ? "Going out" : d.action === "rollback" ? "Rolling back" : "Redeploying"}</b>
      <span className="dpp-dp">{d.short_id || "asked for"}</span>
      <code>{short(d.sha)}</code>
      <span className="dpp-dim">{d.started_by ?? sourceWord(d)}{d.created_at ? ` · ${ago(now, d.created_at)}` : ""}</span>
      {d.url ? <a className="dpp-log" href={d.url} target="_blank" rel="noreferrer">{logWord(d)}</a> : null}
      {steps.length ? (
        <ol className="dpp-steps">{steps.map((s) => <li key={s.id} data-status={s.status}>{s.id}</li>)}</ol>
      ) : null}
    </section>
  );
}

/** The repository's production pause (DP17): who, when and why, the rollback that made it, what lifts it, and the
 *  migrations that rule a revert out. Lift for whoever may lift it. */
export function Paused({ p, canLift, now, onLift }: { p: DeployPauseView; canLift: boolean; now: number; onLift: () => void }) {
  const u = p.until;
  return (
    <section className="dpp-going" data-kind="paused" data-deploy-paused={p.repository}>
      <Pause className="w-3.5 h-3.5" aria-hidden />
      <b>Paused</b>
      <span className="dpp-paused-by">{p.by}</span>
      <span className="dpp-age">{ago(now, p.at)}</span>
      {canLift ? <button type="button" className="dpp-back dpp-lift" onClick={onLift} data-deploy-lift={p.repository}>Lift</button> : null}
      <dl className="dpp-pause-facts">
        <dt>Why</dt><dd data-deploy-pause-reason>{p.reason}</dd>
        {p.rollback ? <><dt>Rollback</dt><dd><EntityIdPill shortId={p.rollback} compact /></dd></> : null}
        <dt>Lifts</dt>
        <dd data-deploy-pause-lifts>
          {u ? <>{u.task ? <EntityIdPill shortId={u.task} compact /> : <span className="dpp-dim">its task</span>} {u.kind === "revert" ? "revert" : "fix forward"} green on main</> : `${p.by} or the Release Captain`}
        </dd>
        {u?.migrations.length ? (
          <>
            <dt>Migrations</dt>
            <dd className="dpp-pause-warn" role="alert" data-deploy-pause-migrations={u.migrations.length}>
              <b>No revert: fix forward</b>
              <ul>{u.migrations.map((m) => <li key={m}><code>{m}</code></li>)}</ul>
            </dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

function Failed({ d }: { d: TeamDeployRow }) {
  return (
    <section className="dpp-going" data-kind="failed" data-deploy-failed={d.short_id}>
      <X className="w-3.5 h-3.5" strokeWidth={3} aria-hidden />
      <b>{d.short_id} failed</b>
      <code>{short(d.sha)}</code>
      {d.url ? <a className="dpp-log" href={d.url} target="_blank" rel="noreferrer" data-deploy-log={d.short_id}>{logWord(d)}</a> : null}
      {d.note ? <span className="dpp-note">{d.note}</span> : null}
    </section>
  );
}

/**
 * One of a waiting commit's references, in a fixed-width cell so every row's columns line up; a commit without one leaves
 * the cell empty. Each is the pill a conversation draws, hover card and all: a task or session by its title (cut at the
 * cell's edge), a PR or commit by its ID, since the row's subject is already its title, bare of the state the queue says.
 */
function CommitId({ kind, c, pr, repository }: { kind: DeployLabel; c: QueueGroup["commits"][number]; pr: number | null; repository: string }) {
  const t = kind === "task" ? c.tasks.find((x) => x.short_id) : null;
  const pill =
    kind === "pr" ? (pr ? <EntityIdPill type="pr" id={`${repository}#${pr}`} idLabel={`#${pr}`} certain compact bare /> : null)
    : kind === "sha" ? <EntityIdPill type="commit" id={`${repository}@${c.sha.slice(0, 10)}`} idLabel={short(c.sha)} certain compact bare />
    : kind === "task" ? (t ? <EntityIdPill type="task" id={t.short_id!} wide /> : null)
    : kind === "session" ? (c.session ? <EntityIdPill type="session" id={c.session.conversation_id} wide /> : null)
    : c.branch ? <code title={c.branch}>{c.branch}</code> : null;
  return <span className="dpp-id" data-kind={kind} data-deploy-pr={kind === "pr" && pr ? pr : undefined}>{pill}</span>;
}

/** Which IDs each waiting commit shows; any mix, kept in the address. */
function LabelSwitch({ labels, onToggle }: { labels: DeployLabel[]; onToggle: (l: DeployLabel) => void }) {
  return (
    <span className="dpp-labels" role="group" aria-label="IDs shown" data-deploy-labels>
      {DEPLOY_LABELS.map((l) => <button key={l.id} type="button" aria-pressed={labels.includes(l.id)} onClick={() => onToggle(l.id)} data-deploy-label={l.id}>{l.word}</button>)}
    </span>
  );
}

/** The thing the link pointed at, and where it is on this target: waiting, live in a deploy, on its way out, or not here. */
export function FocusChip({ focus, repository, waiting, coming = null, deploys, live, onClear }: { focus: DeployFocus; repository: string; waiting: boolean; coming?: FocusComing; deploys: TeamDeployRow[]; live: TeamDeployRow | null; onClear: () => void }) {
  const d = deploys[0];
  const where = waiting ? "waiting"
    : !d && coming === "coming" ? "on its way"
    : !d && coming === "parked" ? "parked on its way"
    : !d && coming === "reading" ? "looking…"
    : !d ? "not on this target"
    : focus.kind === "deploy" ? (d._id === live?._id ? "live now" : d.status)
    : d._id === live?._id ? `live in ${d.short_id}` : d.status === "live" ? `went out in ${d.short_id}` : `${d.status} in ${d.short_id}`;
  return (
    <div className="dpp-focus" data-state={waiting || (!d && coming) ? "waiting" : d ? "deployed" : "missing"} data-deploy-focus={focusWord(focus)}>
      {/* The thing reads as its pill does anywhere: a session, task, PR, commit or deploy by its title; a branch by its name. */}
      <span className="dpp-focus-ref"><FocusRef focus={focus} repository={repository} /></span>
      <span>{where}</span>
      <button type="button" onClick={onClear} aria-label="Clear highlight" data-deploy-focus-clear><X className="w-3 h-3" aria-hidden /></button>
    </div>
  );
}

function FocusRef({ focus: f, repository }: { focus: DeployFocus; repository: string }) {
  switch (f.kind) {
    case "pr": return <EntityIdPill type="pr" id={`${repository}#${f.pr}`} label={focusWord(f)} certain wide />;
    case "sha": return <EntityIdPill type="commit" id={`${repository}@${f.sha}`} label={focusWord(f)} certain wide />;
    case "task": return <EntityIdPill type="task" id={f.id} wide />;
    case "session": return <EntityIdPill type="session" id={f.id} wide />;
    case "deploy": return <EntityIdPill type="deploy" id={f.id} wide />;
    case "branch": return <b>{f.name}</b>;
  }
}
