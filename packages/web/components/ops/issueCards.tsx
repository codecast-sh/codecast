// The issue page's cards that read past the group row: the Fix card (the
// problem task by name, the sessions on it, the pull request and its checks,
// and the one press that moves the fix), the check or metric card that leads
// a non-error issue, and the state strip that draws a check or metric over
// time instead of a wall of identical bars.
import { useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { Check, ChevronRight, ExternalLink, EyeOff, Link2Off, Pencil, RotateCcw, TriangleAlert, Wand2 } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { useSyncConversationPullRequests } from "../../hooks/useSyncTimeline";
import { useShaCommit, useSyncShaCommit } from "../../hooks/useSyncOps";
import { formatRelative, relTimeShort } from "../../lib/utils";
import { EntityIdPill } from "../EntityIdPill";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { entityQueryArgs } from "../../lib/entityDisplay";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { opsHref } from "./opsPaths";
import { taskByRef } from "../../lib/taskRef";
import { FixStageGlyph } from "./issueParts";
import { useResolverWords, type TaskRow } from "./useIssueFix";
import { CiRunStrip, SuspectCommit } from "./issueSuspect";
import { countWords, jobQuiet, ciBreak, ciRuns, creditedTask, taskStateWord, orderFixSessions, parseTags, fixActionLabel, fixClose, fixClosed, healthStrip, occurrencesSince, regressedAt, stripTicks, taskMatchesIssue, type FixClose, type FixPlan, type FixSessionFact, type FixStage, type HealthState } from "./issuesModel";
import { setTaskStatusUndoable, triage } from "./issueUndo";
import { useIssueEpisodes } from "./useWatchEpisodes";
import { durationShort } from "./metricModel";
import type { OpsEvent, OpsGroup, OpsSample, OpsWatch } from "./opsTypes";


const api = _api as any;


const prSig = (p: any) => `${p.number}|${p.state}|${p.checks_state ?? ""}|${p.merged_at ?? ""}|${p.title}`;
const CHECKS_INK: Record<string, string> = { success: "var(--sol-green)", failure: "var(--sol-red)", error: "var(--sol-red)", pending: "var(--sol-yellow)" };

/** Feeds one commit's row into the store; renders nothing. The page mounts it for the fix's landed commit, which the Fix card reads. */
export function CommitFeeder({ sha }: { sha: string }) {
  useSyncShaCommit(sha);
  return null;
}

/** Feeds one session's pull requests into the store; renders nothing. */
function SessionPrsFeeder({ id }: { id: string }) {
  useSyncConversationPullRequests(id);
  return null;
}

function FixPullRequests({ sessionIds }: { sessionIds: string[] }) {
  const key = sessionIds.join(",");
  const where = useMemo(() => (p: any) => Array.isArray(p.linked_session_ids) && p.linked_session_ids.some((s: string) => sessionIds.includes(s)), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const prs = useCollectionRows<any>("pullRequests", { where, sig: prSig });
  return (
    <>
      {sessionIds.slice(0, 3).map((id) => <SessionPrsFeeder key={id} id={id} />)}
      {prs.length > 0 && (
        <>
          <dt>Change</dt>
          <dd className="flex-col !items-start gap-1">
            {prs.slice(0, 3).map((p) => (
              <span key={p._id} className="inline-flex items-center gap-1.5 min-w-0">
                <EntityIdPill type="pr" id={`${p.repository}#${p.number}`} compact />
                <span className="text-[11px]" style={{ color: p.state === "merged" ? "var(--sol-violet)" : p.state === "closed" ? "var(--sol-text-dim)" : "var(--sol-text-muted)" }}>{p.state}</span>
                {p.checks_state && p.state === "open" && (
                  <span className="ops-pill" style={{ color: CHECKS_INK[p.checks_state] ?? "var(--sol-text-muted)", background: `color-mix(in srgb, ${CHECKS_INK[p.checks_state] ?? "var(--sol-text-muted)"} 12%, transparent)` }}>
                    checks {p.checks_state}
                  </span>
                )}
              </span>
            ))}
          </dd>
        </>
      )}
    </>
  );
}

/** The first deploy of the group's source after `at`: where a fix most likely went out. */
function deployAfter(group: Pick<OpsGroup, "source_id">, events: OpsEvent[] | undefined, at: number | null): OpsEvent | null {
  if (at === null || !events) return null;
  let hit: OpsEvent | null = null;
  for (const e of events) if (e.kind === "deploy" && e.source_id === group.source_id && e.created_at >= at && (!hit || e.created_at < hit.created_at)) hit = e;
  return hit;
}

/** How a fix closed, in a few words with its proof: the commit, or that no change is on record. */
function CloseLine({ close, now, provider }: { close: FixClose; now: number; provider?: string }) {
  const resolver = useResolverWords(close.how === "resolved" ? { via: close.via ?? null, by: close.by } : { via: null }, provider);
  const ago = close.at !== null ? `${relTimeShort(close.at, now)} ago` : "";
  if (close.how === "landed") {
    return (
      <span className="inline-flex items-baseline gap-1.5">
        {close.url ? <a href={close.url} target="_blank" rel="noopener noreferrer" className="ops-mono hover:underline">{close.sha.slice(0, 9)}</a> : <span className="ops-mono">{close.sha.slice(0, 9)}</span>}
        <span className="ops-quiet">landed {ago}</span>
      </span>
    );
  }
  if (close.how === "done") return <span><span className="ops-quiet">closed {ago}</span> <span className="iss-noproof">no change landed</span></span>;
  if (close.how === "resolved") return <span className="ops-quiet">{resolver} after the fix session, {ago}{close.release ? <> in <span className="ops-mono">{close.release}</span></> : null}</span>;
  if (close.how === "dissolved") return <span><span className="ops-quiet">dissolved {ago}</span> <span className="iss-noproof">no change</span></span>;
  return <span className="ops-quiet">dropped {ago}</span>;
}

/**
 * The verdict on a closed fix, read against the occurrences since it went
 * out (the deploy after it when one is known, else the close): it held, or
 * it did not and by how much.
 */
function Verdict({ group, close, deployAt, stage, now }: { group: OpsGroup; close: FixClose; deployAt: number | null; stage: FixStage; now: number }) {
  if (close.at === null) return null;
  const since = deployAt ?? close.at;
  const ref = close.how === "landed" ? `${close.sha.slice(0, 7)} ${deployAt ? "deployed" : "landed"}` : deployAt ? "the deploy" : close.how === "resolved" ? "the resolve" : "the close";
  const state = group.kind === "check" || group.kind === "metric";
  if (stage === "recurring") {
    const back = state ? regressedAt(group) ?? group.last_seen : null;
    const n = occurrencesSince(group, since, now);
    return (
      <div className="iss-verdict" data-held="false">
        <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
        <span>
          <b>Did not hold</b>{" "}
          {state
            ? <>failing again {back ? `since ${relTimeShort(back, now)} ago` : ""}</>
            : <><span className="ops-num">{n.n === null ? "events" : `${n.n.toLocaleString()}${n.exact ? "" : "+"} ${n.n === 1 ? "event" : "events"}`}</span> since {ref}, last {relTimeShort(group.last_seen, now)} ago</>}
        </span>
      </div>
    );
  }
  return (
    <div className="iss-verdict" data-held="true">
      <Check className="w-3.5 h-3.5 shrink-0" />
      <span><b>Held</b> <span className="ops-num">0 events</span> in {relTimeShort(since, now)} since {ref}</span>
    </div>
  );
}

/**
 * Where the fix stands, read against what the issue did since: the problem
 * task by title and id (flagged when it was filed for something else, and
 * re-pointed or unlinked in one step), the sessions on it with the awake
 * ones marked, the pull request and its checks, how the task closed (the
 * landed commit, or that no change is on record), the deploy that carried
 * it, and the verdict: held, or did not hold and by how much. The press it
 * leads with follows: open the running fix, refile a dropped problem, start
 * one, resolve an issue whose fix held, or start a follow-up on one that did
 * not. A second agent is only ever "Start another".
 */
export function FixCard({ group, stage, task, sessions, plan, now, onStart, events, lead }: {
  group: OpsGroup;
  stage: FixStage;
  task: TaskRow | null;
  sessions: FixSessionFact[];
  plan: FixPlan;
  now: number;
  onStart: () => void;
  events?: OpsEvent[];
  /** A metric alert's biggest contributor: the fix goes to the error behind the number before the number itself. */
  lead?: {
    title: string;
    /** Its issue's ref, when an issue names it. */ ref: string | null;
    href: string;
    share: number;
    onStart: () => void;
    /** Known noise (noiseOf): its cure is leaving it out of the metric, a fix is the second press. */
    noise?: string | null;
    leaveOut?: () => void;
  } | null;
}) {
  const [editing, setEditing] = useState(false);
  const dropped = task?.status === "dropped" || stage === "dropped";
  const reopenTask = () => task?.short_id && setTaskStatusUndoable({ short_id: task.short_id, status: task.status }, "open");
  // The close is read through the same rule as the stage: a task filed for another title closes nothing here.
  const close = fixClose(group, creditedTask(group, task));
  const closed = close && fixClosed(stage) ? close : null;
  const deploy = closed ? deployAfter(group, events, closed.at) : null;
  const mismatch = !!task?.title && !taskMatchesIssue(task.title, group.title);
  // Every fix press names what it works on: the task when there is one.
  const startLabel = fixActionLabel("start", task?.short_id, mismatch)!;
  const taskClosed = task?.status === "done" || task?.status === "dropped" || !!task?.cause?.dissolved;
  // The session that wrote the landed commit, so its pill says it shipped.
  const landedSha = !mismatch ? task?.landed?.sha ?? null : null;
  const shippedBy: string | null = useShaCommit(landedSha)?.conversation_id ?? null;
  // The contributor leads only where the card would lead with starting a fix at all.
  const leading = !!lead && (plan.primary === "start" || plan.primary === "refile" || plan.primary === "followup");
  return (
    <div className="ops-card iss-fixcard" id="iss-fix" data-stage={stage}>
      <div className="ops-card-head"><span>Fix</span><FixStageGlyph stage={stage} word /></div>
      <div className="ops-card-body flex flex-col gap-3">
        <dl className="iss-chain ops-ref-fit">
          <dt>Problem</dt>
          <dd className="iss-task" data-mismatch={mismatch ? "true" : undefined}>
            {group.signal_task_id ? (
              <>
                <Link href={`/tasks/${task?.short_id ?? group.signal_task_id}`} className="iss-task-title" title={task?.title}>
                  {task?.title ?? <EntityIdPill type="task" id={group.signal_task_id} compact />}
                </Link>
                <span className="iss-task-meta">
                  {task?.short_id && <span className="ops-mono ops-dim">{task.short_id}</span>}
                  {task?.status && <span data-task-status={task.cause?.dissolved ? "dropped" : task.status} className="iss-task-status">{taskStateWord(task)}</span>}
                  {dropped && (task?.cause?.dissolved?.at ?? task?.closed_at) ? <span className="ops-dim">{relTimeShort((task!.cause?.dissolved?.at ?? task!.closed_at)!, now)} ago</span> : null}
                  <button type="button" className="iss-task-act" title="Point at another task" aria-label="Point at another task" onClick={() => setEditing((v) => !v)}><Pencil className="w-3 h-3" /></button>
                  <button type="button" className="iss-task-act" title="Unlink this task" aria-label="Unlink this task" onClick={() => useInboxStore.getState().setOpsGroupTask(group._id, null)}><Link2Off className="w-3 h-3" /></button>
                </span>
                {mismatch && (
                  <span className="iss-mismatch">
                    <TriangleAlert className="w-3 h-3 shrink-0" /> other issue's task
                    <button type="button" className="iss-task-act" onClick={() => useInboxStore.getState().setOpsGroupTask(group._id, null)}>Unlink</button>
                  </span>
                )}
                {dropped && task?.cause?.dissolved?.note && <DropNote note={task.cause.dissolved.note} />}
              </>
            ) : (
              <span className="inline-flex items-center gap-2">
                <span className="ops-dim">not filed</span>
                <button type="button" className="iss-task-act" onClick={() => setEditing((v) => !v)}>Link a task</button>
              </span>
            )}
            {editing && <TaskLinkForm groupId={group._id} onDone={() => setEditing(false)} />}
          </dd>
          <dt>Session</dt>
          <dd>
            {sessions.length ? <FixSessionList sessions={sessions} shipped={shippedBy} now={now} /> : <span className="ops-dim">none</span>}
          </dd>
          <FixPullRequests sessionIds={sessions.map((s) => s.id)} />
          {closed ? (
            <>
              <dt>Closed</dt>
              <dd><CloseLine close={closed} now={now} provider={group.external?.provider} /></dd>
              {deploy && (
                <>
                  <dt>Deployed</dt>
                  <dd className="ops-quiet">
                    <span className="ops-mono text-sol-text">{deploy.data?.release ?? "deploy"}</span> {relTimeShort(deploy.created_at, now)} ago
                  </dd>
                </>
              )}
            </>
          ) : task?.landed ? (
            <>
              <dt>{mismatch ? "Its commit" : "Landed"}</dt>
              <dd>
                <a href={task.landed.url} target="_blank" rel="noopener noreferrer" className="ops-mono hover:underline">{task.landed.sha.slice(0, 9)}</a>{" "}
                <span className="ops-quiet">{relTimeShort(task.landed.at, now)} ago</span>
                {mismatch ? <span className="iss-noproof">other title</span> : task.status !== "done" ? <span className="ops-dim">task not closed</span> : null}
              </dd>
            </>
          ) : null}
        </dl>
        {closed && <Verdict group={group} close={closed} deployAt={deploy?.created_at ?? null} stage={stage} now={now} />}
        {leading && lead && (
          <div className="iss-fix-lead">
            <span className="iss-fix-lead-k">Behind it</span>
            <Link href={lead.href} className="iss-fix-lead-title" title={lead.title}>{lead.title}</Link>
            <span className="ops-num iss-fix-lead-n">{lead.noise && <span className="iss-noise-tag">{lead.noise}</span>} <b>{Math.round(lead.share * 100)}%</b>{lead.ref && <> <span className="ops-mono ops-dim">{lead.ref}</span></>}</span>
          </div>
        )}
        {leading && lead?.noise ? (
          <div className="flex gap-2 flex-wrap">
            {lead.leaveOut && <button type="button" className="ops-btn" data-tone="primary" onClick={lead.leaveOut} title="Change the watch's query so it stops counting this; Undo puts it back"><EyeOff className="w-3.5 h-3.5" /> Leave it out</button>}
            {/* Noise is left out, not fixed: with Leave it out on offer, a fix on the cause is not a second choice beside it. */}
            {!lead.leaveOut && <button type="button" className="ops-btn" onClick={lead.onStart}><Wand2 className="w-3.5 h-3.5" /> {lead.ref ? `Start fix on ${lead.ref}` : "Start fix on the cause"}</button>}
            <button type="button" className="ops-btn" onClick={onStart}>{startLabel}</button>
          </div>
        ) : leading && lead ? (
          <div className="flex gap-2 flex-wrap">
            <button type="button" className="ops-btn" data-tone="primary" onClick={lead.onStart}><Wand2 className="w-3.5 h-3.5" /> {lead.ref ? `Start fix on ${lead.ref}` : "Start fix on the cause"} <KeyCap size="xs" tone="onAccent">f</KeyCap></button>
            <button type="button" className="ops-btn" onClick={onStart}>{startLabel}</button>
          </div>
        ) : (plan.primary === "open" || plan.primary === "continue") && plan.live ? (
          <div className="flex gap-2 flex-wrap">
            <Link className="ops-btn" data-tone="primary" href={`/conversation/${plan.live}`}>{fixActionLabel(plan.primary, null, false)} <KeyCap size="xs" tone="onAccent">f</KeyCap></Link>
            <button type="button" className="ops-btn" onClick={onStart}>Start another</button>
          </div>
        ) : plan.primary === "followup" ? (
          <div className="flex gap-2 flex-wrap">
            <button type="button" className="ops-btn" data-tone="primary" onClick={onStart}><Wand2 className="w-3.5 h-3.5" /> {fixActionLabel("followup", task?.short_id, mismatch)} <KeyCap size="xs" tone="onAccent">f</KeyCap></button>
            {task?.short_id && taskClosed && !mismatch && <button type="button" className="ops-btn" onClick={reopenTask}><RotateCcw className="w-3.5 h-3.5" /> Reopen {task.short_id}</button>}
          </div>
        ) : plan.primary === "resolve" ? (
          <div className="flex gap-2 flex-wrap">
            <button type="button" className="ops-btn" data-tone="primary" onClick={() => triage([group], "resolved")}><Check className="w-3.5 h-3.5" /> Resolve <KeyCap size="xs" tone="onAccent">e</KeyCap></button>
          </div>
        ) : plan.primary === "refile" && !mismatch ? (
          // One press does the whole job: the fix review reopens the dropped task and starts its session. Reopening alone starts nothing.
          <div className="flex gap-2 flex-wrap">
            <button type="button" className="ops-btn" data-tone="primary" onClick={onStart}><Wand2 className="w-3.5 h-3.5" /> {fixActionLabel("refile", task?.short_id, mismatch)} <KeyCap size="xs" tone="onAccent">f</KeyCap></button>
            {task?.short_id && <button type="button" className="ops-btn" onClick={reopenTask} title={`Set ${task.short_id} back to open without starting a session; z undoes it`}><RotateCcw className="w-3.5 h-3.5" /> Reopen only</button>}
          </div>
        ) : plan.primary === "start" || plan.primary === "refile" ? (
          <button type="button" className="ops-btn self-start" data-tone="primary" onClick={onStart}><Wand2 className="w-3.5 h-3.5" /> {startLabel} <KeyCap size="xs" tone="onAccent">f</KeyCap></button>
        ) : plan.primary === null && !fixClosed(stage) ? (
          // A settled issue: the fix is there to take, never the lead.
          <button type="button" className="ops-btn self-start" onClick={onStart}><Wand2 className="w-3.5 h-3.5" /> {startLabel} <KeyCap size="xs">f</KeyCap></button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The fix's sessions as pills, each with its state (working now, shipped the
 * landed commit, or idle) and when it last moved: working and shipped first,
 * then newest, with older ones folded behind "+N earlier".
 */
export function FixSessionList({ sessions, shipped, now }: { sessions: FixSessionFact[]; shipped: string | null; now: number }) {
  const [all, setAll] = useState(false);
  const { ordered, lead } = orderFixSessions(sessions, shipped);
  const shown = all ? ordered : lead;
  const hidden = ordered.length - lead.length;
  return (
    <span className="iss-sessions">
      {shown.map((s) => <FixSessionItem key={s.id} s={s} shipped={shipped} now={now} />)}
      {hidden > 0 && <button type="button" className="iss-task-act" aria-expanded={all} onClick={() => setAll((v) => !v)}>{all ? "fewer" : `+${hidden} earlier`}</button>}
    </span>
  );
}

/**
 * One fix session: its state dot, pill and age. A session this device does
 * not hold is read from the server (the pill reads the same query, so it
 * costs nothing more): its title, whether it is working now and when it last
 * moved, as the conversation header shows them; a skeleton until it answers,
 * never a bare "Session".
 */
function FixSessionItem({ s, shipped, now }: { s: FixSessionFact; shipped: string | null; now: number }) {
  const { data, error } = useQueryNoThrow(api.conversations.webGet, s.known ? "skip" : entityQueryArgs("session", s.id));
  const remote = !s.known && data ? (data as { is_active?: boolean; updated_at?: number }) : null;
  const awake = s.awake || !!remote?.is_active;
  const at = s.at ?? remote?.updated_at;
  const state = awake ? "working" : s.id === shipped ? "shipped" : s.known || remote ? "idle" : "unknown";
  return (
    <span className="iss-session" data-state={state} title={state === "working" ? "working now" : state === "shipped" ? "wrote the landed commit" : state === "idle" ? `idle${at ? ` since ${new Date(at).toLocaleString()}` : ""}` : "not readable from here"}>
      <i className="iss-session-dot" />
      {!s.known && data === undefined && !error ? <span className="iss-skel" style={{ width: 96 }} aria-busy="true" /> : <EntityIdPill type="session" id={s.id} compact />}
      {at ? <span className="ops-dim ops-num text-[11px]">{relTimeShort(at, now)}</span> : null}
    </span>
  );
}

/** Why a problem was dropped, one press away: the note is prose, so the card shows that there is one, not the half of it a line holds. */
function DropNote({ note }: { note: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="iss-task-drop">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? "Hide note" : "Why dropped"}</button>
      {open && <span className="iss-task-notefull">{note}</span>}
    </span>
  );
}

/** Point the group at a task by its short id; only a task this device holds, so the link paints at once and reconciles by value. */
function TaskLinkForm({ groupId, onDone }: { groupId: string; onDone: () => void }) {
  const [value, setValue] = useState("");
  const [missing, setMissing] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const ref = value.trim().toLowerCase();
    if (!ref) return;
    const tasks = useInboxStore.getState().tasks as Record<string, TaskRow>;
    const hit = taskByRef(tasks, ref);
    if (!hit) return setMissing(true);
    useInboxStore.getState().setOpsGroupTask(groupId, hit._id);
    onDone();
  };
  return (
    <form className="iss-task-form" onSubmit={submit}>
      <input
        autoFocus
        value={value}
        placeholder="ct-123"
        aria-label="Task id"
        aria-invalid={missing}
        data-missing={missing ? "true" : undefined}
        onChange={(e) => { setValue(e.target.value); setMissing(false); }}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onDone(); } }}
      />
      <button type="submit" className="ops-btn" style={{ height: 24 }}>Link</button>
    </form>
  );
}

// ── The check or metric that leads a non-error issue ──

const HEALTH_INK: Record<HealthState, string> = { failing: "var(--sol-red)", passing: "var(--sol-green)", none: "transparent" };

const HEALTH_RANGES = [
  { key: "24h", hours: 24 },
  { key: "7d", hours: 24 * 7 },
  { key: "30d", hours: 24 * 30 },
  { key: "90d", hours: 24 * 90 },
] as const;

/**
 * A check or metric over time as failing and passing spans, the way a
 * monitor's state timeline reads: one strip, the share of the window spent
 * failing, and how often it flipped.
 */
export function HealthChart({ group, events, now }: { group: OpsGroup; events: OpsEvent[]; now: number }) {
  const [range, setRange] = useState<(typeof HEALTH_RANGES)[number]["key"]>("7d");
  const hours = HEALTH_RANGES.find((r) => r.key === range)!.hours;
  const strip = useMemo(() => healthStrip(group, events, now, hours), [group, events, now, hours]);
  const span = strip.end - strip.start;
  const fmt = (at: number) => (hours <= 24 ? new Date(at).toLocaleTimeString(undefined, { hour: "numeric" }) : new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  const ticks = [...stripTicks(strip.start, strip.end, hours), { x: 1, at: strip.end, day: false }];
  return (
    <div className="ops-card iss-chart">
      <div className="iss-chart-head">
        <span className="font-semibold">State</span>
        <span className="ops-dim ops-num">
          {Math.round(strip.failingShare * 100)}% failing · {strip.failures} {strip.failures === 1 ? "red span" : "red spans"}
        </span>
        <div className="ops-seg" role="group" aria-label="State window">
          {HEALTH_RANGES.map((r) => (
            <button key={r.key} type="button" data-on={range === r.key ? "true" : undefined} aria-pressed={range === r.key} onClick={() => setRange(r.key)}>{r.key}</button>
          ))}
        </div>
      </div>
      <div className="iss-health" role="img" aria-label={`${group.short_id}: ${Math.round(strip.failingShare * 100)}% of the last ${range} failing`}>
        {strip.spans.map((s) => (
          <span
            key={s.from}
            className="iss-health-span"
            data-state={s.state}
            style={{ left: `${((s.from - strip.start) / span) * 100}%`, width: `${((s.to - s.from) / span) * 100}%`, background: HEALTH_INK[s.state] }}
            title={`${s.state === "none" ? "not watched yet" : s.state} · ${new Date(s.from).toLocaleString()} to ${new Date(s.to).toLocaleString()}`}
          />
        ))}
      </div>
      <div className="iss-chart-x" style={{ marginLeft: 0 }}>
        {/* A tick close to the right edge gives way to "now" where the strip is narrow. */}
        {/* Every other date gives way on a phone, where a day's label is wider than a day. */}
        {ticks.map((t, i) => <span key={t.at} data-alt={t.x < 1 && i % 2 === 1 ? "true" : undefined} data-edge={t.x < 1 && t.x > 0.86 ? "true" : undefined} style={{ left: `${t.x * 100}%`, transform: t.x < 0.03 ? "none" : t.x === 1 ? "translateX(-100%)" : undefined }}>{t.x === 1 ? "now" : fmt(t.at)}</span>)}
      </div>
    </div>
  );
}

/**
 * The top card of a check or a job: is it failing, since when, when it was
 * last green (the last passing reading, with its commit for a CI run), its
 * runs on the branch by commit, and the commit that broke it: the first red
 * run after the last green, with the session that wrote it. When that run was
 * not kept the card says so rather than offering an older sample.
 */
export function CheckCard({ group, events, now, runUrl, samples = [], env = null, envPending = false }: { group: OpsGroup; events: OpsEvent[]; now: number; runUrl?: string | null; samples?: OpsSample[]; /** The failing run blames its machine (ciRunModel envFailure): the suspect is the runner, not a commit. */ env?: { step: string | null; image: string | null } | null; /** The failing run is still being read, so whether its machine is to blame is not known yet. */ envPending?: boolean }) {
  const strip = useMemo(() => healthStrip(group, events, now, 24 * 90), [group, events, now]);
  const runs = useMemo(() => ciRuns(samples), [samples]);
  const lastOk = group.meta?.last_ok_at !== undefined ? { at: group.meta.last_ok_at, sha: group.meta.last_ok_sha ?? null, branch: group.meta.last_ok_branch ?? null } : null;
  const brk = useMemo(() => ciBreak(runs, { failingSince: strip.failingSince, lastOk }), [runs, strip.failingSince, lastOk?.at, lastOk?.sha]); // eslint-disable-line react-hooks/exhaustive-deps
  const branchRuns = useMemo(() => {
    const own = brk ? runs.filter((r) => (r.branch ?? null) === brk.branch) : runs;
    // The last green leads the strip even though passing runs are not kept as samples.
    // Without a recorded pass, the flip to red the timeline holds still marks where green ended.
    const green = brk?.lastPass ?? (strip.lastGreen !== null && strip.lastGreen < now ? { at: strip.lastGreen, sha: group.meta?.last_ok_sha ?? null, url: undefined } : null);
    return green && !own.some((r) => r.ok && r.at === green.at) ? [...own, { at: green.at, sha: green.sha, ok: true, conclusion: "success", url: green.url }].sort((a, b) => b.at - a.at) : own;
  }, [runs, brk, strip.lastGreen, now, group.meta?.last_ok_sha]);
  const repository = useMemo(() => {
    for (const s of samples) {
      const r = parseTags(s.context_json)?.repository;
      if (typeof r === "string") return r;
    }
    return null;
  }, [samples]);
  const compare = brk?.lastPass?.sha && brk.firstFail?.sha && repository ? `https://github.com/${repository}/compare/${brk.lastPass.sha}...${brk.firstFail.sha}` : null;
  // A settled issue is not failing whatever its last reading said: a person resolved it, or it recovered.
  // A job reports only its failures: it is failing while they keep coming, and quiet once none has come for well past its usual gap.
  const quiet = group.status === "open" && jobQuiet(group, now);
  const failing = group.status === "open" && !quiet && (group.kind === "job" || strip.failingSince !== null || group.meta?.ok === false);
  const url = runUrl ?? group.external?.url ?? null;
  const green = failing ? (strip.lastGreen !== null && strip.lastGreen < now ? strip.lastGreen : null) : strip.lastPass;
  const lastFailed = group.failed_at?.length ? Math.max(...group.failed_at) : null;
  const settledAt = group.status !== "open" ? group.resolved_at ?? null : null;
  const greenSha = brk?.lastPass?.sha ?? (failing ? group.meta?.last_ok_sha : undefined);
  return (
    <div className="ops-card iss-kindcard" data-failing={failing ? "true" : undefined}>
      <div className="ops-card-head">
        <span>{group.kind === "job" ? "Job" : "Check"}{brk?.branch ? <span className="ops-mono ops-dim font-normal text-[11px] ml-2">{brk.branch}</span> : null}</span>
        <span className="iss-kind-state" data-state={failing ? "failing" : quiet ? "quiet" : "passing"}>{failing ? "failing" : quiet ? "quiet" : group.status === "open" ? "passing" : group.status}</span>
      </div>
      <div className="iss-figures">
        {quiet ? (
          <>
            <Figure label="quiet for" value={formatRelative(group.last_seen, now).replace(/ ago$/, "")} title={`no failure since ${new Date(group.last_seen).toLocaleString()}`} />
            <Figure label="last failure" value={new Date(group.last_seen).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} title={new Date(group.last_seen).toLocaleString()} />
            <Figure label="first failure" value={formatRelative(group.first_seen, now)} title={new Date(group.first_seen).toLocaleString()} />
          </>
        ) : failing && group.kind === "job" ? (
          // A job's source lists only its failed runs: with no total there is no failure share to claim, and no last success to name.
          <>
            <Figure label={countWords("job", group.count).long} value={group.count.toLocaleString()} title={`first failure ${new Date(group.first_seen).toLocaleString()}`} tone="var(--sol-red)" />
            <Figure label="first failure" value={formatRelative(group.first_seen, now)} title={new Date(group.first_seen).toLocaleString()} />
            <Figure label="passing runs" value="not reported" title="This source lists failed runs only, so the runs that passed, the share that failed and the last success are unknown" />
          </>
        ) : failing || !settledAt || strip.lastPass ? (
          <Figure label={failing ? "failing since" : "passing since"} value={failing ? (strip.failingSince ? formatRelative(strip.failingSince, now) : "unknown") : strip.lastPass ? formatRelative(strip.lastPass, now) : "unknown"} title={failing && strip.failingSince ? new Date(strip.failingSince).toLocaleString() : undefined} />
        ) : (
          <Figure label={group.status === "resolved" ? "resolved" : group.status} value={formatRelative(settledAt, now)} title={new Date(settledAt).toLocaleString()} />
        )}
        {!failing && lastFailed !== null && <Figure label="last failure" value={formatRelative(lastFailed, now)} title={new Date(lastFailed).toLocaleString()} />}
        {failing && group.kind !== "job" && (
          <Figure
            label={greenSha ? `last green · ${greenSha.slice(0, 7)}` : "last green"}
            value={green ? formatRelative(green, now) : "not recorded"}
            title={green ? new Date(green).toLocaleString() : undefined}
          />
        )}
        {!(failing && group.kind === "job") && <Figure label={countWords(group.kind, group.count).long} value={group.count.toLocaleString()} title={`first failure ${new Date(group.first_seen).toLocaleString()}`} />}
        {!quiet && <Figure label={group.kind === "job" ? "last failure" : "last run"} value={formatRelative(group.last_seen, now)} title={new Date(group.last_seen).toLocaleString()} />}
      </div>
      {branchRuns.length > 1 && (
        <div className="ops-card-body pt-0">
          <CiRunStrip runs={branchRuns} breakAt={brk?.firstFail?.at ?? null} now={now} />
        </div>
      )}
      {brk && runs.length > 0 && (
        <div className="ops-card-body pt-0">
          {env && failing ? (
            <div className="iss-suspect" data-known="true">
              <div className="iss-suspect-head">
                <span className="iss-suspect-k">Suspect</span>
                <span className="text-sol-text">runner environment{env.image ? ` (${env.image})` : ""}</span>
                {env.step && <span className="ops-dim truncate" title={env.step}>failed at {env.step}</span>}
                {brk.firstFail?.sha && <span className="ops-dim ops-mono">first red {brk.firstFail.sha.slice(0, 7)}</span>}
              </div>
            </div>
          ) : envPending && failing ? (
            <div className="iss-suspect" aria-busy="true">
              <div className="iss-suspect-head"><span className="iss-suspect-k">Suspect</span><span className="iss-skel" style={{ width: 160 }} /></div>
            </div>
          ) : brk.firstFail?.sha ? (
            <SuspectCommit sha={brk.firstFail.sha} why={brk.lastPass?.sha ? `first red after ${brk.lastPass.sha.slice(0, 7)} passed` : "first red run of this streak"} now={now} compare={compare} />
          ) : (
            <div className="iss-suspect" data-known="false">
              <div className="iss-suspect-head">
                <span className="iss-suspect-k">Suspect</span>
                <span className="text-sol-text">unknown</span>
                <span className="ops-dim">{brk.lastPass ? "first red run not kept" : "last pass not recorded"}</span>
              </div>
            </div>
          )}
        </div>
      )}
      {(group.culprit || url) && (
        <div className="ops-card-body flex items-center gap-3 flex-wrap text-[12px] pt-0">
          {group.culprit && <span className="ops-mono ops-quiet truncate max-w-full" title={group.culprit}>{group.culprit}</span>}
          {url && <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sol-blue hover:underline">{group.kind === "job" ? "Last failed run" : "Run on GitHub"} <ExternalLink className="w-3 h-3" aria-hidden /></a>}
        </div>
      )}
    </div>
  );
}

/** The top card of a metric issue: the watch it came from, its line, and where the value sits against it. */
export function MetricCard({ group, watch, now }: { group: OpsGroup; watch?: OpsWatch | null; now: number }) {
  const value = watch?.last_value ?? group.meta?.value;
  const threshold = watch?.threshold ?? group.meta?.threshold;
  const direction = watch?.direction ?? group.meta?.direction;
  const unit = watch?.unit ? ` ${watch.unit}` : "";
  const over = value !== undefined && value !== null && threshold !== undefined ? (direction === "below" ? value < threshold : value > threshold) : null;
  const fmt = (n: number) => (Math.abs(n) >= 100 ? Math.round(n).toLocaleString() : Number(n.toPrecision(3)).toLocaleString());
  const episodes = useIssueEpisodes(group, watch, now);
  return (
    <div className="ops-card iss-kindcard" data-failing={over ? "true" : undefined}>
      <div className="ops-card-head">
        <span className="inline-flex items-center gap-2 min-w-0">
          Metric
          {watch && <Link href={opsHref.metric(watch.short_id)} className="font-normal text-sol-text truncate hover:underline">{watch.name}</Link>}
          {watch && <span className="ops-mono ops-dim font-normal text-[11px]">{watch.short_id}</span>}
        </span>
        {over !== null && <span className="iss-kind-state" data-state={over ? "failing" : "passing"}>{over ? (direction === "below" ? "under the line" : "over the line") : "within the line"}</span>}
      </div>
      <div className="iss-figures">
        <Figure label="now" value={value !== undefined && value !== null ? `${fmt(value)}${unit}` : "no reading"} tone={over ? "var(--sol-red)" : undefined} />
        <Figure label="line" value={threshold !== undefined ? `${direction === "below" ? "below" : "above"} ${fmt(threshold)}${unit}` : "none"} />
        <Figure label="last read" value={watch?.last_at ? formatRelative(watch.last_at, now) : formatRelative(group.last_seen, now)} />
        <Figure label={episodes.count === 1 ? "episode" : "episodes"} value={episodes.count.toLocaleString()} title="Times the monitor announced it past the line" />
        {episodes.total > 0 && <Figure label="alerting" value={durationShort(episodes.total)} title="How long it stayed past the line, every episode together" />}
      </div>
      {watch?.query && <WatchQuery kind={watch.query_kind} query={watch.query} />}
    </div>
  );
}

/** What the watch reads, one press away: the query is data, not a label. */
function WatchQuery({ kind, query }: { kind: string; query: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ops-card-body pt-0 flex flex-col gap-1.5">
      <button type="button" className="iss-task-act self-start inline-flex items-center gap-1" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-ops-watch-query>
        <ChevronRight className="w-3 h-3 transition-transform" style={open ? { transform: "rotate(90deg)" } : undefined} aria-hidden />
        <span>Query</span>
        <span className="ops-mono ops-dim">{kind}</span>
      </button>
      {open && <pre className="ops-code iss-watch-query">{query}</pre>}
    </div>
  );
}

function Figure({ label, value, title, tone }: { label: string; value: string; title?: string; tone?: string }) {
  return (
    <div className="iss-figure" title={title}>
      <span className="iss-figure-v ops-num" style={tone ? { color: tone } : undefined}>{value}</span>
      <span className="iss-figure-k">{label}</span>
    </div>
  );
}

