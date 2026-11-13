// The replay player's smaller parts: the rest-of-recording status, the
// semantic stage, Share, and the events rail with its rows and details.
import Link from "next/link";
import { type CSSProperties, Fragment, type ReactNode, useMemo, useRef, useState } from "react";
import type { ReplayEvent } from "@codecast/shared/contracts/replay";
import { ChevronDown, Copy, EyeOff, Link2, Search, Share2, X } from "lucide-react";
import { formatReplayTime, isFailedRequest, isFailure, rageBursts, routeOf } from "@codecast/shared/replay";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { copyText } from "../../lib/copyText";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { opsHref } from "./opsPaths";
import { pressable } from "./parts";
import type { OpsReplay } from "./opsTypes";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { momentRef, pathOf, plural, railRowAt, type RestHold, restLine, type RestQueued, type RestState } from "./replayModel";
import {
  actionDetail,
  ALL_KIND_LABEL,
  ALL_KINDS_HIDDEN_BY_DEFAULT,
  type AllKind,
  allKindCounts,
  describeEvent,
  endpointOf,
  eventHas,
  foldRail,
  netGrade,
  netParts,
  netPath,
  RAIL_LABEL,
  RAIL_TABS,
  railAdmits,
  railCounts,
  type RailTab,
  runText,
} from "./replayRail";
import { ALL_HIDDEN_KEY, inBlocks, inkOf, MUTED_KEY, RAIL_BLOCK, wordOf } from "./replayPlayerModel";

/**
 * Where reading the rest of a cut copy stands (restLine: the same words as the
 * list row), with a meter while it reads and the press that reads it again,
 * offered only when the server will act on it (restDue) and nothing holds it.
 */
export function RestStatus({ rest, starting, readRest, hold, vendorName, queued }: { rest: RestState | null; starting: boolean; readRest?: () => void; hold: RestHold | null; vendorName: string | null; queued?: RestQueued }) {
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
export function SemanticStage({ events, idx, url, outline }: { events: ReplayEvent[]; idx: number; url: string | null; outline: string | null }) {
  const cur = idx >= 0 ? events[idx] : undefined;
  return (
    <div className="rp-semantic">
      <div className="rp-semantic-url ops-mono" title={url ?? undefined}>{url ? routeOf(pathOf(url)) : "No page yet"}</div>
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
export function ShareMoment({ replay, t }: { replay: OpsReplay; t: number }) {
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
export function EventRail({ events, t, hasOutlines, outline, onSeek, children }: {
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
                      <RailRow e={e} i={i} past={e.t <= t} current={i === cur} open={openIdx === i} onSeek={() => onSeek(e.t)} onToggle={() => setOpenIdx(openIdx === i ? null : i)} onMute={e.type === "network" && !isFailure(e) ? () => mute(endpointOf(e)) : undefined} run={many ? { count: members.length, open: expanded, toggle: () => toggleRun(i), until: members[members.length - 1][0].t, typed: runText(e, members[members.length - 1][0]) ?? undefined, rage: e.type === "click" && rageBursts(members.map(([m]) => m)).length > 0 } : undefined} />
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

type RailRun = { count: number; open: boolean; toggle: () => void; until: number; rage?: boolean; typed?: string };

function RailRow({ e, i, past, current, open, onSeek, onToggle, onMute, run, nested }: { e: ReplayEvent; i: number; past: boolean; current: boolean; open: boolean; onSeek: () => void; onToggle: () => void; onMute?: () => void; run?: RailRun; nested?: boolean }) {
  const grade = e.type === "network" ? netGrade(e) : null;
  const text = run?.typed ?? describeEvent(e);
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
            <span className="truncate" title={e.type === "nav" ? e.url : text} style={{ color: isFailure(e) ? "var(--sol-red)" : undefined }}>{text}</span>
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
