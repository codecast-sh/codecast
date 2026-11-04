// One recording as a player. The recorded page plays on the left with its
// controls attached under it; the events rail on the right lists what
// happened (clicks, pages, console, network, errors) on the same clock, and
// below sit the issues it caught with their fixes, and the person's other
// recordings. When the recording kept its page capture (DOM chunks), the page
// is the isolated player (ReplayPlayerFrame, on replay.codecast.sh, never
// this origin) with its own bar hidden, driven from this one: every seek here
// is posted to it, and its time posts move the scrubber and the rail, so the
// two clocks are one (both are the replay clock, ms since its first event).
// Without a capture the page reads as the semantic view alone.
//
// Skip inactivity jumps the clock over idle stretches (shared/replay/list.ts
// idleRanges) whichever clock is playing. The address follows the scrubber
// once it rests, so a copied URL opens where the person stopped, and Share
// copies a link or a `rp-N@m:ss` moment that plays in place in a message.
// Copy repro writes the Playwright test toRepro builds; Start fix
// goes through the consequential review and records the session on the
// recording's issues, so a second press opens it instead.
//
// The events come from the replay's chunks, read through the chunk route
// (an access check, then a short signed redirect). They are the recording's
// bytes, held by the page while it is open like a video's frames; the
// manifest and the text timeline are store rows. A mirrored recording
// (PostHog, Sentry) not imported yet is imported when the page opens it
// (sources/vendorReplay.importLinked); the import lands in the replay row,
// whose new chunks the page then reads like any other.
import { Fragment, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import Link from "next/link";
import { useAuthToken } from "@convex-dev/auth/react";
import { useAction, useMutation } from "convex/react";
import { REPLAY_PLAYER_SPEEDS, replayWindowHolds, type ReplayPlayerMessage } from "@codecast/shared/contracts/replayPlayer";
import { api } from "@codecast/convex/convex/_generated/api";
import { needsVendorImport, type ReplayEvent } from "@codecast/shared/contracts/replay";
import { ChevronDown, Copy, EyeOff, ExternalLink, FastForward, ImageOff, Image as ImageIcon, Link2, Maximize2, Minimize2, PanelRightClose, PanelRightOpen, Pause, Play, RotateCcw, Search, Share2, Wand2, X } from "lucide-react";
import {
  activeMsOf,
  formatReplayTime,
  idleRanges,
  isAnonymous,
  isFailure,
  isFailedRequest,
  parseReplayEvents,
  personKey,
  personLabel,
  primaryFailure,
  rageBursts,
  resolveReplayFilter,
  routeOf,
  sortReplayEvents,
  foldRepeatNavs,
  toRepro,
} from "@codecast/shared/replay";
import { detailGone, useOpsGroups, useOpsReplay, useOpsReplayTally, useOpsReplayTimeline, useOpsReplays, useOpsSources, useSyncOpsReplay, useSyncOpsReplayBrowse } from "../../hooks/useSyncOps";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { CONVEX_URL } from "../../lib/convexUrl";
import { copyText } from "../../lib/copyText";
import { relTimeShort } from "../../lib/utils";
import { hasOpenModal, isEditableTarget } from "../../shortcuts";
import { useInboxStore } from "../../store/inboxStore";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { EntityIdPill } from "../EntityIdPill";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { decodeReplayChunk, eventIndexAt, fixPrompt, isScrubberTick, outlineAt, replayBaseUrl, replayLength, urlAt, type FixFacts } from "./opsModel";
import { opsHref } from "./opsPaths";
import { OpsFeedError, ProviderIcon, pressable } from "./parts";
import { OpsNotFound } from "./OpsShellParts";
import { fixFolderChoices, fixSessionPath, startOpsFixSession } from "./startFix";
import { folderName } from "./issueFix";
import { FIX_STAGE_LABEL, fixActionLabel, taskFixStage, taskMatchesIssue, taskStateWord, type FixStage } from "./issuesModel";
import { FixReview, FixStageGlyph } from "./issueParts";
import { useIssueFix, useProblemTask } from "./useIssueFix";
import { setTaskStatusUndoable } from "./issueUndo";
import type { OpsGroup, OpsReplay, OpsSource } from "./opsTypes";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { ReplayPlayerIframe } from "./ReplayPlayerFrame";
import { useReplayPlayerChannel, useReplayPlayerLink } from "../../hooks/useReplayPlayer";
import { EnvMarks, PersonMark, ReplayFigures, ReplayStrip } from "./replayParts";
import {
  RAIL_LABEL,
  RAIL_TABS,
  ALL_KIND_LABEL,
  ALL_KINDS_HIDDEN_BY_DEFAULT,
  allKindCounts,
  type AllKind,
  activityBins,
  describeEvent,
  endpointOf,
  eventHas,
  issueMoments,
  isUserAction,
  momentRef,
  foldRail,
  importedUntil,
  captureEndFrom,
  netGrade,
  netParts,
  netPath,
  onReplayClock,
  pathOf,
  playerImportedUntil,
  replayPagePath,
  restDue,
  restHold,
  railRowAt,
  restLine,
  restState,
  restQueued,
  withRemoteAssets,
  type RestHold,
  type RestState,
  type RestQueued,
  plural,
  railAdmits,
  railCounts,
  actionDetail,
  isEmptyInput,
  replayFixLedger,
  replayLengthText,
  selectorName,
  skipTarget,
  stageProblemText,
  stepTo,
  vendorRecordingUrl,
  vendorUrlAt,
  type RailTab,
} from "./replayModel";
import "./replays.css";

type Loaded = { state: "loading" } | { state: "ready"; events: ReplayEvent[] } | { state: "failed"; error: string };

/** Read every chunk of a replay the viewer may see, in order. */
function useReplayEvents(replay: OpsReplay | undefined): Loaded {
  const token = useAuthToken();
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  // A re-import (a newer converter, a part of a long recording) replaces chunks that may keep their count: when it landed is part of the key.
  const key = replay ? `${replay._id}:${replay.chunks}:${replay.captured_ms ?? ""}:${replay.imported_at ?? ""}` : null;
  // The replay whose events are on screen: a later part landing reads the chunks again behind them, so nothing blanks.
  const shown = useRef<string | null>(null);
  useWatchEffect(() => {
    if (!replay || !token) return;
    if (replay.chunks === 0) {
      setLoaded({ state: "ready", events: [] });
      return;
    }
    let cancelled = false;
    if (shown.current !== replay._id) setLoaded({ state: "loading" });
    (async () => {
      // Every chunk at once: a long recording is several, and each is a round trip through the chunk route.
      const parts = await Promise.all(Array.from({ length: replay.chunks }, async (_, seq) => {
        const res = await fetch(`${CONVEX_URL}/cli/replays/chunk?replay=${encodeURIComponent(replay._id)}&seq=${seq}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(res.status === 404 ? "a chunk is missing or expired (chunks are kept 30 days)" : `chunk ${seq} answered ${res.status}`);
        return parseReplayEvents(await decodeReplayChunk(new Uint8Array(await res.arrayBuffer())));
      }));
      const all = parts.flat();
      if (cancelled) return;
      shown.current = replay._id;
      setLoaded({ state: "ready", events: onReplayClock(foldRepeatNavs(sortReplayEvents(all))) });
    })().catch((e) => {
      if (!cancelled) setLoaded({ state: "failed", error: e instanceof Error ? e.message : String(e) });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key stands in for the replay row
  }, [key, token]);
  return loaded;
}

type Import = ({ state: "idle" } | { state: "importing" } | { state: "failed"; error: string }) & {
  again?: () => void;
  /** The server read nothing on the last ask, and why (importLinked's `declined`): shown at once, before the row's own sync says so. */
  declined?: RestHold | null;
};

/**
 * Import a mirrored recording the first time the page opens it. The answer is
 * not rendered: the import writes the replay row, and the row's sync brings
 * its chunks here. One attempt per replay per visit.
 */
function useVendorImport(replay: OpsReplay | undefined): Import {
  const importLinked = useAction(api.sources.vendorReplay.importLinked);
  const [state, setState] = useState<Import>({ state: "idle" });
  const [declined, setDeclined] = useState<RestHold | null>(null);
  const tried = useRef<string | null>(null);
  // Also a copy holding only the start of a long recording with nothing reading the rest: the server starts reading it.
  const due = !!replay && (needsVendorImport(replay) || restDue(replay, Date.now())) && !(declined && declined.until > Date.now());
  const run = (id: string) => {
    setState({ state: "importing" });
    setDeclined(null);
    importLinked({ replay: id }).then(
      (out: { declined?: { why: string; until?: number } }) => {
        setState({ state: "idle" });
        const d = out?.declined;
        if (d && d.until && d.why !== "whole" && d.why !== "reading") setDeclined({ why: d.why as RestHold["why"], until: d.until });
      },
      (e) => setState({ state: "failed", error: e instanceof Error ? e.message : String(e) }),
    );
  };
  useWatchEffect(() => {
    if (!replay || !due || tried.current === replay._id) return;
    tried.current = replay._id;
    run(replay._id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per replay id
  }, [replay?._id, due]);
  // A press that asks again: reading the rest stopped while the page was open.
  return { ...state, declined, again: replay && due && state.state !== "importing" ? () => run(replay._id) : undefined };
}

/** The issues a recording is linked to: the store's group rows first (they carry fix state), the detail's names for the rest. */
function useLinkedIssues(replay: OpsReplay | undefined, timeline: ReturnType<typeof useOpsReplayTimeline>): { _id: string; short_id: string; title: string; status: string; fingerprint?: string; group?: OpsGroup }[] {
  const groups = useOpsGroups();
  return useMemo(() => {
    if (!replay) return [];
    const byId = new Map(groups.map((g) => [g._id, g]));
    const named = new Map((timeline?.groups ?? []).map((g) => [g._id, g]));
    return replay.group_ids
      .map((id) => {
        const g = byId.get(id);
        if (g) return { _id: g._id, short_id: g.short_id, title: g.title, status: g.status, fingerprint: g.fingerprint, group: g };
        const n = named.get(id);
        return n ? { _id: n._id, short_id: n.short_id, title: n.title, status: n.status } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
  }, [replay, groups, timeline]);
}

/** Where the vendor shows the recording itself, when the source says enough to build the address. */
function vendorUrl(replay: OpsReplay, source: Pick<OpsSource, "config" | "vendor_web_url"> | undefined): string | null {
  return vendorRecordingUrl(replay.provider, replay.external_id, source);
}

const VENDOR_NAME: Partial<Record<OpsReplay["provider"], string>> = { sentry: "Sentry", posthog: "PostHog" };

const NO_EVENTS: ReplayEvent[] = [];
/** How long "Opening rp-N" waits on the server before the page says the recording is not in the lists it holds (still checking). */
const OPEN_PATIENCE_MS = 4_000;

export function ReplayPage({ id, t }: { id: string; t: number | null }) {
  const feed = useSyncOpsReplay(id);
  const replay = useOpsReplay(id);
  const timeline = useOpsReplayTimeline(replay?._id);
  const loaded = useReplayEvents(replay);
  const vendorImport = useVendorImport(replay);
  const issues = useLinkedIssues(replay, timeline);
  const sources = useOpsSources();
  const now = useCoarseNow(60_000);
  // The player registers "play from here", so the header's issue chip and the issue cards can start it at an issue.
  const seekRef = useRef<((t: number) => void) | null>(null);
  const loadedEvents = loaded.state === "ready" ? loaded.events : null;
  const moments = useMemo(() => (loadedEvents && replay ? issueMoments(loadedEvents, replay.url, issues) : new Map<string, number>()), [loadedEvents, replay, issues]);
  const [slowOpen, setSlowOpen] = useState(false);
  const missing = !replay;
  useWatchEffect(() => {
    setSlowOpen(false);
    if (!missing) return;
    const timer = setTimeout(() => setSlowOpen(true), OPEN_PATIENCE_MS);
    return () => clearTimeout(timer);
  }, [missing, id]);

  if (!replay) {
    if (detailGone(feed)) return <OpsNotFound id={id} kind="replay" />;
    if (feed.error) return <OpsFeedError what={id} retry={feed.retry} />;
    // Nothing cached holds it and the server is slow to answer: say so while it still checks, rather than "Opening" for half a minute.
    if (slowOpen) return <OpsNotFound id={id} kind="replay" checking />;
    return <div className="rp-page ops-quiet text-[12.5px]">Opening {id}…</div>;
  }

  const events = loaded.state === "ready" ? loaded.events : null;
  const source = sources.find((s) => s._id === replay.source_id);
  const external = vendorUrl(replay, source);
  const seek = (at: number) => seekRef.current?.(Math.max(0, at - 2000));
  const issueMarks = issues.flatMap((i) => (moments.has(i._id) ? [{ t: moments.get(i._id)!, short_id: i.short_id, title: i.title }] : []));
  const len = replayLengthText(replay);
  const active = activeMsOf(replay);
  const cutAt = importedUntil(replay.captured_ms, replay.duration_ms);
  const rest = restState(replay, now);
  const queued = restQueued(replay, source, now);
  // Counted from the stream once it is read (repeat snapshots of one page folded), the stored shape until then: both count changes of address.
  const pages = (events && events.length ? events.filter((e) => e.type === "nav").length : replay.shape?.pages) || undefined;
  const who = personKey(replay.user);
  // A recording with a page capture opens its player while its events are still being read, so the capture loads alongside them.
  const early = loaded.state === "loading" && replay.chunks > 0 && (replay.dom_chunks ?? 0) > 0;

  return (
    <div className="rp-page" data-ops-replay={replay.short_id}>
      <div className="rp-page-head">
        <div className="rp-title-row">
          <PersonMark label={personLabel(replay.user)} personKey={who} anonymous={isAnonymous(replay.user)} size={30} />
          <div className="min-w-0 flex-1">
            <div className="rp-title-line">
            <h1 className="rp-h1" title={replay.url ?? undefined}>
              {who ? (
                <Link className="rp-h1-person" href={personListHref(who)} title={`Every recording of ${personLabel(replay.user)}`} data-anon={isAnonymous(replay.user) ? "true" : undefined}>
                  {personLabel(replay.user)}
                </Link>
              ) : (
                <span className="ops-quiet">Anonymous</span>
              )}
              <span className="rp-h1-on ops-dim">on</span>
              <MiddlePath text={replayPagePath(replay) ? routeOf(replayPagePath(replay)) : "no page recorded"} />
            </h1>
            {issues[0] && <HeaderIssue issue={issues[0]} more={issues.length - 1} at={moments.get(issues[0]._id)} onSeek={seek} />}
            </div>
            <div className="rp-facts">
              <span className="rp-fact"><ProviderIcon provider={replay.provider} />{replay.source_name ?? replay.provider}</span>
              <span className="rp-fact ops-num" title={new Date(replay.started_at).toLocaleString()}>{new Date(replay.started_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {relTimeShort(replay.started_at, now)}</span>
              <span className="rp-fact ops-num" title={len.known ? "Length" : undefined}>{len.known ? len.text : <span className="ops-dim">{len.text}</span>}{active !== undefined && len.known ? <span className="ops-dim"> · {formatReplayTime(active).replace(/\.\d$/, "")} active</span> : null}</span>
              {cutAt !== null && (
                <span className="rp-fact rp-cut-fact ops-num" title={`Imported 0:00 to ${formatReplayTime(cutAt)} of ${formatReplayTime(replay.duration_ms ?? 0)}`}>
                  {formatReplayTime(cutAt).replace(/\.\d$/, "")} of {formatReplayTime(replay.duration_ms ?? 0).replace(/\.\d$/, "")} imported
                  <RestStatus rest={rest} starting={vendorImport.state === "importing"} readRest={vendorImport.again} hold={vendorImport.declined ?? restHold(replay, now)} vendorName={external ? (VENDOR_NAME[replay.provider] ?? replay.provider) : null} queued={queued} />
                  {external && (
                    <a className="rp-cut-vendor" href={vendorUrlAt(external, cutAt)} target="_blank" rel="noreferrer noopener" title={`The rest of the recording, from ${formatReplayTime(cutAt).replace(/\.\d$/, "")}, in ${VENDOR_NAME[replay.provider] ?? replay.provider}`}>
                      Play the rest in {VENDOR_NAME[replay.provider] ?? replay.provider} <ExternalLink className="w-3 h-3" aria-hidden />
                    </a>
                  )}
                </span>
              )}
              {pages !== undefined && <span className="rp-fact ops-num">{plural(pages, "page")}</span>}
              <ReplayFigures replay={replay} />
              {replay.facts && <span className="rp-fact"><EnvMarks facts={replay.facts} full /></span>}
            </div>
          </div>
          <ReplayActions replay={replay} events={events} issues={issues} vendor={external ? { href: external, name: VENDOR_NAME[replay.provider] ?? replay.provider } : null} />
        </div>
      </div>

      {(events && events.length > 0) || early ? (
        <Player replay={replay} events={events ?? NO_EVENTS} reading={early} initialT={t} issueMarks={issueMarks} seekRef={seekRef} vendor={external ? { href: external, name: VENDOR_NAME[replay.provider] ?? replay.provider } : null} readRest={vendorImport.again} starting={vendorImport.state === "importing"} hold={vendorImport.declined ?? restHold(replay, now)} queued={queued} />
      ) : loaded.state === "loading" && replay.chunks > 0 ? (
        <div className="rp-main rp-main-wait ops-quiet"><span className="rp-wait-bar" aria-hidden />Reading the recording</div>
      ) : vendorImport.state === "importing" || (needsVendorImport(replay) && vendorImport.state === "idle") ? (
        <div className="rp-main rp-main-wait ops-quiet">Importing the recording from {replay.source_name ?? replay.provider}…</div>
      ) : (
        <div className="ops-card">
          <div className="ops-card-head">
            <span>Timeline</span>
            {loaded.state === "failed" && <span className="text-[11px] font-normal" style={{ color: "var(--sol-orange)" }}>Could not be read: {loaded.error}</span>}
            {vendorImport.state === "failed" && <span className="text-[11px] font-normal" style={{ color: "var(--sol-orange)" }}>Import failed: {vendorImport.error}</span>}
          </div>
          <pre className="ops-outline ops-mono" style={{ maxHeight: "none" }}>{timeline?.timeline_md ?? (replay.chunks === 0 ? "Nothing recorded yet." : "No text timeline yet.")}</pre>
        </div>
      )}

      <div className="rp-below">
        <IssuesAndFixes issues={issues} moments={moments} onSeek={events && events.length > 0 ? seek : null} />
        {who && <PersonRecordings replay={replay} personKey={who} now={now} />}
      </div>
    </div>
  );
}

/** Copy repro, and the fix: open the one running, or start one through the review. */
function ReplayActions({ replay, events, issues, vendor }: { replay: OpsReplay; events: ReplayEvent[] | null; issues: ReturnType<typeof useLinkedIssues>; vendor: { href: string; name: string } | null }) {
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
          <Wand2 className="w-3.5 h-3.5" /> Start fix
        </button>
      )}
      {reviewing && <SwitchReview ledger={ledger()} onClose={() => setReviewing(false)} onConfirm={start} onPick={setFolder} />}
    </div>
  );
}

/** The recording's first issue in the header: its id and status, and a press that plays from just before it happens. */
/** A path cut in the middle, never at its end: the last segment names the page. */
function MiddlePath({ text }: { text: string }) {
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

function HeaderIssue({ issue, more, at, onSeek }: { issue: ReturnType<typeof useLinkedIssues>[number]; more: number; at: number | undefined; onSeek: (t: number) => void }) {
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
function IssuesAndFixes({ issues, moments, onSeek }: { issues: ReturnType<typeof useLinkedIssues>; moments: Map<string, number>; onSeek: ((t: number) => void) | null }) {
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
/** The list under one person, every recording of theirs however short: the person card and the header link both open it. */
const personListHref = (who: string) => `${opsHref.tab("replays")}?person=${encodeURIComponent(who)}&active=any`;

function PersonRecordings({ replay, personKey: who, now }: { replay: OpsReplay; personKey: string; now: number }) {
  // Every recording of this person, this one included however short: "All" opens the list under the same filter, so both say the same count.
  const browse = useMemo(() => ({ source: null, match: resolveReplayFilter({ person: who, active: "any" }, 0), sort: "newest" as const, limit: 20 }), [who]);
  const { key } = useSyncOpsReplayBrowse(browse);
  const tally = useOpsReplayTally(key);
  const all = useOpsReplays();
  const theirs = useMemo(() => all.filter((r) => personKey(r.user) === who), [all, who]);
  const others = theirs.filter((r) => r._id !== replay._id).slice(0, 20);
  // One count for "this person's recordings": the workspace browse's, the same the list shows under their filter. Until it lands, the cached rows stand in, dimmed.
  // Said as the list says it under this person's filter (ReplaysTab floorOnly): a whole number, never "56+".
  const total = Math.max(1, tally?.total ?? theirs.length);
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
          <span data-provisional={tally ? undefined : "true"}><b>{total.toLocaleString()}</b> recording{total === 1 ? "" : "s"}</span>
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

const EV_INK: Partial<Record<ReplayEvent["type"], string>> = {
  nav: "var(--sol-blue)",
  error: "var(--sol-red)",
  mark: "var(--sol-violet)",
  submit: "var(--sol-green)",
  view: "var(--sol-text-dim)",
};

function inkOf(e: ReplayEvent): string {
  if (e.type === "console") return e.level === "error" ? "var(--sol-red)" : "var(--sol-yellow)";
  if (e.type === "network") return netGrade(e) === "failed" ? "var(--sol-red)" : netGrade(e) === "slow" ? "var(--sol-yellow)" : "var(--sol-text-muted)";
  return EV_INK[e.type] ?? "var(--sol-text-muted)";
}

// The rail's type column: one short word each, so the column stays narrow.
const TYPE_WORD: Record<ReplayEvent["type"], string> = {
  nav: "page", click: "click", input: "type", submit: "submit", key: "key", scroll: "scroll",
  console: "log", network: "net", error: "error", view: "view", mark: "mark",
};
/** An event's kind word in the rail: a field entered without typing is a focus. */
const wordOf = (e: ReplayEvent) => (isEmptyInput(e) ? "focus" : TYPE_WORD[e.type]);

type Speed = (typeof REPLAY_PLAYER_SPEEDS)[number];
const SPEEDS = REPLAY_PLAYER_SPEEDS;
const SKIP_KEY = "ops.replay.skipIdle";
const THEATER_KEY = "ops.replay.theater";
const MUTED_KEY = "ops.replay.mutedEndpoints";
const ALL_HIDDEN_KEY = "ops.replay.allHidden";
const RAIL_W_KEY = "ops.replay.railW";
const RAIL_MIN_PX = 240;
const RAIL_MAX_PX = 640;
const URL_SETTLE_MS = 400;

function readSkip(): boolean {
  try {
    return localStorage.getItem(SKIP_KEY) !== "0";
  } catch {
    return true;
  }
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {}
}

/** The controls under the stage (scrubber, bar, keys) and the stage's padding: what the stage's height leaves room for. */
const CONTROLS_PX = 96;
const STAGE_PAD_PX = 20;

/** The smallest the two-column player gets before the page scrolls to it. */
const FIT_MIN_PX = 420;

/**
 * The player's height so it ends at the bottom of the window: the stage and
 * its controls in view together, with no scroll before anything plays. Read
 * from where the player sits in its scroll container, on open and on resize.
 */
function useViewportFit(): { ref: (el: HTMLDivElement | null) => void; height: number | null } {
  const [height, setHeight] = useState<number | null>(null);
  const node = useRef<HTMLDivElement | null>(null);
  const measure = () => {
    const el = node.current;
    if (!el || typeof window === "undefined") return;
    let sc: HTMLElement | null = el.parentElement;
    while (sc && typeof window.getComputedStyle === "function" && !/(auto|scroll)/.test(window.getComputedStyle(sc).overflowY)) sc = sc.parentElement;
    const scTop = sc ? sc.getBoundingClientRect().top : 0;
    const offset = el.getBoundingClientRect().top - scTop + (sc ? sc.scrollTop : window.scrollY);
    const view = sc ? sc.clientHeight : window.innerHeight;
    const next = Math.max(FIT_MIN_PX, Math.round(view - offset - 14));
    setHeight((prev) => (prev === next ? prev : next));
  };
  useWatchEffect(() => {
    if (typeof window === "undefined") return;
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- measured on open and on resize
  }, []);
  const ref = (el: HTMLDivElement | null) => {
    node.current = el;
    if (el) measure();
  };
  return { ref, height };
}

type PlayerProps = {
  replay: OpsReplay;
  /** Why the server is not reading the rest now, and until when (restHold). */
  hold?: RestHold | null;
  /** Ask the server again to read the rest of a long recording, when reading it stopped. */
  readRest?: () => void;
  /** The page asked the server to read the rest and it has not answered yet. */
  starting?: boolean;
  /** Where a cut copy waits for the sweep (restQueued). */
  queued?: RestQueued;
  events: ReplayEvent[];
  /** The events are still being read: the page capture plays meanwhile, and the rail says so. */
  reading?: boolean;
  initialT: number | null;
  /** The recording in its vendor's own player, for the part the import does not hold. */
  vendor?: { href: string; name: string } | null;
  /** Where each linked issue first happens, marked on the scrubber. */
  issueMarks?: { t: number; short_id: string; title: string }[];
  /** Set to "play from here" for controls outside the player (the header's issue, the issue cards). */
  seekRef?: { current: ((t: number) => void) | null };
};

/**
 * The player proper: exported for its mount test (ops/__tests__/replayPlayer.mount.test.tsx).
 * Each recording gets its own player, so moving between recordings in the app opens the next one
 * at the time its address asks for, as a full load does.
 */
export function Player(props: PlayerProps) {
  return <RecordingPlayer key={props.replay._id} {...props} />;
}

function RecordingPlayer({ replay, events, reading = false, initialT, issueMarks = [], seekRef, vendor = null, readRest, starting = false, hold = null, queued }: PlayerProps) {
  // The capture can run past the last event (a page left open): the player says how long its clock runs once it is ready.
  const [captureMs, setCaptureMs] = useState(0);
  // Where the page capture itself ends (0 until the player says): what the import cut is read from when the row stores no reach.
  const [captureEnd, setCaptureEnd] = useState(0);
  const length = useMemo(() => Math.max(1, replayLength(events, replay.duration_ms), captureMs), [events, replay.duration_ms, captureMs]);
  const fit = useViewportFit();
  // Theater hides the events rail so the page gets the width; fullscreen gives the player the screen.
  const [theater, setTheater] = useState(() => readFlag(THEATER_KEY));
  const mainRef = useRef<HTMLDivElement | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useWatchEffect(() => {
    if (typeof document === "undefined") return;
    const on = () => setFullscreen(!!document.fullscreenElement && document.fullscreenElement === mainRef.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);
  // The rail's width, dragged from its left edge and kept for every recording; null is the layout's own width.
  const [railW, setRailW] = useState<number | null>(() => {
    try {
      const n = Number(localStorage.getItem(RAIL_W_KEY));
      return n >= RAIL_MIN_PX && n <= RAIL_MAX_PX ? n : null;
    } catch {
      return null;
    }
  });
  const onGripDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const main = mainRef.current;
    if (!main) return;
    e.preventDefault();
    const right = main.getBoundingClientRect().right;
    const cap = Math.min(RAIL_MAX_PX, Math.round(main.clientWidth * 0.5));
    let last = railW;
    const move = (ev: PointerEvent) => {
      last = Math.max(RAIL_MIN_PX, Math.min(cap, Math.round(right - ev.clientX)));
      setRailW(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        if (last) localStorage.setItem(RAIL_W_KEY, String(last));
      } catch {}
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const resetRail = () => {
    setRailW(null);
    try {
      localStorage.removeItem(RAIL_W_KEY);
    } catch {}
  };
  const toggleTheater = () => setTheater((v) => {
    writeFlag(THEATER_KEY, !v);
    return !v;
  });
  const toggleFullscreen = () => {
    const el = mainRef.current;
    if (!el || typeof document === "undefined") return;
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void el.requestFullscreen?.().catch(() => {});
  };
  const [vh, setVh] = useState(() => (typeof window === "undefined" ? 800 : window.innerHeight));
  useWatchEffect(() => {
    if (typeof window === "undefined") return;
    const on = () => setVh(window.innerHeight);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const avail = fullscreen ? vh : fit.height;
  const failure = useMemo(() => primaryFailure(events), [events]);
  const [t, setT] = useState(() => Math.min(length, initialT ?? (failure ? Math.max(0, failure.t - 3000) : 0)));
  // Where the imported copy stops, when the recording runs well past it; from there on nothing plays.
  const cut = useMemo(() => playerImportedUntil(replay, events[events.length - 1]?.t ?? 0, captureEnd), [replay, events, captureEnd]);
  const end = cut ?? length;
  // A time asked for past the import (a ?t, a seek into the rest) lands at the import's end, and the stage says so with the vendor's player at that time.
  const [pastCut, setPastCut] = useState<number | null>(null);
  // The time the address asked for, held until the reach is known: the player clamps its clock to what is imported, so `t` alone forgets it.
  const asked = useRef<number | null>(initialT);
  const restNow = useCoarseNow(15_000);
  const rest = restState(replay, restNow);
  useWatchEffect(() => {
    // The rest reached the time a person asked for: open the longer capture there and play.
    if (pastCut !== null && (cut === null || pastCut <= cut + 1000)) {
      const to = pastCut;
      setPastCut(null);
      if (domParts > stagedParts.current) {
        stagedParts.current = domParts;
        setT(to);
        setPlaying(true);
        setStageGen((g) => g + 1);
      } else playFrom(to);
      return;
    }
    const want = asked.current ?? t;
    if (cut !== null) asked.current = null;
    if (cut !== null && want > cut + 1000) seekTo(want);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once the reach is known, and each time it grows
  }, [cut, replay.dom_chunks]);
  // The page capture grows as the rest of a long recording lands. The stage
  // opens again on the longer capture when the whole recording is in, or at
  // once when the person is waiting at the end of what is there.
  const domParts = replay.dom_chunks ?? 0;
  const [stageGen, setStageGen] = useState(0);
  const stagedParts = useRef(domParts);
  const atCut = pastCut !== null || (cut !== null && t >= cut - 2000);
  useWatchEffect(() => {
    if (domParts <= stagedParts.current) return;
    if (replay.import_rest && !atCut) return;
    stagedParts.current = domParts;
    setStageGen((g) => g + 1);
  }, [domParts, !!replay.import_rest, atCut]);
  // Opened before the events were read: once they are, an untouched player moves to just before the failure, as it would have opened.
  const placed = useRef(!reading || initialT !== null);
  useWatchEffect(() => {
    if (reading || placed.current) return;
    placed.current = true;
    if (failure && !playing && t < 1) seekTo(Math.max(0, failure.t - 3000));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the events land
  }, [reading, failure]);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [skip, setSkip] = useState(readSkip);
  const idx = eventIndexAt(events, t);
  const outline = outlineAt(events, t);
  const url = urlAt(events, t, replay.url);
  const ticks = useMemo(() => events.filter(isScrubberTick), [events]);
  const idle = useMemo(() => idleRanges(events, end), [events, end]);
  const rage = useMemo(() => rageBursts(events), [events]);
  const bins = useMemo(() => activityBins(events, length, 120), [events, length]);
  const hasOutlines = useMemo(() => events.some((e) => e.type === "view"), [events]);

  // The page itself, when the recording kept it. Opened once, at the time the
  // page opened on; from then on it follows this page's clock.
  const stage = useReplayStage(replay, t, playing, speed, length, setT, setPlaying, setSpeed, (len, capEnd) => {
    setCaptureMs(len);
    setCaptureEnd(capEnd);
  }, avail ? avail - CONTROLS_PX : null, stageGen);
  const driven = stage.driven;

  // The capture ran past the stored length: the server reads the capture and keeps the longer length, so the list agrees.
  const checkLength = useMutation(api.replays.checkCaptureLength);
  const lengthAsked = useRef<string | null>(null);
  useWatchEffect(() => {
    // Also once for a copy whose reach is not stored, so the list can mark a recording the import cut short.
    const unstored = replay.provider !== "sdk" && replay.captured_ms == null && (captureMs > 0 || captureEnd > 0);
    if ((!unstored && Math.max(captureMs, captureEnd) <= (replay.duration_ms ?? 0) + 1000) || lengthAsked.current === replay._id) return;
    lengthAsked.current = replay._id;
    void Promise.resolve()
      .then(() => checkLength({ replay: replay._id }))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per replay, when the capture says it is longer
  }, [captureMs, captureEnd, replay._id, replay.duration_ms, replay.captured_ms]);

  // Without the page, playback advances on animation frames by real elapsed
  // time, times the speed. With it, the player is the clock and its time
  // posts move this one (useReplayStage).
  useWatchEffect(() => {
    if (!playing || driven) return;
    let last = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const dt = (now - last) * speed;
      last = now;
      setT((cur) => {
        const next = cur + dt;
        if (next >= end) {
          setPlaying(false);
          return end;
        }
        return next;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, end, driven]);

  /** Move to a time, paused unless `keepPlaying`: the scrubber, the rail and the keys all land here. */
  const seekTo = (to: number, keepPlaying = false) => {
    asked.current = null;
    if (cut !== null && to > cut + 1000) setPastCut(Math.min(length, to));
    else if (pastCut !== null) setPastCut(null);
    const next = Math.min(end, Math.max(0, to));
    if (!keepPlaying) setPlaying(false);
    setT(next);
    if (!keepPlaying) stage.send({ type: "pause" });
    stage.send({ type: "seek", t_ms: next, ...(keepPlaying && playing ? { play: true } : {}) });
  };
  /** Play from a time: what the issue controls outside the player press. */
  const playFrom = (to: number) => {
    const next = Math.min(end, Math.max(0, to));
    setT(next);
    setPlaying(true);
    stage.send({ type: "seek", t_ms: next, play: true });
  };
  if (seekRef) seekRef.current = playFrom;

  // A link to this same recording at another time (the address changes, the recording does not) moves the player there.
  // The address following the scrubber asks for where the player already is, so that echo moves nothing.
  const lastAsked = useRef(initialT);
  useWatchEffect(() => {
    if (initialT === lastAsked.current) return;
    lastAsked.current = initialT;
    if (initialT !== null && Math.abs(initialT - (pastCut ?? t)) > 1000) seekTo(initialT);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the address alone
  }, [initialT]);

  // Skip inactivity: while playing, an idle stretch is jumped to its end, on whichever clock runs.
  useWatchEffect(() => {
    if (!playing || !skip) return;
    const to = skipTarget(idle, t);
    // Idle to the end: nothing more happens, so playback ends there.
    if (to !== null) seekTo(to, to < end);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the clock alone
  }, [t, playing, skip, idle]);

  const togglePlay = () => {
    const from = t >= end - 50 ? 0 : t;
    if (from !== t) setT(from);
    setPastCut(null);
    const next = !playing || from !== t;
    setPlaying(next);
    if (from !== t) stage.send({ type: "seek", t_ms: from });
    stage.send({ type: next ? "play" : "pause" });
  };
  const pickSpeed = (s: Speed) => {
    setSpeed(s);
    stage.send({ type: "speed", speed: s });
  };
  const toggleSkip = () => {
    setSkip((v) => {
      try {
        localStorage.setItem(SKIP_KEY, v ? "0" : "1");
      } catch {}
      return !v;
    });
  };

  // The address follows the scrubber once it rests, so a copied URL opens here.
  useWatchEffect(() => {
    if (playing || typeof window === "undefined") return;
    const id = setTimeout(() => {
      // Waiting past the cut, the address keeps the time asked for, so a reload or a copied link still asks for it.
      const href = opsHref.replay(replay.short_id || replay._id, Math.round(pastCut ?? t));
      const target = new URL(href, window.location.origin);
      const cur = new URL(window.location.href);
      if (cur.searchParams.get("t") === target.searchParams.get("t")) return;
      cur.searchParams.set("t", target.searchParams.get("t") ?? "0");
      window.history.replaceState(window.history.state, "", `${cur.pathname}?${cur.searchParams.toString()}`);
    }, URL_SETTLE_MS);
    return () => clearTimeout(id);
  }, [t, pastCut, playing, replay.short_id, replay._id]);

  // Space plays and pauses; the arrows step between events, with Shift ten seconds; N and P walk
  // the failures, ] and [ what the person did; S toggles skipping, T theater, F fullscreen.
  const keys = useRef({ togglePlay, seekTo, t, toggleSkip, toggleTheater, toggleFullscreen });
  keys.current = { togglePlay, seekTo, t, toggleSkip, toggleTheater, toggleFullscreen };
  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target) || hasOpenModal()) return;
      const { togglePlay: toggle, seekTo: to, t: cur, toggleSkip: flip } = keys.current;
      const walk = (dir: 1 | -1, pick: (ev: ReplayEvent) => boolean) => {
        const hit = stepTo(events, cur, dir, pick);
        if (hit) to(hit.t);
      };
      if (e.key === " ") toggle();
      else if (e.key === "ArrowRight" && e.shiftKey) to(cur + 10_000);
      else if (e.key === "ArrowLeft" && e.shiftKey) to(cur - 10_000);
      else if (e.key === "ArrowRight") to(events.find((ev) => ev.t > cur + 1)?.t ?? end);
      else if (e.key === "ArrowLeft") to([...events].reverse().find((ev) => ev.t < cur - 1)?.t ?? 0);
      else if (e.key === "n") walk(1, isFailure);
      else if (e.key === "p") walk(-1, isFailure);
      else if (e.key === "]") walk(1, isUserAction);
      else if (e.key === "[") walk(-1, isUserAction);
      else if (e.key === "s") flip();
      else if (e.key === "t") keys.current.toggleTheater();
      else if (e.key === "f") keys.current.toggleFullscreen();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [events, end]);

  const railRef = useRef<HTMLDivElement>(null);
  const seek = (clientX: number) => {
    const r = railRef.current?.getBoundingClientRect();
    if (!r) return;
    seekTo(((clientX - r.left) / r.width) * length);
  };
  // On the focused scrubber, Page Up and Page Down move ten seconds, Home and End jump to the ends.
  const onScrubKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const to = e.key === "Home" ? 0 : e.key === "End" ? end : e.key === "PageUp" ? t - 10_000 : e.key === "PageDown" ? t + 10_000 : null;
    if (to === null) return;
    e.preventDefault();
    seekTo(to);
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    seek(e.clientX);
  };

  const pct = (ms: number) => `${(Math.min(length, Math.max(0, ms)) / length) * 100}%`;

  return (
    <div
      className="rp-main ops-player"
      ref={(el) => {
        mainRef.current = el;
        fit.ref(el);
      }}
      style={{ ...(fit.height ? { "--rp-fit": `${fit.height}px` } : {}), ...(railW ? { "--rp-rail-w": `${railW}px` } : {}) } as CSSProperties}
      data-rail-w={railW ? "true" : undefined}
      data-has-stage={stage.view ? "true" : "false"}
      data-sized={stage.box ? "true" : undefined}
      data-theater={theater ? "true" : undefined}
      data-fullscreen={fullscreen ? "true" : undefined}
    >
      <div className="rp-stagecol">
        <div className="rp-stagearea" ref={stage.areaRef} style={stage.box ? { height: stage.box.height + STAGE_PAD_PX } : undefined}>
          {stage.problem && (
            <div className="ops-stage-note rp-stage-note" role="status">
              <b>{stageProblemText(stage.problem)}</b>
              <span className="ops-dim">events still play</span>
              <span className="rp-stage-note-acts">
                {vendor && (
                  <a className="ops-btn" href={vendorUrlAt(vendor.href, t)} target="_blank" rel="noreferrer noopener">
                    Play at {formatReplayTime(t).replace(/\.\d$/, "")} in {vendor.name} <ExternalLink className="w-3 h-3" aria-hidden />
                  </a>
                )}
                <button type="button" className="ops-btn" onClick={stage.retry}>Try again</button>
              </span>
            </div>
          )}
          {pastCut !== null && cut !== null && (
            <div className="rp-past-cut" role="status">
              <span className="rp-past-cut-fact ops-num"><b>{formatReplayTime(pastCut).replace(/\.\d$/, "")}</b> not imported yet <span className="ops-dim">· {formatReplayTime(cut).replace(/\.\d$/, "")} of {formatReplayTime(length).replace(/\.\d$/, "")} imported</span></span>
              <RestStatus rest={rest} starting={starting} readRest={readRest} hold={hold} vendorName={vendor?.name ?? null} queued={queued} />
              {vendor && (
                <a className="ops-btn" data-tone="primary" href={vendorUrlAt(vendor.href, pastCut)} target="_blank" rel="noreferrer noopener">
                  Play at {formatReplayTime(pastCut).replace(/\.\d$/, "")} in {vendor.name} <ExternalLink className="w-3 h-3" aria-hidden />
                </a>
              )}
              <button type="button" className="rp-icon-btn" aria-label="Dismiss" onClick={() => setPastCut(null)}><X className="w-3.5 h-3.5" /></button>
            </div>
          )}
          {stage.view ?? <SemanticStage events={events} idx={idx} url={url} outline={outline?.outline ?? null} />}
        </div>
        <div className="rp-controls">
          <div ref={railRef} className="ops-scrub rp-scrub" onPointerDown={onPointerDown} onPointerMove={(e) => e.buttons === 1 && seek(e.clientX)} role="slider" tabIndex={0} onKeyDown={onScrubKey} aria-label="Position" aria-valuemin={0} aria-valuemax={length} aria-valuenow={Math.round(t)} aria-valuetext={`${formatReplayTime(t)} of ${formatReplayTime(length)}`}>
            <div className="rp-activity" aria-hidden>
              {bins.map((b, i) => (b > 0 ? <i key={i} style={{ left: `${(i / bins.length) * 100}%`, width: `${100 / bins.length}%`, height: `${Math.max(12, b * 100)}%` }} /> : null))}
            </div>
            {inBlocks(idle, RAIL_BLOCK).map((block, b) => (
              <Fragment key={`ib${b}`}>
                {block.map((r, k) => (
                  <span key={k} className="rp-idle" style={{ left: pct(r.from), width: `calc(${pct(r.to)} - ${pct(r.from)})` }} title={`Idle ${formatReplayTime(r.to - r.from).replace(/\.\d$/, "")}${skip ? ", skipped" : ""}`} />
                ))}
              </Fragment>
            ))}
            {/* In blocks, as the rail's rows are (RAIL_BLOCK): a long recording has thousands of ticks. */}
            {inBlocks(ticks, RAIL_BLOCK).map((block, b) => (
              <Fragment key={`tb${b}`}>
                {block.map((e, k) => (
                  <span key={k} className="ops-scrub-tick" data-kind={isFailure(e) ? "fail" : e.type} style={{ left: pct(e.t), background: inkOf(e) }} title={`${formatReplayTime(e.t)} ${wordOf(e)}: ${describeEvent(e)}`} />
                ))}
              </Fragment>
            ))}
            {rage.map((r, i) => (
              <span key={`rage${i}`} className="rp-rage-tick" style={{ left: pct(r.t) }} title={`${formatReplayTime(r.t)} rage click: ${r.clicks} clicks on ${r.label || selectorName(r.selector)}`} />
            ))}
            {issueMarks.map((m) => (
              <span key={`issue${m.short_id}`} className="rp-issue-tick" style={{ left: pct(m.t) }} title={`${formatReplayTime(m.t)} ${m.short_id}: ${m.title}`} />
            ))}
            {cut !== null && (
              <span className="rp-cut" data-state={starting ? "starting" : rest?.state ?? "none"} style={{ left: pct(cut), width: `calc(100% - ${pct(cut)})` }} title={`${formatReplayTime(cut).replace(/\.\d$/, "")} of ${formatReplayTime(length).replace(/\.\d$/, "")} imported · ${restLine(rest, hold, starting, vendor?.name ?? "the vendor", restNow, queued).text}`} />
            )}
            <div className="ops-scrub-rail" />
            <div className="ops-scrub-fill" style={{ width: pct(t) }} />
            <div className="ops-scrub-head" style={{ left: pct(t) }} />
          </div>
          <div className="ops-player-bar rp-bar">
            <button type="button" className="ops-btn rp-play" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
              {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
            </button>
            <span className="ops-mono ops-num text-[12px] whitespace-nowrap rp-clock">{formatReplayTime(t)} <span className="ops-dim">/ {formatReplayTime(length)}</span></span>
            <div className="ops-seg rp-speeds" role="group" aria-label="Speed">
              {SPEEDS.map((s) => (
                // Pressing the speed already on moves to the next one, so the control still works where only the current speed fits.
                <button key={s} type="button" data-on={s === speed ? "true" : undefined} aria-pressed={s === speed} onClick={() => pickSpeed(s === speed ? SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length] : s)}>{s}x</button>
              ))}
            </div>
            <button type="button" className="rp-toggle" aria-pressed={skip} data-on={skip ? "true" : undefined} onClick={toggleSkip} title="Jump over stretches where nothing happens">
              <FastForward className="w-3 h-3" aria-hidden /> <span className="rp-toggle-word">Skip idle</span>
            </button>
            <span className="ops-dim text-[11px] truncate ops-mono flex-1 min-w-0 rp-bar-path" title={url ?? undefined}>{url ? pathOf(url) : ""}</span>
            {stage.size && <span className="ops-dim text-[11px] ops-num whitespace-nowrap rp-viewport" title="The recorded window">{stage.size.width}×{stage.size.height}</span>}
            {stage.remoteAssets && (
              <button type="button" className="rp-icon-btn" aria-pressed={stage.remoteAssets.on} data-on={stage.remoteAssets.on ? "true" : undefined} onClick={stage.remoteAssets.toggle} aria-label={stage.remoteAssets.on ? "Stop loading the page's images" : "Load the page's images"} title={stage.remoteAssets.on ? "Images and fonts load from the sites the page names. Press to stop." : "Load images and fonts from the sites the page names (they see that you opened it)"}>
                {stage.remoteAssets.on ? <ImageIcon className="w-3.5 h-3.5" /> : <ImageOff className="w-3.5 h-3.5" />}
              </button>
            )}
            <ShareMoment replay={replay} t={t} />
            <button type="button" className="rp-icon-btn" aria-pressed={theater} data-on={theater ? "true" : undefined} onClick={toggleTheater} aria-label={theater ? "Show events" : "Hide events"} title={theater ? "Show events (T)" : "Hide events (T)"}>
              {theater ? <PanelRightOpen className="w-3.5 h-3.5" /> : <PanelRightClose className="w-3.5 h-3.5" />}
            </button>
            <button type="button" className="rp-icon-btn" aria-pressed={fullscreen} onClick={toggleFullscreen} aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"} title={fullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"}>
              {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          </div>
          <div className="rp-keys ops-dim" aria-hidden>
            <span><KeyCap size="xs">Space</KeyCap> play</span>
            <span><KeyCap size="xs">←</KeyCap><KeyCap size="xs">→</KeyCap> step</span>
            <span><KeyCap size="xs">N</KeyCap><KeyCap size="xs">P</KeyCap> failure</span>
            <span><KeyCap size="xs">[</KeyCap><KeyCap size="xs">]</KeyCap> action</span>
            <span><KeyCap size="xs">S</KeyCap> skip idle</span>
            <span><KeyCap size="xs">T</KeyCap> theater</span>
            <span><KeyCap size="xs">F</KeyCap> fullscreen</span>
          </div>
        </div>
      </div>
      {!theater && (reading ? (
        <aside className="rp-rail rp-rail-reading" aria-label="Events" aria-busy="true">
          <span className="rp-wait-bar" aria-hidden />
          <span className="ops-quiet">Reading events</span>
        </aside>
      ) : (
        <EventRail events={events} t={t} hasOutlines={hasOutlines} outline={outline} onSeek={(at) => seekTo(at)}>
          <div className="rp-rail-grip" role="separator" aria-orientation="vertical" aria-label="Resize events" title="Drag to resize; double-click for the default width" onPointerDown={onGripDown} onDoubleClick={resetRail} />
        </EventRail>
      ))}
    </div>
  );
}

/**
 * Where reading the rest of a cut copy stands (restLine: the same words as the
 * list row), with a meter while it reads and the press that reads it again,
 * offered only when the server will act on it (restDue) and nothing holds it.
 */
function RestStatus({ rest, starting, readRest, hold, vendorName, queued }: { rest: RestState | null; starting: boolean; readRest?: () => void; hold: RestHold | null; vendorName: string | null; queued?: RestQueued }) {
  const now = useCoarseNow(30_000);
  const line = restLine(rest, hold, starting, vendorName ?? "the vendor", now, queued);
  const press = readRest && !starting && !hold && (!rest || rest.state === "stopped");
  return (
    <span className="rp-rest ops-num" data-state={line.tone} role="status" title={line.title}>
      {line.tone === "busy" && line.share !== null && <span className="rp-rest-track" aria-hidden><span style={{ width: `${Math.round(line.share * 100)}%` }} /></span>}
      {!press || rest ? <span>{line.text}</span> : null}
      {press && <button type="button" className="ops-btn rp-rest-btn" onClick={readRest}>{rest ? "Read again" : "Import the rest"}</button>}
    </span>
  );
}

/** Without a page capture: where the person was and what just happened, large, on the same clock. */
function SemanticStage({ events, idx, url, outline }: { events: ReplayEvent[]; idx: number; url: string | null; outline: string | null }) {
  const cur = idx >= 0 ? events[idx] : undefined;
  return (
    <div className="rp-semantic">
      <div className="rp-semantic-url ops-mono" title={url ?? undefined}>{url ? pathOf(url) : "No page yet"}</div>
      {cur && (
        <div className="rp-semantic-ev" style={{ borderColor: inkOf(cur) }}>
          <span className="ops-mono ops-dim">{formatReplayTime(cur.t)}</span>
          <span className="ops-mono" style={{ color: inkOf(cur) }}>{wordOf(cur)}</span>
          <span className="rp-semantic-text">{describeEvent(cur)}</span>
        </div>
      )}
      {outline && <pre className="rp-semantic-outline">{outline}</pre>}
    </div>
  );
}

/** Share where the scrubber stands: a link that opens here, or a moment that plays in place when pasted in a message. */
function ShareMoment({ replay, t }: { replay: OpsReplay; t: number }) {
  const [open, setOpen] = useState(false);
  const ref = replay.short_id || replay._id;
  const at = Math.floor(t / 1000) * 1000;
  const copyLink = () => {
    const href = new URL(opsHref.replay(ref, at), window.location.origin).toString();
    void copyText(href, `Link at ${formatReplayTime(at).replace(/\.\d$/, "")} copied`);
    setOpen(false);
  };
  const copyMoment = () => {
    void copyText(momentRef(ref, at), "Moment copied");
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="ops-btn rp-share" aria-label="Share this moment">
          <Share2 className="w-3.5 h-3.5" /> <span className="ops-num">{formatReplayTime(at).replace(/\.\d$/, "")}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="rp-share-pop">
        <button type="button" onClick={copyLink}>
          <Link2 className="w-3.5 h-3.5" aria-hidden />
          <span>Copy link</span>
          <span className="ops-dim ops-num">at {formatReplayTime(at).replace(/\.\d$/, "")}</span>
        </button>
        <button type="button" onClick={copyMoment}>
          <Copy className="w-3.5 h-3.5" aria-hidden />
          <span>Copy moment</span>
          <span className="ops-dim ops-mono">{momentRef(ref, at)}</span>
        </button>
      </PopoverContent>
    </Popover>
  );
}

/** The events beside the page: a tab per kind with its count, a filter, and requests that open to their detail. */
function EventRail({ events, t, hasOutlines, outline, onSeek, children }: {
  /** The rail's resize grip. */
  children?: ReactNode;
  events: ReplayEvent[];
  t: number;
  hasOutlines: boolean;
  outline: { t: number; outline: string } | null | undefined;
  onSeek: (t: number) => void;
}) {
  const [tab, setTab] = useState<RailTab | "page">("all");
  const [q, setQ] = useState("");
  // Network's own filter: only the requests that failed (Errors lists exceptions and console errors).
  const [failedOnly, setFailedOnly] = useState(false);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  // Endpoints a person hid (a long-poll, a beacon): their requests that answered leave the rail; a failure always stays.
  const [muted, setMuted] = useState<ReadonlySet<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(MUTED_KEY) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const saveMuted = (next: Set<string>) => {
    setMuted(next);
    try {
      localStorage.setItem(MUTED_KEY, JSON.stringify([...next].slice(-200)));
    } catch {}
  };
  const mute = (endpoint: string) => saveMuted(new Set([...muted, endpoint]));
  // The kinds All leaves out, remembered across recordings: scrolls until a person turns them on.
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<AllKind>>(() => {
    try {
      const stored = localStorage.getItem(ALL_HIDDEN_KEY);
      // Only scrolls can be hidden from All (the one toggle beside its filter); every other kind always shows.
      if (stored !== null) return new Set((JSON.parse(stored) as string[]).filter((k): k is AllKind => (ALL_KINDS_HIDDEN_BY_DEFAULT as readonly string[]).includes(k)));
    } catch {}
    return new Set(ALL_KINDS_HIDDEN_BY_DEFAULT);
  });
  const toggleKind = (k: AllKind) => setHiddenKinds((cur) => {
    const next = new Set(cur);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    try {
      localStorage.setItem(ALL_HIDDEN_KEY, JSON.stringify([...next]));
    } catch {}
    return next;
  });
  const isMuted = (e: ReplayEvent) => e.type === "network" && muted.size > 0 && !isFailure(e) && muted.has(endpointOf(e));
  const hiddenHere = useMemo(() => (muted.size ? events.filter(isMuted).length : 0), [events, muted]); // eslint-disable-line react-hooks/exhaustive-deps -- isMuted reads muted
  const counts = useMemo(() => railCounts(muted.size ? events.filter((e) => !isMuted(e)) : events, hiddenKinds), [events, muted, hiddenKinds]); // eslint-disable-line react-hooks/exhaustive-deps -- isMuted reads muted
  const kindCounts = useMemo(() => allKindCounts(events), [events]);
  const failedCount = useMemo(() => events.filter(isFailedRequest).length, [events]);
  const rows = useMemo(() => (tab === "page" ? [] : events.map((e, i) => [e, i] as const).filter(([e]) => railAdmits(tab, e, hiddenKinds) && !(tab === "network" && failedOnly && !isFailedRequest(e)) && !isMuted(e) && eventHas(e, q.trim()))), [events, tab, q, muted, hiddenKinds, failedOnly]); // eslint-disable-line react-hooks/exhaustive-deps -- isMuted reads muted
  // Repeats of one request or console line fold into one row with a count, so a burst of failures does not bury the clicks around it.
  const runs = useMemo(() => foldRail(rows), [rows]);
  const [openRuns, setOpenRuns] = useState<ReadonlySet<number>>(() => new Set());
  const leadOf = useMemo(() => {
    const m = new Map<number, number>();
    for (const r of runs) if (!openRuns.has(r.lead[1])) for (const [, j] of r.members) m.set(j, r.lead[1]);
    return m;
  }, [runs, openRuns]);
  const toggleRun = (lead: number) => setOpenRuns((cur) => {
    const next = new Set(cur);
    if (next.has(lead)) next.delete(lead);
    else next.add(lead);
    return next;
  });
  const listRef = useRef<HTMLDivElement>(null);
  // The row the clock is at: the last one this tab and filter show at or before it (inside a folded run, its lead). The
  // clock's own event may be one the tab hides (a scroll in All, a click in Network), so it is never looked up directly.
  const cur = useMemo(() => railRowAt(rows, t, leadOf), [rows, t, leadOf]);
  // Keep the current row in view as the clock moves, and after a seek from the address. Only the
  // rail's own list scrolls: scrollIntoView would also scroll the page and clip its heading.
  useWatchEffect(() => {
    const list = listRef.current;
    const el = cur >= 0 ? list?.querySelector<HTMLElement>(`[data-ev="${cur}"]`) : null;
    if (!list || !el) return;
    const top = el.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + el.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + el.offsetHeight - list.clientHeight;
  }, [cur, tab]);

  return (
    <aside className="rp-rail" aria-label="Events" style={{ "--rp-time-w": `${Math.ceil(formatReplayTime(events[events.length - 1]?.t ?? 0).length * 6.7) + 2}px` } as CSSProperties}>
      {children}
      <label className="rp-rail-pick">
        <select value={tab} aria-label="Events to show" onChange={(e) => setTab(e.target.value as RailTab | "page")}>
          {RAIL_TABS.map((k) => (
            <option key={k} value={k} disabled={k !== "all" && counts[k] === 0}>{RAIL_LABEL[k]} · {counts[k].toLocaleString()}</option>
          ))}
          {hasOutlines && <option value="page">Text</option>}
        </select>
        {tab !== "errors" && counts.errors > 0 && <button type="button" className="ops-num" onClick={() => setTab("errors")} title="Show the errors">{plural(counts.errors, "error")}</button>}
      </label>
      <div className="rp-rail-tabs" role="tablist">
        {RAIL_TABS.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} data-on={tab === k ? "true" : undefined} data-tab={k} disabled={k !== "all" && counts[k] === 0} onClick={() => setTab(k)}>
            {RAIL_LABEL[k]} <span className="ops-num">{counts[k]}</span>
          </button>
        ))}
        {hasOutlines && (
          <button type="button" role="tab" aria-selected={tab === "page"} data-on={tab === "page" ? "true" : undefined} onClick={() => setTab("page")}>Text</button>
        )}
      </div>
      {tab === "page" ? (
        <div className="rp-rail-list">
          <div className="rp-outline-at ops-dim ops-num">{outline ? `As of ${formatReplayTime(outline.t)}` : "Before the first outline"}</div>
          <pre className="rp-outline">{outline?.outline ?? ""}</pre>
        </div>
      ) : (
        <>
          {/* One row: the tabs pick the type; the filter and the tab's one toggle (scrolls in All, failed only in Network) sit together under them. */}
          <div className="rp-rail-tools">
            <label className="rp-rail-filter">
              <Search className="w-3 h-3 ops-dim" aria-hidden />
              <input type="search" value={q} placeholder={`Filter ${RAIL_LABEL[tab].toLowerCase()}`} aria-label="Filter events" onChange={(e) => setQ(e.target.value)} />
              {q && <button type="button" aria-label="Clear filter" onClick={() => setQ("")}><X className="w-3 h-3" /></button>}
            </label>
            {tab === "all" && kindCounts.scrolls > 0 && ALL_KINDS_HIDDEN_BY_DEFAULT.map((k) => (
              <button key={k} type="button" className="rp-kind" data-kind={k} aria-pressed={!hiddenKinds.has(k)} onClick={() => toggleKind(k)}>
                {ALL_KIND_LABEL[k]} <span className="ops-num">{kindCounts[k]}</span>
              </button>
            ))}
            {tab === "network" && failedCount > 0 && (
              <button type="button" className="rp-kind" data-kind="requests" data-filter="true" aria-pressed={failedOnly} onClick={() => setFailedOnly((v) => !v)}>
                Failed only <span className="ops-num">{failedCount}</span>
              </button>
            )}
          </div>
          {hiddenHere > 0 && (
            <div className="rp-muted ops-dim">
              <EyeOff className="w-3 h-3" aria-hidden />
              <span className="ops-num">{plural(hiddenHere, "request")} hidden</span>
              <span className="truncate ops-mono" title={[...muted].join("\n")}>{[...muted].slice(0, 2).join(", ")}{muted.size > 2 ? ` +${muted.size - 2}` : ""}</span>
              <button type="button" onClick={() => saveMuted(new Set())}>Show</button>
            </div>
          )}
          <div className="rp-rail-list ops-events" ref={listRef}>
            {rows.length === 0 && <div className="rp-card-empty ops-dim">{q ? "Nothing matches" : "None"}</div>}
            {/* Rows in blocks of RAIL_BLOCK: React walks siblings recursively (Fast Refresh), and a long recording's thousands of rows in one chain overflow the stack. */}
            {inBlocks(runs, RAIL_BLOCK).map((block, b) => (
              <Fragment key={`b${b}`}>
                {block.map(({ lead: [e, i], members }) => {
                  const many = members.length > 1;
                  const expanded = many && openRuns.has(i);
                  return (
                    <Fragment key={i}>
                      <RailRow e={e} i={i} past={e.t <= t} current={i === cur} open={openIdx === i} onSeek={() => onSeek(e.t)} onToggle={() => setOpenIdx(openIdx === i ? null : i)} onMute={e.type === "network" && !isFailure(e) ? () => mute(endpointOf(e)) : undefined} run={many ? { count: members.length, open: expanded, toggle: () => toggleRun(i), until: members[members.length - 1][0].t, rage: e.type === "click" && rageBursts(members.map(([m]) => m)).length > 0 } : undefined} />
                      {expanded && members.slice(1).map(([m, j]) => (
                        <RailRow key={j} e={m} i={j} nested past={m.t <= t} current={j === cur} open={openIdx === j} onSeek={() => onSeek(m.t)} onToggle={() => setOpenIdx(openIdx === j ? null : j)} />
                      ))}
                    </Fragment>
                  );
                })}
              </Fragment>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}

const RAIL_BLOCK = 100;

function inBlocks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type RailRun = { count: number; open: boolean; toggle: () => void; until: number; rage?: boolean };

function RailRow({ e, i, past, current, open, onSeek, onToggle, onMute, run, nested }: { e: ReplayEvent; i: number; past: boolean; current: boolean; open: boolean; onSeek: () => void; onToggle: () => void; onMute?: () => void; run?: RailRun; nested?: boolean }) {
  const grade = e.type === "network" ? netGrade(e) : null;
  const text = describeEvent(e);
  const expandable = e.type === "network" || e.type === "click" || e.type === "input" || e.type === "submit" || (e.type === "error" && !!e.stack) || (e.type === "console" && e.message.length > 120);
  const word = wordOf(e);
  const label = `${formatReplayTime(e.t)} ${word}: ${text}${run ? `, ${run.count} times` : ""}`;
  return (
    <div className="rp-ev-wrap" data-open={open ? "true" : undefined} data-nested={nested ? "true" : undefined}>
      <div className="ops-ev rp-ev" data-ev={i} data-past={past ? "true" : "false"} data-current={current ? "true" : undefined} data-grade={grade ?? undefined} aria-label={label} {...pressable(onSeek)}>
        <span className="ops-mono ops-num ops-dim text-[11px]">{formatReplayTime(e.t)}</span>
        <span className="ops-mono text-[10.5px]" style={{ color: inkOf(e) }}>{word}</span>
        <span className="rp-ev-text">
          {e.type === "network" ? (
            <NetText method={e.method} url={e.url} failed={isFailure(e)} />
          ) : (
            <span className="truncate" title={text} style={{ color: isFailure(e) ? "var(--sol-red)" : undefined }}>{text}</span>
          )}
          {run && (
            <button type="button" className="rp-run" data-rage={run.rage ? "true" : undefined} aria-expanded={run.open} title={`${run.count} in a row, to ${formatReplayTime(run.until)}${run.rage ? " · rage click" : ""}`} onClick={(ev) => { ev.stopPropagation(); run.toggle(); }}>
              ×{run.count}
            </button>
          )}
          {onMute && e.type === "network" && (
            <button type="button" className="rp-mute" aria-label={`Hide ${endpointOf(e)}`} title={`Hide ${endpointOf(e)} on every recording (its failures stay)`} onClick={(ev) => { ev.stopPropagation(); onMute(); }}>
              <EyeOff className="w-3 h-3" />
            </button>
          )}
        </span>
        {e.type === "network" ? (
          <span className="rp-net ops-num ops-mono">
            <span data-grade={grade} title={e.status ? undefined : "No response (blocked, offline or CORS)"}>{e.status || "ERR"}</span>
            <span className="ops-dim rp-net-ms">{e.ms >= 1000 ? `${(e.ms / 1000).toFixed(1)}s` : `${Math.round(e.ms)}ms`}</span>
          </span>
        ) : (
          <span />
        )}
        {expandable ? (
          <button type="button" className="rp-ev-more" aria-label={open ? "Hide detail" : "Show detail"} aria-expanded={open} onClick={(ev) => { ev.stopPropagation(); onToggle(); }}>
            <ChevronDown className="w-3 h-3" style={{ transform: open ? "rotate(180deg)" : undefined }} />
          </button>
        ) : (
          <span />
        )}
      </div>
      {open && <EventDetail e={e} />}
    </div>
  );
}

/** A request in the rail: its path's start gives way, its last segment always shows. */
function NetText({ method, url, failed }: { method: string; url: string; failed: boolean }) {
  const { head, tail } = netParts(method, url);
  return (
    <span className="rp-net-path" title={`${method} ${url}`} style={{ color: failed ? "var(--sol-red)" : undefined }}>
      <span className="rp-net-method">{method}</span>
      {head && <span className="rp-net-head">{head}</span>}
      <span className="rp-net-tail">{tail}</span>
    </span>
  );
}

/** A request's whole address, host included, without the query keys that carry nothing. */
function fullNetUrl(url: string): string {
  try {
    return `${new URL(url).origin}${netPath(url)}`;
  } catch {
    return url;
  }
}

function EventDetail({ e }: { e: ReplayEvent }) {
  if (e.type === "network") {
    const grade = netGrade(e);
    return (
      <dl className="rp-ev-detail">
        <dt>Request</dt><dd className="ops-mono" title={e.url}>{e.method} <span className="rp-break">{fullNetUrl(e.url)}</span></dd>
        <dt>Status</dt><dd className="ops-mono" data-grade={grade}>{e.status ? e.status : "no response (blocked, offline or CORS)"}</dd>
        <dt>Time</dt><dd className="ops-num">{Math.round(e.ms).toLocaleString()} ms{grade === "slow" ? " · slow" : ""}</dd>
        <dt>At</dt><dd className="ops-num">{formatReplayTime(e.t)}</dd>
      </dl>
    );
  }
  const facts = actionDetail(e);
  if (facts.length) {
    return (
      <dl className="rp-ev-detail">
        {facts.map((f) => (
          <Fragment key={f.term}>
            <dt>{f.term}</dt>
            <dd className={f.mono ? "ops-mono rp-break" : "rp-break"}>{f.value}</dd>
          </Fragment>
        ))}
      </dl>
    );
  }
  const body = e.type === "error" ? `${e.message}${e.stack ? `\n${e.stack}` : ""}` : e.type === "console" ? e.message : describeEvent(e);
  return <pre className="rp-ev-detail rp-ev-pre">{body}</pre>;
}

const NO_SIZE = { width: 16, height: 10, below: 0 };

/** How long after a seek a stale time post is ignored, and how far from the asked time the player's own echo may land. */
const SEEK_SETTLE_MS = 300;
const SEEK_ECHO_SLACK_MS = 50;
/** How close to a stretch's end playback opens the next one. */
const STRETCH_LEAD_MS = 400;

/** The largest box of a page's shape that fits the area: the recorded page fills the space without spilling past the controls. */
function fitBox(area: { width: number; height: number } | null, page: { width: number; height: number }): { width: number; height: number } | null {
  if (!area || area.width <= 0 || area.height <= 0) return null;
  const scale = Math.min(area.width / page.width, area.height / page.height);
  return { width: Math.max(1, Math.floor(page.width * scale)), height: Math.max(1, Math.floor(page.height * scale)) };
}

/**
 * The recorded page, when the replay kept its capture: the isolated player
 * with its own bar hidden, opened at the time the page opened on. Until it
 * says ready the page keeps its own clock; once it does, it is told where
 * this page stands (time, playing, speed), and from then on its time posts
 * are the clock. If it cannot play (an expired capture, a capture with
 * nothing to draw), it says why in one line and the semantic view goes on as
 * it would without a capture.
 */
function useReplayStage(
  replay: OpsReplay,
  t: number,
  playing: boolean,
  speed: number,
  length: number,
  setT: (t: number) => void,
  setPlaying: (p: boolean) => void,
  setSpeed: (s: Speed) => void,
  /** The player's clock length and where its capture ends (0 when it cannot say; captureEndFrom). */
  setCaptureMs: (lengthMs: number, captureEndMs: number) => void,
  /** The tallest the stage may be (the window less the controls); null until measured. */
  maxStageH: number | null = null,
  /** Raised to open the stage again on a capture that grew (a long recording's rest landed); it opens where the clock stands. */
  gen = 0,
) {
  const hasDom = (replay.dom_chunks ?? 0) > 0;
  const [openedAt] = useState(t);
  // A long capture plays a stretch at a time (replayDomWindow): leaving the stretch, by playing past it or seeking out of it, opens the player again there.
  // A new link opens where the clock stands; once ready it is told whether to play (the ready handler below).
  const [hop, setHop] = useState({ n: 0, t: 0 });
  const link = useReplayPlayerLink(hasDom ? replay._id : null, hasDom, { t_ms: gen > 0 || hop.n > 0 ? t : openedAt, controls: false }, gen + hop.n);
  const win = link.state === "ready" ? link.window : null;
  const [size, setSize] = useState<{ width: number; height: number; below: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The page's images and fonts on other sites: the player draws an opt-in strip under the page for them, which the stage
  // clips (the frame runs past the stage's bottom by its height); the bar's image chip asks for them instead, on this view only.
  const [remoteAssets, setRemoteAssets] = useState<{ offered: boolean; on: boolean }>({ offered: false, on: false });
  const frameUrl = link.state === "ready" ? (remoteAssets.on ? withRemoteAssets(link.url) : link.url) : null;
  const [area, setArea] = useState<{ width: number; height: number } | null>(null);
  const areaObserver = useRef<ResizeObserver | null>(null);
  const areaRef = (el: HTMLDivElement | null) => {
    areaObserver.current?.disconnect();
    areaObserver.current = null;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setArea((prev) => (prev && Math.abs(prev.width - r.width) < 1 && Math.abs(prev.height - r.height) < 1 ? prev : { width: r.width, height: r.height }));
    });
    ro.observe(el);
    areaObserver.current = ro;
  };
  const here = useRef({ t, playing, speed });
  here.current = { t, playing, speed };
  const hopping = useRef<number | null>(null);
  // A new stretch is loading: the stage says so until its player is ready, rather than showing a blank page.
  const [reloading, setReloading] = useState(false);
  const hopTo = (to: number) => {
    if (hopping.current !== null && Math.abs(hopping.current - to) < 1000) return;
    hopping.current = to;
    setReloading(true);
    setT(Math.min(length, Math.max(0, to)));
    setHop((h) => ({ n: h.n + 1, t: Math.max(0, Math.round(to)) }));
  };
  /** Playing into the stretch's end: open the next one where it ends, still playing. */
  const atStretchEnd = (at: number, isPlaying: boolean) => {
    if (!win || win.end_ms === null || !isPlaying || at < win.end_ms - STRETCH_LEAD_MS) return false;
    hopTo(win.end_ms);
    return true;
  };
  // A time post the player queued before this page's seek can land after it
  // and pull the scrubber back for a beat. For a moment after a seek only the
  // player's echo of the seek itself (at the asked time) is followed.
  const lastSeek = useRef<{ t_ms: number; at: number } | null>(null);
  const channel = useReplayPlayerChannel(link.state === "ready" ? link.origin : null, (msg: ReplayPlayerMessage) => {
    if (msg.type === "ready") {
      setSize({ width: msg.width, height: msg.height, below: msg.below_px ?? 0 });
      if ((msg.below_px ?? 0) > 0 && !remoteAssets.offered) setRemoteAssets((r) => ({ ...r, offered: true }));
      // A stretch ends where its chunks do, not where the capture does: only a whole capture says where the import stopped.
      if (msg.duration_ms > 0) setCaptureMs(msg.duration_ms, win && win.end_ms !== null ? 0 : captureEndFrom(msg, replay.duration_ms));
      setError(null);
      hopping.current = null;
      setReloading(false);
      const cur = here.current;
      // The person moved out of this stretch while it loaded.
      if (!replayWindowHolds(win, cur.t) && Math.abs(cur.t - hop.t) > 2000) return hopTo(cur.t);
      if (cur.speed !== 1) channel.send({ type: "speed", speed: cur.speed });
      channel.send({ type: "seek", t_ms: cur.t, ...(cur.playing ? { play: true } : {}) });
    } else if (msg.type === "size") {
      setSize((prev) => (prev ? { ...prev, width: msg.width, height: msg.height } : prev));
    } else if (msg.type === "time") {
      const sought = lastSeek.current;
      if (sought && Date.now() - sought.at < SEEK_SETTLE_MS && Math.abs(msg.t_ms - sought.t_ms) > SEEK_ECHO_SLACK_MS) return;
      setT(Math.min(length, Math.max(0, msg.t_ms)));
      if (atStretchEnd(msg.t_ms, msg.playing || here.current.playing)) return;
      setPlaying(msg.playing);
    } else if (msg.type === "state") {
      // The stretch's player stops at its last event; the recording goes on in the next stretch.
      if (!msg.playing && atStretchEnd(here.current.t, here.current.playing)) return;
      setPlaying(msg.playing);
      if ((SPEEDS as readonly number[]).includes(msg.speed)) setSpeed(msg.speed as Speed);
    } else if (msg.type === "error") {
      setError(msg.message);
    }
  });
  const driven = link.state === "ready" && size !== null && error === null && !reloading;
  const send = (cmd: Parameters<typeof channel.send>[0]) => {
    if (!driven) return;
    if (cmd.type === "seek" && !replayWindowHolds(win, cmd.t_ms)) return hopTo(cmd.t_ms);
    if (cmd.type === "seek") lastSeek.current = { t_ms: cmd.t_ms, at: Date.now() };
    channel.send(cmd);
  };
  // The stage takes the area's whole width and only the height the page's shape needs, up to what
  // the window leaves; the area then shrinks to it, so a wide capture has no empty band above and below.
  const box = fitBox(area && maxStageH ? { width: area.width, height: Math.max(160, maxStageH - STAGE_PAD_PX) } : area, size ?? NO_SIZE);

  const problem = link.state === "failed" ? link.error : error;
  /** Load the page's remote images and fonts, or stop: the frame reloads where the clock stands (its ready handler seeks there). */
  const toggleRemoteAssets = () => {
    setReloading(true);
    setRemoteAssets((r) => ({ ...r, on: !r.on }));
  };
  /** Open the player again where the clock stands (a lapsed link, a load that failed). */
  const retry = () => {
    setError(null);
    hopping.current = null;
    setReloading(true);
    setHop((h) => ({ n: h.n + 1, t: here.current.t }));
  };
  let view: ReactNode = null;
  if (!problem && (link.state === "opening" || link.state === "ready")) {
    // The box keeps the page's shape inside the area; whatever the player
    // draws below the page (its remote-assets strip) runs past the box's bottom and is clipped.
    view = (
      <div className="ops-stage rp-stage" style={{ overflow: "hidden", ...(box ? { width: box.width, height: box.height } : { width: "100%", aspectRatio: `${(size ?? NO_SIZE).width} / ${(size ?? NO_SIZE).height}` }) }}>
        {frameUrl && (
          <ReplayPlayerIframe frameRef={channel.frameRef} url={frameUrl} title={`The page recorded in ${replay.short_id}`} style={{ position: "absolute", left: 0, top: 0, width: "100%", height: `calc(100% + ${size?.below ?? 0}px)`, opacity: size && !reloading ? 1 : 0 }} />
        )}
        {(!size || link.state === "opening" || reloading) && <div className="ops-stage-wait ops-quiet">{hop.n > 0 ? `Loading from ${formatReplayTime(hop.t).replace(/\.\d$/, "")}…` : "Loading the page capture…"}</div>}
      </div>
    );
  }
  return { driven, send, view: problem ? null : view, problem, retry, size: size ? { width: size.width, height: size.height } : null, areaRef, box: !problem && view && maxStageH ? box : null, remoteAssets: remoteAssets.offered ? { on: remoteAssets.on, toggle: toggleRemoteAssets } : null };
}
