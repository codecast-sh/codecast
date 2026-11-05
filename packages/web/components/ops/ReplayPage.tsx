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
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { needsVendorImport, type ReplayEvent } from "@codecast/shared/contracts/replay";
import { ExternalLink, Play } from "lucide-react";
import { activeMsOf, formatReplayTime, isAnonymous, personKey, personLabel, routeOf } from "@codecast/shared/replay";
import { detailGone, useOpsReplay, useOpsReplayTimeline, useOpsSources, useSyncOpsReplay } from "../../hooks/useSyncOps";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { relTimeShort } from "../../lib/utils";
import { OpsFeedError, ProviderIcon } from "./parts";
import { OpsNotFound } from "./OpsShellParts";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { EnvMarks, PersonMark, ReplayFigures } from "./replayParts";
import { importedUntil, plural, replayLengthText, replayPagePath, restHold, restQueued, restState, vendorUrlAt } from "./replayModel";
import { issueMoments } from "./replayRail";
import { useLinkedIssues, useReplayEvents, useVendorImport, VENDOR_NAME, vendorUrl } from "./replayPageData";
import { HeaderIssue, IssuesAndFixes, MiddlePath, PersonRecordings, ReplayActions } from "./ReplayIssues";
import { personListHref, startTime } from "./replayPlayerModel";
import { Player } from "./ReplayPlayer";
import { RestStatus } from "./ReplayPlayerParts";
import "./replays.css";

const NO_EVENTS: ReplayEvent[] = [];
/** How long "Opening rp-N" waits on the server before the page says the recording is not in the lists it holds (still checking). */
const OPEN_PATIENCE_MS = 4_000;

export function ReplayPage({ id, t: asked, tAlt }: { id: string; t: number | null; tAlt?: number }) {
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
  // ?t is seconds; a link written before that carried ms, which reads as a time past the recording's end: that one opens where it meant.
  const t = startTime(asked, tAlt, replay?.duration_ms ?? null);
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
  const rest = restState(replay, now, source?.replay_rest?.reading);
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
        <Player replay={replay} events={events ?? NO_EVENTS} reading={early} initialT={t} issueMarks={issueMarks} seekRef={seekRef} vendor={external ? { href: external, name: VENDOR_NAME[replay.provider] ?? replay.provider } : null} readRest={vendorImport.again} starting={vendorImport.state === "importing"} hold={vendorImport.declined ?? restHold(replay, now)} queued={queued} restReading={source?.replay_rest?.reading ?? null} />
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

