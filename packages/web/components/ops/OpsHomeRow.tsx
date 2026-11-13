// One row of the Ops home's list and the work on it. A row reads like an
// issue stream: the title and the facts that say how bad (the ones that
// matter never cut, the rest dropped whole as the row narrows), then Events,
// Users and Since in aligned columns, then its task, the one primary act and
// a menu. The action columns are sized by the widest row (a subgrid of the
// list), so no label is ever cut. The menu names every key the list answers
// (OpsHome's triage keys) beside the act it runs.
import { useMemo, useState, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { BellOff, BellRing, Check, ChevronDown, Clock, EyeOff, Film, ListX, MessageSquare, MoreHorizontal, Pause, Pencil, Plug, RotateCcw, Search, Settings2, Unlink, UserPlus, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { useInboxStore } from "../../store/inboxStore";
import { formatRelative, relTimeShort } from "../../lib/utils";
import { memberDisplayName, resolveAssigneeInfo } from "../../lib/liveEntities";
import { taskVisual } from "../TaskStatusBadge";
import { AssigneeFace } from "../identity/AssigneeFace";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { Spark, SparkLine } from "../Spark";
import { ConsequentialSwitch } from "../consequential/ConsequentialSwitch";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { opsHref } from "./opsPaths";
import { escalation, escalationFactor, fixActionLabel, knownRelease, taskFixStage, taskMatchesIssue, type FixPlan } from "./issuesModel";
import { useIssueFix, useProblemTask } from "./useIssueFix";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useOrgRoles } from "../../hooks/useOrgRoles";
import { attentionSeries, fixLedger, handled, replayName, type AttentionItem, type AttentionTask } from "./opsHomeModel";
import { KindGlyph, ProviderIcon, SETUP_HREF } from "./parts";
import { HealthFixButton } from "./SourceHealthParts";
import { SourceCheck } from "./SourceCheck";
import type { SourceHealth } from "./sourceHealth";
import { fixSessionPath, startOpsFixSession } from "./startFix";
import { snoozeChoices } from "./opsSnooze";
import { fixLabel, silentSourceFacts } from "./sourceViewModel";
import { setTaskStatusUndoable, triage } from "./issueUndo";
import { assignItems, compact, fmt, itemFacts, itemGroup, itemGroups, itemHref, itemRef, itemTitle, resolvableGroups, resolveItems, rowEvents, rowUsers, snoozeItems, type RowFact } from "./opsHomeItems";
import type { FixFacts } from "./opsModel";
import type { OpsGroup, OpsSource, OpsWatch } from "./opsTypes";
import { teamMembersOf } from "../../lib/activeTeam";

/** The pill each state wears: the same words as its tile (ATTENTION_FILTERS), singular and lower case. */
const STATE_WORD: Record<AttentionItem["state"], string> = { alerting: "alerting", check: "check failing", regressed: "regressed", escalating: "escalating", new: "new", firing: "firing", errors: "replay errors", reader: "reader failing", erroring: "watch error", source: "source down", degraded: "degraded" };

/** What the Started column's one time means for each state, in its tooltip: always when it went wrong, never its latest event. */
const STARTED_WORD: Record<AttentionItem["state"], string> = { alerting: "Alerting since", check: "Failing since", regressed: "Regressed", escalating: "Escalating since", new: "First seen", firing: "Firing since", errors: "First replay with errors", reader: "Failing since", erroring: "Blind since", source: "Down since", degraded: "Degraded since" };

/**
 * A row's one press in the same words for the same plan on every row: the task it works on is the chip beside it and the
 * confirm's own row, so the press never repeats the id (fixActionLabel's longer words are its tooltip).
 */
const ROW_FIX_WORD: Record<NonNullable<FixPlan["primary"]>, string> = { open: "Open session", continue: "Continue fix", start: "Start fix", refile: "Reopen and fix", followup: "Follow-up fix", resolve: "Resolve" };

/**
 * A source row's pill is its health's own label ("poll failing", "stopped"), the word its overview, the Sources table and
 * the palette use; the tile above names the group (Degraded, Source down). Several failing pieces are counted in the title.
 */
function stateWord(it: AttentionItem, now: number): string {
  if (it.kind === "source" && (it.health.problems?.length ?? 0) < 2) return it.health.label.toLowerCase();
  // An escalating issue says how far over its usual day it runs, as its page's lane tag does ("escalating 2.1×").
  const factor = it.kind === "issue" && it.state === "escalating" ? escalationFactor(escalation(it.group, now)) : "";
  return factor ? `${STATE_WORD[it.state]} ${factor}` : STATE_WORD[it.state];
}

/** A row's state pill; `copy` is the one inside line two that a phone shows in place of the state column. */
function StatePill({ item: it, now, copy }: { item: AttentionItem; now: number; copy?: boolean }) {
  const also = it.also?.length ? `also ${it.also.map((st) => STATE_WORD[st]).join(", ")}` : undefined;
  return <span className="ops-home-state" data-copy={copy ? "true" : undefined} data-state={it.state} data-reader={it.kind === "reader" ? "true" : undefined} title={also}>{stateWord(it, now)}</span>;
}

export type RowProps = {
  item: AttentionItem;
  source: OpsSource | undefined;
  groupById: ReadonlyMap<string, OpsGroup>;
  now: number;
  snoozedTill?: number | null;
  isNew: boolean;
  cursor: boolean;
  selected: boolean;
  onOpen: () => void;
  onSelect: (range: boolean) => void;
  onPoint: () => void;
};

export function AttentionRow({ item: it, source, groupById, now, snoozedTill, isNew, cursor, selected, onOpen, onSelect, onPoint }: RowProps) {
  const href = itemHref(it);
  const series = attentionSeries(it, now);
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  const snoozedView = snoozedTill !== undefined;
  const facts = itemFacts(it, now, groupById);
  const lead = facts.filter((f) => f.rank === 1);
  const rest = facts.filter((f) => f.rank !== 1);
  // The first fact is the reason (a watch's error, a reader's failure, a rate): it shrinks to fit rather than drop.
  const fact = (f: RowFact, i: number) => <span key={i} className="ops-home-fact" data-rank={f.rank} data-lead={i === 0 ? "true" : undefined} data-narrow={f.narrow ? "true" : undefined} data-mono={f.mono ? "true" : undefined} title={f.text}>{f.text}</span>;
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const pick = (e: MouseEvent) => {
    e.stopPropagation();
    onSelect(e.shiftKey);
  };
  return (
    <li
      className="ops-home-row"
      data-sev={snoozedView ? undefined : it.severity}
      data-state={it.state}
      data-ops-item={itemRef(it)}
      data-cursor={cursor ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      aria-selected={selected}
      tabIndex={-1}
      onMouseDown={onPoint}
      onClick={(e) => (e.shiftKey || e.metaKey ? pick(e) : onOpen())}
      aria-label={`${itemRef(it)} ${itemTitle(it)}`}
    >
      <span className="ops-home-glyph" onClick={pick} title="Select (x, shift for a range)">
        <input type="checkbox" className="ops-home-check" checked={selected} readOnly tabIndex={-1} aria-label={`Select ${itemRef(it)}`} />
        <span className="ops-home-glyph-ico">
          {it.kind === "issue" ? <KindGlyph kind={it.group.kind} /> : it.kind === "reader" ? <span className="ops-kind ops-home-ico" data-k="watch-error"><Plug className="w-3.5 h-3.5" /></span> : it.kind === "watch" ? <span className="ops-kind ops-home-ico" data-k={it.state === "erroring" ? "watch-error" : "watch"}><BellRing className="w-3.5 h-3.5" /></span> : it.kind === "replay" ? <span className="ops-kind ops-home-ico" data-k="replay"><Film className="w-3.5 h-3.5" /></span> : <span className="ops-kind ops-home-ico" data-k={it.state === "degraded" ? "source-degraded" : "source"}><Plug className="w-3.5 h-3.5" /></span>}
        </span>
      </span>
      {/* The state in a column of its own, as wide as the widest on the list, so every pill lines up down the rows. */}
      <span className="ops-home-statecol"><StatePill item={it} now={now} /></span>
      <span className="ops-home-main">
        <span className="ops-home-line1">
          {isNew && <i className="ops-home-newdot" title="New since your last visit" data-ops-new />}
          <span className="ops-mono ops-dim ops-home-ref">{itemRef(it)}</span>
          <a href={href} className="ops-home-title" onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) { e.stopPropagation(); return; } e.preventDefault(); }} title={itemTitle(it)}>{itemTitle(it)}</a>
        </span>
        <span className="ops-home-line2" data-ops-facts>
          {/* A phone has no state column: the pill leads line two there (opsHome.css). */}
          <StatePill item={it} now={now} copy />
          {lead.map(fact)}
          {it.kind === "reader" && it.watches.length > 0 && (
            // The watches behind the reader, blind ones first: the count is the one thing on the line that opens.
            <button type="button" className="ops-home-fact ops-home-blind" data-rank="1" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} onMouseDown={(e) => e.stopPropagation()} data-ops-blind={it.blind}>
              {it.blind ? `${it.blind.toLocaleString()} ${it.blind === 1 ? "watch" : "watches"} blind` : `feeds ${it.watches.length.toLocaleString()} ${it.watches.length === 1 ? "watch" : "watches"}`}<ChevronDown className="w-3 h-3" aria-hidden />
            </button>
          )}
          {it.kind === "issue" && it.variants && (
            // One root cause, several issues: the count opens them, each to its own page.
            <button type="button" className="ops-home-fact ops-home-blind" data-rank="1" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} onMouseDown={(e) => e.stopPropagation()} data-ops-variants={it.variants.length}>
              {it.variants.length} variants<ChevronDown className="w-3 h-3" aria-hidden />
            </button>
          )}
          {/* Where it came from rides right after the number that says how bad, so it is the last thing to drop. */}
          {source && it.kind !== "source" && it.kind !== "reader" && <span className="ops-home-fact ops-home-src" data-rank="1" data-ops-src={source.name}><ProviderIcon provider={source.provider} />{source.name}</span>}
          {snoozedView && <span className="ops-home-fact ops-home-snz" data-rank="1"><Clock className="w-3 h-3" />{snoozedTill ? `back in ${relTimeShort(now, snoozedTill)}` : "until it gets worse"}</span>}
          {rest.map((f, i) => fact(f, i + lead.length))}
          {/* A second state the row also holds (an alerting watch whose issue regressed) rides last, the first thing to drop; the pill's tooltip names it too. */}
          {it.also?.map((st) => <span key={st} className="ops-home-state ops-home-also" data-state={st} data-ops-also={st}>{STATE_WORD[st]}</span>)}
        </span>
      </span>
      <span className="ops-home-spark" aria-hidden={!series.length}>
        {(it.kind === "issue" || it.kind === "replay") && series.length ? <Spark values={series} bar={2} gap={1} height={18} tone="var(--sol-red)" label={`${itemRef(it)}, events per hour over the last day`} /> : null}
        {it.kind === "watch" && series.length > 1 ? <SparkLine values={series} target={it.watch.threshold ?? null} width={72} height={18} tone={it.state === "erroring" ? "var(--sol-text-muted)" : "var(--sol-red)"} label={`${it.watch.name}, recent readings`} /> : null}
      </span>
      <EventsCell item={it} />
      <span className="ops-home-numcol ops-num" data-col="users">{rowUsers(it) ?? (counted(it) ? <span className="ops-dim">–</span> : null)}</span>
      <time className="ops-home-age ops-num ops-dim" dateTime={new Date(it.at).toISOString()} title={`${STARTED_WORD[it.state]} ${new Date(it.at).toLocaleString()}`} data-ops-started>{relTimeShort(it.at, now)}</time>
      <span className="ops-home-acts" onClick={stop} onKeyDown={stop} onMouseDown={stop}>
        <RowActions item={it} snoozedView={snoozedView} onCheck={() => setChecking((c) => !c)} />
      </span>
      {it.kind === "reader" && open && <BlindWatches watches={it.watches} blind={it.blind} now={now} />}
      {it.kind === "issue" && it.variants && open && <Variants groups={it.variants} now={now} />}
      {it.kind === "source" && checking && (
        <div className="ops-home-sub ops-home-check-sub" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
          <SourceCheck source={it.source} lastAt={it.source.last_event_at ?? null} onClose={() => setChecking(false)} />
        </div>
      )}
    </li>
  );
}

/** The watches a failing reader feeds, the blind ones first, each opening its own page. */
function BlindWatches({ watches, blind, now }: { watches: OpsWatch[]; blind: number; now: number }) {
  return (
    <ul className="ops-home-sub" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} data-ops-blind-list>
      {watches.map((w, i) => (
        <li key={w._id}>
          <Link href={opsHref.metric(w.short_id || w._id)} className="ops-home-subrow" data-ops-blind-watch={w.short_id}>
            <BellRing className="w-3 h-3" aria-hidden />
            <span className="ops-mono ops-dim">{w.short_id}</span>
            <span className="truncate">{w.name}</span>
            <span className="ops-dim ops-num" data-blind={i < blind ? "true" : undefined}>{i < blind ? (w.last_at ? `blind ${relTimeShort(w.last_at, now)}` : "never read") : w.last_at ? `read ${formatRelative(w.last_at, now)}` : "never read"}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** A folded row's issues, busiest first, each opening its own page. */
function Variants({ groups, now }: { groups: OpsGroup[]; now: number }) {
  return (
    <ul className="ops-home-sub" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} data-ops-variant-list>
      {groups.map((g) => (
        <li key={g._id}>
          <Link href={opsHref.issue(g.short_id || g._id)} className="ops-home-subrow" data-ops-variant={g.short_id} title={g.title}>
            <KindGlyph kind={g.kind} />
            <span className="ops-mono ops-dim">{g.short_id}</span>
            <span className="truncate">{g.title}</span>
            <span className="ops-dim ops-num">{compact(g.count)} · {relTimeShort(g.last_seen, now)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Whether a row's kind has events and people at all: a watch, a source or a reader has neither, so its cells stay blank rather than a column of dashes. */
const counted = (it: AttentionItem) => it.kind === "issue" || it.kind === "replay";

function EventsCell({ item }: { item: AttentionItem }) {
  const e = rowEvents(item);
  return <span className="ops-home-numcol ops-num" data-col="events" title={e?.tip}>{e ? compact(e.n) : counted(item) ? <span className="ops-dim">—</span> : null}</span>;
}

/**
 * What a person can do from the row, in three columns the whole list shares:
 * the task a fix is filed under, the one primary act (the session on it, else
 * Fix; a source's own fix; Retry for a watch that cannot read), and a menu.
 */
function RowActions({ item: it, snoozedView, onCheck }: { item: AttentionItem; snoozedView: boolean; /** Send a test opens the source's check under the row. */ onCheck: () => void }) {
  // An item with an issue behind it offers that issue's fix as its page does: one plan, one press, one task reading.
  const group = !snoozedView && !(it.kind === "watch" && it.state === "erroring") ? itemGroup(it) : null;
  if (group && it.kind !== "source" && it.kind !== "reader") return <GroupFixSlots item={it} group={group} snoozedView={snoozedView} />;
  let primary: ReactNode = null;
  if (snoozedView) {
    primary = <button type="button" className="ops-btn" onClick={() => snoozeItems([it], null)} data-ops-wake><BellRing className="w-3.5 h-3.5" />Wake</button>;
  } else if (it.sessionId) {
    primary = <Link href={`/conversation/${it.sessionId}`} className="ops-btn" title="The session working on it"><MessageSquare className="w-3.5 h-3.5" />Session</Link>;
  } else if ((it.kind === "source" || it.kind === "reader") && it.health.problems?.length) {
    // An app whose readers, actions or checks fail goes to an agent from here, the same Start fix the Apps board offers.
    primary = <SourceFix source={it.source} health={it.health} />;
  } else if (it.kind === "source" && (it.health.state === "stopped" || it.health.state === "quiet") && it.source.short_id) {
    // A silent source offers what its overview's header leads with: the test that proves it sends, and a fix session briefed on the silence.
    primary = (
      <>
        <HealthFixButton source={it.source} health={it.health} primary onCheck={onCheck} />
        <SilentFix source={it.source} lastAt={it.health.lastAt} usual={it.health.normal || null} />
      </>
    );
  } else if (it.kind === "source") {
    primary = it.health.fix === "setup" || !it.health.fix
      ? <Link href={opsHref.home({ source: it.source.name })} className="ops-btn" data-tone="primary" data-ops-fix="inspect"><Search className="w-3.5 h-3.5" />Inspect</Link>
      : <HealthFixButton source={it.source} health={it.health} primary onCheck={onCheck} />;
  } else if (it.kind === "reader") {
    // The fix is the reader's (its failing calls), once for every watch it starves.
    primary = it.health.fix && it.health.fix !== "setup"
      ? <HealthFixButton source={it.source} health={it.health} primary />
      : <Link href={opsHref.home({ source: it.source.name })} className="ops-btn" data-tone="primary" data-ops-fix="inspect"><Search className="w-3.5 h-3.5" />Inspect</Link>;
  } else if (it.kind === "watch" && it.state === "erroring") {
    primary = <button type="button" className="ops-btn" data-tone="primary" data-ops-retry onClick={() => retryWatch(it)} title="Read it again now"><RotateCcw className="w-3.5 h-3.5" />Retry</button>;
  } else if (!handled(it)) {
    primary = <StartFix item={it} />;
  }
  return (
    <>
      <RowSlots chip={it.taskId ? <TaskChip taskId={it.taskId} task={it.task} /> : null} primary={primary} menu={<RowMenu item={it} snoozedView={snoozedView} />} />
    </>
  );
}

/**
 * The task and primary press for an item whose issue is known, read through
 * the Fix card's own rules (taskFixStage, fixPlan, fixActionLabel): a task
 * filed for another title is flagged and never bound, a dropped one reopens,
 * a running fix opens its session, a closed one that held resolves.
 */
export function GroupFixSlots({ item: it, group, snoozedView = false, bare = false }: { item: Fixable; group: OpsGroup; snoozedView?: boolean; /** The primary press alone, for a surface that draws its own task chip and acts (the Timeline's rows and panels). */ bare?: boolean }) {
  const now = useCoarseNow(60_000);
  const task = useProblemTask(group.signal_task_id);
  const stage = taskFixStage(group, task ?? undefined);
  const { plan } = useIssueFix(group, stage, now);
  const mismatch = !!task?.title && !taskMatchesIssue(task.title, group.title);
  const full = fixActionLabel(plan.primary, task?.short_id, mismatch);
  // A task filed for another title is never reopened from here: the press starts a fix of this issue's own.
  const label = plan.primary ? ROW_FIX_WORD[plan.primary === "refile" && (mismatch || !task?.short_id) ? "start" : plan.primary] : null;
  let primary: ReactNode = null;
  if ((plan.primary === "open" || plan.primary === "continue") && plan.live) {
    primary = <Link href={`/conversation/${plan.live}`} className="ops-btn" data-tone={plan.primary === "continue" ? "primary" : undefined} title={plan.primary === "open" ? "The session working on it" : `${full}: the fix session stopped, pick it up`} data-ops-fix-open={plan.primary}><MessageSquare className="w-3.5 h-3.5" />{label}</Link>;
  } else if (plan.primary === "resolve") {
    primary = <button type="button" className="ops-btn" data-tone="primary" data-ops-fix-resolve onClick={() => triage([group], "resolved")} title="Its fix held: resolve it"><Check className="w-3.5 h-3.5" />Resolve</button>;
  } else if (plan.primary === "refile" && !mismatch && task?.short_id) {
    // The Fix card's press: reopen the dropped task and start its session, in one confirm.
    primary = <StartFix item={it} label={label ?? undefined} taskId={it.taskId} title={full ?? undefined} reopen={{ short_id: task.short_id, status: task.status }} />;
  } else if (plan.primary) {
    primary = <StartFix item={it} label={label ?? undefined} taskId={mismatch ? null : it.taskId} title={full ?? undefined} />;
  } else if (!bare && !snoozedView && !handled(it)) {
    // Listed on the home, so waiting on someone, though its issue is settled (a replay that caught a resolved issue's error
    // again, a watch whose issue closed): the row still offers its one act, a session of its own, never the closed task.
    primary = <StartFix item={it} taskId={null} />;
  }
  if (bare) return <>{primary}</>;
  return (
    <>
      <RowSlots chip={it.taskId ? <TaskChip taskId={it.taskId} task={it.task} mismatch={mismatch} dissolved={!!task?.cause?.dissolved} /> : null} primary={primary} menu={<RowMenu item={it} snoozedView={snoozedView} />} />
    </>
  );
}

/**
 * The row's two action columns: the task ref, then the menu. The one primary press rides inside the task's column and
 * shows over the row's numbers while the row is pointed at, holds the cursor or has focus (opsHome.css), so a list of
 * rows that all offer Start fix reads as rows, and f still presses it on the cursor row.
 */
function RowSlots({ chip, primary, menu }: { chip: ReactNode; primary: ReactNode; menu: ReactNode }) {
  return (
    <>
      <span className="ops-home-slot" data-slot="task" data-primary={primary ? "true" : undefined}>
        {chip}
        {primary ? <span className="ops-home-slot" data-slot="primary">{primary}</span> : null}
      </span>
      <span className="ops-home-slot" data-slot="more">{menu}</span>
    </>
  );
}

function retryWatch(it: Extract<AttentionItem, { kind: "watch" }>) {
  useInboxStore.getState().readOpsWatchesNow([it.watch._id]);
  toast(`Reading ${it.watch.short_id} again`);
}

/** Who the Assign menu offers: this person first, then the team. */
function useAssignees(): { id: string; name: string; me: boolean }[] {
  const members = useInboxStore(teamMembersOf) as any[] | undefined;
  const me = useInboxStore((s) => s.currentUser) as any;
  return useMemo(() => {
    const out: { id: string; name: string; me: boolean }[] = [];
    if (me?._id) out.push({ id: me._id, name: "Me", me: true });
    for (const m of members ?? []) if (m?._id && m._id !== me?._id) out.push({ id: m._id, name: memberDisplayName(m), me: false });
    return out;
  }, [members, me]);
}

const Key = ({ k }: { k: string }) => <span className="ops-home-menu-key"><KeyCap size="xs">{k}</KeyCap></span>;

function RowMenu({ item: it, snoozedView }: { item: AttentionItem; snoozedView: boolean }) {
  const st = () => useInboxStore.getState();
  const ref = itemRef(it);
  const group = itemGroup(it);
  const canResolve = resolvableGroups([it]).length > 0;
  const people = useAssignees();
  const newest = it.kind === "issue" ? it.replay : it.kind === "replay" ? it.replay : null;
  const replays = it.kind === "issue" ? it.replays : it.kind === "replay" ? it.replays.length : 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="ops-btn ops-home-menu-btn" aria-label={`More for ${ref}`} data-ops-menu={ref}><MoreHorizontal className="w-3.5 h-3.5" /></button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="ops-home-menu">
        {newest && (
          <DropdownMenuItem asChild>
            <Link href={opsHref.replay(newest.short_id || newest._id)} data-ops-newest-replay><Film />{replays > 1 ? `Newest of ${replays} replays` : "Replay"}</Link>
          </DropdownMenuItem>
        )}
        {(it.kind === "source" || it.kind === "reader") && (
          <DropdownMenuItem asChild>
            <Link href={opsHref.home({ source: it.source.name })}><Search />Open {it.source.name}<Key k="↵" /></Link>
          </DropdownMenuItem>
        )}
        {(it.kind === "source" || it.kind === "reader") && it.source.provider === "app" && (
          <DropdownMenuItem asChild>
            <Link href={opsHref.tab("apps", { app: it.source.short_id || it.source.name })} data-ops-open-app><ListX />Open app</Link>
          </DropdownMenuItem>
        )}
        {it.kind === "watch" && (
          <DropdownMenuItem asChild>
            <Link href={opsHref.metric(it.watch.short_id || it.watch._id)} data-ops-edit-watch><Pencil />{it.state === "erroring" ? "Edit query" : "Open watch"}<Key k="↵" /></Link>
          </DropdownMenuItem>
        )}
        {canResolve && !snoozedView && (
          <DropdownMenuItem data-ops-resolve onSelect={() => resolveItems([it])}><Check />Resolve {it.kind === "issue" && it.variants ? it.variants.length : group?.short_id !== ref ? group?.short_id : ""}<Key k="e" /></DropdownMenuItem>
        )}
        {it.task?.short_id && people.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-ops-assign><UserPlus className="w-3.5 h-3.5 mr-2 text-sol-text-muted" />Assign <span className="ml-1 modern:font-mono">{it.task.short_id}</span></DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="ops-home-menu">
              {people.map((p) => (
                <DropdownMenuItem key={p.id} onSelect={() => assignItems([it], p.id, p.name)} data-ops-assign-to={p.me ? "me" : p.id}>
                  {p.name}{p.me ? <Key k="a" /> : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {!snoozedView && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="ops-home-menu-label">{it.kind === "watch" ? "Mute for the team" : "Snooze for me"}</DropdownMenuLabel>
            {snoozeChoices(it.kind).map((c) => (
              <DropdownMenuItem key={c.key} onSelect={() => snoozeItems([it], c)} data-ops-snooze={c.key}>
                {it.kind === "watch" ? <BellOff /> : <Clock />}{c.label}{c.key === "24h" ? <Key k="s" /> : null}
              </DropdownMenuItem>
            ))}
          </>
        )}
        {snoozedView && (
          <DropdownMenuItem onSelect={() => snoozeItems([it], null)}><BellRing />{it.kind === "watch" ? "Unmute" : "Wake now"}</DropdownMenuItem>
        )}
        {it.kind === "issue" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem data-ops-ignore onSelect={() => triage(itemGroups(it), "ignored")}><EyeOff />Ignore for good{it.variants ? ` ${it.variants.length}` : ""}</DropdownMenuItem>
          </>
        )}
        {it.kind === "watch" && it.state === "erroring" && it.watch.status === "active" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-ops-pause-watch
              onSelect={() => {
                st().updateOpsWatch(it.watch._id, { status: "paused" });
                toast(`Paused ${ref}`, { action: { label: "Undo", onClick: () => st().updateOpsWatch(it.watch._id, { status: "active" }) } });
              }}
            >
              <Pause />Pause watch
            </DropdownMenuItem>
          </>
        )}
        {it.kind === "source" && it.source.status === "active" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-ops-pause
              onSelect={() => {
                st().setOpsSourceStatus(it.source._id, "paused");
                toast(`Paused ${it.source.name}`, { action: { label: "Undo", onClick: () => st().setOpsSourceStatus(it.source._id, "active") } });
              }}
            >
              <Pause />Pause source
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href={SETUP_HREF}><Settings2 />Settings</Link>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The task a fix is filed under, as a quiet ref: its status, its id and the
 * face of whoever has it. Nobody on it leaves the face's slot empty, so the
 * rows someone is on stand out and the ids still line up; the Nobody on it
 * tile counts the rest once. Its title is in the tooltip, never the row's own.
 */
export function TaskChip({ taskId, task, mismatch, dissolved }: { taskId: string; task: AttentionTask | null; /** Filed for another title than its issue's. */ mismatch?: boolean; dissolved?: boolean }) {
  const shortId = task?.short_id;
  const assignee = task?.assignee ?? null;
  // The face from the live roster (lib/liveEntities), never the task's server snapshot.
  const members = useInboxStore(teamMembersOf);
  const me = useInboxStore((s) => s.currentUser);
  // A role can own a task too: without the org's roles its assignee reads as nobody.
  const { roles } = useOrgRoles();
  const info = assignee ? resolveAssigneeInfo(assignee, null, members as any, me as any, roles as any) : null;
  const look = taskVisual(dissolved ? "dropped" : task?.status);
  const Icon = mismatch ? Unlink : look.icon;
  return (
    <Link href={`/tasks/${shortId ?? taskId}`} className="ops-home-task" data-keep="true" data-ops-task={shortId ?? taskId} data-assigned={info ? "true" : undefined} data-mismatch={mismatch ? "true" : undefined} title={`${shortId ?? "Task"} · ${dissolved ? "dissolved" : look.label}${mismatch ? " · other issue's task" : ""} · ${info?.name ?? "nobody on it"}`}>
      <Icon className={`w-3 h-3 ${mismatch ? "text-sol-yellow" : look.color}`} />
      <span className="ops-mono">{shortId ?? "task"}</span>
      {info ? <AssigneeFace info={info} size={14} hover={false} /> : <span className="ops-home-task-none" aria-hidden data-ops-task-unassigned />}
    </Link>
  );
}

type Fixable = Exclude<AttentionItem, { kind: "source" | "reader" }>;

function fixFactsOf(it: Fixable): FixFacts {
  if (it.kind === "issue") return { groupRefs: itemGroups(it).map((g) => g.short_id || g._id), replayRef: it.replay?.short_id ?? null, title: itemTitle(it), culprit: it.group.culprit, release: knownRelease(it.group.last_release) };
  if (it.kind === "watch") {
    const w = it.watch;
    if (it.state === "erroring") return { groupRefs: it.group ? [it.group.short_id] : [], title: `Metric ${w.short_id} ${w.name} cannot read`, failure: w.last_error ?? "no answer" };
    return { groupRefs: it.group ? [it.group.short_id] : [], title: `Metric ${w.short_id} ${w.name} is ${w.direction === "above" ? "above" : "below"} its line`, failure: `${fmt(w.last_value, w.unit)} against ${fmt(w.threshold, w.unit)}` };
  }
  if (it.group) return { groupRefs: [it.group.short_id || it.group._id], replayRef: it.replay.short_id, title: it.group.title, culprit: it.group.culprit, release: knownRelease(it.group.last_release), url: it.replay.url };
  return { replayRef: it.replay.short_id, groupRefs: [], title: replayName(it.replay), url: it.replay.url };
}

/** The groups a fix session records itself on, so a second press opens it rather than starting another. */
function fixGroups(it: Fixable): string[] {
  return itemGroups(it).map((g) => g._id);
}

/** The open tasks a fold's other issues filed, by short id, apart from the one a fix binds: what merges into it. */
function useVariantTasks(variants: readonly OpsGroup[] | undefined, bind: string | null | undefined): string[] {
  const ids = useMemo(() => [...new Set((variants ?? []).map((g) => g.signal_task_id).filter((id): id is string => !!id && id !== bind))], [variants, bind]);
  const sig = useInboxStore((s) => ids.map((id) => {
    const t = (s.tasks as Record<string, { short_id?: string; status?: string } | undefined>)[id];
    return t?.short_id && t.status !== "done" && t.status !== "dropped" ? t.short_id : "";
  }).join(","));
  return useMemo(() => sig.split(",").filter(Boolean), [sig]);
}

/** A source that stopped sending, handed to an agent: one session starts, briefed on the silence and what the source used to send. */
export function SilentFix({ source, lastAt, usual }: { source: OpsSource; lastAt: number | null; usual: number | null }) {
  const facts = silentSourceFacts(source, lastAt, usual);
  const folder = useMemo(() => fixSessionPath(useInboxStore.getState() as any, source._id), [source._id]);
  return (
    <ConsequentialSwitch
      on={false}
      ledger={fixLedger(source.short_id, facts.title ?? source.name, folder)}
      onTurnOn={() => startOpsFixSession(facts, source._id)}
      onTurnOff={() => {}}
      trigger={({ press }) => (
        <button type="button" className="ops-btn" onClick={press} title="Start a session briefed on the silence" data-ops-silent-fix>
          <Wand2 className="w-3.5 h-3.5" />Start fix
        </button>
      )}
    />
  );
}

/** An app's failing readers, actions and checks, handed to one agent session seeded with every one of them. */
export function SourceFix({ source, health }: { source: OpsSource; health: SourceHealth }) {
  const folder = useMemo(() => fixSessionPath(useInboxStore.getState() as any, source._id), [source._id]);
  const problems = health.problems ?? [];
  const title = problems.length > 1 ? `${source.name}: ${problems.length} failing` : `${source.name}: ${problems[0]?.name ?? health.label} failing`;
  return (
    <ConsequentialSwitch
      on={false}
      ledger={fixLedger(source.short_id, title, folder)}
      onTurnOn={() => startOpsFixSession({ groupRefs: [], title, failure: problems.map((p) => p.line).join("\n") }, source._id)}
      onTurnOff={() => {}}
      trigger={({ press }) => (
        <button type="button" className="ops-btn" data-tone="primary" data-ops-fix-start data-ops-source-fix={source.name} onClick={press} title="Start a session seeded with these failures (f)">
          <Wand2 className="w-3.5 h-3.5" />Start fix
        </button>
      )}
    />
  );
}

export function StartFix({ item: it, label, taskId: bind = it.taskId, title, reopen }: { item: Fixable; label?: string; /** The task the session binds to; null to start unbound (a task filed for another title). */ taskId?: string | null; title?: string; /** A dropped task the start reopens. */ reopen?: { short_id: string; status?: string } }) {
  const folder = useMemo(() => fixSessionPath(useInboxStore.getState() as any, it.sourceId), [it.sourceId]);
  const ref = itemRef(it);
  const bound = bind ? it.task?.short_id ?? null : null;
  // A folded row's other issues filed tasks of their own: they merge into the one the session works, so nobody is left on a twin.
  const merges = useVariantTasks(it.kind === "issue" ? it.variants : undefined, bind);
  const seeds = it.kind === "issue" && it.variants ? it.variants.map((g) => g.short_id || g._id) : undefined;
  return (
    <ConsequentialSwitch
      on={false}
      ledger={fixLedger(ref, itemTitle(it), folder, bound, { seeds, merges, reopens: !!reopen })}
      onTurnOn={() => {
        if (reopen) setTaskStatusUndoable(reopen, "open");
        startOpsFixSession(fixFactsOf(it), it.sourceId, { taskId: bind, groupIds: fixGroups(it) });
        if (bound) for (const m of merges) void useInboxStore.getState().mergeProblem(m, bound);
      }}
      onTurnOff={() => {}}
      trigger={({ press }) => (
        <button type="button" className="ops-btn" data-tone="primary" data-ops-fix-start onClick={press} title={`${title ?? (bind ? fixLabel(it.task, true) : "Start a session seeded with this")} (f)`}>
          <Wand2 className="w-3.5 h-3.5" />{label ?? ROW_FIX_WORD[bind && (it.task?.status === "done" || it.task?.status === "dropped") ? "followup" : "start"]}
        </button>
      )}
    />
  );
}
