// The bulk import of a PostHog or Sentry source's recordings (external-data.md
// X5, convex sources/replayBackfill.ts), as one row: the source, a bar of how
// far it got, its counts, its state and the control that moves it. The source
// card on Settings, Integrations and the Ops Replays tab both render it; the
// progress is the source row's `replay_backfill`, which every page of the
// import writes. On the Replays tab a finished import can be put away; the
// next run brings it back.
import { useState } from "react";
import { ChevronDown, ExternalLink, Loader2, RotateCw, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { useInboxStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import {
  DEFAULT_REPLAY_BACKFILL_WINDOW,
  REPLAY_BACKFILL_WINDOWS,
  replayBackfillState,
  type ReplayBackfill,
  type ReplayBackfillWindow,
} from "@codecast/shared/contracts/replay";
import { formatRelative, relTimeShort } from "../../lib/utils";
import Link from "next/link";
import { opsHref } from "./opsPaths";
import { ProviderIcon } from "./parts";
import type { OpsSource } from "./opsTypes";
import { etaText, failureReasons, pathOf, restTrend, vendorRecordingUrl } from "./replayModel";
import { anonHandle, formatReplayTime } from "@codecast/shared/replay";
import "./replays.css";

const WINDOW_LABEL: Record<ReplayBackfillWindow, string> = { "7d": "7 days", "30d": "30 days", "90d": "90 days", all: "All" };
const STATE_LABEL = { running: "Importing", done: "Imported", paused: "Paused", error: "Stopped", stalled: "Stalled" } as const;
const STATE_COLOR = { running: "var(--sol-blue)", done: "var(--sol-green)", paused: "var(--sol-yellow)", error: "var(--sol-red)", stalled: "var(--sol-orange)" } as const;

/** Sources whose recordings can be imported in bulk. */
export const hasVendorRecordings = (s: Pick<OpsSource, "provider" | "short_id">) => (s.provider === "posthog" || s.provider === "sentry") && !!s.short_id;

const DISMISSED_KEY = "ops.replayImport.dismissed";

/** A finished import put away on the Replays tab, by source and run, so the next run shows again. */
function dismissedRuns(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

export function isImportDismissed(source: Pick<OpsSource, "_id" | "replay_backfill">): boolean {
  const b = source.replay_backfill;
  return !!b && b.status === "done" && dismissedRuns()[source._id] === b.started_at;
}

/** Where a run stands as bar segments, each a share of what was listed. */
export function importBar(b: Pick<ReplayBackfill, "listed" | "imported" | "skipped" | "failed">): { imported: number; skipped: number; failed: number } {
  const of = Math.max(1, b.listed, b.imported + b.skipped + b.failed);
  return { imported: b.imported / of, skipped: b.skipped / of, failed: b.failed / of };
}

/** The failed count as a control: the recordings the vendor did not hand over, by id and reason, and (once the run is done) a new run, which skips what is already here and so tries only them and anything new. */
function FailedImports({ backfill: b, retry, source }: { backfill: ReplayBackfill; retry: (() => void) | null; source: OpsSource }) {
  const [open, setOpen] = useState(false);
  const kept = b.failures ?? [];
  const reasons = failureReasons([...kept].reverse());
  const vendor = source.provider === "posthog" ? "PostHog" : source.provider === "sentry" ? "Sentry" : null;
  const now = useCoarseNow(60_000);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="rp-import-failed rp-cell ops-num" aria-label={`${b.failed.toLocaleString()} recordings failed to import`}>
          <b>{b.failed.toLocaleString()}</b><small>failed</small>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="rp-failed-pop">
        <div className="rp-failed-head">
          <span className="ops-num"><b>{b.failed.toLocaleString()}</b> {b.failed === 1 ? "recording" : "recordings"} not imported</span>
          {retry && (
            <button type="button" className="ops-btn" onClick={() => { setOpen(false); retry(); }}>
              <RotateCw className="w-3 h-3" aria-hidden /> Retry
            </button>
          )}
        </div>
        {kept.length > 0 ? (
          reasons.map((r) => (
            <div key={r.plain} className="rp-failed-group">
              <div className="rp-failed-why">{r.plain}{reasons.length > 1 && <span className="ops-dim ops-num"> · {r.items.length}</span>}</div>
              <ul className="rp-failed-list">
                {r.items.map((f) => {
                  const href = vendorRecordingUrl(source.provider, f.id, source);
                  const who = f.person ? (f.person.includes("@") ? f.person : anonHandle(f.person)) : null;
                  return (
                    <li key={f.id} title={f.id}>
                      <span className="rp-failed-rec">
                        <b className="truncate">{who ?? <span className="ops-mono">{f.id.slice(0, 13)}…</span>}</b>
                        <span className="ops-dim ops-num truncate">
                          {[f.url ? pathOf(f.url) : null, f.length_ms ? formatReplayTime(f.length_ms) : null, f.at ? formatRelative(f.at, now) : null].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                      {href && vendor && (
                        <a className="rp-failed-open" href={href} target="_blank" rel="noreferrer noopener">
                          {vendor} <ExternalLink className="w-3 h-3" aria-hidden />
                        </a>
                      )}
                    </li>
                  );
                })}
              </ul>
              {r.error !== r.plain && (
                <details className="rp-failed-raw">
                  <summary>Details</summary>
                  <pre className="ops-mono">{r.error}</pre>
                </details>
              )}
            </div>
          ))
        ) : b.last_error ? (
          <div className="rp-failed-list"><span className="rp-failed-why" title={b.last_error}>{b.last_error}</span></div>
        ) : null}
        {b.failed > kept.length && kept.length > 0 && <div className="rp-failed-more ops-dim ops-num">Newest {kept.length} of {b.failed.toLocaleString()}</div>}
      </PopoverContent>
    </Popover>
  );
}

/** How long a backlog takes to clear, as a glance reads it: 40m, 6h, 3d. */

/**
 * Long recordings whose copies hold only their start, how that count moved,
 * and the one whose rest is being read now (sources/replayRest.ts reads them
 * one at a time, issue recordings first, inside PostHog's rate limit). The
 * count opens the same set in the list, every one however short, so the list
 * header prints the same number. Null when none are cut.
 */
function RestTally({ source, now }: { source: OpsSource; now: number }) {
  const r = source.replay_rest;
  if (!r || r.cut === 0) return null;
  const waiting = r.waiting_until && r.waiting_until > now;
  const trend = restTrend(r, now);
  return (
    <span className="rp-rest-tally">
      <Link className="rp-rest-tally-n rp-cell" href={`${opsHref.tab("replays", { source: source.name })}&has=partial&active=any`} data-ops-partial-replays>
        <b>{r.cut.toLocaleString()}</b>
        <small>partly imported</small>
      </Link>
      {/* How the backlog moves, in its own cell with its unit: when it clears at the rate it falls, or that it grows. */}
      {trend && trend.tone !== "flat" && (
        <span className="rp-cell" data-ops-rest-trend title={`${(r.prev!.cut).toLocaleString()} at ${new Date(r.prev!.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`}>
          <b className="rp-rest-trend" data-tone={trend.tone}>{trend.eta_ms ? `~${etaText(trend.eta_ms)}` : trend.text}</b>
          <small>{trend.eta_ms ? `to clear · ${trend.text.replace(/^[−+]/, "")}` : "backlog growing"}</small>
        </span>
      )}
      {r.reading ? (
        <span className="rp-cell" title={waiting ? `PostHog rate limit until ${new Date(r.waiting_until!).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : undefined}>
          <b><Link className="ops-mono" href={opsHref.replay(r.reading)}>{r.reading}</Link></b>
          <small>{waiting ? `waiting until ${new Date(r.waiting_until!).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : "reading"}</small>
        </span>
      ) : (
        <span className="rp-cell"><b>≤15m</b><small>next read</small></span>
      )}
      {trend?.eta_ms !== undefined && (
        <span className="rp-cell" title={`At ${trend.text.replace("−", "")} the ${r.cut.toLocaleString()} cut copies are read whole in about this long; today's short recordings go first`}>
          <b className="ops-num">~{etaText(trend.eta_ms)}</b><small>to clear</small>
        </span>
      )}
    </span>
  );
}

export function ReplayImportLine({ source, showName = false, dismissible = false }: { source: OpsSource; showName?: boolean; dismissible?: boolean }) {
  const now = useCoarseNow(15_000);
  const b = source.replay_backfill;
  const [window, setWindow] = useState<ReplayBackfillWindow>(b?.window ?? DEFAULT_REPLAY_BACKFILL_WINDOW);
  const [, redraw] = useState(0);
  const [againOpen, setAgainOpen] = useState(false);
  const store = () => useInboxStore.getState();
  const state = b ? replayBackfillState(b, now) : null;
  const inactive = source.status !== "active";
  const rest = <RestTally source={source} now={now} />;
  if (dismissible && isImportDismissed(source)) {
    return (source.replay_rest?.cut ?? 0) > 0 ? (
      <div className="rp-import rp-import-done" data-ops-replay-import={source.name} data-state="rest">
        {showName && (
          <span className="rp-import-name">
            <ProviderIcon provider={source.provider} className="w-3.5 h-3.5" />
            <span className="truncate">{source.name}</span>
          </span>
        )}
        <span className="rp-import-nums ops-num">{rest}</span>
      </div>
    ) : null;
  }
  const bar = b ? importBar(b) : null;
  const dismiss = () => {
    if (!b) return;
    localStorage.setItem(DISMISSED_KEY, JSON.stringify({ ...dismissedRuns(), [source._id]: b.started_at }));
    redraw((n) => n + 1);
  };

  const windowPicker = (
    <div className="ops-seg" role="radiogroup" aria-label="How far back">
      {REPLAY_BACKFILL_WINDOWS.map((w) => (
        <button key={w} type="button" role="radio" aria-checked={window === w} data-on={window === w ? "true" : undefined} onClick={() => setWindow(w)}>
          {WINDOW_LABEL[w]}
        </button>
      ))}
    </div>
  );

  // On the Replays tab a finished run is one line: when, what failed, and Import again with its range behind it.
  if (dismissible && b && state === "done") {
    return (
      <div className="rp-import rp-import-done" data-ops-replay-import={source.name} data-state={state}>
        {showName && (
          <span className="rp-import-name">
            <ProviderIcon provider={source.provider} className="w-3.5 h-3.5" />
            <span className="truncate">{source.name}</span>
          </span>
        )}
        <span className="rp-import-nums ops-num">
          <span className="rp-import-done-state" style={{ color: STATE_COLOR.done }} title={b.finished_at ? `Imported ${formatRelative(b.finished_at, now)}` : undefined}>Imported</span>
          {b.finished_at && <span className="ops-dim rp-import-when">{formatRelative(b.finished_at, now)}</span>}
          {b.imported > 0 && <span className="rp-cell rp-import-new" title="Imported by this run"><b>{b.imported.toLocaleString()}</b><small>new</small></span>}
          {b.failed > 0 && <FailedImports backfill={b} source={source} retry={inactive ? null : () => store().startOpsReplayImport(source._id, b.window)} />}
          {rest}
        </span>
        <span className="rp-import-acts">
          <Popover open={againOpen} onOpenChange={setAgainOpen}>
            <PopoverTrigger asChild>
              <button type="button" className="ops-btn rp-again-btn" disabled={inactive} title={inactive ? "Resume the source first" : "Import again"} aria-label="Import again">
                <RotateCw className="w-3 h-3 rp-again-icon" aria-hidden />
                <span className="rp-again-label">Import again</span>
                <ChevronDown className="w-3 h-3 rp-again-label" aria-hidden />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="rp-again-pop">
              {windowPicker}
              <button type="button" className="ops-btn" data-tone="primary" onClick={() => { setAgainOpen(false); store().startOpsReplayImport(source._id, window); }}>
                Import {window === "all" ? "everything kept" : `the last ${WINDOW_LABEL[window]}`}
              </button>
            </PopoverContent>
          </Popover>
          <button type="button" className="rp-icon-btn" aria-label={`Hide the finished import of ${source.name}`} onClick={dismiss}>
            <X className="w-3.5 h-3.5" />
          </button>
        </span>
      </div>
    );
  }

  return (
    <div className="rp-import" data-ops-replay-import={source.name} data-state={state ?? "none"}>
      {showName && (
        <span className="rp-import-name">
          <ProviderIcon provider={source.provider} className="w-3.5 h-3.5" />
          <span className="truncate">{source.name}</span>
        </span>
      )}
      {b && state && bar ? (
        <>
          <span className="rp-import-state" style={{ color: STATE_COLOR[state] }}>{STATE_LABEL[state]}</span>
          <span className="rp-import-bar" role="progressbar" aria-label="Import progress" aria-valuemin={0} aria-valuemax={b.listed} aria-valuenow={b.imported + b.skipped + b.failed}>
            <i style={{ width: `${bar.imported * 100}%`, background: STATE_COLOR[state === "error" ? "done" : state] }} />
            <i style={{ width: `${bar.skipped * 100}%`, background: "color-mix(in srgb, var(--sol-text-muted) 45%, transparent)" }} />
            <i style={{ width: `${bar.failed * 100}%`, background: "var(--sol-red)" }} />
          </span>
          <span className="rp-import-nums ops-num">
            {state === "running" && b.listed + b.imported + b.skipped + b.failed === 0 ? (
              // The first page is still being listed: nothing to count yet, so the line says what it is waiting on.
              <span className="rp-import-listing" role="status"><Loader2 className="w-3 h-3 animate-spin" aria-hidden />listing {source.provider === "sentry" ? "Sentry" : "PostHog"}…</span>
            ) : (
              <>
                <span className="rp-cell" title="Imported by this run"><b>{b.imported.toLocaleString()}</b><small>new</small></span>
                {b.skipped > 0 && <span className="rp-cell" title="Already here when the import reached them"><b>{b.skipped.toLocaleString()}</b><small>already here</small></span>}
                {b.failed > 0 && <FailedImports backfill={b} source={source} retry={state !== "done" || inactive ? null : () => store().startOpsReplayImport(source._id, b.window)} />}
              </>
            )}
            <span className="rp-cell">{b.listed > 0 ? <b>{b.listed.toLocaleString()}</b> : <b>{b.window === "all" ? "all" : b.window}</b>}<small>{b.listed > 0 ? `listed, ${b.window === "all" ? "everything kept" : `last ${b.window}`}` : "window"}</small></span>
            {/* A 429 is a state, not a sentence: a chip, and how long it has waited (the import stops on its own past the cap). */}
            {state === "running" && b.rate_limited_since !== undefined ? (
              <span className="rp-cell" title={b.last_error}><span className="rp-import-chip" data-tone="warn" data-ops-rate-limited>Rate limited</span><small>{relTimeShort(b.rate_limited_since, now) === "now" ? "just now" : `${relTimeShort(b.rate_limited_since, now)} waiting`}</small></span>
            ) : state === "running" && b.last_error ? <span className="ops-dim truncate" title={b.last_error}>{b.last_error}</span> : null}
            {state === "stalled" && <span className="rp-cell"><b>{relTimeShort(b.updated_at, now)}</b><small>no progress</small></span>}
            {(state === "paused" || state === "error") && b.last_error && <span className="rp-import-err truncate" title={b.last_error}>{b.last_error}</span>}
            {state === "done" && b.finished_at && <span className="rp-cell" title={new Date(b.finished_at).toLocaleString()}><b>{relTimeShort(b.finished_at, now) === "now" ? "now" : `${relTimeShort(b.finished_at, now)} ago`}</b><small>finished</small></span>}
            {rest}
          </span>
        </>
      ) : (
        <span className="rp-import-state ops-quiet">Not imported</span>
      )}
      <span className="rp-import-acts">
        {state === "running" ? (
          <button type="button" className="ops-btn" onClick={() => store().stopOpsReplayImport(source._id)}>
            Stop
          </button>
        ) : state === "paused" || state === "error" || state === "stalled" ? (
          <button type="button" className="ops-btn" disabled={inactive} title={inactive ? "Resume the source first" : undefined} onClick={() => store().startOpsReplayImport(source._id)}>
            Resume
          </button>
        ) : (
          <>
            {windowPicker}
            <button type="button" className="ops-btn" disabled={inactive} title={inactive ? "Resume the source first" : undefined} onClick={() => store().startOpsReplayImport(source._id, window)}>
              {state === "done" ? "Import again" : "Import recordings"}
            </button>
          </>
        )}
        {dismissible && state === "done" && (
          <button type="button" className="rp-icon-btn" aria-label={`Hide the finished import of ${source.name}`} onClick={dismiss}>
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </span>
    </div>
  );
}
