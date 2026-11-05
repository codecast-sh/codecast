// The replay page's header and footer parts: Copy repro and Start fix, the
// linked issues with their fixes, and the person's other recordings.
import Link from "next/link";
import { useMemo, useState } from "react";
import type { ReplayEvent } from "@codecast/shared/contracts/replay";
import { Copy, ExternalLink, Play, RotateCcw, Wand2 } from "lucide-react";
import { REPLAY_ACTIVE_DEFAULT, formatReplayTime, isAnonymous, personKey, personLabel, primaryFailure, resolveReplayFilter, routeOf, toRepro } from "@codecast/shared/replay";
import { useOpsReplays, useOpsReplayTally, useOpsSources, useSyncOpsReplayBrowse } from "../../hooks/useSyncOps";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { copyText } from "../../lib/copyText";
import { relTimeShort } from "../../lib/utils";
import { useInboxStore } from "../../store/inboxStore";
import { EntityIdPill } from "../EntityIdPill";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { type FixFacts, fixPrompt, replayBaseUrl } from "./opsModel";
import { opsHref } from "./opsPaths";
import { fixFolderChoices, fixSessionPath, startOpsFixSession } from "./startFix";
import { folderName } from "./issueFix";
import { FIX_STAGE_LABEL, fixActionLabel, type FixStage, taskFixStage, taskMatchesIssue, taskStateWord } from "./issuesModel";
import { FixReview, FixStageGlyph } from "./issueParts";
import { useIssueFix, useProblemTask } from "./useIssueFix";
import { setTaskStatusUndoable } from "./issueUndo";
import type { OpsGroup, OpsReplay } from "./opsTypes";
import { PersonMark, ReplayFigures, ReplayStrip } from "./replayParts";
import { pathOf, replayFixLedger, replayLengthText, replayPagePath } from "./replayModel";
import { useLinkedIssues } from "./replayPageData";
import { personListHref } from "./replayPlayerModel";

/** Copy repro, and the fix: open the one running, or start one through the review. */
export function ReplayActions({ replay, events, issues, vendor }: { replay: OpsReplay; events: ReplayEvent[] | null; issues: ReturnType<typeof useLinkedIssues>; vendor: { href: string; name: string } | null }) {
  const [reviewing, setReviewing] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);
  const running = issues.map((i) => i.group?.fix_conversation_id).filter((x): x is string => !!x);
  const failure = events ? primaryFailure(events) : undefined;
  const failureText = failure ? (failure.type === "network" ? `${failure.method} ${failure.url} ${failure.status || "failed"}` : failure.message) : null;
  // The fix aims at the issue the header leads with; the recording's first failure only when no issue is linked.
  const headline = issues[0] ?? null;
  const aim = headline ? `${headline.short_id} ${headline.title}` : failureText;
  const facts: FixFacts = { replayRef: replay.short_id || replay._id, groupRefs: issues.map((g) => g.short_id), title: headline?.title ?? null, failure: failureText, url: replay.url };
  const task = issues.find((i) => i.group?.signal_task_id)?.group?.signal_task_id ?? null;
  // The press names what it works on, as each issue card's own press does ("Start fix on ct-N"), so the header and the card read as one action.
  const taskRow = useProblemTask(task ?? undefined);
  const startLabel = taskRow?.short_id ? `Start fix on ${taskRow.short_id}` : headline ? `Start fix · ${headline.short_id}` : "Start fix";
  // The page's main action matches the recording: a fix leads only when something failed or an issue is linked.
  const lead = !!failure || issues.length > 0;
  const folders = () => fixFolderChoices(useInboxStore.getState() as any, replay.source_id);
  const chosenPath = () => {
    const { paths } = folders();
    return paths.find((p) => folderName(p) === folder) ?? paths[0];
  };
  const ledger = () => {
    const st = useInboxStore.getState() as any;
    const choice = folders();
    const path = chosenPath() ?? fixSessionPath(st, replay.source_id);
    return replayFixLedger({
      replay: replay.short_id,
      path: pathOf(replay.url) ? routeOf(pathOf(replay.url)) : "",
      failure: aim,
      issues: issues.map((g) => g.short_id),
      project: folderName(path),
      folders: choice.paths.map((p) => folderName(p)!).filter(Boolean),
      fromSource: choice.fromSource && path === choice.paths[0],
      task: task ? (st.tasks?.[task]?.short_id ?? task) : null,
      running: running.length,
      prompt: fixPrompt(facts),
      showPrompt,
      togglePrompt: () => setShowPrompt((v) => !v),
    });
  };
  const start = () => {
    setReviewing(false);
    startOpsFixSession(facts, replay.source_id, { taskId: task, groupIds: issues.filter((i) => i.group).map((i) => i._id), projectPath: chosenPath() });
  };
  return (
    <div className="rp-actions">
      {vendor && (
        <a className="ops-btn rp-vendor" href={vendor.href} target="_blank" rel="noreferrer noopener" title={`Open in ${vendor.name}`} aria-label={`Open in ${vendor.name}`}>
          <ExternalLink className="w-3.5 h-3.5" aria-hidden /> <span className="rp-vendor-name">{vendor.name}</span>
        </a>
      )}
      {events && events.length > 0 && (
        <button type="button" className="ops-btn" onClick={() => void copyText(toRepro(events, { baseUrl: replayBaseUrl(replay.url) }), "Repro copied")} title="A Playwright test that replays the steps up to the failure, then asserts it does not happen">
          <Copy className="w-3.5 h-3.5" /> Copy repro
        </button>
      )}
      {running[0] ? (
        <Link className="ops-btn" data-tone={lead ? "primary" : undefined} href={`/conversation/${running[0]}`}>
          <Wand2 className="w-3.5 h-3.5" /> Open fix session
        </Link>
      ) : (
        <button type="button" className="ops-btn" data-tone={lead ? "primary" : undefined} aria-haspopup="dialog" onClick={() => setReviewing(true)}>
          <Wand2 className="w-3.5 h-3.5" /> {startLabel}
        </button>
      )}
      {reviewing && <SwitchReview ledger={ledger()} onClose={() => setReviewing(false)} onConfirm={start} onPick={setFolder} />}
    </div>
  );
}

/** The recording's first issue in the header: its id and status, and a press that plays from just before it happens. */
/** A path cut in the middle, never at its end: the last segment names the page. */
export function MiddlePath({ text }: { text: string }) {
  const cut = text.lastIndexOf("/", text.length - 2);
  const head = cut > 0 ? text.slice(0, cut) : "";
  const tail = cut > 0 ? text.slice(cut) : text;
  return (
    <span className="rp-h1-path" title={text}>
      {head && <span className="rp-h1-path-head">{head}</span>}
      <span className="rp-h1-path-tail">{tail}</span>
    </span>
  );
}

export function HeaderIssue({ issue, more, at, onSeek }: { issue: ReturnType<typeof useLinkedIssues>[number]; more: number; at: number | undefined; onSeek: (t: number) => void }) {
  return (
    <span className="rp-fact rp-head-issue" data-status={issue.status}>
      <Link href={opsHref.issue(issue.short_id)} className="ops-mono" title={issue.title}>{issue.short_id}</Link>
      <span className="rp-head-issue-title truncate" title={issue.title}>{issue.title}</span>
      {at !== undefined && (
        <button type="button" className="rp-issue-at ops-num" onClick={() => onSeek(at)} title={`Play from just before ${issue.short_id} happens`}>
          <Play className="w-3 h-3" aria-hidden /> {formatReplayTime(at).replace(/\.\d$/, "")}
        </button>
      )}
      {more > 0 && <span className="ops-dim ops-num">+{more}</span>}
    </span>
  );
}

/** The issues this recording caught, each with where its fix stands and the session and task behind it. */
export function IssuesAndFixes({ issues, moments, onSeek }: { issues: ReturnType<typeof useLinkedIssues>; moments: Map<string, number>; onSeek: ((t: number) => void) | null }) {
  if (!issues.length) return null;
  return (
    <section className="rp-card" aria-label="Issues and fixes">
      <div className="rp-card-head">Issues <span className="ops-dim ops-num">{issues.length}</span></div>
      <div className="rp-issues">
        {issues.map((i) => <IssueFixRow key={i._id} issue={i} at={moments.get(i._id)} onSeek={onSeek} />)}
      </div>
    </section>
  );
}

/**
 * One issue the recording caught, with its fix read the way the issue page's
 * Fix card reads it: the problem task as stored, credited only when it was
 * filed for this issue (taskFixStage), in the same glyph, colour and word.
 * The stage opens the issue's fix; a closed task offers its reopen here too.
 */
function IssueFixRow({ issue: i, at, onSeek }: { issue: ReturnType<typeof useLinkedIssues>[number]; at: number | undefined; onSeek: ((t: number) => void) | null }) {
  const task = useProblemTask(i.group?.signal_task_id);
  const stage = i.group ? taskFixStage(i.group, task ?? undefined) : "none";
  const word = taskStateWord(task);
  return (
    <div className="rp-issue-row">
      <Link href={opsHref.issue(i.short_id)} className="rp-issue-name" title={i.title}>
        <span className="ops-mono rp-sid" data-status={i.status}>{i.short_id}</span>
        <span className="rp-issue-title">{i.title}</span>
      </Link>
      <div className="rp-issue-meta">
        {at !== undefined && onSeek && (
          <button type="button" className="rp-issue-at ops-num" onClick={() => onSeek(at)} title={`Play from just before ${i.short_id} happens`}>
            <Play className="w-3 h-3" aria-hidden /> {formatReplayTime(at).replace(/\.\d$/, "")}
          </button>
        )}
        {/* Two states, each named for what it is: the issue's status, and where its fix stands. */}
        <span className="rp-issue-status" data-status={i.status}><span className="ops-dim">Issue</span> {i.status}</span>
        <Link href={opsHref.issue(i.short_id)} className="rp-fix-stage" data-stage={stage} title={`Fix: ${FIX_STAGE_LABEL[stage]}${task?.short_id ? ` · ${task.short_id}${word ? ` ${word}` : ""}` : ""}`}>
          <span className="ops-dim">Fix</span> <FixStageGlyph stage={stage} word />
        </Link>
        {i.group?.fix_conversation_id && <EntityIdPill type="session" id={i.group.fix_conversation_id} />}
        {i.group?.signal_task_id && <EntityIdPill type="task" id={i.group.signal_task_id} />}
        {i.group && <IssueFixActions group={i.group} stage={stage} />}
      </div>
    </div>
  );
}

/** The same person's other recordings, newest first, each one press away. */
export function PersonRecordings({ replay, personKey: who, now }: { replay: OpsReplay; personKey: string; now: number }) {
  // The person under the list's default active floor, with the short ones beside it: the same split People and their list print ("32 +9"), and "All" opens that list.
  const browse = useMemo(() => ({ source: null, match: resolveReplayFilter({ person: who }, 0), sort: "newest" as const, limit: 20 }), [who]);
  const { key } = useSyncOpsReplayBrowse(browse);
  const tally = useOpsReplayTally(key);
  const all = useOpsReplays();
  const theirs = useMemo(() => all.filter((r) => personKey(r.user) === who), [all, who]);
  const others = theirs.filter((r) => r._id !== replay._id).slice(0, 20);
  // One count for "this person's recordings": the workspace browse's, the same the list shows under their filter. Until it lands, the cached rows stand in, dimmed.
  // Said as the list says it under this person's filter (ReplaysTab floorOnly): a whole number, never "56+".
  const short = tally?.below_active ?? 0;
  // Before the count lands, the cached rows stand in as a floor, all of them under the total.
  const total = tally ? tally.total : Math.max(1, theirs.length);
  // "since" is the server's oldest match, the same set the count is of; the cached rows stand in until it answers.
  const first = tally?.oldest_at ?? theirs.reduce((m, r) => Math.min(m, r.started_at), replay.started_at);
  return (
    <section className="rp-card" aria-label="This person's recordings">
      <div className="rp-card-head">
        <span className="inline-flex items-center gap-2 min-w-0">
          <PersonMark label={personLabel(replay.user)} personKey={who} anonymous={isAnonymous(replay.user)} size={18} />
          <span className="truncate">{personLabel(replay.user)}</span>
        </span>
        <span className="rp-person-figs ops-num">
          <span data-provisional={tally ? undefined : "true"}>
            <b>{total.toLocaleString()}</b> recording{total === 1 ? "" : "s"}
            {short > 0 && <span className="ops-dim" title={`${short.toLocaleString()} more under ${REPLAY_ACTIVE_DEFAULT} active, on their list`}> +{short.toLocaleString()}</span>}
          </span>
          <span className="ops-dim" title={new Date(first).toLocaleString()}>since {relTimeShort(first, now)}</span>
          <Link className="rp-more-link" href={personListHref(who)}>All</Link>
        </span>
      </div>
      {others.length === 0 ? (
        <div className="rp-card-empty ops-dim">{tally ? "Only this recording" : "Reading…"}</div>
      ) : (
        <div className="rp-person-list">
          {others.map((r) => {
            const len = replayLengthText(r);
            return (
              <Link key={r._id} href={opsHref.replay(r.short_id || r._id)} className="rp-person-row">
                <span className="ops-mono ops-dim">{r.short_id}</span>
                {replayPagePath(r) ? <span className="truncate" title={r.url ?? undefined}>{routeOf(replayPagePath(r))}</span> : <span className="ops-dim">no page recorded</span>}
                <ReplayStrip shape={r.shape} width={88} height={14} />
                <span className="ops-num ops-quiet rp-person-len">{len.known ? len.text.replace(/\.\d$/, "") : <span className="ops-dim">{len.text}</span>}</span>
                <ReplayFigures replay={r} />
                <span className="ops-num ops-dim rp-person-age">{relTimeShort(r.started_at, now)}</span>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * The fix press the issue page's Fix card leads with, read from the same plan
 * (useIssueFix, fixActionLabel): one primary, the same words, and for a
 * dropped task the same "Reopen only" beside it. A start goes through the
 * same fix review, which shows what starts before anything does.
 */
function IssueFixActions({ group, stage }: { group: OpsGroup; stage: FixStage }) {
  const now = useCoarseNow(60_000);
  const { task, plan } = useIssueFix(group, stage, now);
  const source = useOpsSources().find((s) => s._id === group.source_id);
  const [fixing, setFixing] = useState(false);
  const mismatch = !!task?.title && !taskMatchesIssue(task.title, group.title);
  const reopen = () => task?.short_id && setTaskStatusUndoable({ short_id: task.short_id, status: task.status }, "open");
  const review = fixing ? <FixReview groups={[group]} source={source} onClose={() => setFixing(false)} /> : null;
  if ((plan.primary === "open" || plan.primary === "continue") && plan.live) {
    return <Link className="ops-btn rp-issue-fix" data-tone="primary" href={`/conversation/${plan.live}`}>{fixActionLabel(plan.primary, null, false)}</Link>;
  }
  if (plan.primary !== "start" && plan.primary !== "refile" && plan.primary !== "followup") return null;
  const label = fixActionLabel(plan.primary, task?.short_id, mismatch);
  return (
    <>
      <button type="button" className="ops-btn rp-issue-fix" data-tone="primary" onClick={() => setFixing(true)}><Wand2 className="w-3 h-3" aria-hidden /> {label}</button>
      {plan.primary === "refile" && !mismatch && task?.short_id && (
        <button type="button" className="ops-btn rp-issue-reopen" onClick={reopen} title={`Set ${task.short_id} back to open without starting a session; z undoes it`}>
          <RotateCcw className="w-3 h-3" aria-hidden /> Reopen only
        </button>
      )}
      {review}
    </>
  );
}
