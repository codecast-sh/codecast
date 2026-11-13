// The issue page's sample cards: the selected event with its replay moment,
// details and stack as frames, the index of kept samples, and the tag
// breakdown over them.
import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Copy } from "lucide-react";
import { toast } from "sonner";
import { groupSha, useOpsReplay, useShaCommit, useSyncOpsReplay } from "../../hooks/useSyncOps";
import { filePath } from "../../lib/externalEvents";
import { relTimeShort } from "../../lib/utils";
import { formatReplayTime } from "@codecast/shared/replay";
import { replayRefId } from "@codecast/shared/contracts/replayPlayer";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { foldRuns, replayPlace } from "./opsModel";
import { opsHref } from "./opsPaths";
import { ReplayMomentEmbed } from "./ReplayMomentEmbed";
import { durationShort } from "./metricModel";
import { exceptionValue, parseTags, replayOffset, sampleFacets, stackRows, type StackFrameRow } from "./issuesModel";
import type { OpsGroup, OpsSample } from "./opsTypes";

export type SamplesState = "loading" | "ready" | "none" | "error";

export function SkeletonCard({ title }: { /** Left out while the issue's kind is unknown, so no card is named that this kind may never draw. */ title?: string }) {
  return (
    <div className="ops-card" aria-busy="true">
      <div className="ops-card-head">{title ?? <span className="iss-skel" style={{ width: 72 }} />}</div>
      <div className="ops-card-body flex flex-col gap-2">
        <div className="iss-skel" style={{ width: "70%" }} />
        <div className="iss-skel" style={{ width: "55%" }} />
        <div className="iss-skel" style={{ width: "62%" }} />
      </div>
    </div>
  );
}

/** The event the page is on: which of the kept samples, when, where, who, and its replay at that moment. */
export function EventCard({ group, samples, all, index, state, retry, go, filter, clearFilter, now }: {
  group: OpsGroup;
  samples: OpsSample[];
  all: number;
  index: number;
  state: SamplesState;
  retry?: () => void;
  go: (i: number) => void;
  filter: { key: string; value: string } | null;
  clearFilter: () => void;
  now: number;
}) {
  if (state === "loading") return <SkeletonCard title="Event" />;
  if (state === "error") {
    return (
      <div className="ops-card">
        <div className="ops-card-head">Event</div>
        <div className="ops-card-body ops-dim">Samples did not load. {retry && <button type="button" className="text-sol-link hover:underline" onClick={retry}>Try again</button>}</div>
      </div>
    );
  }
  const s = samples[index];
  const head = (
    <div className="ops-card-head">
      <span className="inline-flex items-center gap-2 whitespace-nowrap">
        Event
        {s && <span className="ops-dim ops-num font-normal">{index + 1} of {samples.length}{filter ? ` of ${all}` : ""}</span>}
        {filter && <button type="button" className="ops-pill" style={{ color: "var(--sol-blue)", background: "color-mix(in srgb, var(--sol-blue) 12%, transparent)" }} onClick={clearFilter}>{filter.key}: {filter.value} ×</button>}
      </span>
      {samples.length > 1 && (
        <span className="iss-event-nav" aria-label="Move between events">
          <button type="button" disabled={index === 0} onClick={() => go(0)} title="Newest event"><ChevronsLeft className="w-3 h-3" /><span className="iss-event-word">Newest</span></button>
          <button type="button" disabled={index === 0} onClick={() => go(index - 1)} title="Newer event"><ChevronLeft className="w-3 h-3" /><KeyCap size="xs">[</KeyCap></button>
          <button type="button" disabled={index >= samples.length - 1} onClick={() => go(index + 1)} title="Older event"><KeyCap size="xs">]</KeyCap><ChevronRight className="w-3 h-3" /></button>
          <button type="button" disabled={index >= samples.length - 1} onClick={() => go(samples.length - 1)} title="Oldest event"><span className="iss-event-word">Oldest</span><ChevronsRight className="w-3 h-3" /></button>
        </span>
      )}
    </div>
  );
  if (!s) {
    return (
      <div className="ops-card">
        {head}
        <div className="ops-card-body ops-dim">{filter ? "No kept sample has that value." : group.kind === "check" || group.kind === "metric" ? "Checks and metrics keep readings, not samples." : "No samples kept for this group."}</div>
      </div>
    );
  }
  const who = s.user?.email ?? s.user?.name ?? s.user?.id ?? null;
  // A job's sample is one failed run: its run id leads, so the run can be found in the app's own logs.
  const ctxTags = group.kind === "job" ? parseTags(s.context_json) : null;
  const runId = ctxTags ? [ctxTags.run_id, ctxTags.job_id, ctxTags.id].find((v) => typeof v === "string" || typeof v === "number") : undefined;
  return (
    <div className="ops-card">
      {head}
      <div className="iss-event">
        <span className="ops-num text-sol-text" title={new Date(s.at).toLocaleString()}>{new Date(s.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" })}</span>
        <span className="ops-dim">{relTimeShort(s.at, now)} ago</span>
        {runId !== undefined && <span className="ops-mono text-sol-text" title={`run ${runId}`}>run {String(runId).slice(0, 8)}</span>}
        {s.level && <span className="ops-mono ops-quiet">{s.level}</span>}
        {s.release && <span className="ops-mono ops-quiet">{s.release}</span>}
        {s.environment && <span className="ops-quiet">{s.environment}</span>}
        {who && <span className="text-sol-text truncate max-w-[240px]" title={who}>{who}</span>}
        <span className="ops-mono ops-dim text-[10.5px] ml-auto" title="sample id">{s._id.slice(-8)}</span>
      </div>
      {s.message && s.message !== group.title && s.message.trim() !== exceptionValue(s, group.title) ? <div className="px-3 pb-2 text-[12.5px] text-sol-text break-words">{s.message}</div> : group.kind === "job" && !s.message?.trim() ? <div className="px-3 pb-2 text-[12px] ops-dim">no error message sent</div> : null}
      {s.url && <div className="px-3 pb-2 text-[11.5px] ops-mono ops-quiet break-all">{s.url}</div>}
      {s.replay_id && <SampleReplay sample={s} />}
    </div>
  );
}

/** The sample's replay, opened at the moment the sample happened. */
function SampleReplay({ sample }: { sample: OpsSample }) {
  // The replay may be past the window the replays list holds: read its own row.
  useSyncOpsReplay(sample.replay_id ?? null);
  const replay = useOpsReplay(sample.replay_id ?? null);
  const t = replayOffset(sample.at, replay);
  const id = replay?.short_id || sample.replay_id!;
  return (
    <div className="px-3 pb-3 flex flex-col gap-2">
      <Link className="text-sol-link hover:underline text-[12px] inline-flex items-center gap-1" href={opsHref.replay(id, t)}>
        {replay?.short_id ?? "Replay"}{t !== null ? ` at ${formatReplayTime(t)}` : ""} <ChevronRight className="w-3 h-3" />
      </Link>
      {replay && replay.short_id && <ReplayMomentEmbed rawId={replayRefId(replay.short_id, t)} entity={replay} served href={opsHref.replay(id, t)} />}
    </div>
  );
}

export function DetailsCard({ sample: s }: { sample: OpsSample }) {
  const tags = parseTags(s.tags_json);
  const context = parseTags(s.context_json);
  if (!tags && !context && !s.user) return null;
  return (
    <div className="ops-card">
      <div className="ops-card-head">Tags and context</div>
      <div className="ops-card-body">
        <dl className="ops-kv">
          {s.user && (<><dt>person</dt><dd>{[s.user.email, s.user.name, s.user.id].filter(Boolean).join(" · ")}</dd></>)}
          {tags && Object.entries(tags).map(([k, v]) => (<Fragment key={k}><dt className="ops-mono">{k}</dt><dd className="ops-mono">{String(v)}</dd></Fragment>))}
          {context && (<><dt>context</dt><dd><pre className="ops-code">{JSON.stringify(context, null, 2)}</pre></dd></>)}
        </dl>
      </div>
    </div>
  );
}

/** The repo path a deployed file most likely is: the build's own prefix dropped. */
function repoPath(file: string): string {
  return file.replace(/^[a-z]+:\/\/[^/]*\//i, "").replace(/^\/+/, "").replace(/^(app|var\/task|usr\/src\/app|srv|workspace)\//, "");
}

export function StackCard({ stack, other, group, now, at }: { stack: string; other: boolean; group: OpsGroup; now: number; at: number }) {
  const rows = useMemo(() => stackRows(stack), [stack]);
  const [raw, setRaw] = useState(false);
  const [libs, setLibs] = useState<Set<number>>(new Set());
  const sha = groupSha(group);
  const commit = useShaCommit(sha);
  // A frame is one line: until source context is kept, opening it would only repeat it.
  // An unminified frame of the product links to its file at the release's commit.
  const frameRow = (f: StackFrameRow) => {
    const href = f.in_app && !f.minified && commit?.repository && commit?.sha ? filePath({ repository: commit.repository, ref: commit.sha, path: repoPath(f.file), line: f.line ?? undefined } as any) : null;
    return (
      <div key={f.i} className="iss-frame" data-inapp={f.in_app ? "true" : "false"}>
        <div className="iss-frame-line ops-mono">
          <span />
          <span className="iss-frame-fn">{f.fn}</span>
          {href ? (
            <Link href={href} className="iss-frame-file hover:underline" title={`Open at ${commit.sha.slice(0, 7)}`}><bdi>{f.file}{f.line ? `:${f.line}${f.col ? `:${f.col}` : ""}` : ""}</bdi></Link>
          ) : (
            <span className="iss-frame-file" title={f.raw}><bdi>{f.file}{f.line ? `:${f.line}${f.col ? `:${f.col}` : ""}` : ""}</bdi></span>
          )}
          <span className="inline-flex gap-1">
            {f.in_app && <span className="ops-pill" style={{ color: "var(--sol-red)", background: "color-mix(in srgb, var(--sol-red) 12%, transparent)" }}>app</span>}
            {f.minified && <span className="ops-pill" style={{ color: "var(--sol-text-muted)", background: "color-mix(in srgb, var(--sol-text-muted) 12%, transparent)" }} title="no source map">minified</span>}
          </span>
        </div>
      </div>
    );
  };
  return (
    <div className="ops-card">
      <div className="ops-card-head">
        <span className="inline-flex items-center gap-2">Stack {other && <span className="ops-dim font-normal text-[11px]">from {relTimeShort(at, now)} ago</span>}</span>
        <span className="inline-flex items-center gap-2">
          <div className="ops-seg" role="group" aria-label="Stack view">
            <button type="button" data-on={!raw ? "true" : undefined} aria-pressed={!raw} onClick={() => setRaw(false)}>Frames</button>
            <button type="button" data-on={raw ? "true" : undefined} aria-pressed={raw} onClick={() => setRaw(true)}>Raw</button>
          </div>
          <button type="button" className="ops-btn" style={{ height: 22 }} onClick={() => copy(stack, "Stack copied")}><Copy className="w-3 h-3" /> Copy</button>
        </span>
      </div>
      {raw ? (
        <pre className="iss-raw ops-mono">{stack}</pre>
      ) : (
        <div className="iss-frames">
          {rows.map((r, i) =>
            r.type === "message" ? (
              <div key={`m${i}`} className="iss-msg ops-mono">{r.text}</div>
            ) : r.type === "frame" ? (
              frameRow(r)
            ) : (
              <div key={`l${i}`} className="iss-lib">
                <button type="button" className="iss-lib-toggle" onClick={() => setLibs((p) => { const n = new Set(p); n.has(i) ? n.delete(i) : n.add(i); return n; })} aria-expanded={libs.has(i)}>
                  <ChevronDown className="w-3 h-3" style={{ transform: libs.has(i) ? undefined : "rotate(-90deg)" }} />
                  +{r.frames.length} library frames
                </button>
                {libs.has(i) && r.frames.map(frameRow)}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function copy(text: string, done: string) {
  void navigator.clipboard?.writeText(text).then(() => toast.success(done), () => toast.error("Could not copy"));
}

/** Every kept sample as a compact index: alike runs fold, and any one opens as the page's event. */
export function SamplesIndex({ samples, title, current, pick, now }: { samples: OpsSample[]; title: string; current: string | null; pick: (id: string) => void; now: number }) {
  const [openRun, setOpenRun] = useState<string | null>(null);
  const runs = useMemo(() => {
    const line = (s: OpsSample) => (s.message && s.message !== title ? s.message : replayPlace(s.url) ?? s.message ?? "occurrence");
    const folded = foldRuns(samples, (s) => [line(s), s.user?.email ?? s.user?.id ?? "", s.release, s.environment, s.replay_id].join("|"));
    let at = 0;
    return folded.map((r) => {
      const members = samples.slice(at, at + r.count);
      at += r.count;
      return { ...r, members, line: line(r.row) };
    });
  }, [samples, title]);
  return (
    <div className="ops-card">
      <div className="ops-card-head"><span>Samples <span className="ops-dim ops-num">{samples.length}</span></span></div>
      {runs.map((r) => {
        const on = r.members.some((m) => m._id === current);
        const who = r.row.user?.email ?? r.row.user?.name ?? r.row.user?.id ?? "";
        return (
          <div key={r.row._id} className="iss-index-group">
            <button type="button" className="iss-index-row" data-on={on && r.count === 1 ? "true" : undefined} onClick={() => (r.count > 1 ? setOpenRun(openRun === r.row._id ? null : r.row._id) : pick(r.row._id))}>
              <span className="ops-num ops-dim">{relTimeShort(r.row.at, now)}</span>
              <span className="truncate ops-mono text-sol-text" title={r.row.url ?? undefined}>{r.line}</span>
              <span className="inline-flex items-center gap-2 text-[11px]">
                {r.count > 1 && <span className="ops-pill ops-num" style={{ color: "var(--sol-text-muted)", background: "color-mix(in srgb, var(--sol-text-muted) 12%, transparent)" }}>{r.count} alike</span>}
                {who && <span className="ops-quiet truncate max-w-[160px]">{who}</span>}
                {r.row.release && <span className="ops-mono ops-dim">{r.row.release}</span>}
              </span>
            </button>
            {r.count > 1 && openRun === r.row._id && r.members.map((m) => (
              <button key={m._id} type="button" className="iss-index-row" data-member="true" data-on={m._id === current ? "true" : undefined} onClick={() => pick(m._id)}>
                <span className="ops-num ops-dim">{relTimeShort(m.at, now)}</span>
                <span className="truncate ops-quiet">{new Date(m.at).toLocaleString()}</span>
                <span className="ops-mono ops-dim text-[10.5px]">{m._id.slice(-8)}</span>
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** Each tag's top values across the kept samples; a value narrows the events to it. */
/** Below this share of an issue's life, kept samples are a sliver of it: the Tags card gives counts, not shares. */
const TAGS_SHARE_MIN = 0.05;

export function TagsCard({ samples, of, life, filter, setFilter, now }: { samples: OpsSample[]; /** The issue's whole count, which the kept samples are a part of. */ of: number; /** How long the issue has been happening, first to last occurrence. */ life: number; filter: { key: string; value: string } | null; setFilter: (f: { key: string; value: string } | null) => void; now: number }) {
  const facets = useMemo(() => sampleFacets(samples), [samples]);
  // A key where every sample differs says nothing by its top values; a card of only those is noise.
  if (!facets.length || facets.every((f) => f.spread)) return null;
  const covered = Math.max(60_000, samples[0].at - samples[samples.length - 1].at);
  // Kept samples that cover a sliver of the issue's life say what that sliver held, not how the issue splits: counts, never shares.
  const sliver = samples.length < of && covered < life * TAGS_SHARE_MIN;
  return (
    <div className="ops-card">
      {/* The shares are of the kept samples, so the head names them and the stretch they cover, never the issue's whole count. */}
      <div className="ops-card-head">
        <span>Tags</span>
        <span className="ops-dim ops-num font-normal text-[11px]" title={`${new Date(samples[samples.length - 1].at).toLocaleString()} to ${new Date(samples[0].at).toLocaleString()}`}>
          {sliver ? <>last {durationShort(covered)} only · {samples.length} of {of.toLocaleString()}</> : <>{samples.length < of ? `${samples.length} kept of ${of.toLocaleString()}` : `all ${samples.length}`} · over {durationShort(covered)}, last {relTimeShort(samples[0].at, now)} ago</>}
        </span>
      </div>
      <div className="ops-card-body">
        {facets.map((f) => {
          // One value on every kept sample: the value alone, its bar full. Counts only say something once a tag splits.
          const single = !f.spread && f.values.length === 1 && f.total === samples.length;
          return (
            <div key={f.key} className="iss-tag" data-spread={f.spread ? "true" : undefined}>
              <div className="iss-tag-key"><span className="ops-mono">{f.key}</span>{!single && <span className="ops-num" title={`${f.total} of the kept samples carry it`}>{f.spread ? `${f.distinct} distinct` : `${f.total} kept`}</span>}</div>
              {!f.spread && f.values.map((v) => {
                const on = filter?.key === f.key && filter.value === v.value;
                return (
                  <button key={v.value} type="button" className="iss-tag-val" data-on={on ? "true" : undefined} onClick={() => setFilter(on ? null : { key: f.key, value: v.value })} title={`${v.count} of ${f.total}`}>
                    {(!sliver || single) && <i style={{ width: single ? "100%" : `${Math.round(v.share * 100)}%` }} />}
                    <span className="ops-mono">{v.value}</span>
                    {!single && <span className="ops-num ops-quiet">{sliver ? `${v.count} of ${f.total}` : `${Math.round(v.share * 100)}%`}</span>}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
