"use client";
// /deploys (deploys.md DP10 to DP12): every place the team's code goes live,
// what runs there now, what waits on main to go out (by the session that wrote
// it, with CI), the press that sends it, what is going out now step by step,
// and every deploy with the sessions it carried and a way back. Reads the
// store only (hooks/useSyncDeployTargets); a press paints at once and the
// confirm flow (components/consequential) carries its weight.
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, CircleDashed, Loader2, RotateCcw, X } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { activeTeamIdOf } from "../../lib/activeTeam";
import { useDeployTargets } from "../../hooks/useSyncDeployTargets";
import { isMineCommit, mineOnly, orderTargets, prOfSubject, rebuiltOnly, recordTargets, rollbackTarget, sessionWords, sessionsOf, sourceWord, targetNow, targetTone, type DeployTargetRow, type TeamDeployRow, type TargetTone } from "../../lib/deploys/targets";
import type { Press } from "./DeployPress";
import { useDeployPress } from "../../hooks/useDeployPress";
import { rollBackHere } from "../../lib/deploys/press";
import { ageShort } from "../../lib/lineFlow";
import { prPageHref } from "../../lib/repoView";
import { DEPLOY_LABELS, commitMatches, deployMatches, focusRef, focusRepository, focusTarget, focusWord, reachAnyDeploy, reachDeployOn, type DeployFocus, type DeployLabel } from "../../lib/deploys/focus";
import { useDeployReach } from "../../hooks/useDeployReach";
import type { DeployReach } from "@codecast/shared/contracts/deployReach";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import type { CommitCiState, QueueGroup } from "@codecast/shared/contracts/deployTargets";
import { entityRoute } from "@codecast/shared/entities";
import { ShareControl } from "../ShareControl";
import { PageHeader } from "../ui/page-header";
import { useIsModernStyle } from "../../hooks/useVisualStyle";
import "./deploys.css";

/** Where a deploy's own log is, named by its host. */
const logWord = (d: Pick<TeamDeployRow, "source" | "url">) => `${sourceWord(d)} log`;
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "—");
const ago = (now: number, at: number | null | undefined) => (at ? ageShort(now - at) : "");

/**
 * Bring the highlighted row to the middle of the screen, and keep it there while the page above it settles (queues
 * and history arrive after the first paint). The viewer's own scroll, or 1.5s, ends it.
 */
function keepFocusInView(): () => void {
  const pane = document.querySelector("[data-deploy-pane]");
  // A deploy's row, not its item: the item holds the opened detail, which can be taller than the screen.
  const center = () => pane?.querySelector(".dpp-commit[data-focus], [data-focus] > .dpp-dp-row")?.scrollIntoView({ block: "center" });
  const frame = requestAnimationFrame(center);
  const watch = pane ? new ResizeObserver(center) : null;
  if (pane) watch!.observe(pane.closest(".dpp") ?? pane);
  const stop = () => { cancelAnimationFrame(frame); watch?.disconnect(); for (const e of ["wheel", "touchstart", "keydown"]) window.removeEventListener(e, stop); clearTimeout(timer); };
  const timer = setTimeout(stop, 1500);
  for (const e of ["wheel", "touchstart", "keydown"]) window.addEventListener(e, stop, { passive: true });
  return stop;
}

/** Change the page's address in place, so a copied link opens the view on screen; a null drops the param. */
function rewriteAddress(set: Record<string, string | null>) {
  const url = new URL(window.location.href);
  for (const [k, v] of Object.entries(set)) v === null ? url.searchParams.delete(k) : url.searchParams.set(k, v);
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}


export function DeploysPage({ initialTarget, initialTeam, initialDeploy, initialFocus, initialLabels, initialRepo }: { initialTarget?: string | null; initialTeam?: string | null; initialDeploy?: string | null; initialFocus?: DeployFocus | null; initialLabels?: DeployLabel[]; initialRepo?: string | null }) {
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
  const { targets, deploys, ready } = useDeployTargets(teamId);
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
  useEffect(() => {
    if (labels !== firstLabels.current) rewriteAddress({ show: labels.join(",") });
  }, [labels]);
  const clearFocus = () => {
    // The target the link opened stays open once the highlight goes.
    setPicked((was) => was ?? picked?._id ?? null);
    setFocus(null);
    rewriteAddress({ pr: null, sha: null, task: null, session: null, deploy: null });
  };
  const [pickedId, setPicked] = useState<string | null>(initialTarget ?? null);
  // A PR or commit's own reach says where it went out, so a deploy that listed only its newest commits still finds it.
  const inferredReach = useDeployReach(initialRepo ? null : focusRef(focus, focusRepository(null, allTargets))) ?? null;
  const reach = focus ? (initialRepo ? namedReach : inferredReach) : null;
  const focusAt = useMemo(() => (pickedId ? null : focusTarget(allTargets, deploys, focus, reach)), [pickedId, allTargets, deploys, focus, reach]);
  // A deploy link opens at that deploy's target; a change's link opens where its reach says (focusAt), not at the deploy that found the team.
  const want = pickedId ?? (initialDeploy && where ? (where.repository ? `${where.repository}#${where.target}` : where.target) : null) ?? focusAt?._id ?? null;
  const picked = ordered.find((t) => t._id === want || t.name === want) ?? ordered[0] ?? null;
  const press = useDeployPress(teamId, deploys);
  const modern = useIsModernStyle();
  const repos = new Set(allTargets.map((t) => t.repository).filter(Boolean));

  if (!teamId) return modern ? <div className="dpp-frame dpp-frame--headed"><PageHeader legacy={null} title="Deploys" /><div className="min-h-0 flex-1"><div className="dpp-empty">Deploys belong to a team.</div></div></div> : <div className="dpp-empty">Deploys belong to a team.</div>;
  const teamPicker = teams.length > 1 ? (
    <select className="dpp-team" value={teamId} onChange={(e) => { setTeamPick(e.target.value); setPicked(null); }} aria-label="Team" data-deploys-team>
      {teams.map((t) => <option key={t._id} value={t._id}>{t.name}</option>)}
    </select>
  ) : null;
  // `dpp-frame` is the page's own width (deploys.css): a narrow pane stacks the targets above the target.
  // Classic and Minimal: the page's name at the top of the targets rail.
  // Modern: the page header over the targets and the target.
  const header = <PageHeader legacy={null} title="Deploys" count={allTargets.length || null} actions={teamPicker} />;
  const railTitle = !modern && <div className="dpp-title-row"><h1 className="dpp-title">Deploys</h1>{teamPicker}</div>;
  const frame = modern ? "dpp-frame dpp-frame--headed" : "dpp-frame";
  if (!ready && allTargets.length === 0) return <div className={frame}>{header}<div className="dpp" aria-busy><nav className="dpp-rail">{railTitle}</nav><div className="dpp-main dpp-cold" /></div></div>;
  if (allTargets.length === 0) return <div className={frame}>{header}<div className="dpp" data-deploys-none><nav className="dpp-rail">{railTitle}</nav><div className="dpp-empty">No deploys yet</div></div></div>;

  return (
    <div className={frame}>
    {header}
    <div className="dpp" data-deploys-page>
      <nav className="dpp-rail" aria-label="Deploy targets">
        {railTitle}
        <ul>
          {ordered.map((t) => {
            const n = targetNow(t, deploys);
            const tone = targetTone(t, n);
            return (
              <li key={t._id}>
                <button type="button" className="dpp-target" aria-current={picked?._id === t._id ? "true" : undefined} data-tone={tone} onClick={() => setPicked(t._id)} data-deploy-target={t.name}>
                  <ToneMark tone={tone} />
                  <span className="dpp-target-name">{t.name}{repos.size > 1 ? <span className="dpp-repo">{t.repository.split("/").pop()}</span> : null}</span>
                  <span className="dpp-target-state">{targetWords(t, n, tone)}</span>
                  <span className="dpp-target-live">{n.live ? <><code>{short(n.live.sha)}</code> {ago(now, n.live.live_at ?? n.live.created_at)}</> : "no live version known"}</span>
                </button>
                {tone === "waiting" ? <WaitingSessions t={t} onOpen={(key) => { setPicked(t._id); requestAnimationFrame(() => document.querySelector(`[data-deploy-group="${key}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" })); }} /> : null}
              </li>
            );
          })}
        </ul>
      </nav>
      {picked ? <TargetPane key={picked._id} target={picked} deploys={deploys} now={now} onPress={press.open} openDeploy={initialDeploy ?? null} focus={focus} reach={reach} onClearFocus={clearFocus} labels={labels} onToggleLabel={toggleLabel} /> : null}
      {press.review}
    </div>
    </div>
  );
}

/** The sessions a target's waiting commits came from, a press from their place in the queue. */
function WaitingSessions({ t, onOpen }: { t: DeployTargetRow; onOpen: (key: string) => void }) {
  const groups = t.queue.groups;
  const shown = groups.slice(0, 3);
  return (
    <ul className="dpp-rail-sessions" data-deploy-rail-sessions={t.name}>
      {shown.map((g) => (
        <li key={g.key}>
          <button type="button" onClick={() => onOpen(g.key)} title={g.session?.title ?? "Commits with no Codecast-Session trailer"}>
            <span className="dpp-rail-session" data-none={g.session ? undefined : ""}>{g.session ? g.session.title || g.session.short_id : "Not from a session"}</span>
            <span className="dpp-num">{g.commits.length}</span>
          </button>
        </li>
      ))}
      {groups.length > shown.length ? <li className="dpp-dim dpp-rail-more">+{groups.length - shown.length} more</li> : null}
    </ul>
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

function TargetPane({ target: t, deploys, now, onPress, openDeploy, focus, reach, onClearFocus, labels, onToggleLabel }: { target: DeployTargetRow; deploys: ReadonlyArray<TeamDeployRow>; now: number; onPress: (p: Press) => void; openDeploy: string | null; focus: DeployFocus | null; reach: DeployReach | null; onClearFocus: () => void; labels: DeployLabel[]; onToggleLabel: (l: DeployLabel) => void }) {
  const n = targetNow(t, deploys);
  // Where the linked thing is here: waiting in the queue, or on the deploys that took it out (newest first).
  const focusWaiting = !!focus && t.queue.groups.some((g) => g.commits.some((c) => commitMatches(c, focus)));
  // Reach names the one deploy that holds a PR or commit here; anything else is matched on what each deploy carried.
  const held = reachDeployOn(reach, t.name);
  const focusDeploys = !focus ? [] : held ? n.history.filter((d) => d.short_id === held.short_id) : n.history.filter((d) => deployMatches(d, focus));
  const focusOpen = focusWaiting ? null : focusDeploys[0]?.short_id ?? null;
  const [open, setOpen] = useState<string | null>(openDeploy ?? focusOpen);
  // Reach lands after the first paint: open the deploy it names once it does, and bring the highlight on screen.
  useEffect(() => {
    if (!focus) return;
    if (focusOpen && !openDeploy) setOpen(focusOpen);
    return keepFocusInView();
  }, [focus, focusOpen, focusWaiting, openDeploy]);
  const [mineOn, setMineOn] = useState(false);
  const login = useInboxStore((s) => (s.currentUser as { github_username?: string } | null)?.github_username ?? null);
  const name = useInboxStore((s) => (s.currentUser as { name?: string } | null)?.name ?? null);
  const me = { login, name };
  const mineCount = t.queue.groups.reduce((n, g) => n + g.commits.filter((c) => isMineCommit(c.author, me)).length, 0);
  // With none of yours left waiting the toggle goes away, so the filter must too, or the list strands empty.
  const mineShown = mineOn && mineCount > 0;
  const groups = mineShown ? mineOnly(t.queue.groups, me) : t.queue.groups;
  const back = rollbackTarget(n.history, n.live);
  const waiting = t.queue.commits;
  const sessions = t.queue.groups.filter((g) => g.session).length;
  const blocked = n.open ? `${n.open.short_id || "A deploy"} is going out` : !t.can_deploy ? (t.runs === "push" ? "Deploys itself when main moves" : "No machine publishes it") : waiting === 0 && t.queue.known ? "Nothing waiting" : null;
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
          {back && (t.can_redeploy_sha || t.can_rollback) && !n.open ? (
            <button type="button" className="dpp-back" onClick={() => onPress({ target: t, action: t.can_rollback ? "rollback" : "redeploy", of: back })} data-deploy-rollback={t.name}>
              <RotateCcw className="w-3 h-3" aria-hidden />Roll back to {short(back.sha)}
            </button>
          ) : null}
        </div>
      </header>

      {n.open ? <GoingOut d={n.open} now={now} /> : n.failed ? <Failed d={n.failed} /> : null}
      {focus ? <FocusChip focus={focus} waiting={focusWaiting} deploys={focusDeploys} live={n.live} onClear={onClearFocus} /> : null}

      <div className="dpp-body" data-record-only={t.record_only ? "" : undefined}>
      {t.record_only ? null : <section className="dpp-sec" data-deploy-waiting>
        <h3>Waiting on main{t.queue.known ? <span className="dpp-num">{waiting} {waiting === 1 ? "commit" : "commits"}</span> : null}{sessions ? <span className="dpp-h-sub">· {sessions} {sessions === 1 ? "session" : "sessions"}</span> : null}{t.queue.untouched ? <span className="dpp-h-sub" title={`${t.queue.untouched} commits on main change no file ${t.name} ships`}>· {t.queue.untouched} not for {t.name}</span> : null}<LabelSwitch labels={labels} onToggle={onToggleLabel} />{mineCount ? <button type="button" className="dpp-mine" aria-pressed={mineShown} onClick={() => setMineOn((v) => !v)} data-deploy-mine>Mine<span className="dpp-num">{mineCount}</span></button> : null}</h3>
        {!t.queue.known ? <p className="dpp-none" data-deploy-queue-unknown>Live <code>{short(n.live?.sha)}</code> is not on main, so what waits here can't be counted.</p>
        : waiting === 0 ? <p className="dpp-none">Everything on main is live here.</p> : (
          <ul className="dpp-groups">
            {groups.map((g) => <SessionGroup key={g.key} g={g} now={now} repository={t.repository} me={me} labels={labels} focus={focus} />)}
            {!mineShown && t.queue.commits > t.queue.shown ? <li className="dpp-more">{t.queue.commits - t.queue.shown} older commits</li> : null}
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
              : rollBackHere(d, t, deploys) ? (
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
    </section>
  );
}

/** One deploy whole: every session it carried, its steps, who sent it, and its own log. */
function DeployDetail({ d, now }: { d: TeamDeployRow; now: number }) {
  const ss = sessionsOf(d);
  return (
    <div className="dpp-detail" data-deploy-detail={d.short_id}>
      <dl>
        <dt>Sent</dt><dd><code>{short(d.previous_sha)}</code> → <code>{short(d.sha)}</code>{d.version && !(d.sha ?? "").startsWith(d.version.slice(0, 7)) ? <span className="dpp-ver"> {d.version}</span> : null}</dd>
        <dt>By</dt><dd>{d.started_by ?? sourceWord(d)} · {new Date(d.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}{d.live_at && d.live_at - d.created_at >= 60_000 ? ` · live after ${ageShort(d.live_at - d.created_at)}` : ""}</dd>
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
  const tasks = [...new Map(g.commits.flatMap((c) => c.tasks).map((t) => [t.task_id, t])).values()];
  const authors = [...new Set(g.commits.map((c) => c.author).filter(Boolean))] as string[];
  const shown = all ? g.commits : g.commits.slice(0, GROUP_SHOWN);
  return (
    <li className="dpp-group" data-deploy-session={g.session?.conversation_id ?? "none"} data-deploy-group={g.key}>
      <div className="dpp-group-head">
        <CiMark ci={g.ci} />
        {g.session
          ? <><Link className="dpp-session" href={`/conversation/${g.session.conversation_id}`}>{sessionWords(g.session)}</Link>{(g.session as { via?: string }).via === "task" ? <span className="dpp-via" title="These commits name a task, not a session; this is the task's newest session">by its task</span> : null}</>
          : <span className="dpp-session dpp-dim" title="Commits with no Codecast-Session trailer">Not from a session{authors.length ? <span className="dpp-authors"> · {authors.slice(0, 3).join(", ")}{authors.length > 3 ? ` +${authors.length - 3}` : ""}</span> : null}</span>}
        {tasks.map((t) => <Link key={t.task_id} className="dpp-task" href={`/tasks/${t.short_id ?? t.task_id}`} title={t.title ?? undefined}>{t.short_id}</Link>)}
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

/** One of a waiting commit's IDs, in a fixed-width cell so every row's IDs line up; a commit without one leaves the cell empty. */
function CommitId({ kind, c, pr, repository }: { kind: DeployLabel; c: QueueGroup["commits"][number]; pr: number | null; repository: string }) {
  if (kind === "pr") return pr ? <Link className="dpp-id dpp-pr" data-kind="pr" href={prPageHref(repository, pr)} data-deploy-pr={pr}>#{pr}</Link> : <span className="dpp-id" data-kind="pr" />;
  if (kind === "sha") return <code className="dpp-id" data-kind="sha">{short(c.sha)}</code>;
  if (kind === "task") {
    const t = c.tasks.find((x) => x.short_id);
    return t ? <Link className="dpp-id dpp-task" data-kind="task" href={`/tasks/${t.short_id}`} title={c.tasks.map((x) => x.short_id ?? "").filter(Boolean).join(", ")}>{t.short_id}</Link> : <span className="dpp-id" data-kind="task" />;
  }
  const s = c.session;
  return s ? <Link className="dpp-id dpp-sid" data-kind="session" href={`/conversation/${s.conversation_id}`} title={s.title ?? undefined}>{s.short_id ?? s.conversation_id.slice(0, 7)}</Link> : <span className="dpp-id" data-kind="session" />;
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
function FocusChip({ focus, waiting, deploys, live, onClear }: { focus: DeployFocus; waiting: boolean; deploys: TeamDeployRow[]; live: TeamDeployRow | null; onClear: () => void }) {
  const d = deploys[0];
  const where = !d && !waiting ? "not on this target"
    : waiting ? "waiting"
    : focus.kind === "deploy" ? (d._id === live?._id ? "live now" : d.status)
    : d._id === live?._id ? `live in ${d.short_id}` : d.status === "live" ? `went out in ${d.short_id}` : `${d.status} in ${d.short_id}`;
  return (
    <div className="dpp-focus" data-state={waiting ? "waiting" : d ? "deployed" : "missing"} data-deploy-focus={focusWord(focus)}>
      <b>{focusWord(focus)}</b>
      <span>{where}</span>
      <button type="button" onClick={onClear} aria-label="Clear highlight" data-deploy-focus-clear><X className="w-3 h-3" aria-hidden /></button>
    </div>
  );
}
