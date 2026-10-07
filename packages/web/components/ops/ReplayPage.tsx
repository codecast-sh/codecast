// /ops/replays/:id: one recording as a player. The scrubber runs over the
// semantic events, the event list follows it, and beside them the page's text
// outline as of that moment, then the console and the network. When the
// recording kept its page capture (DOM chunks), the page itself plays above
// them: the isolated player (ReplayPlayerFrame, on replay.codecast.sh, never
// this origin) with its own bar hidden, driven from this one. Every seek here
// is posted to it, and its time posts move the scrubber and the list, so the
// two clocks are one (both are the replay clock, ms since its first event).
// Without a capture the page reads as the semantic view alone. Copy repro writes the Playwright test toRepro builds; Start fix
// session opens a session seeded with the replay, as quoted data.
//
// The events come from the replay's chunks, read through the chunk route
// (an access check, then a short signed redirect). They are the recording's
// bytes, held by the page while it is open like a video's frames; the
// manifest and the text timeline are store rows. A mirrored recording (PostHog,
// Sentry) not imported yet is imported when the page opens it
// (sources/vendorReplay.importLinked); the import lands in the replay row,
// whose new chunks the page then reads like any other.
import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { useAuthToken } from "@convex-dev/auth/react";
import { useAction } from "convex/react";
import type { ReplayPlayerMessage } from "@codecast/shared/contracts/replayPlayer";
import { api } from "@codecast/convex/convex/_generated/api";
import { needsVendorImport } from "@codecast/shared/contracts/replay";
import { ChevronRight, Copy, Pause, Play, Wand2 } from "lucide-react";
import type { ReplayEvent } from "@codecast/shared/contracts/replay";
import { formatReplayTime, isFailedRequest, isFailure, parseReplayEvents, primaryFailure, sortReplayEvents, toRepro, urlPath } from "@codecast/shared/replay";
import { byRef, detailGone, useOpsReplays, useOpsReplayTimeline, useOpsSources, useSyncOpsReplay } from "../../hooks/useSyncOps";
import { CONVEX_URL } from "../../lib/convexUrl";
import { copyText } from "../../lib/copyText";
import { hasOpenModal, isEditableTarget } from "../../shortcuts";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { decodeReplayChunk, eventIndexAt, isScrubberTick, outlineAt, replayBaseUrl, replayLength, replayTitle, urlAt } from "./opsModel";
import { opsHref } from "./opsPaths";
import { OpsEmpty, OpsFeedError, ProviderIcon, pressable } from "./parts";
import { startOpsFixSession } from "./startFix";
import type { OpsReplay } from "./opsTypes";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { ReplayPlayerIframe, useReplayPlayerChannel, useReplayPlayerLink } from "./ReplayPlayerFrame";

type Loaded = { state: "loading" } | { state: "ready"; events: ReplayEvent[] } | { state: "failed"; error: string };

/** Read every chunk of a replay the viewer may see, in order. */
function useReplayEvents(replay: OpsReplay | undefined): Loaded {
  const token = useAuthToken();
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const key = replay ? `${replay._id}:${replay.chunks}` : null;
  useWatchEffect(() => {
    if (!replay || !token) return;
    if (replay.chunks === 0) {
      setLoaded({ state: "ready", events: [] });
      return;
    }
    let cancelled = false;
    setLoaded({ state: "loading" });
    (async () => {
      const all: ReplayEvent[] = [];
      for (let seq = 0; seq < replay.chunks; seq++) {
        const res = await fetch(`${CONVEX_URL}/cli/replays/chunk?replay=${encodeURIComponent(replay._id)}&seq=${seq}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(res.status === 404 ? "a chunk is missing or expired (chunks are kept 30 days)" : `chunk ${seq} answered ${res.status}`);
        all.push(...parseReplayEvents(await decodeReplayChunk(new Uint8Array(await res.arrayBuffer()))));
      }
      if (!cancelled) setLoaded({ state: "ready", events: sortReplayEvents(all) });
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

type Import = { state: "idle" } | { state: "importing" } | { state: "failed"; error: string };

/**
 * Import a mirrored recording the first time the page opens it. The answer is
 * not rendered: the import writes the replay row, and the row's sync brings
 * its chunks here. One attempt per replay per visit.
 */
function useVendorImport(replay: OpsReplay | undefined): Import {
  const importLinked = useAction(api.sources.vendorReplay.importLinked);
  const [state, setState] = useState<Import>({ state: "idle" });
  const tried = useRef<string | null>(null);
  const due = !!replay && needsVendorImport(replay);
  useWatchEffect(() => {
    if (!replay || !due || tried.current === replay._id) return;
    tried.current = replay._id;
    setState({ state: "importing" });
    importLinked({ replay: replay._id }).then(
      () => setState({ state: "idle" }),
      (e) => setState({ state: "failed", error: e instanceof Error ? e.message : String(e) }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per replay id
  }, [replay?._id, due]);
  return state;
}

export function ReplayPage({ id, t }: { id: string; t: number | null }) {
  const feed = useSyncOpsReplay(id);
  const replay = byRef(useOpsReplays(), id);
  const timeline = useOpsReplayTimeline(replay?._id);
  const loaded = useReplayEvents(replay);
  const vendorImport = useVendorImport(replay);

  if (!replay) {
    if (detailGone(feed)) return <OpsEmpty title={`${id} is not here`}>It may belong to another workspace, or it has expired.</OpsEmpty>;
    if (feed.error) return <OpsFeedError what={id} retry={feed.retry} />;
    return <div className="ops-detail ops-quiet text-[12.5px]">Opening {id}…</div>;
  }

  return (
    <div className="ops-detail">
      <div className="ops-crumb">
        <Link href={opsHref.tab("replays")}>Replays</Link>
        <ChevronRight className="w-3 h-3" />
        <span className="ops-mono">{replay.short_id}</span>
      </div>
      <h1 className="ops-h1">{replayTitle(replay)}</h1>
      <div className="flex items-center gap-3 flex-wrap text-[12px] ops-quiet">
        <span className="inline-flex items-center gap-1.5"><ProviderIcon provider={replay.provider} />{replay.source_name ?? replay.provider}</span>
        {replay.user && <span>{replay.user.email ?? replay.user.name ?? replay.user.id}</span>}
        <span>{new Date(replay.started_at).toLocaleString()}</span>
        {(timeline?.groups ?? []).map((g) => (
          <Link key={g._id} href={opsHref.issue(g.short_id)} className="hover:underline inline-flex items-baseline gap-1.5 min-w-0 max-w-[420px]" title={g.title}>
            <span className="ops-mono" style={{ color: g.status === "open" ? "var(--sol-red)" : undefined }}>{g.short_id}</span>
            <span className="truncate text-sol-text">{g.title}</span>
          </Link>
        ))}
      </div>

      <div className="mt-4">
        {loaded.state === "ready" && loaded.events.length > 0 ? (
          <Player replay={replay} events={loaded.events} initialT={t} groupRefs={(timeline?.groups ?? []).map((g) => g.short_id)} />
        ) : loaded.state === "loading" && replay.chunks > 0 ? (
          <div className="ops-card ops-card-body ops-quiet">Reading {replay.chunks} chunk{replay.chunks === 1 ? "" : "s"}…</div>
        ) : vendorImport.state === "importing" || (needsVendorImport(replay) && vendorImport.state === "idle") ? (
          <div className="ops-card ops-card-body ops-quiet">Importing the recording from {replay.source_name ?? replay.provider}…</div>
        ) : (
          <div className="ops-card">
            <div className="ops-card-head">
              <span>Timeline</span>
              {loaded.state === "failed" && <span className="text-[11px] font-normal" style={{ color: "var(--sol-orange)" }}>The recording could not be read: {loaded.error}</span>}
              {vendorImport.state === "failed" && <span className="text-[11px] font-normal" style={{ color: "var(--sol-orange)" }}>The import failed: {vendorImport.error}</span>}
            </div>
            <pre className="ops-outline ops-mono" style={{ maxHeight: "none" }}>{timeline?.timeline_md ?? (replay.chunks === 0 ? "Nothing recorded yet." : "No text timeline yet.")}</pre>
          </div>
        )}
      </div>
    </div>
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
  if (e.type === "network") return isFailedRequest(e) ? "var(--sol-red)" : "var(--sol-orange)";
  return EV_INK[e.type] ?? "var(--sol-text-muted)";
}

function describe(e: ReplayEvent): string {
  switch (e.type) {
    case "nav": return urlPath(e.url);
    case "click": return e.text && e.text !== e.label ? `${e.label} (${e.text})` : e.label;
    case "input": return `${e.label}, ${e.length} chars`;
    case "submit": return e.label;
    case "key": return e.key;
    case "scroll": return `to ${Math.round(e.y)} of ${Math.round(e.of)}`;
    case "console": return e.message;
    case "network": return `${e.method} ${urlPath(e.url)} ${e.status || "failed"} ${e.ms}ms`;
    case "error": return e.message;
    case "view": return "page outline";
    case "mark": return e.data ? `${e.name} ${JSON.stringify(e.data).slice(0, 120)}` : e.name;
  }
}

// The event list's type column: one short word each, so the column stays narrow.
const TYPE_WORD: Record<ReplayEvent["type"], string> = {
  nav: "nav", click: "click", input: "type", submit: "submit", key: "key", scroll: "scroll",
  console: "log", network: "net", error: "error", view: "view", mark: "mark",
};

const SPEEDS = [1, 2, 4] as const;

/** The player proper: exported for its mount test (ops/__tests__/replayPlayer.mount.test.tsx). */
export function Player({ replay, events, initialT, groupRefs }: { replay: OpsReplay; events: ReplayEvent[]; initialT: number | null; groupRefs: string[] }) {
  const length = useMemo(() => Math.max(1, replayLength(events, replay.duration_ms)), [events, replay.duration_ms]);
  const failure = useMemo(() => primaryFailure(events), [events]);
  const [t, setT] = useState(() => Math.min(length, initialT ?? (failure ? Math.max(0, failure.t - 3000) : 0)));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const idx = eventIndexAt(events, t);
  const outline = outlineAt(events, t);
  const url = urlAt(events, t, replay.url);
  const ticks = useMemo(() => events.filter(isScrubberTick), [events]);
  const consoleRows = useMemo(() => events.filter((e) => e.type === "console" || e.type === "error"), [events]);
  const networkRows = useMemo(() => events.filter((e) => e.type === "network"), [events]);

  // The page itself, when the recording kept it. Opened once, at the time the
  // page opened on; from then on it follows this page's clock.
  const stage = useReplayStage(replay, t, playing, speed, length, setT, setPlaying, setSpeed);
  const driven = stage.driven;

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
        if (next >= length) {
          setPlaying(false);
          return length;
        }
        return next;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, length, driven]);

  /** Move to a time, paused unless `keepPlaying`: the scrubber, the lists and the keys all land here. */
  const seekTo = (to: number, keepPlaying = false) => {
    const next = Math.min(length, Math.max(0, to));
    if (!keepPlaying) setPlaying(false);
    setT(next);
    if (!keepPlaying) stage.send({ type: "pause" });
    stage.send({ type: "seek", t_ms: next });
  };
  const togglePlay = () => {
    const from = t >= length ? 0 : t;
    if (from !== t) setT(from);
    const next = !playing || from !== t;
    setPlaying(next);
    if (from !== t) stage.send({ type: "seek", t_ms: from });
    stage.send({ type: next ? "play" : "pause" });
  };
  const pickSpeed = (s: (typeof SPEEDS)[number]) => {
    setSpeed(s);
    stage.send({ type: "speed", speed: s });
  };

  // Space plays and pauses; the arrows step between events.
  const keys = useRef({ togglePlay, seekTo, t });
  keys.current = { togglePlay, seekTo, t };
  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target) || hasOpenModal()) return;
      const { togglePlay: toggle, seekTo: to, t: cur } = keys.current;
      if (e.key === " ") toggle();
      else if (e.key === "ArrowRight") to(events.find((ev) => ev.t > cur + 1)?.t ?? length);
      else if (e.key === "ArrowLeft") to([...events].reverse().find((ev) => ev.t < cur - 1)?.t ?? 0);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [events, length]);

  // Keep the current event in view as the scrubber moves.
  const listRef = useRef<HTMLDivElement>(null);
  useWatchEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-ev="${idx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const railRef = useRef<HTMLDivElement>(null);
  const seek = (clientX: number) => {
    const r = railRef.current?.getBoundingClientRect();
    if (!r) return;
    seekTo(((clientX - r.left) / r.width) * length);
  };
  // The arrows step between events from anywhere on the page (above); on the
  // focused scrubber, Page Up and Page Down move ten seconds, Home and End
  // jump to the ends.
  const onScrubKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const to = e.key === "Home" ? 0 : e.key === "End" ? length : e.key === "PageUp" ? t - 10_000 : e.key === "PageDown" ? t + 10_000 : null;
    if (to === null) return;
    e.preventDefault();
    seekTo(to);
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    seek(e.clientX);
  };

  const copyRepro = () => void copyText(toRepro(events, { baseUrl: replayBaseUrl(replay.url) }), "Repro copied");
  const startFix = () => {
    const failureText = failure ? (failure.type === "network" ? `${failure.method} ${failure.url} ${failure.status}` : failure.message) : null;
    startOpsFixSession({ replayRef: replay.short_id || replay._id, groupRefs, failure: failureText, url: replay.url }, replay.source_id);
  };

  const pct = (ms: number) => `${(ms / length) * 100}%`;

  return (
    <div className="ops-player">
      {stage.view}
      <div className="ops-player-bar">
        <button type="button" className="ops-btn" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
          {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
        </button>
        <span className="ops-mono ops-num text-[12px]">{formatReplayTime(t)} <span className="ops-dim">/ {formatReplayTime(length)}</span></span>
        <div className="ops-seg">
          {SPEEDS.map((s) => (
            <button key={s} type="button" data-on={s === speed ? "true" : undefined} aria-pressed={s === speed} onClick={() => pickSpeed(s)}>{s}x</button>
          ))}
        </div>
        <span className="ops-dim text-[11px] truncate ops-mono flex-1" title={url ?? undefined}>{url ? urlPath(url) : ""}</span>
        <span className="ops-dim text-[11px] hidden lg:inline-flex items-center gap-1"><KeyCap size="xs">Space</KeyCap> play <KeyCap size="xs">←</KeyCap><KeyCap size="xs">→</KeyCap> step</span>
        <button type="button" className="ops-btn" onClick={copyRepro} title="A Playwright test that replays the steps up to the failure, then asserts it does not happen">
          <Copy className="w-3.5 h-3.5" /> Copy repro
        </button>
        <button type="button" className="ops-btn" data-tone="primary" onClick={startFix}>
          <Wand2 className="w-3.5 h-3.5" /> Start fix session
        </button>
      </div>

      <div ref={railRef} className="ops-scrub" onPointerDown={onPointerDown} onPointerMove={(e) => e.buttons === 1 && seek(e.clientX)} role="slider" tabIndex={0} onKeyDown={onScrubKey} aria-label="Position" aria-valuemin={0} aria-valuemax={length} aria-valuenow={Math.round(t)} aria-valuetext={`${formatReplayTime(t)} of ${formatReplayTime(length)}`}>
        {ticks.map((e, i) => (
          <span key={i} className="ops-scrub-tick" style={{ left: pct(e.t), background: inkOf(e), height: isFailure(e) ? 16 : e.type === "nav" ? 14 : 9, top: isFailure(e) ? 2 : e.type === "nav" ? 4 : 9 }} title={`${formatReplayTime(e.t)} ${e.type}: ${describe(e)}`} />
        ))}
        <div className="ops-scrub-rail" />
        <div className="ops-scrub-fill" style={{ width: pct(t) }} />
        <div className="ops-scrub-head" style={{ left: pct(t) }} />
      </div>

      <div className="ops-replay-cols">
        <div className="min-w-0 ops-events-col">
          <div className="ops-card-head" style={{ borderTop: 0 }}>
            <span>Events <span className="ops-dim ops-num font-normal">{events.length}</span></span>
            <span className="ops-dim text-[11px] font-normal">click one to jump there</span>
          </div>
          <div className="ops-events" ref={listRef}>
            {events.map((e, i) => (
              <div key={i} data-ev={i} className="ops-ev" data-past={e.t <= t ? "true" : "false"} data-current={i === idx ? "true" : undefined} aria-label={`${formatReplayTime(e.t)} ${TYPE_WORD[e.type]}: ${describe(e)}`} {...pressable(() => seekTo(e.t))}>
                <span className="ops-mono ops-num ops-dim text-[11px]">{formatReplayTime(e.t)}</span>
                <span className="ops-mono text-[10.5px]" style={{ color: inkOf(e) }}>{TYPE_WORD[e.type]}</span>
                <span className="truncate" title={describe(e)} style={{ color: isFailure(e) ? "var(--sol-red)" : undefined }}>{describe(e)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="min-w-0">
          <div className="ops-card-head" style={{ borderTop: 0 }}>
            <span>The page</span>
            <span className="ops-dim text-[11px] font-normal">{outline ? `outline at ${formatReplayTime(outline.t)}` : "no outline yet"}</span>
          </div>
          <div className="ops-outline">{outline?.outline ?? "The recorder takes the page's visible text at each navigation and just before an error."}</div>
        </div>
      </div>

      <div className="ops-panes">
        <div>
          <div className="ops-card-head">Console <span className="ops-dim ops-num font-normal">{consoleRows.length}</span></div>
          <div className="ops-pane-rows">
            {consoleRows.length === 0 && <div className="ops-dim">No warnings or errors.</div>}
            {consoleRows.map((e, i) => (
              <div key={i} style={{ opacity: e.t <= t ? 1 : 0.45, cursor: "pointer" }} aria-label={`${formatReplayTime(e.t)} ${describe(e)}`} {...pressable(() => seekTo(e.t, true))}>
                <span className="ops-mono ops-num ops-dim">{formatReplayTime(e.t)}</span>
                <span className="ops-mono" style={{ color: inkOf(e), whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{describe(e)}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="ops-card-head">Network <span className="ops-dim ops-num font-normal">{networkRows.length}</span></div>
          <div className="ops-pane-rows">
            {networkRows.length === 0 && <div className="ops-dim">No failed or slow requests.</div>}
            {networkRows.map((e, i) => (
              <div key={i} style={{ opacity: e.t <= t ? 1 : 0.45, cursor: "pointer" }} aria-label={`${formatReplayTime(e.t)} ${describe(e)}`} {...pressable(() => seekTo(e.t, true))}>
                <span className="ops-mono ops-num ops-dim">{formatReplayTime(e.t)}</span>
                <span className="ops-mono truncate" style={{ color: inkOf(e) }} title={e.type === "network" ? e.url : undefined}>{describe(e)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const NO_SIZE = { width: 16, height: 10 };

/**
 * The recorded page above the scrubber, when the replay kept its capture: the
 * isolated player with its own bar hidden, opened at the time the page opened
 * on. Until it says ready the page keeps its own clock; once it does, it is
 * told where this page stands (time, playing, speed), and from then on its
 * time posts are the clock. If it cannot play (an expired capture, a capture
 * with nothing to draw), it says why in one line and the semantic view goes on
 * as it would without a capture.
 */
function useReplayStage(
  replay: OpsReplay,
  t: number,
  playing: boolean,
  speed: number,
  length: number,
  setT: (t: number) => void,
  setPlaying: (p: boolean) => void,
  setSpeed: (s: (typeof SPEEDS)[number]) => void,
) {
  const hasDom = (replay.dom_chunks ?? 0) > 0;
  const [openedAt] = useState(t);
  const link = useReplayPlayerLink(hasDom ? replay._id : null, hasDom, { t_ms: openedAt, controls: false });
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const here = useRef({ t, playing, speed });
  here.current = { t, playing, speed };
  const channel = useReplayPlayerChannel(link.state === "ready" ? link.origin : null, (msg: ReplayPlayerMessage) => {
    if (msg.type === "ready") {
      setSize({ width: msg.width, height: msg.height });
      setError(null);
      const cur = here.current;
      if (cur.speed !== 1) channel.send({ type: "speed", speed: cur.speed });
      channel.send({ type: "seek", t_ms: cur.t, ...(cur.playing ? { play: true } : {}) });
    } else if (msg.type === "time") {
      setT(Math.min(length, Math.max(0, msg.t_ms)));
      setPlaying(msg.playing);
    } else if (msg.type === "state") {
      setPlaying(msg.playing);
      if ((SPEEDS as readonly number[]).includes(msg.speed)) setSpeed(msg.speed as (typeof SPEEDS)[number]);
    } else if (msg.type === "error") {
      setError(msg.message);
    }
  });
  const driven = link.state === "ready" && size !== null && error === null;
  const send = (cmd: Parameters<typeof channel.send>[0]) => {
    if (driven) channel.send(cmd);
  };

  const problem = link.state === "failed" ? link.error : error;
  let view: React.ReactNode = null;
  if (problem) {
    view = (
      <div className="ops-stage-note">
        The page capture could not be played: {problem} The events below still play.
      </div>
    );
  } else if (link.state === "opening" || link.state === "ready") {
    const box = size ?? NO_SIZE;
    view = (
      <div className="ops-stage" style={{ aspectRatio: `${box.width} / ${box.height}` }}>
        {link.state === "ready" && (
          <ReplayPlayerIframe frameRef={channel.frameRef} url={link.url} title={`The page recorded in ${replay.short_id}`} style={{ height: "100%", opacity: size ? 1 : 0 }} />
        )}
        {!size && <div className="ops-stage-wait ops-quiet">Loading the page capture…</div>}
      </div>
    );
  }
  return { driven, send, view };
}
