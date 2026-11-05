// Pieces the issues list and the issue page share: a group's state pill
// (regressed is its own), where its fix stands as a glyph, and the review a
// fix session starts through.
import { useMemo, useState } from "react";
import { CircleCheck, CircleDashed, CircleDot, CircleSlash, Flame, GitPullRequest, PackageCheck, Unlink, Wrench } from "lucide-react";
import { toast } from "sonner";
import { relTimeShort } from "../../lib/utils";
import { useInboxStore } from "../../store/inboxStore";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { fixPrompt, type FixFacts } from "./opsModel";
import { issueFixLedger, folderName, seededWith } from "./issueFix";
import { FIX_STAGE_LABEL, FIX_STAGE_SHORT, FLAP_DAYS, FLAP_MIN, escalation, escalationFactor, escalationWords, issueState, rateUnit, rateWords, knownRelease, regressedAt, resolverOf, taskMatchesIssue, taskStateWord, type FixStage, type FixTask, type IssueLane, type IssueState } from "./issuesModel";
import { fixFolderChoices, startOpsFixSession } from "./startFix";
import type { OpsGroup, OpsSource } from "./opsTypes";

const STATE_LOOK: Record<IssueState, { ink: string; label: string }> = {
  regressed: { ink: "var(--sol-orange)", label: "regressed" },
  open: { ink: "var(--sol-red)", label: "open" },
  ok: { ink: "var(--sol-cyan)", label: "ok" },
  resolved: { ink: "var(--sol-green)", label: "resolved" },
  ignored: { ink: "var(--sol-text-muted)", label: "ignored" },
};

/**
 * A group's state. A regressed one names what it came back in: the release
 * when there is one, else how long ago (`now` given), so triage reads it
 * without a hover. A check or metric that keeps flipping (`flaps`, its
 * failures in FLAP_DAYS, given when it is past FLAP_MIN) reads as flapping
 * with the count, never as a fresh regression each time it fails.
 */
export function IssueStatePill({ group, release, now, flaps, row, stage, resolvedBy }: {
  group: OpsGroup;
  release?: string | null;
  now?: number;
  flaps?: number;
  /** In a list row: a regression reads its age (its release is on the row's meta line), and a settled issue says how and when it settled. */
  row?: boolean;
  /** The fix's stage, so a resolve a fix closed reads "fixed". */
  stage?: FixStage;
  /** Who resolved it, in words, for the hover. */
  resolvedBy?: string;
}) {
  const state = issueState(group);
  // A flapper failing now reads flapping; one resting resolved or passing between flips reads its own state, its flips a second mark, so a Resolved list says resolved.
  const flapper = !!flaps && flaps >= FLAP_MIN && state !== "ignored";
  if (flapper && (state === "open" || state === "regressed")) {
    const ink = "var(--sol-yellow)";
    return (
      <span className="ops-pill iss-state-pill" data-issue-state="flapping" data-rel="true" style={{ color: ink, background: `color-mix(in srgb, ${ink} 14%, transparent)` }} title={`failed ${flaps} times in ${FLAP_DAYS} days; failing now`}>
        <span className="iss-state-word">flapping </span><span className="ops-num iss-state-rel">{flaps}×</span>
      </span>
    );
  }
  const look = STATE_LOOK[state];
  const solid = state === "regressed";
  const back = state === "regressed" ? regressedAt(group) : null;
  const settled = row && state === "resolved" ? settledWord(group, stage) : null;
  const shownRelease = row ? null : release;
  const age = back ?? (settled ? group.resolved_at ?? null : null);
  const rel = shownRelease ? <span className="ops-mono iss-state-rel">{shownRelease}</span> : age && now ? <span className="ops-num iss-state-rel">{relTimeShort(age, now)}</span> : null;
  // A plain open row says nothing: the list is open issues, and regressed, flapping and settled rows stand out against the blank.
  if (row && state === "open" && !rel && !flapper) return null;
  const title = back
    ? `regressed ${new Date(back).toLocaleString()}${release ? ` in ${release}` : ""}`
    : settled && group.resolved_at
      ? `${settled === "fixed" ? "fixed and resolved" : resolvedBy ?? settled} ${new Date(group.resolved_at).toLocaleString()}${group.resolved_in ? ` in ${group.resolved_in}` : ""}`
      : undefined;
  return (
    <span
      className="ops-pill iss-state-pill"
      data-issue-state={state}
      data-rel={rel ? "true" : undefined}
      style={solid ? { color: "var(--sol-bg)", background: look.ink, fontWeight: 600 } : { color: look.ink, background: `color-mix(in srgb, ${look.ink} 12%, transparent)` }}
      title={title}
    >
      <span className="iss-state-word">{settled ?? look.label}</span>
      {rel}
      {flapper && <span className="ops-num iss-state-flaps" title={`flipped to failing ${flaps} times in ${FLAP_DAYS} days`}> · {flaps}×</span>}
    </span>
  );
}

/** How a resolved issue settled, in one word: a fix closed it, it recovered on its own, or it was resolved. */
function settledWord(group: OpsGroup, stage?: FixStage): string {
  if (stage === "shipped" || stage === "closed") return "fixed";
  return resolverOf(group).via === "recovered" ? "recovered" : "resolved";
}

/** A new or escalating open issue, marked beside its title; the other lanes need no mark. */
export function LaneTag({ lane, group, now }: { lane: IssueLane | null; group: OpsGroup; now: number }) {
  if (lane === "new") return <span className="iss-lane" data-lane="new" title={`first seen ${new Date(group.first_seen).toLocaleString()}`}>New</span>;
  if (lane !== "escalating") return null;
  const e = escalation(group, now);
  return (
    <span className="iss-lane" data-lane="escalating" title={escalationWords(e)}>
      <Flame className="w-3 h-3" />
      {/* The lane's word (the home's pill and tile say it too), then how far over its usual day. */}
      Escalating{escalationFactor(e) ? ` ${escalationFactor(e)}` : ""}
    </span>
  );
}

/**
 * A spike on an issue's page. Going on: the lane's flame and multiplier, the
 * day against the usual day and the rate now. Passed: when it peaked and that
 * the rate is back near the usual, so a spike a deploy calmed never reads as
 * getting worse.
 */
export function EscalationStrip({ group, now }: { group: OpsGroup; now: number }) {
  const e = escalation(group, now);
  if (!e.spiked) return null;
  if (e.settled) {
    // Passed only once the rate is back near its usual; under the spike line but still well over usual, it is still elevated.
    return (
      <span className="iss-escalation ops-num" data-settled={e.back ? "true" : undefined} title={`peaked at ${e.peak.toLocaleString()} in the hour from ${new Date(e.peakAt).toLocaleString()}`}>
        {e.back ? <span className="iss-lane" data-lane="settled">Spike passed</span> : <span className="iss-lane" data-lane="escalating"><Flame className="w-3 h-3" />Still elevated</span>}
        <span className="ops-dim">peak {e.peak.toLocaleString()}/h {relTimeShort(e.peakAt, now)} ago · now {rateWords(e.perHourNow * 24, rateUnit(e.perHourNow * 24, e.baseline))}, usually {rateWords(e.baseline, rateUnit(e.perHourNow * 24, e.baseline))}</span>
      </span>
    );
  }
  return (
    <span className="iss-escalation ops-num">
      <LaneTag lane="escalating" group={group} now={now} />
      <span className="ops-dim">{escalationWords(e)}</span>
    </span>
  );
}

const STAGE_LOOK: Record<FixStage, { icon: typeof Wrench; ink: string }> = {
  none: { icon: CircleDashed, ink: "var(--sol-text-dim)" },
  dropped: { icon: CircleSlash, ink: "var(--sol-orange)" },
  other: { icon: Unlink, ink: "var(--sol-yellow)" },
  filed: { icon: CircleDot, ink: "var(--sol-text-muted)" },
  fixing: { icon: Wrench, ink: "var(--sol-blue)" },
  review: { icon: GitPullRequest, ink: "var(--sol-violet)" },
  closed: { icon: CircleCheck, ink: "var(--sol-text-muted)" },
  shipped: { icon: PackageCheck, ink: "var(--sol-green)" },
  recurring: { icon: Flame, ink: "var(--sol-orange)" },
};

/**
 * Where a fix stands. In a list cell (`word`) it is a short word with its
 * glyph, the word dropping only where the column is too narrow; elsewhere
 * the glyph alone with its whole label on hover.
 */
export function FixStageGlyph({ stage, word }: { stage: FixStage; word?: boolean }) {
  const look = STAGE_LOOK[stage];
  const Icon = look.icon;
  if (word && stage === "none") return <span className="iss-fix" data-stage={stage} title={FIX_STAGE_LABEL[stage]}><span className="ops-dim">–</span></span>;
  return (
    <span className="iss-fix" data-stage={stage} data-word={word ? "true" : undefined} style={{ color: look.ink }} title={stage === "other" ? "Its task was filed for another issue" : FIX_STAGE_LABEL[stage]}>
      <Icon className="w-3.5 h-3.5 shrink-0" strokeWidth={1.75} role="img" aria-label={FIX_STAGE_LABEL[stage]} />
      {word && <span className="iss-fix-label" aria-hidden="true">{FIX_STAGE_SHORT[stage]}</span>}
    </span>
  );
}

const ref = (g: OpsGroup) => g.short_id || g._id;

/**
 * The consequential review before a fix session starts, for one issue or a
 * selection: the folder (picked among the source's project, where a new
 * session starts, and recent ones), the problem task it binds to, the seeded
 * prompt. A selection that shares one task binds to it; one whose tasks
 * differ lists them and binds to the one picked, so the fix shows on a task
 * and never starts unbound beside them. `facts` adds what the page knows
 * beyond the row (the top frame, the url).
 */
export function FixReview({ groups, source, facts: extra, onClose, onStarted }: { groups: OpsGroup[]; source?: OpsSource; facts?: Partial<FixFacts>; onClose: () => void; onStarted?: (stubId: string) => void }) {
  const [showPrompt, setShowPrompt] = useState(false);
  const first = groups[0];
  const facts: FixFacts = { groupRefs: groups.map(ref), title: first.title, culprit: first.culprit, release: knownRelease(first.last_release), ...extra };
  // Each issue's task as the store holds it: its id, state, and whether it was filed for this issue's title.
  const taskSig = useInboxStore((s) =>
    JSON.stringify(
      groups.map((g) => {
        const t = g.signal_task_id ? (s.tasks as Record<string, { short_id?: string; title?: string; status?: string; cause?: FixTask["cause"] }>)[g.signal_task_id] : undefined;
        // A closed task (done, dropped, dissolved) is reopened by the start, so the review names it.
        const closed = !!t && (t.status === "done" || t.status === "dropped" || !!t.cause?.dissolved);
        return g.signal_task_id ? [g.signal_task_id, t?.short_id ?? "a problem task", taskStateWord(t) ?? "", t?.title ? !taskMatchesIssue(t.title, g.title) : false, closed && t?.short_id ? t.short_id : null, t?.status ?? "open"] : null;
      }),
    ),
  );
  const perIssue = useMemo(
    () =>
      (JSON.parse(taskSig) as ([string, string, string, boolean, string | null, string] | null)[]).map((t, i) => ({
        ref: ref(groups[i]),
        id: t?.[0] ?? null,
        task: t?.[1] ?? null,
        state: t?.[2] || undefined,
        mismatch: t?.[3] ?? false,
        reopen: t?.[4] ? { short_id: t[4], status: t[5] } : null,
      })),
    [taskSig, groups],
  );
  // A task filed for another title is never bound by default: tasks about these issues come first, then
  // working unbound, then the mismatched ones, each one press away.
  const candidates = useMemo(() => {
    const good = [...new Set(perIssue.filter((i) => i.id && !i.mismatch).map((i) => i.id!))];
    const bad = [...new Set(perIssue.filter((i) => i.id && i.mismatch).map((i) => i.id!))].filter((id) => !good.includes(id));
    return bad.length ? [...good, null, ...bad] : good;
  }, [perIssue]);
  const [taskAt, setTaskAt] = useState(0);
  // Issues that share no one task are unrelated: each gets its own session on its own task, unless the person picks one for all.
  const related = groups.length < 2 || (perIssue.every((i) => i.id && !i.mismatch) && new Set(perIssue.map((i) => i.id)).size === 1);
  const [split, setSplit] = useState(!related);
  const each = split && groups.length > 1;
  const taskId = candidates.length ? candidates[taskAt % candidates.length] : null;
  const taskIds = candidates.filter((c): c is string => !!c);
  const refOf = (id: string | null) => (id ? perIssue.find((i) => i.id === id)?.task ?? "a problem task" : null);
  const refs = taskIds.map((id) => refOf(id)!);
  const taskMismatch = !!taskId && !perIssue.some((i) => i.id === taskId && !i.mismatch);
  const next = candidates.length > 1 ? candidates[(taskAt + 1) % candidates.length] : undefined;
  const choice = useInboxStore((s) => {
    const c = fixFolderChoices(s as any, first.source_id);
    const pid = source?.project_id;
    const title = pid ? (s.projects as Record<string, { title?: string }>)[pid]?.title : undefined;
    // The source's own folder reads by its project's title; the others by their last part.
    return JSON.stringify({ names: c.paths.map((p, i) => folderName(p, i === 0 && c.fromSource ? title : null) ?? p), paths: c.paths, fromSource: c.fromSource });
  });
  const folders = JSON.parse(choice) as { names: string[]; paths: string[]; fromSource: boolean };
  // Issues from different sources each start in their own source's folder: one per issue, named in the review.
  const ownSig = useInboxStore((s) =>
    JSON.stringify(
      groups.map((g) => {
        const c = fixFolderChoices(s as any, g.source_id);
        const pid = (s.opsSources as Record<string, { project_id?: string }>)[g.source_id]?.project_id;
        const title = pid ? (s.projects as Record<string, { title?: string }>)[pid]?.title : undefined;
        return [c.paths[0] ?? null, c.paths[0] ? folderName(c.paths[0], c.fromSource ? title : null) : null];
      }),
    ),
  );
  const ownFolder = JSON.parse(ownSig) as [string | null, string | null][];
  const [folder, setFolder] = useState<string | null>(null);
  const at = Math.max(0, folder ? folders.names.indexOf(folder) : 0);
  const perFolder = each && new Set(ownFolder.map((o) => o[0])).size > 1;
  // The closed tasks the start sets back to open: each issue's own when one per issue, else the one it binds to.
  const reopens = each
    ? perIssue.filter((i) => i.reopen && !i.mismatch).map((i) => i.reopen!)
    : (() => {
        const r = perIssue.find((i) => i.id === taskId && i.reopen)?.reopen;
        return r ? [r] : [];
      })();
  const ledger = issueFixLedger({
    refs: facts.groupRefs,
    title: first.title,
    project: folders.names[at] ?? null,
    folders: perFolder ? undefined : folders.names,
    perFolder: perFolder ? groups.map((g, i) => ({ ref: ref(g), folder: ownFolder[i][1] })) : undefined,
    reopens: reopens.map((r) => r.short_id),
    fromSource: folders.fromSource && at === 0,
    task: refOf(taskId),
    tasks: taskIds.length > 1 ? refs : undefined,
    issues: groups.length > 1 ? perIssue.map(({ ref: r, task, state, mismatch }) => ({ ref: r, task, state, mismatch })) : undefined,
    taskMismatch,
    sessions: each ? groups.length : 1,
    ...(groups.length > 1 ? { splitToggle: { label: each ? "One session for all" : "One per issue", press: () => setSplit((v) => !v) } } : {}),
    nextTask: next !== undefined ? { label: next ? `Use ${refOf(next)}` : "Work unbound", press: () => setTaskAt((i) => i + 1) } : undefined,
    unfiled: groups.filter((g) => !g.signal_task_id).length,
    running: groups.filter((g) => g.fix_conversation_id && g.status === "open").length,
    prompt: fixPrompt(facts),
    seeded: seededWith(facts, groups.every((g) => g.kind === first.kind) ? first.kind : undefined),
    showPrompt,
    togglePrompt: () => setShowPrompt((v) => !v),
  });
  return (
    <SwitchReview
      ledger={ledger}
      onClose={onClose}
      onPick={setFolder}
      onConfirm={() => {
        onClose();
        for (const r of reopens) void useInboxStore.getState().updateTask(r.short_id, { status: "open" });
        if (each) {
          // One session per issue, each seeded with its own issue and bound to its own task (one filed for another title stays unbound).
          const stubs = groups.map((g, i) => {
            const own = perIssue[i];
            return startOpsFixSession({ groupRefs: [ref(g)], title: g.title, culprit: g.culprit, release: knownRelease(g.last_release) }, g.source_id, { taskId: own.id && !own.mismatch ? own.id : null, groupIds: [g._id], projectPath: perFolder ? ownFolder[i][0] ?? undefined : folder !== null || g.source_id === first.source_id ? folders.paths[at] : undefined, quiet: true }).stubId;
          });
          toast.success(`${groups.length} fix sessions started`, { description: "They are in your inbox." });
          onStarted?.(stubs[0]);
          return;
        }
        const { stubId } = startOpsFixSession(facts, first.source_id, { taskId, groupIds: groups.map((g) => g._id), projectPath: folders.paths[at] });
        onStarted?.(stubId);
      }}
    />
  );
}

/** The triage toast's Undo, with its key. */
export function UndoLabel() {
  return <span className="inline-flex items-center gap-1.5">Undo <KeyCap size="xs">z</KeyCap></span>;
}
