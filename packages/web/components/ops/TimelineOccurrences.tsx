// The stream's occurrence rows (Timeline, Rows: Occurrences): each occurrence
// a group kept (event_samples) as one row with its level, message, issue,
// url, user and release, and a side panel with the whole thing: the stack,
// the context and tags, the replay at that moment, and the issue at its
// vendor. Transitions say what changed; these are what happened.
import { Fragment, useMemo, type ReactNode } from "react";
import Link from "next/link";
import { CheckCircle2, ChevronRight, ExternalLink, EyeOff, Film, RotateCcw, X } from "lucide-react";
import { replayRefId } from "@codecast/shared/contracts/replayPlayer";
import { formatCallTime } from "@codecast/shared/entities";
import { useOpsReplay, useSyncOpsReplay } from "../../hooks/useSyncOps";
import { replayOffset } from "./issuesModel";
import { ReplayMomentEmbed } from "./ReplayMomentEmbed";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { relTimeShort } from "../../lib/utils";
import { opsHref } from "./opsPaths";
import { KindGlyph, ProviderIcon, SOURCE_PROVIDER_LABEL } from "./parts";
import { fmtStamp, fmtTime, sampleLevel, vendorStreamUrl, type OccurrenceItem } from "./timelineModel";
import { issueWorkItem, prettyJson, requestLevel, requestLine, sampleTitle, sampleWho, shortUrl } from "./sourceViewModel";
import { GroupFixSlots, TaskChip } from "./OpsHomeRow";
import type { AttentionTask } from "./opsHomeModel";
import { useAttentionTasks } from "./useOpsAttention";
import { EntityIdPill } from "../EntityIdPill";
import { useInboxStore } from "../../store/inboxStore";
import type { OpsGroup, OpsSample, OpsSource } from "./opsTypes";

/** A row's time: the full stamp in the column (with its date on a dated window), a short age ("6m") on a phone row where the message takes the width. */
export function RowTime({ at, span, now, dated, title }: { at: number; span: number; now: number; dated?: boolean; title?: string }) {
  return (
    <span className="ops-num ops-dim otl-time" title={title ?? fmtStamp(at)}>
      <span className="otl-time-full">{fmtTime(at, span, dated)}</span>
      <span className="otl-time-age">{relTimeShort(at, now)}</span>
    </span>
  );
}

export function OccurrenceRows(p: {
  samples: OpsSample[];
  /** The rows as listed: runs of one issue folded (foldRepeats), else each sample as itself. */
  items?: OccurrenceItem<OpsSample>[];
  /** The folded runs opened row by row, by key. */
  expanded?: ReadonlySet<string>;
  toggleRun?: (key: string) => void;
  span: number;
  /** The window needs dates on its times (windowDated). */
  dated?: boolean;
  groupById: Map<string, OpsGroup>;
  sourceById: Map<string, OpsSource>;
  open: string | null;
  cursor: string | null;
  setOpen: (id: string | null) => void;
  loading: boolean;
  canOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => void;
  filtered: boolean;
  clear: () => void;
  source: string | null;
  /** What the window holds beyond the kept rows: every occurrence counted, and where the vendor lists them all. */
  gap?: { total: number | null; vendor: { url: string; name: string } | null };
  /** The window's transitions, when the occurrence list is empty: a source that keeps no samples still shows what changed one press away. */
  transitions?: { n: number; show: () => void } | null;
}) {
  const now = useCoarseNow(60_000);
  const vendorLink = p.gap?.vendor ? <a href={p.gap.vendor.url} target="_blank" rel="noreferrer" className="ops-btn" data-ops-vendor-stream>Show all in {p.gap.vendor.name}<ExternalLink className="w-3 h-3" /></a> : null;
  if (!p.samples.length) {
    return (
      <div className="otl-empty" data-ops-stream-empty>
        <b>{p.loading ? "Reading occurrences…" : p.filtered ? "Nothing matches" : p.source ? `No kept occurrences from ${p.source} in this window` : "No kept occurrences in this window"}</b>
        <span className="otl-empty-acts">
          {p.filtered && <button type="button" className="ops-btn" onClick={p.clear}>Clear the filter</button>}
          {p.canOlder && <button type="button" className="ops-btn" onClick={p.loadOlder}>Load older</button>}
          {!p.loading && p.transitions && <button type="button" className="ops-btn" onClick={p.transitions.show} data-ops-show-transitions>Transitions <span className="ops-num">{p.transitions.n.toLocaleString()}</span></button>}
          {vendorLink}
        </span>
      </div>
    );
  }
  const total = p.gap?.total ?? null;
  const sampleRow = (x: OpsSample, inRun?: boolean) => {
    const g = p.groupById.get(x.group_id);
    const s = p.sourceById.get(x.source_id);
    const { level, type } = sampleLevel(x, g);
    const where = [shortUrl(x.url), sampleWho(x), x.release ? x.release.slice(0, 12) : null].filter(Boolean).join(" · ");
    const on = p.open === x._id;
    return (
      <div
        key={x._id}
        className="otl-row otl-orow"
        data-in-run={inRun ? "true" : undefined}
        data-on={on ? "true" : undefined}
        data-cursor={p.cursor === x._id ? "true" : undefined}
        data-ops-row={x._id}
        data-ops-sample={x._id}
        role="button"
        tabIndex={0}
        aria-expanded={on}
        onClick={(ev) => { if (!(ev.target as Element).closest("a")) p.setOpen(on ? null : x._id); }}
        onKeyDown={(ev) => { if (ev.target === ev.currentTarget && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); p.setOpen(on ? null : x._id); } }}
      >
        <RowTime at={x.at} span={p.span} now={now} dated={p.dated} />
        <span className="otl-src">{s && <ProviderIcon provider={s.provider} />}<span className="truncate">{s?.name ?? "-"}</span></span>
        <span className="otl-what" title={type ? `${level ?? "no level"} · ${type.replace(/_/g, " ")}` : undefined}>{level && <span className="otl-level" data-level={level}>{level}</span>}{x.replay_id && <Film className="w-3 h-3 ops-dim" aria-label="Has a replay" />}</span>
        <span className="otl-title truncate" title={x.message ?? g?.title}><SampleMessage sample={x} group={g} /></span>
        <span className="otl-id ops-mono">{g ? <Link href={opsHref.issue(g.short_id)}>{g.short_id}</Link> : <span className="ops-dim">-</span>}</span>
        <span className="otl-where ops-dim truncate" title={where}>{where}</span>
      </div>
    );
  };
  const items = p.items ?? p.samples.map((x) => ({ kind: "one" as const, sample: x }));
  return (
    <section className="otl-rows" aria-label="Occurrences" data-span={p.span > 2 * 86_400_000 || p.dated ? "long" : undefined} data-view="occurrences" data-scoped={p.source ? "true" : undefined}>
      <div className="otl-row otl-orow otl-row-head" aria-hidden>
        <span>Time</span><span>Source</span><span>Level</span><span>Message</span><span>Issue</span><span>Where</span>
      </div>
      {items.map((it) => {
        if (it.kind === "one") return sampleRow(it.sample);
        const open = !!p.expanded?.has(it.key);
        return (
          <Fragment key={it.key}>
            <RunRow run={it} span={p.span} dated={p.dated} now={now} open={open} cursor={p.cursor === it.samples[0]._id} group={p.groupById.get(it.samples[0].group_id)} source={p.sourceById.get(it.samples[0].source_id)} onToggle={() => p.toggleRun?.(it.key)} />
            {open && it.samples.map((x) => sampleRow(x, true))}
          </Fragment>
        );
      })}
      <div className="otl-sentinel otl-gap" data-ops-gap>
        {p.loadingOlder ? <span className="ops-dim">Reading older occurrences…</span> : p.canOlder ? <button type="button" className="ops-btn" onClick={p.loadOlder}>Load older</button> : null}
        {/* The kept rows against everything counted: the gap is a number, and the vendor's own list is one press away. */}
        <span className="ops-dim ops-num" data-ops-kept-of>{p.samples.length.toLocaleString()} kept{total !== null && total > p.samples.length ? ` of ${total.toLocaleString()}` : ""}</span>
        {vendorLink}
      </div>
    </section>
  );
}

/** A run of one issue's occurrences folded into one line: its newest message, how many, and the span they cover; pressing it lists them. */
function RunRow({ run, span, dated, now, open, cursor, group: g, source: s, onToggle }: { run: Extract<OccurrenceItem<OpsSample>, { kind: "run" }>; span: number; dated?: boolean; now: number; open: boolean; cursor: boolean; group?: OpsGroup; source?: OpsSource; onToggle: () => void }) {
  const x = run.samples[0];
  const { level, type } = sampleLevel(x, g);
  const n = run.samples.length;
  // The run's span on hover, one moment when its ends are the same second; its Where is its newest occurrence's, as a single row's.
  const spanTitle = Math.floor(run.from / 1000) === Math.floor(run.to / 1000) ? fmtStamp(run.to) : `${fmtStamp(run.from)} to ${fmtStamp(run.to)}`;
  const where = [shortUrl(x.url), sampleWho(x), x.release ? x.release.slice(0, 12) : null].filter(Boolean).join(" · ");
  return (
    <div
      className="otl-row otl-orow otl-run"
      data-open={open ? "true" : undefined}
      data-cursor={cursor && !open ? "true" : undefined}
      data-ops-row={open ? undefined : x._id}
      data-ops-run={n}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={(ev) => { if (!(ev.target as Element).closest("a")) onToggle(); }}
      onKeyDown={(ev) => { if (ev.target === ev.currentTarget && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); onToggle(); } }}
    >
      <RowTime at={run.to} span={span} now={now} dated={dated} title={spanTitle} />
      <span className="otl-src">{s && <ProviderIcon provider={s.provider} />}<span className="truncate">{s?.name ?? "-"}</span></span>
      <span className="otl-what" title={type ? `${level ?? "no level"} · ${type.replace(/_/g, " ")}` : undefined}>{level && <span className="otl-level" data-level={level}>{level}</span>}</span>
      <span className="otl-title otl-run-title" title={x.message ?? g?.title}>
        <ChevronRight className="otl-run-chev w-3 h-3" aria-hidden />
        <span className="otl-run-n ops-num">×{n.toLocaleString()}</span>
        <span className="truncate"><SampleMessage sample={x} group={g} /></span>
      </span>
      <span className="otl-id ops-mono">{g ? <Link href={opsHref.issue(g.short_id)}>{g.short_id}</Link> : <span className="ops-dim">-</span>}</span>
      <span className="otl-where ops-dim truncate" title={where}>{where}</span>
    </div>
  );
}

export function OccurrencePanel({ sample: x, group, source, onClose }: { sample: OpsSample; group?: OpsGroup; source?: OpsSource; onClose: () => void }) {
  useWatchEffect(() => {
    const onKey = (k: KeyboardEvent) => {
      if (k.key !== "Escape") return;
      k.preventDefault();
      k.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const tags = useMemo(() => prettyJson(x.tags_json), [x.tags_json]);
  const context = useMemo(() => prettyJson(x.context_json), [x.context_json]);
  const { level, type } = sampleLevel(x, group);
  // The issue at its vendor, else the vendor's own event list around this moment (a minute either side).
  const vendorName = (p: string) => SOURCE_PROVIDER_LABEL[p as OpsSource["provider"]] ?? p;
  const around = source ? vendorStreamUrl(source, { from: x.at - 60_000, to: x.at + 60_000 }) : null;
  const vendor = group?.external?.url ? { url: group.external.url, name: vendorName(group.external.provider) } : around && source ? { url: around, name: vendorName(source.provider) } : null;
  const taskOf = useAttentionTasks(group ? [group] : []);
  const task = group?.signal_task_id ? taskOf(group.signal_task_id) : undefined;
  const facts: [string, ReactNode][] = [
    ["When", fmtStamp(x.at)],
    ["Source", <span key="s" className="inline-flex items-center gap-1.5">{source && <ProviderIcon provider={source.provider} />}{source?.name ?? "-"}</span>],
    ...(level ? [["Level", level] as [string, ReactNode]] : []),
    ...(type ? [["Type", type.replace(/_/g, " ")] as [string, ReactNode]] : []),
    ...(x.url ? [["URL", <a key="u" href={x.url} target="_blank" rel="noreferrer" className="ops-link modern:font-mono break-all">{x.url}</a>] as [string, ReactNode]] : []),
    ...(sampleWho(x) ? [["User", sampleWho(x)] as [string, ReactNode]] : []),
    ...(x.release ? [["Release", <span key="r" className="ops-mono">{x.release}</span>] as [string, ReactNode]] : []),
    ...(x.environment ? [["Env", x.environment] as [string, ReactNode]] : []),
  ];
  return (
    <aside className="otl-panel" aria-label="Occurrence" data-ops-sample-panel>
      <div className="otl-panel-head">
        {level && <span className="otl-level" data-level={level.toLowerCase()}>{level.toLowerCase()}</span>}
        <span className="flex-1" />
        <button type="button" className="otl-clear" aria-label="Close" onClick={onClose}><X className="w-4 h-4" /></button>
      </div>
      <div className="otl-panel-title"><SampleMessage sample={x} group={group} /></div>
      <dl className="ops-kv">
        {facts.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}
      </dl>
      {/* The issue first, with what codecast does about it (its task, the fix session, Fix, Resolve, Ignore): the event below is the evidence. */}
      {group && (
        <div className="otl-panel-group" data-ops-sample-issue>
          <div className="ops-section-label">Issue</div>
          <Link href={opsHref.issue(group.short_id)} className="otl-panel-issue">
            <KindGlyph kind={group.kind} />
            <span className="truncate">{group.title}</span>
            <span className="ops-dim ops-num">{group.count.toLocaleString()}×</span>
          </Link>
          <IssueActs group={group} task={task} />
        </div>
      )}
      {x.replay_id && <ReplayMoment replayRef={x.replay_id} at={x.at} />}
      {vendor && (
        <div className="otl-panel-acts">
          <a href={vendor.url} target="_blank" rel="noreferrer" className="ops-btn" data-ops-sample-vendor>View in {vendor.name}<ExternalLink className="w-3 h-3" /></a>
        </div>
      )}
      {x.message && x.message.includes("\n") && (
        <div className="otl-panel-group">
          <div className="ops-section-label">Message</div>
          <pre className="ops-code ops-mono otl-pre">{x.message}</pre>
        </div>
      )}
      {x.stack && (
        <div className="otl-panel-group">
          <div className="ops-section-label">Stack</div>
          <pre className="ops-code ops-mono otl-pre" data-ops-stack>{x.stack}</pre>
        </div>
      )}
      {tags && (
        <details className="otl-panel-group">
          <summary className="ops-section-label">Tags</summary>
          <pre className="ops-code ops-mono otl-pre">{tags}</pre>
        </details>
      )}
      {context && (
        <details className="otl-panel-group">
          <summary className="ops-section-label">Context</summary>
          <pre className="ops-code ops-mono otl-pre">{context}</pre>
        </details>
      )}
    </aside>
  );
}

/** A replay opened at the moment something happened in it: the player in place, and the replay page at that second. */
export function ReplayMoment({ replayRef, at }: { replayRef: string; at: number }) {
  // The replay may be past the window the replays list holds: read its own row.
  useSyncOpsReplay(replayRef);
  const replay = useOpsReplay(replayRef);
  const t = replayOffset(at, replay);
  const id = replay?.short_id || replayRef;
  // The embedded player already plays that moment and opens the replay page; the press stands in only until it can draw.
  return (
    <div className="otl-panel-group" data-ops-replay-moment={id}>
      {replay?.short_id ? (
        <ReplayMomentEmbed rawId={replayRefId(replay.short_id, t)} entity={replay} served href={opsHref.replay(id, t)} />
      ) : (
        <Link href={opsHref.replay(id, t)} className="ops-btn self-start">
          <Film className="w-3.5 h-3.5" />Watch replay{t !== null ? ` at ${formatCallTime(t)}` : ""}
        </Link>
      )}
    </div>
  );
}

/** An occurrence's message as a row reads it: a failed request as its method, path and coloured status (the host every row shares dropped), anything else as its first line. */
export function SampleMessage({ sample: x, group }: { sample: Pick<OpsSample, "message">; group?: Pick<OpsGroup, "title"> }) {
  const req = requestLine(x.message);
  if (!req) return <>{sampleTitle(x, group)}</>;
  return (
    // The status leads and the duration trails as fixed tokens; only the path gives way on a narrow row, so the part that matters is never cut.
    <span className="otl-req" data-ops-request title={`${req.method} ${req.path} → ${req.status}${req.ms !== null ? ` (${req.ms.toLocaleString()} ms)` : ""}`}>
      <span className="otl-req-st ops-num" data-level={requestLevel(req)}>{req.status}</span>
      <span className="otl-req-m">{req.method}</span>
      <span className="otl-req-path ops-mono">{req.path}</span>
      {req.ms !== null && <span className="otl-req-ms ops-dim ops-num">{req.ms.toLocaleString()}ms</span>}
    </span>
  );
}

/**
 * What a person does about an issue from a stream panel: its task chip, the
 * session fixing it, Fix while nobody is on it, and Resolve and Ignore (or
 * Reopen). The transition panel and the occurrence panel share it.
 */
export function IssueActs({ group, task }: { group: OpsGroup; task: AttentionTask | undefined }) {
  const item = issueWorkItem(group, task);
  const setStatus = (status: "open" | "resolved" | "ignored") => useInboxStore.getState().setOpsGroupStatus(group._id, status);
  return (
    <div className="otl-panel-acts ops-ref-fit" data-ops-panel-acts>
      <span className="otl-panel-facts ops-dim ops-num" data-ops-issue-status={group.status}>{group.regressed_at && group.status === "open" ? "regressed" : group.status}{group.users ? ` · ${group.users.toLocaleString()} users` : ""}</span>
      {group.signal_task_id && <TaskChip taskId={group.signal_task_id} task={task ?? null} />}
      {group.fix_conversation_id && group.status !== "open" && <EntityIdPill type="session" id={group.fix_conversation_id} />}
      {/* The issue's fix plan, read as everywhere else: open or continue its session, reopen its task, or start one. */}
      {group.status === "open" && <GroupFixSlots item={item} group={group} bare />}
      {group.status === "open" ? (
        <>
          <button type="button" className="ops-btn" onClick={() => setStatus("resolved")} data-ops-resolve><CheckCircle2 className="w-3.5 h-3.5" />Resolve</button>
          <button type="button" className="ops-btn" onClick={() => setStatus("ignored")} data-ops-ignore><EyeOff className="w-3.5 h-3.5" />Ignore</button>
        </>
      ) : (
        <button type="button" className="ops-btn" onClick={() => setStatus("open")} data-ops-reopen><RotateCcw className="w-3.5 h-3.5" />Reopen</button>
      )}
    </div>
  );
}
