// The Apps tab (X8): each source codecast may act through, as a board. The
// head answers whether the connection is healthy; under it sit what agents
// may do (a switch per action, the only place a grant is made: an agent's CLI
// cannot), what is watched, the call audit folded into groups with what still
// fails first, and what codecast can read. Every row is a name and its state;
// the manifest's own description, the route, the arguments and the full error
// open under the row that names them (appsModel.ts works all of it out).
import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ChevronRight, History, Pause, Play, RefreshCw, ShieldAlert } from "lucide-react";
import { activeGrant, grantableActions, parseAppManifest, sourceHasGrants, type AppManifest, type GrantableAction } from "@codecast/shared/contracts/appConnector";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useOpsApp, useOpsAppCalls, useOpsSources, useOpsWatches, useSyncOpsApp } from "../../hooks/useSyncOps";
import { useInboxStore } from "../../store/inboxStore";
import { relTimeShort } from "../../lib/utils";
import { Switch } from "../ui/switch";
import { appHealth, day, moment, callActor, callReason, callsFailing, filterCalls, healthTone, metricWatchRow, grantLedger, groupCalls, groupState, groupTone, lastAnswered, lastFailure, schemaParams, titleLookup, usageByName, watchRowVerdict, watchRows, watchTally, type AppTone, type CallFilter, type CallGroup, type Param, type Usage } from "./appsModel";
import { ConsequentialSwitch } from "../consequential/ConsequentialSwitch";
import { opsHref, sourceConnectHref } from "./opsPaths";
import { OpsEmpty, OpsFeedEmpty, OpsFeedError, ProviderIcon, SETUP_HREF, SOURCE_PROVIDER_LABEL, useOpsFeed } from "./parts";
import type { OpsAppCall, OpsSource, OpsWatch } from "./opsTypes";
import type { SourceHealth } from "./sourceHealth";
import { useSourceHealth } from "./useSourceHealth";
import { formatValue } from "./metricModel";
import { EntryRun, NoManifest } from "./AppRun";
import { useAppRunner, type AppRunner } from "./appRunner";
import { CallFilters, CallFix, CallGroupDetail } from "./appCalls";
import "./sourceView.css";
import { teamMembersOf } from "../../lib/activeTeam";

export function AppsTab({ app, source: scope }: { app: string | null; source?: string | null }) {
  const sources = useOpsSources();
  const feed = useOpsFeed("sources");
  const apps = useMemo(() => sources.filter((s) => sourceHasGrants(s.provider)), [sources]);
  // The shell's source filter names the page's source: its board, never another source's under its name.
  const scoped = scope ? sources.find((s) => s.name === scope || s.short_id === scope || s._id === scope) ?? null : null;
  const selected = scope ? (scoped && sourceHasGrants(scoped.provider) ? scoped : null) : apps.find((s) => s.short_id === app || s._id === app || s.name === app) ?? apps[0];

  if (scope) {
    if (!scoped) {
      if (feed?.error || (feed && !feed.ready)) return <OpsFeedEmpty feeds={[feed]} what="sources" title={`Reading ${scope}`} />;
      return <div className="ops-detail"><OpsEmpty title={`No source named ${scope}`}><Link href={opsHref.tab("apps")} className="ops-btn mt-2">All apps</Link></OpsEmpty></div>;
    }
    if (!selected) return <div className="ops-detail"><NoAppActions source={scoped} apps={apps} /></div>;
    return <div className="ops-detail"><AppDetail key={selected._id} source={selected} /></div>;
  }

  if (apps.length === 0) {
    if (feed?.error || (feed && !feed.ready)) return <OpsFeedEmpty feeds={[feed]} what="sources" title="No app connected" />;
    return <div className="ops-detail"><AppsPreview /></div>;
  }

  return (
    <div className="ops-detail">
      {apps.length > 1 && (
        <nav className="ops-app-picks" aria-label="Apps">
          {apps.map((s) => (
            <Link key={s._id} href={opsHref.tab("apps", { app: s.short_id || s._id })} className="ops-app-pick" aria-current={s._id === selected?._id ? "page" : undefined} title={s.last_error}>
              <span className="ops-dot" data-status={pickState(s) ? (s.status === "paused" ? "paused" : "error") : "active"} />
              <ProviderIcon provider={s.provider} />
              <span className="truncate min-w-0">{s.name}</span>
              {pickState(s) && <span className="ops-app-pick-state">{pickState(s)}</span>}
            </Link>
          ))}
        </nav>
      )}
      {selected && <AppDetail key={selected._id} source={selected} />}
    </div>
  );
}

/**
 * A source with nothing for agents to do through it (a CI, analytics or webhook feed): what agents read from it,
 * "no actions", and the workspace's apps that do have actions.
 */
export function NoAppActions({ source, apps }: { source: OpsSource; apps: OpsSource[] }) {
  return (
    <section className="ops-noapp" aria-label={`${source.name} has no app actions`} data-ops-no-app>
      <div className="ops-noapp-head">
        <ProviderIcon provider={source.provider} />
        <b>{source.name} has no app actions</b>
        <span className="ops-dim">{SOURCE_PROVIDER_LABEL[source.provider] ?? source.provider}</span>
      </div>
      <dl className="ops-kv">
        <dt>Agents read</dt>
        <dd className="ops-noapp-links">
          <Link href={opsHref.tab("issues", { source: source.name })} className="ops-link">Issues</Link>
          <Link href={opsHref.tab("timeline", { source: source.name })} className="ops-link">Timeline</Link>
        </dd>
        <dt>Agents do</dt>
        <dd className="ops-dim">No actions</dd>
      </dl>
      {apps.length > 0 && (
        <div className="ops-noapp-apps">
          {apps.map((a) => (
            <Link key={a._id} href={opsHref.tab("apps", { source: a.name })} className="ops-btn"><ProviderIcon provider={a.provider} />Open {a.name}</Link>
          ))}
        </div>
      )}
    </section>
  );
}

/** What is wrong with an app, in a word, for the switcher; nothing when it is fine. */
function pickState(s: OpsSource): string | null {
  if (s.status === "error") return "Error";
  if (s.status === "paused") return "Paused";
  return s.watch_state?.some((w) => w.last_error) ? "Failing" : null;
}

function AppDetail({ source }: { source: OpsSource }) {
  const feed = useSyncOpsApp(source._id);
  const app = useOpsApp(source._id);
  const calls = useOpsAppCalls(source._id);
  const now = useCoarseNow(60_000);
  const sourcesFeed = useOpsFeed("sources");
  const runner = useAppRunner(source._id);
  // The one health reading every surface names (sourceHealth.ts), and the metric watches that read through this app.
  const health = useSourceHealth(source);
  const allWatches = useOpsWatches();
  const metricWatches = useMemo(() => allWatches.filter((w) => w.source_id === source._id).sort((a, b) => a.name.localeCompare(b.name)), [allWatches, source._id]);
  const members = useInboxStore(teamMembersOf);
  const me = useInboxStore((s) => s.currentUser);
  const manifest: AppManifest | null = useMemo(() => {
    if (!app?.manifest_json) return null;
    try {
      const parsed = parseAppManifest(JSON.parse(app.manifest_json));
      return parsed.ok ? parsed.manifest : null;
    } catch {
      return null;
    }
  }, [app?.manifest_json]);
  const nameOf = (userId: string) => {
    const person = String(me?._id ?? "") === userId ? me : members.find((m: any) => String(m?._id) === userId);
    return person?.name ?? null;
  };
  const setGrant = (action: string, on: boolean) => {
    const store = useInboxStore.getState();
    if (on) store.grantOpsAction(source._id, action);
    else store.revokeOpsAction(source._id, action);
  };

  const isApp = source.provider === "app";
  if (!app && feed.refused) {
    return (
      <OpsEmpty title={`${source.name} is not readable here`}>
        <Link href={SETUP_HREF} className="ops-btn mt-2">Sources and access</Link>
      </OpsEmpty>
    );
  }
  if (!app && feed.error) return <OpsFeedError what={`${source.name}'s ${isApp ? "manifest" : "grants"}`} retry={feed.retry} />;
  if (!app) return <AppBoardSkeleton name={source.name} />;
  const onWatch = {
    pause: (key: string, paused: boolean) => useInboxStore.getState().setOpsAppWatchPaused(source._id, key, paused),
    run: (key: string) => useInboxStore.getState().pollOpsAppWatch(source._id, key),
  };
  const onMetric = {
    run: (id: string) => useInboxStore.getState().readOpsWatchesNow([id]),
    pause: (id: string, paused: boolean) => useInboxStore.getState().updateOpsWatch(id, { status: paused ? "paused" : "active" }),
  };
  return <AppBoard source={source} manifest={manifest} calls={calls} now={now} fresh={!!sourcesFeed?.ready} nameOf={nameOf} onGrant={setGrant} onWatch={onWatch} onMetric={onMetric} runner={runner} health={health} metricWatches={metricWatches} />;
}

/** The board's shape while its app row is read: the head with its stats and the panels under it, so the wait is visible and nothing jumps. */
function AppBoardSkeleton({ name }: { name: string }) {
  const bar = (w: number | string, h = 12) => <i className="ops-skel" style={{ width: w, height: h }} />;
  return (
    <div className="ops-app" aria-busy="true" aria-label={`Reading ${name}`} data-ops-app-skeleton>
      <header className="ops-app-head">
        <div className="ops-app-id">
          <div className="min-w-0 flex flex-col gap-2">
            <div className="ops-app-name"><span className="truncate">{name}</span></div>
            {bar(220, 10)}
          </div>
        </div>
        <div className="ops-app-stats">
          {[0, 1].map((i) => <div key={i} className="ops-stat">{bar(48, 26)}{bar(84, 10)}</div>)}
        </div>
      </header>
      <div className="ops-skel-panels">
        {[0, 1, 2].map((i) => <div key={i} className="ops-panel ops-skel-panel">{bar("40%")}{bar("90%", 10)}{bar("75%", 10)}{bar("82%", 10)}</div>)}
      </div>
    </div>
  );
}

// ── The board ──

export type AppBoardProps = {
  /** The source's own row: its status, grants and watch state are read from here. */
  source: Pick<OpsSource, "_id" | "name" | "provider" | "status" | "last_error" | "grants" | "watch_state" | "manifest_fetched_at">;
  /** The manifest the app declares; null for a vendor source, or an app whose manifest has not been read. */
  manifest: AppManifest | null;
  calls: OpsAppCall[];
  now: number;
  /** The source row is the server's current answer, not a cached one still waiting on its feed. */
  fresh?: boolean;
  nameOf?: (userId: string) => string | null;
  onGrant: (action: string, on: boolean) => void;
  /** Pause or resume one watch, and poll one now. Absent: the watches are read-only (a vendor source). */
  onWatch?: { pause: (key: string, paused: boolean) => void; run: (key: string) => void };
  /** Read a metric watch now, and pause or resume it. Absent: its rows only link to the watch. */
  onMetric?: { run: (watchId: string) => void; pause: (watchId: string, paused: boolean) => void };
  /** Run a reader or an action, and read the manifest again, as the person. Absent: the board only shows. */
  runner?: AppRunner;
  /** The source's one health reading (sourceHealth.ts): the verdict and its reason, the same words the overview and the Sources table give. */
  health?: Pick<SourceHealth, "tone" | "label" | "reason"> & Partial<Pick<SourceHealth, "starves" | "watches" | "checks">>;
  /** Metric watches that poll through this app's readers (query_kind reader). */
  metricWatches?: readonly OpsWatch[];
};

const NONE: never[] = [];
const ACTOR_LABEL = { watch: "Watch", cli: "CLI", session: "Agent" } as const;
/** Call groups the log shows before "more". */
const CALL_GROUPS = 12;
/** Reasons a call row names before it counts the rest. */
const REASONS = 3;

/** "3m ago", or "just now". */
const ago = (at: number, now: number) => {
  const t = relTimeShort(at, now);
  return t === "now" ? "just now" : `${t} ago`;
};

export function AppBoard({ source, manifest, calls, now, fresh = true, nameOf, onGrant, onWatch, onMetric, runner, health: shared, metricWatches = NONE }: AppBoardProps) {
  const grants = source.grants ?? NONE;
  const watchState = source.watch_state ?? NONE;
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [callFilter, setCallFilter] = useState<CallFilter>({ status: null, actor: null });
  const [callsShown, setCallsShown] = useState(CALL_GROUPS);
  // Run now was pressed: the row says so until its poll lands (polled_at moves past the press).
  const [ran, setRan] = useState<Record<string, number>>({});
  const [ranMetric, setRanMetric] = useState<Record<string, number>>({});
  const toggle = (id: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  const isApp = source.provider === "app";
  const actions = grantableActions(source.provider, manifest);
  const grantOf = (name: string) => activeGrant(grants, name, now);
  const granted = actions.filter((a) => grantOf(a.name));
  const riskyGranted = granted.filter((a) => a.risk === "high").length;

  const watches = useMemo(() => watchRows(manifest?.watches ?? [], watchState, calls, now, fresh), [manifest, watchState, calls, now, fresh]);
  const groups = useMemo(() => groupCalls(calls, { grants, watchState, watches: manifest?.watches ?? [], now, metricWatches }), [calls, grants, watchState, manifest, now, metricWatches]);
  const filteredCalls = useMemo(() => filterCalls(calls, callFilter), [calls, callFilter]);
  const shownGroups = useMemo(() => groupCalls(filteredCalls, { grants, watchState, watches: manifest?.watches ?? [], now, metricWatches }), [filteredCalls, grants, watchState, manifest, now, metricWatches]);
  const usage = useMemo(() => usageByName(calls), [calls]);
  const titleOf = useMemo(() => titleLookup(manifest, actions), [manifest, actions]);
  const own = appHealth(source, watches, groups);
  // One verdict everywhere: the shared reading when the page has it, the board's own words otherwise.
  const health = shared ? { tone: healthTone(shared.tone), label: shared.label, reason: shared.reason, detail: own.detail } : { ...own, reason: own.detail ? callReason({ status: "error", error: own.detail }) : null };
  const metricRows = useMemo(() => metricWatches.map(metricWatchRow), [metricWatches]);
  // The reader every metric watch reads through, when they share one: named once on the group's heading, never on each row.
  const sharedReader = metricRows.length > 1 && metricRows.every((m) => m.reader && m.reader === metricRows[0].reader) ? metricRows[0].reader : null;
  // Two counts that never overlap: the watches by the source's one sentence (the overview's header and tile say the same), and the reads and actions failing outside them.
  const tally = shared?.watches ?? watchTally([...watches.map(watchRowVerdict), ...metricRows.map((m) => m.verdict)], { noLine: metricRows.filter((m) => m.noLine).length });
  const failing = callsFailing(groups);
  // Only the callers the log holds are offered as a filter: a pick that can only answer "None match" is not offered.
  const actorsSeen = useMemo(() => new Set(calls.map(callActor)), [calls]);
  const lastFailed = useMemo(() => lastFailure(calls), [calls]);
  const answered = useMemo(() => lastAnswered(calls, watchState), [calls, watchState]);
  const live = groups.filter((g) => g.live);
  // The failing reader behind the health reading, with the metric watches it leaves without an answer.
  const cause = useMemo(() => {
    const starves = shared?.starves;
    const lead = starves ? groups.find((g) => g.kind === starves.reader.kind && g.name === starves.reader.name) : live.find((g) => g.status === "error" && !g.manifestWatch);
    if (!lead) return null;
    const blind = starves ? metricRows.filter((m) => starves.watchIds.includes(m.id)) : metricRows.filter((m) => m.reader === lead.name && m.stale);
    return { group: lead, watches: blind };
  }, [shared?.starves, groups, live, metricRows]);
  const failingCalls = shownGroups.filter((g) => g.live && g.status === "error");
  const otherCalls = shownGroups.filter((g) => !failingCalls.includes(g)).sort((a, b) => b.latest - a.latest);
  const callsFiltered = !!(callFilter.status || callFilter.actor);
  const watchedEvery = new Map((manifest?.watches ?? []).map((w) => [w.reader, w.every]));
  const viewsLocked = !!manifest?.views.length && actions.some((a) => a.name === "views.token") && !grantOf("views.token");

  const callRow = (g: CallGroup) => (
    <Disclosure
      key={g.key}
      className="ops-dotrow"
      id={`call:${g.key}`}
      open={open}
      toggle={toggle}
      tone={groupTone(g)}
      summary={
        <>
          <span className="ops-state ops-tone-tag" data-live={g.live && g.status === "error" ? "true" : undefined}>{groupState(g)}</span>
          {/* The name takes the room; why it fails sits under it while it fails, each reason with its own count, as the header counts them. */}
          <span className="ops-call-what">
            <span className="ops-row-title ops-call-name">{titleOf(g.kind, g.name)}</span>
            {g.live && g.status === "error" && (
              <span className="ops-call-reasons">
                {g.reasons.slice(0, REASONS).map((r) => (
                  <span key={r.reason} className="ops-tag" data-tone="bad">{r.reason}<span className="ops-num ops-tag-n">{r.count.toLocaleString()}×</span></span>
                ))}
              </span>
            )}
          </span>
          {/* What went wrong before is a count, with the errors behind it; a failing row's counts are its reasons. */}
          {!g.live && g.status === "error" && <span className="ops-row-when ops-num">{g.reasons.reduce((n, r) => n + r.count, 0)} failed</span>}
          {g.status !== "error" && <span className="ops-row-when ops-num ops-row-n" title={`${g.count} calls`}>{g.count.toLocaleString()}×</span>}
          <span className="ops-row-when ops-row-actor">{ACTOR_LABEL[g.actor]}</span>
          <span className="ops-row-when ops-watch-age" title={moment(g.latest)}>{ago(g.latest, now)}</span>
        </>
      }
      trail={g.live && g.status === "error" ? <span className="ops-watch-acts"><CallFix source={source} group={g} /></span> : undefined}
    >
      <CallGroupDetail group={g} />
    </Disclosure>
  );

  const risky = actions.filter((a) => a.risk === "high");
  const safe = actions.filter((a) => a.risk !== "high");
  const actionRow = (a: GrantableAction) => {
    const g = grantOf(a.name);
    const id = `do:${a.name}`;
    // An agent was refused this lately and it is still off: the row to decide on.
    const asked = live.find((x) => x.status === "denied" && x.kind === "do" && x.name === a.name);
    return (
      <Disclosure
        key={a.name}
        id={id}
        open={open}
        toggle={toggle}
        summary={
          <>
            <span className="ops-row-title" data-off={g ? undefined : "true"}>{a.title}</span>
                        {asked && <span className="ops-tag" data-tone="warn" title={moment(asked.latest)}>Asked {ago(asked.latest, now)}</span>}
            <span className="ops-row-fill" />
            {g?.until && <span className="ops-row-when">until {day(g.until)}</span>}
          </>
        }
        lead={
          a.risk === "high" ? (
            // A high-risk grant goes through the shared review: what it hands over, to whom, and how to take it back.
            <ConsequentialSwitch
              on={!!g}
              ledger={grantLedger(a, source, usage.get(id))}
              onTurnOn={() => onGrant(a.name, true)}
              onTurnOff={() => onGrant(a.name, false)}
              trigger={({ on, press }) => (
                <span className="ops-grant">
                  <Switch checked={on} onCheckedChange={() => press()} aria-label={`${on ? "Revoke" : "Grant"} ${a.title}`} />
                </span>
              )}
            />
          ) : (
            <span className="ops-grant">
              <Switch checked={!!g} onCheckedChange={(on) => onGrant(a.name, on)} aria-label={`${g ? "Revoke" : "Grant"} ${a.title}`} />
            </span>
          )
        }
      >
        <EntryDetail entry={a} usage={usage.get(id)} now={now}>
          <dt>Repeat</dt>
          <dd>{a.idempotent ? "Safe" : <span style={{ color: "var(--sol-orange)" }}>Runs again each time</span>}</dd>
          {g && <><dt>Granted</dt><dd>{moment(g.granted_at)}{nameOf?.(g.granted_by) ? ` · ${nameOf(g.granted_by)}` : ""}</dd></>}
        </EntryDetail>
        {isApp && runner && manifest?.actions.some((x) => x.name === a.name) && (
          <EntryRun source={source} runner={runner} kind="do" entry={manifest.actions.find((x) => x.name === a.name)!} granted={!!g} />
        )}
      </Disclosure>
    );
};

  return (
    <div className="ops-app">
      <header className="ops-app-head" data-tone={health.tone}>
        <div className="ops-app-id">
          <div className="min-w-0">
            <div className="ops-app-name">
              <span className="truncate">{source.name}</span>
              <span className="ops-app-verdict">{health.label}</span>
            </div>
            <div className="ops-app-meta">
              {answered && <span title={moment(answered)}>answered {ago(answered, now)}</span>}
              {lastFailed && <span title={moment(lastFailed)}>last failure {ago(lastFailed, now)}</span>}
              {!isApp && <span>{SOURCE_PROVIDER_LABEL[source.provider] ?? source.provider}</span>}
              <Link href={opsHref.tab("timeline", { source: source.name })} className="ops-app-link" title={manifest && source.manifest_fetched_at ? `${manifest.name} ${manifest.version}, read ${moment(source.manifest_fetched_at)}` : undefined}><History className="w-3 h-3" />Timeline</Link>
            </div>
          </div>
        </div>
        <div className="ops-app-stats">
          {/* Always the watches ok of all of them; every watch unjudged reads as its count with no lines, a press into the first one's line. */}
          {isApp && (manifest || metricRows.length > 0) && tally.total > 0 && (tally.unjudged
            ? <Stat value={tally.total} label={tally.label} tone="off" href={metricRows[0] ? `${opsHref.metric(metricRows[0].ref)}#mx-line` : undefined} />
            : <Stat value={tally.value} of={tally.total} label={tally.label} sub={tally.sub || undefined} tone={tally.tone} />)}
          {/* The app's own checks, their own noun as in the overview's header and tile: counted beside the metric watches, never folded into them. */}
          {isApp && !!shared?.checks?.bad && <Stat value={shared.checks.bad} of={shared.checks.total} label={`${shared.checks.total === 1 ? "check" : "checks"} ${shared.checks.word}`} tone={shared.checks.tone === "ok" ? "ok" : "bad"} />}
          {/* The length of Recent calls' Failing now, and a press that narrows Recent calls to the failed ones. */}
          <Stat value={failing} label={failing === 1 ? "call failing" : "calls failing"} tone={failing ? "bad" : "ok"} onClick={failing ? () => { setCallFilter({ status: "error", actor: null }); setCallsShown(CALL_GROUPS); document.querySelector("section[aria-label=\"Recent calls\"]")?.scrollIntoView({ block: "start", behavior: "smooth" }); } : undefined} />
        </div>
        {cause ? (
          // What fails, as structure: the reader with how it fails and how often, the watches it leaves blind, and the fix.
          <div className="ops-app-cause" data-ops-health-reason data-ops-cause={cause.group.name}>
            <span className="ops-app-cause-reader" title={cause.group.reasons.find((r) => r.error)?.error ?? undefined}>
              <span className="ops-mono">{cause.group.name}</span>
              {cause.group.reasons.slice(0, 2).map((r) => <span key={r.reason} className="ops-tag" data-tone="bad">{r.reason}<span className="ops-num ops-tag-n">{r.count.toLocaleString()}×</span></span>)}
              {/* The window the counts cover, in the words every health line uses (failureLine). */}
              {cause.group.firstFailed && <span className="ops-dim ops-num">in the last {ago(cause.group.firstFailed, now).replace(/ ago$/, "")}</span>}
            </span>
            {cause.watches.length > 0 && (
              <span className="ops-app-cause-blind">
                <span className="ops-dim">no answer</span>
                {cause.watches.slice(0, 3).map((w) => <Link key={w.id} href={opsHref.metric(w.ref)} className="ops-app-cause-watch" title={w.error ?? undefined}>{w.name}</Link>)}
                {cause.watches.length > 3 && <span className="ops-dim ops-num">+{cause.watches.length - 3}</span>}
              </span>
            )}
            <span className="ops-row-fill" />
            {cause.group.live && <CallFix source={source} group={cause.group} />}
          </div>
        ) : health.reason ? (
          <Disclosure id="health" open={open} toggle={toggle} className="ops-app-why" summary={<span className="ops-row-title" data-ops-health-reason>{health.reason}</span>}>
            <pre className="ops-fulltext">{health.detail ?? health.reason}</pre>
          </Disclosure>
        ) : null}
      </header>

      {isApp && !manifest ? (
        <NoManifest source={source} runner={runner} />
      ) : (
        <div className="ops-app-grid">
          <div className="ops-app-col">
            <Panel title="Agents can" count={`${granted.length} of ${actions.length} granted`} empty={actions.length === 0 && "No actions declared"} >
              {risky.length > 0 && <div className="ops-sub" data-tone="bad"><ShieldAlert className="w-3.5 h-3.5" /><span>High risk</span><span className="ops-num">{risky.length}</span></div>}
              {risky.map(actionRow)}
              {risky.length > 0 && safe.length > 0 && <div className="ops-sub"><span>Low risk</span><span className="ops-num">{safe.length}</span></div>}
              {safe.map(actionRow)}
            </Panel>

            {manifest && manifest.readers.length + manifest.views.length > 0 && (
              <Panel title="Agents can read" count={manifest.readers.length + manifest.views.length}>
                <ChipSet
                  groups={[
                    {
                      label: "Data",
                      items: manifest.readers.map((r) => ({
                        id: `read:${r.name}`,
                        label: r.title,
                        detail: (
                          <>
                            <EntryDetail entry={r} usage={usage.get(`read:${r.name}`)} now={now}>
                              {r.output_hint && <><dt>Returns</dt><dd>{r.output_hint}</dd></>}
                              {watchedEvery.has(r.name) && <><dt>Watched</dt><dd>every {watchedEvery.get(r.name)}</dd></>}
                            </EntryDetail>
                            {isApp && runner && <EntryRun source={source} runner={runner} kind="read" entry={r} />}
                          </>
                        ),
                      })),
                    },
                    {
                      label: "Screens",
                      badge: viewsLocked && <span className="ops-tag" data-tone="warn">Not granted</span>,
                      items: manifest.views.map((v) => ({
                        id: `view:${v.name}`,
                        label: v.title,
                        detail: (
                          <>
                            {v.description && <p className="ops-prose">{v.description}</p>}
                            <dl className="ops-kv">
                              <dt>Name</dt><dd className="ops-mono">{v.name}</dd>
                              <dt>Path</dt><dd className="ops-mono">{v.path}</dd>
                              {v.params.length > 0 && <><dt>Takes</dt><dd className="ops-mono">{v.params.join("  ")}</dd></>}
                            </dl>
                          </>
                        ),
                      })),
                    },
                  ]}
                />
              </Panel>
            )}
          </div>

          <div className="ops-app-col">
            {/* Two nouns, two panels: the app's own checks, and the metric watches reading through it, each counted as the head counts it. */}
            {watches.length > 0 && (
              <Panel title="Checks" count={watches.length}>
                {watches.map((w) => (
                  <Disclosure
                    key={w.key}
                    className="ops-dotrow"
                    id={`watch:${w.key}`}
                    open={open}
                    toggle={toggle}
                    tone={w.tone}
                    summary={
                      <>
                        {/* The shape of a Recent calls row: a Failing pill in the state column, why it fails (and how often) under the name. */}
                        <span className="ops-state ops-tone-tag" data-live={w.tone === "bad" ? "true" : undefined}>{w.tone === "bad" ? "Failing" : w.label}</span>
                        <span className="ops-call-what">
                          <span className="ops-row-title ops-call-name">{titleOf("read", w.watch.reader)}</span>
                          {w.tone === "bad" && (
                            <span className="ops-call-reasons" data-ops-watch-reason>
                              <span className="ops-tag" data-tone="bad" title={w.error ?? undefined}>{w.label}{w.failures ? <span className="ops-num ops-tag-n">{w.failures.toLocaleString()}×</span> : null}</span>
                            </span>
                          )}
                        </span>
                        <span className="ops-row-when ops-watch-every">every {w.watch.every}</span>
                        <span className="ops-row-when ops-watch-age" title={w.polledAt ? `${moment(w.polledAt)}${w.nextAt ? `, next ${moment(w.nextAt)}` : ""}` : undefined}>
                          {ran[w.key] && (!w.polledAt || w.polledAt < ran[w.key]) ? "running" : w.polledAt ? ago(w.polledAt, now) : "not yet"}
                        </span>
                      </>
                    }
                    trail={onWatch && isApp ? (
                      <span className="ops-watch-acts">
                        <button type="button" className="ops-icon-btn" title="Run now" aria-label={`Run ${w.watch.reader} now`} disabled={source.status !== "active" || (!!ran[w.key] && (!w.polledAt || w.polledAt < ran[w.key]))} onClick={() => { setRan((r) => ({ ...r, [w.key]: Date.now() })); onWatch.run(w.key); }}>
                          <RefreshCw className="w-3.5 h-3.5" />
                        </button>
                        <button type="button" className="ops-icon-btn" title={w.paused ? "Resume" : "Pause"} aria-label={`${w.paused ? "Resume" : "Pause"} ${w.watch.reader}`} onClick={() => onWatch.pause(w.key, !w.paused)}>
                          {w.paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                        </button>
                      </span>
                    ) : undefined}
                  >
                    {w.error && <pre className="ops-fulltext">{w.error}</pre>}
                    <dl className="ops-kv">
                      <dt>Reader</dt><dd className="ops-mono">{w.watch.reader}</dd>
                      {w.nextAt && <><dt>Next poll</dt><dd>{w.nextAt <= now ? "due now" : `in ${relTimeShort(now, w.nextAt)}`}</dd></>}
                      <dt>Rows become</dt><dd>{w.watch.kind === "check" ? "Checks" : "Failed jobs"}</dd>
                      <dt>Fields</dt><dd className="ops-mono">{Object.entries(w.watch.map).map(([k, v]) => `${k}=${v}`).join("  ")}</dd>
                      {w.lastFailure && <><dt>Failed</dt><dd className="ops-num">{w.failures} of the last {calls.length} calls · last {moment(w.lastFailure)}</dd></>}
                    </dl>
                  </Disclosure>
                ))}
              </Panel>
            )}
            {metricRows.length > 0 && (
              <Panel title="Watches" count={metricRows.length}>
                {sharedReader && <div className="ops-sub"><span>Reader</span><span className="ops-mono font-normal" data-ops-metric-reader>{sharedReader}</span></div>}
                {metricRows.map((w) => {
                  const running = !!ranMetric[w.id] && Date.now() - ranMetric[w.id] < 45_000 && (!w.at || w.at < ranMetric[w.id]);
                  return (
                    <div key={w.id} className="ops-row" data-tone={w.tone} data-ops-metric-watch={w.ref} data-verdict={w.verdict}>
                      <div className="ops-row-line">
                        <Link href={opsHref.metric(w.ref)} className="ops-row-main" title={w.error ?? undefined}>
                          <span className="ops-state ops-tone-tag" data-live={w.tone === "bad" ? "true" : undefined}>{w.label}</span>
                          <span className="ops-row-title">{w.name}</span>
                          {w.reader && !sharedReader && <span className="ops-row-when ops-mono ops-mw-reader">{w.reader}</span>}
                          <span className="ops-row-fill" />
                          {/* A value from before a failed read is not the current one: dimmed, its age on hover. Narrow, the two drop under the name. */}
                          <span className="ops-mw-facts">
                            {w.stale && <span className="ops-row-when ops-watch-cause">{w.label}</span>}
                            <span className="ops-row-when ops-num" data-stale={w.stale ? "true" : undefined} title={w.stale && w.at ? `From ${moment(w.at)}; the last read failed` : undefined}>{w.value != null ? formatValue(w.value, w.unit) : "—"}</span>
                            <span className="ops-row-when ops-watch-age" data-stale={w.stale ? "true" : undefined} title={w.at ? moment(w.at) : undefined}>{running ? "running" : w.at ? ago(w.at, now) : "not yet"}</span>
                          </span>
                          <ChevronRight className="ops-row-chev" strokeWidth={1.75} />
                        </Link>
                        {onMetric && (
                          <span className="ops-watch-acts">
                            <button type="button" className="ops-icon-btn" title="Read now" aria-label={`Read ${w.name} now`} disabled={w.paused || running} onClick={() => { setRanMetric((r) => ({ ...r, [w.id]: Date.now() })); onMetric.run(w.id); }} data-ops-metric-run>
                              <RefreshCw className="w-3.5 h-3.5" />
                            </button>
                            <button type="button" className="ops-icon-btn" title={w.paused ? "Resume" : "Pause"} aria-label={`${w.paused ? "Resume" : "Pause"} ${w.name}`} onClick={() => onMetric.pause(w.id, !w.paused)} data-ops-metric-pause>
                              {w.paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                            </button>
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </Panel>
            )}

            <Panel
              title="Recent calls"
              // Both units, so the number over the rows is one a person can count: the routes listed (one row per action or read), then the calls they hold.
              count={calls.length ? `${shownGroups.length.toLocaleString()} ${shownGroups.length === 1 ? "route" : "routes"} · ${callsFiltered ? `${filteredCalls.length} of ` : ""}${calls.length}${calls.length >= 100 ? "+" : ""} calls` : undefined}
              badge={calls.length > 0 && <CallFilters value={callFilter} actors={actorsSeen} onChange={(f) => { setCallFilter(f); setCallsShown(CALL_GROUPS); }} />}
              empty={calls.length === 0 && "No calls yet"}
            >
              {failingCalls.length > 0 && <div className="ops-sub" data-tone="bad"><span>Failing now</span><span className="ops-num">{failingCalls.length}</span></div>}
              {failingCalls.map(callRow)}
              {failingCalls.length > 0 && otherCalls.length > 0 && <div className="ops-sub"><span>Earlier</span><span className="ops-num">{otherCalls.length}</span></div>}
              {otherCalls.slice(0, callsShown).map(callRow)}
              {otherCalls.length > callsShown && (
                <button type="button" className="ops-more-btn" onClick={() => setCallsShown((n) => n + CALL_GROUPS)}>{otherCalls.length - callsShown} more</button>
              )}
              {callsFiltered && !failingCalls.length && !otherCalls.length && <div className="ops-panel-empty">None match</div>}
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Pieces ──

function Stat({ value, of, label, sub, tone, children, onClick, href }: { value: number; of?: number; label: string; sub?: string; tone?: AppTone | "off"; children?: ReactNode; onClick?: () => void; href?: string }) {
  const body = (
    <>
      <div className="ops-stat-value ops-num">
        {value}
        {of !== undefined && <span className="ops-stat-of">/{of}</span>}
        {children}
      </div>
      <div className="ops-stat-label">{label}{sub && <span className="ops-dim"> · {sub}</span>}</div>
    </>
  );
  if (href) return <Link href={href} className="ops-stat" data-tone={tone} data-press="true">{body}</Link>;
  return onClick ? <button type="button" className="ops-stat" data-tone={tone} data-press="true" onClick={onClick}>{body}</button> : <div className="ops-stat" data-tone={tone}>{body}</div>;
}

/** Ghost rows a preview panel holds: a lamp and two bars, at the widths a real row takes. */
function GhostRows({ widths, toggle }: { widths: number[]; toggle?: boolean }) {
  return (
    <div className="ops-app-ghosts">
      {widths.map((w, i) => (
        <div key={i} className="ops-app-ghost">
          {toggle ? <Switch checked={false} onCheckedChange={() => {}} disabled aria-hidden /> : <i className="ops-app-ghost-lamp" />}
          <i className="ops-app-ghost-bar" style={{ width: `${w}%` }} />
          <i className="ops-app-ghost-bar ops-app-ghost-short" />
        </div>
      ))}
    </div>
  );
}

/**
 * The Apps board before any app is connected: its real panels (what agents
 * can do, what they can read, the watches, the recent calls) drawn empty and
 * inert, with the connect step in the head where the app's name will sit.
 */
function AppsPreview() {
  return (
    <div className="ops-app ops-app-preview" data-ops-apps-preview>
      <header className="ops-app-head" data-tone="off">
        <div className="ops-app-id">
          <div className="min-w-0">
            <div className="ops-app-name"><span className="truncate">Your app</span><span className="ops-app-verdict">Not connected</span></div>
            <div className="ops-app-meta"><span>Actions</span><span>Readers</span><span>Watches</span><span>Call audit</span></div>
          </div>
        </div>
        <span className="flex-1" />
        <Link href={sourceConnectHref("app")} className="ops-btn" data-tone="primary" data-ops-connect-app>Connect an app</Link>
      </header>
      <div className="ops-app-grid" aria-hidden inert>
        <div className="ops-app-col">
          <Panel title="Agents can" count="0 granted"><GhostRows widths={[46, 58, 38]} toggle /></Panel>
          <Panel title="Agents can read"><GhostRows widths={[52, 40]} /></Panel>
        </div>
        <div className="ops-app-col">
          <Panel title="Watches"><GhostRows widths={[44, 62, 36]} /></Panel>
          <Panel title="Recent calls"><GhostRows widths={[70, 56, 64, 48]} /></Panel>
        </div>
      </div>
    </div>
  );
}

function Panel({ title, count, badge, empty, children }: { title: string; count?: ReactNode; badge?: ReactNode; empty?: string | false; children?: ReactNode }) {
  return (
    <section className="ops-card ops-panel" aria-label={title}>
      <div className="ops-card-head">
        <span className="ops-panel-title">{title}{count !== undefined && <span className="ops-dim ops-num font-normal">{count}</span>}</span>
        {badge}
      </div>
      {empty ? <div className="ops-panel-empty">{empty}</div> : children}
    </section>
  );
}

type Chip = { id: string; label: string; detail: ReactNode };
type ChipGroup = { label: string; badge?: ReactNode; items: Chip[] };

/**
 * Many small things of a kind as one row each kind: its label, how many, and
 * the first few names. Opening the row lists them as chips, and picking a chip
 * opens what stands behind it.
 */
function ChipSet({ groups }: { groups: ChipGroup[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <>
      {groups.filter((g) => g.items.length > 0).map((g) => {
        const on = open === g.label;
        const item = on ? g.items.find((i) => i.id === picked) : undefined;
        return (
          <div key={g.label} className="ops-row" data-open={on ? "true" : undefined}>
            <div className="ops-row-line">
              <button type="button" className="ops-row-main" aria-expanded={on} onClick={() => setOpen(on ? null : g.label)}>
                <span className="ops-row-title">{g.label}</span>
                <span className="ops-row-when ops-row-count ops-num">{g.items.length}</span>
                <span className="ops-row-fill" />
                {g.badge}
                <ChevronRight className="ops-row-chev" strokeWidth={1.75} />
              </button>
            </div>
            {on && (
              <div className="ops-chips">
                {g.items.map((i) => (
                  <button key={i.id} type="button" className="ops-chip" aria-expanded={i.id === picked} data-on={i.id === picked ? "true" : undefined} onClick={() => setPicked(i.id === picked ? null : i.id)}>
                    {i.label}
                  </button>
                ))}
              </div>
            )}
            {item && <div className="ops-row-detail ops-chip-detail">{item.detail}</div>}
          </div>
        );
      })}
    </>
  );
}

/** A row that names one thing and opens what stands behind it. `lead` holds a control that is not part of the opener. */
function Disclosure({ id, open, toggle, tone, summary, lead, trail, className, children }: { id: string; open: ReadonlySet<string>; toggle: (id: string) => void; tone?: AppTone; summary: ReactNode; lead?: ReactNode; trail?: ReactNode; className?: string; children: ReactNode }) {
  const on = open.has(id);
  return (
    <div className={`ops-row ${className ?? ""}`} data-open={on ? "true" : undefined} data-tone={tone}>
      <div className="ops-row-line">
        {lead}
        <button type="button" className="ops-row-main" aria-expanded={on} onClick={() => toggle(id)}>
          {summary}
          <ChevronRight className="ops-row-chev" strokeWidth={1.75} />
        </button>
        {trail}
      </div>
      {on && <div className="ops-row-detail">{children}</div>}
    </div>
  );
}

function Params({ params }: { params: Param[] }) {
  return (
    <span className="ops-params">
      {params.map((p) => (
        <span key={p.name} className="ops-param" data-required={p.required ? "true" : undefined} title={[p.type, p.required ? "required" : "optional", p.description].filter(Boolean).join(" · ")}>
          {p.name}
        </span>
      ))}
    </span>
  );
}

/** What stands behind a reader or an action: the manifest's own words, its name, route and arguments. */
function EntryDetail({ entry, usage, now, children }: { entry: { name: string; title: string; description?: string; method?: string; path?: string; input?: Parameters<typeof schemaParams>[0] }; usage?: Usage; now: number; children?: ReactNode }) {
  const params = schemaParams(entry.input);
  return (
    <>
      {entry.description && <p className="ops-prose">{entry.description}</p>}
      <dl className="ops-kv">
        <dt>Name</dt><dd className="ops-mono">{entry.name}</dd>
        {entry.path && <><dt>Route</dt><dd className="ops-mono">{entry.method} {entry.path}</dd></>}
        {params.length > 0 && <><dt>Takes</dt><dd><Params params={params} /></dd></>}
        {children}
        {usage && <><dt>Calls</dt><dd className="ops-num">{usage.count}{usage.failed ? `, ${usage.failed} failed` : ""}{usage.last ? ` · last ${relTimeShort(usage.last, now)}` : ""}</dd></>}
      </dl>
    </>
  );
}
