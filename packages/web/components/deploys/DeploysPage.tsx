"use client";
// /deploys (deploys.md DP10 to DP12): every place the team's code goes live,
// what runs there now, what waits on main to go out (by the session that wrote
// it, with CI), the press that sends it, what is going out now step by step,
// and every deploy with the sessions it carried and a way back. Reads the
// store only (hooks/useSyncDeployTargets); a press paints at once and the
// confirm flow (components/consequential) carries its weight.
import { useMemo, useState } from "react";
import Link from "next/link";
import { Check, CircleDashed, Loader2, RotateCcw, X } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { activeTeamIdOf } from "../../lib/activeTeam";
import { useDeployTargets } from "../../hooks/useSyncDeployTargets";
import { orderTargets, recordTargets, rollbackTarget, sessionsOf, targetNow, targetTone, type DeployTargetRow, type TeamDeployRow, type TargetTone } from "../../lib/deploys/targets";
import type { Press } from "./DeployPress";
import { useDeployPress } from "../../hooks/useDeployPress";
import { ageShort } from "../../lib/lineFlow";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import type { CommitCiState, QueueGroup } from "@codecast/shared/contracts/deployTargets";
import "./deploys.css";

/** Who sent a deploy codecast did not start, by where it reports from. */
function sourceWord(d: Pick<TeamDeployRow, "source" | "url">): string {
  const host = d.url ? (() => { try { return new URL(d.url!).hostname; } catch { return ""; } })() : "";
  if (/railway\./.test(host)) return "Railway";
  if (/expo\./.test(host)) return "EAS";
  const src = d.source ?? "";
  if (src.startsWith("github")) return "GitHub";
  if (src.includes("ship mark") || src === "marker") return "deploy.sh";
  if (src === "codecast") return "codecast";
  return src;
}
/** Where a deploy's own log is, named by its host. */
const logWord = (d: Pick<TeamDeployRow, "source" | "url">) => `${sourceWord(d)} log`;
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "—");
const ago = (now: number, at: number | null | undefined) => (at ? ageShort(now - at) : "");


export function DeploysPage({ initialTarget, initialTeam, initialDeploy }: { initialTarget?: string | null; initialTeam?: string | null; initialDeploy?: string | null }) {
  // A deploy named in the address (a dp-N pill) opens on its own team and target, wherever the viewer was.
  const where = useQueryNoThrow((api as any).deployRefs.whereIs, initialDeploy ? { ref: initialDeploy } : "skip").data as { team_id: string | null; target: string; repository: string | null } | null | undefined;
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
  const [pickedId, setPicked] = useState<string | null>(initialTarget ?? null);
  const want = pickedId ?? (where ? (where.repository ? `${where.repository}#${where.target}` : where.target) : null);
  const picked = ordered.find((t) => t._id === want || t.name === want) ?? ordered[0] ?? null;
  const press = useDeployPress(teamId, deploys);
  const repos = new Set(allTargets.map((t) => t.repository).filter(Boolean));

  if (!teamId) return <div className="dpp-empty">Deploys belong to a team.</div>;
  const teamPicker = teams.length > 1 ? (
    <select className="dpp-team" value={teamId} onChange={(e) => { setTeamPick(e.target.value); setPicked(null); }} aria-label="Team" data-deploys-team>
      {teams.map((t) => <option key={t._id} value={t._id}>{t.name}</option>)}
    </select>
  ) : null;
  if (!ready && allTargets.length === 0) return <div className="dpp" aria-busy><nav className="dpp-rail"><div className="dpp-title-row"><h1 className="dpp-title">Deploys</h1>{teamPicker}</div></nav><div className="dpp-main dpp-cold" /></div>;
  if (allTargets.length === 0) return <div className="dpp" data-deploys-none><nav className="dpp-rail"><div className="dpp-title-row"><h1 className="dpp-title">Deploys</h1>{teamPicker}</div></nav><div className="dpp-empty">No deploys yet</div></div>;

  return (
    <div className="dpp" data-deploys-page>
      <nav className="dpp-rail" aria-label="Deploy targets">
        <div className="dpp-title-row"><h1 className="dpp-title">Deploys</h1>{teamPicker}</div>
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
      {picked ? <TargetPane key={picked._id} target={picked} deploys={deploys} now={now} onPress={press.open} openDeploy={initialDeploy ?? null} /> : null}
      {press.review}
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
  return `${t.queue.commits} waiting`;
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

function TargetPane({ target: t, deploys, now, onPress, openDeploy }: { target: DeployTargetRow; deploys: ReadonlyArray<TeamDeployRow>; now: number; onPress: (p: Press) => void; openDeploy: string | null }) {
  const [open, setOpen] = useState<string | null>(openDeploy);
  const n = targetNow(t, deploys);
  const back = rollbackTarget(n.history, n.live);
  const waiting = t.queue.commits;
  const sessions = t.queue.groups.filter((g) => g.session).length;
  const blocked = n.open ? `${n.open.short_id || "A deploy"} is going out` : !t.can_deploy ? (t.runs === "push" ? "Deploys itself when main moves" : "No machine publishes it") : waiting === 0 ? "Nothing waiting" : null;
  return (
    <section className="dpp-main" data-deploy-pane={t.name}>
      <header className="dpp-head">
        <div className="dpp-head-name">
          <h2>{t.name}</h2>
          <span className="dpp-policy" data-policy={t.policy}>{t.record_only ? "from its deploy records" : t.runs === "push" ? "on every push" : t.policy === "auto" ? "on green CI" : "on a press"}</span>
        </div>
        <div className="dpp-live">
          <span className="dpp-head-sub">{t.repository}</span>
          <span className="dpp-k">Live</span>
          {n.live ? (
            <span className="dpp-v"><code>{short(n.live.sha)}</code>{n.live.version ? <span className="dpp-ver">{n.live.version}</span> : null}<span className="dpp-dp">{n.live.short_id}</span><span className="dpp-age">{ago(now, n.live.live_at ?? n.live.created_at)}</span></span>
          ) : <span className="dpp-v dpp-dim">no live version known</span>}
        </div>
        <div className="dpp-actions">
          {t.record_only ? null : t.runs === "push"
            ? <span className="dpp-auto">goes out when main moves</span>
            : waiting === 0 && !n.open
              ? <span className="dpp-current" data-deploy-current={t.name}><Check className="w-3.5 h-3.5" strokeWidth={3} aria-hidden />Up to date</span>
              : <button type="button" className="dpp-go" disabled={!!blocked} title={blocked ?? undefined} onClick={() => onPress({ target: t, action: "deploy", of: null })} data-deploy-go={t.name}>
                  {n.open ? "Going out" : `Deploy ${waiting} ${waiting === 1 ? "commit" : "commits"}`}
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

      <div className="dpp-body">
      <section className="dpp-sec" data-deploy-waiting>
        <h3>Waiting on main<span className="dpp-num">{waiting} {waiting === 1 ? "commit" : "commits"}</span>{sessions ? <span className="dpp-h-sub">· {sessions} {sessions === 1 ? "session" : "sessions"}</span> : null}{t.queue.untouched ? <span className="dpp-h-sub" title={`${t.queue.untouched} commits on main change no file ${t.name} ships`}>· {t.queue.untouched} skip {t.name}</span> : null}</h3>
        {waiting === 0 ? <p className="dpp-none">Everything on main is live here.</p> : (
          <ul className="dpp-groups">
            {t.queue.groups.map((g) => <SessionGroup key={g.key} g={g} now={now} />)}
            {t.queue.commits > t.queue.shown ? <li className="dpp-more">{t.queue.commits - t.queue.shown} older commits</li> : null}
          </ul>
        )}
      </section>

      <section className="dpp-sec" data-deploy-history>
        <h3>History<span className="dpp-num">{n.history.length}</span></h3>
        <ul className="dpp-history">
          {n.history.map((d) => (
            <li key={d._id} className="dpp-dp-item" data-open={open === d.short_id ? "" : undefined}>
            <div className="dpp-dp-row" data-status={d.status} data-live-now={d._id === n.live?._id ? "" : undefined} data-deploy-row={d.short_id || d._id}>
              <StatusMark status={d.status} />
              <button type="button" className="dpp-dp-id" aria-expanded={open === d.short_id} onClick={() => setOpen(open === d.short_id ? null : d.short_id)} data-deploy-open={d.short_id}>{d.short_id || "…"}</button>
              <code className="dpp-dp-sha">{short(d.sha)}</code>
              <span className="dpp-dp-by">{d.started_by ?? sourceWord(d)}</span>
              <span className="dpp-age">{ago(now, d.live_at ?? d.created_at)}</span>
              {d._id === n.live?._id ? <span className="dpp-livenow" data-deploy-live-now>Live now</span>
              : d.status === "live" && d._id !== n.live?._id && d.sha && d.sha !== n.live?.sha && (t.can_redeploy_sha || t.can_rollback) && !n.open ? (
                <button type="button" className="dpp-row-act" onClick={() => onPress({ target: t, action: t.can_redeploy_sha ? "redeploy" : "rollback", of: d })} data-deploy-redeploy={d.short_id}><RotateCcw className="w-3 h-3" aria-hidden />Go back</button>
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
        <dt>Sent</dt><dd><code>{short(d.previous_sha)}</code> → <code>{short(d.sha)}</code>{d.version ? <span className="dpp-ver"> {d.version}</span> : null}</dd>
        <dt>By</dt><dd>{d.started_by ?? sourceWord(d)} · {new Date(d.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}{d.live_at && d.live_at - d.created_at >= 60_000 ? ` · live after ${ageShort(d.live_at - d.created_at)}` : ""}</dd>
        {d.note ? <><dt>Note</dt><dd>{d.note}</dd></> : null}
        {d.steps?.length ? <><dt>Steps</dt><dd><ol className="dpp-steps">{d.steps.map((s) => <li key={s.id} data-status={s.status}>{s.id}</li>)}</ol></dd></> : null}
        <dt>Sessions</dt>
        <dd>{ss.length ? <ul className="dpp-detail-sessions">{ss.map((x) => <li key={x.conversation_id}><Link href={`/conversation/${x.conversation_id}`}>{x.title || x.short_id || x.conversation_id.slice(0, 7)}</Link></li>)}</ul> : <span className="dpp-dim">{d.commits ? `${d.commits} commits, none from a session` : "Not recorded"}</span>}</dd>
      </dl>
      {d.url ? <a className="dpp-log" href={d.url} target="_blank" rel="noreferrer">{logWord(d)}</a> : null}
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
  const empty = !failed && !back && !d.commits && !sessionsOf(d).length && !tasks.length && !after;
  if (empty) return null;
  return (
    <div className="dpp-carried">
      {failed ? <span className="dpp-why">{d.note || "Failed"}</span> : null}
      {back ? <span className="dpp-dim">back to {d.rollback_of ?? short(d.sha)}</span> : null}
      <DeploySessions d={d} />
      {tasks.slice(0, 3).map((x) => <Link key={x.short_id!} className="dpp-task" href={`/tasks/${x.short_id}`} title={x.title ?? undefined}>{x.short_id}</Link>)}
      {d.commits && !sessionsOf(d).length ? <span className="dpp-dim">{d.commits} {d.commits === 1 ? "commit" : "commits"}</span> : null}
      {after && !failed ? <AfterMark after={after} /> : null}
    </div>
  );
}

/** What happened after a deploy went live: quiet, or the errors that started or came back in its window. */
function AfterMark({ after }: { after: NonNullable<TeamDeployRow["after"]> }) {
  if (after.quiet) return <span className="dpp-after" data-tone="ok">{after.open ? "quiet so far" : "quiet"}</span>;
  const parts = [after.new_errors ? `${after.new_errors} new ${after.new_errors === 1 ? "error" : "errors"}` : null, after.regressions ? `${after.regressions} came back` : null].filter(Boolean);
  return parts.length ? <span className="dpp-after" data-tone="bad">{parts.join(" · ")}</span> : null;
}

/** The sessions a deploy carried, each a step from its thread. */
function DeploySessions({ d }: { d: TeamDeployRow }) {
  const ss = sessionsOf(d);
  if (!ss.length) return null;
  const shown = ss.slice(0, 2);
  return (
    <span className="dpp-dp-sessions">
      {shown.map((x) => <Link key={x.conversation_id} className="dpp-dp-session" href={`/conversation/${x.conversation_id}`} title={x.title ?? undefined}>{x.title || x.short_id || x.conversation_id.slice(0, 7)}</Link>)}
      {ss.length > shown.length ? <span className="dpp-dim">+{ss.length - shown.length}</span> : null}
    </span>
  );
}

function StatusMark({ status }: { status: TeamDeployRow["status"] }) {
  return <span className="dpp-status" data-status={status} title={status}>{status === "live" ? <Check className="w-3 h-3" strokeWidth={3} /> : status === "failed" ? <X className="w-3 h-3" strokeWidth={3} /> : status === "cancelled" ? <i className="dpp-ci-none" /> : <Loader2 className="w-3 h-3 animate-spin" />}</span>;
}

/** One session's commits waiting on a target: the session first, then its commits with CI. */
const GROUP_SHOWN = 5;

function SessionGroup({ g, now }: { g: QueueGroup; now: number }) {
  const [all, setAll] = useState(false);
  const tasks = [...new Map(g.commits.flatMap((c) => c.tasks).map((t) => [t.task_id, t])).values()];
  const authors = [...new Set(g.commits.map((c) => c.author).filter(Boolean))] as string[];
  const shown = all ? g.commits : g.commits.slice(0, GROUP_SHOWN);
  return (
    <li className="dpp-group" data-deploy-session={g.session?.conversation_id ?? "none"} data-deploy-group={g.key}>
      <div className="dpp-group-head">
        <CiMark ci={g.ci} />
        {g.session
          ? <Link className="dpp-session" href={`/conversation/${g.session.conversation_id}`}>{g.session.title || g.session.short_id || "Untitled session"}</Link>
          : <span className="dpp-session dpp-dim" title="Commits with no Codecast-Session trailer">Not from a session{authors.length ? <span className="dpp-authors"> · {authors.slice(0, 3).join(", ")}{authors.length > 3 ? ` +${authors.length - 3}` : ""}</span> : null}</span>}
        {tasks.map((t) => <Link key={t.task_id} className="dpp-task" href={`/tasks/${t.short_id ?? t.task_id}`} title={t.title ?? undefined}>{t.short_id}</Link>)}
        <span className="dpp-group-n">{g.commits.length} {g.commits.length === 1 ? "commit" : "commits"}</span>
      </div>
      <ul className="dpp-commits">
        {shown.map((c) => (
          <li key={c.sha} className="dpp-commit">
            <CiMark ci={c.ci} url={c.ci_url} />
            <code>{short(c.sha)}</code>
            <span className="dpp-subject">{c.subject}</span>
            <span className="dpp-age">{ago(now, c.at)}</span>
          </li>
        ))}
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
