// /ops/issues/:id: one group. The stack with the product's own frames lit,
// its recent samples, and on the side the chain the page exists for: the
// release it was last seen in, the commit behind it and the session that
// wrote that commit, the cause it promoted to on the line, the triggers that
// wake on it, the replays that caught it and its transitions. Start fix
// opens a session on it, the replay page's action for issues with no replay.
import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight, ExternalLink, Wand2 } from "lucide-react";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { byRef, detailGone, groupSha, useOpsEvents, useOpsGroups, useOpsReplays, useOpsSamples, useOpsSources, useShaCommit, useSyncOpsEvents, useSyncOpsGroup, useSyncShaCommit } from "../../hooks/useSyncOps";
import { useTriggers } from "../../hooks/useSyncTriggers";
import { useInboxStore } from "../../store/inboxStore";
import { externalEventStyle, commitPath } from "../../lib/externalEvents";
import { formatRelative, relTimeShort } from "../../lib/utils";
import { formatReplayTime } from "@codecast/shared/replay";
import { kindTriggerEvents, type GroupStatus } from "@codecast/shared/contracts/ingest";
import { EntityIdPill } from "../EntityIdPill";
import { Spark } from "../Spark";
import { bucketSeries, foldRuns, readStack, replayPlace, topInAppFrame, triggersOnGroup } from "./opsModel";
import { opsHref } from "./opsPaths";
import { KindGlyph, OpsEmpty, OpsFeedError, SourceChip, StatusPill } from "./parts";
import { startOpsFixSession } from "./startFix";
import type { OpsGroup, OpsSample } from "./opsTypes";

export function IssuePage({ id }: { id: string }) {
  const feed = useSyncOpsGroup(id);
  useSyncOpsEvents();
  const group = byRef(useOpsGroups(), id);
  const sources = useOpsSources();
  const source = group ? sources.find((s) => s._id === group.source_id) : undefined;
  const samples = useOpsSamples(group?._id);
  const now = useCoarseNow(60_000);

  // A group the server no longer has is gone even if this device cached it
  // (useSyncOpsGroup drops the row): its actions would fail on the server.
  if (detailGone(feed)) return <OpsEmpty title={`${id} is not here`}>It may belong to another workspace, or its source was removed.</OpsEmpty>;
  if (!group) {
    if (feed.error) return <OpsFeedError what={id} retry={feed.retry} />;
    return <div className="ops-detail ops-quiet text-[12.5px]">Opening {id}…</div>;
  }

  const series = bucketSeries(group.buckets, now);
  const failing = group.kind === "check" || group.kind === "metric" ? group.meta?.ok === false : undefined;
  const latestStack = samples.find((s) => s.stack)?.stack;

  return (
    <div className="ops-detail">
      <div className="ops-crumb">
        <Link href={opsHref.tab("issues")}>Issues</Link>
        <ChevronRight className="w-3 h-3" />
        <span className="ops-mono">{group.short_id}</span>
      </div>
      <div className="flex items-start gap-3 mt-1">
        <div className="mt-2.5"><KindGlyph kind={group.kind} /></div>
        <div className="flex-1 min-w-0">
          <h1 className="ops-h1">{group.title}</h1>
          <div className="flex items-center gap-2 flex-wrap text-[12px] ops-quiet">
            <StatusPill status={group.status} failing={failing} />
            {source && <SourceChip source={source} href={opsHref.tab("issues", { source: source.name })} />}
            {group.culprit && <span className="ops-mono text-sol-text">{group.culprit}</span>}
            <span className="ops-dim">·</span>
            <span className="ops-num">{group.count.toLocaleString()} times{group.users ? `, ${group.users} people` : ""}</span>
            <span className="ops-dim">·</span>
            <span>first {formatRelative(group.first_seen, now)}, last {formatRelative(group.last_seen, now)}</span>
            {group.external?.url && (
              <a href={group.external.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-sol-text">
                {group.external.provider} <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        </div>
        <StatusActions group={group} samples={samples} />
      </div>

      <div className="ops-card mt-4 px-3 py-2.5 flex items-end gap-3">
        <Spark values={series} bar={5} gap={2} height={40} tone={group.status === "open" ? "var(--sol-red)" : "var(--sol-text-muted)"} label="occurrences per hour, last 72 hours" className="flex-1 min-w-0" stretch />
        <div className="ops-dim text-[11px] whitespace-nowrap">per hour, 72h</div>
      </div>

      <div className="ops-grid">
        <div className="min-w-0 ops-col">
          {latestStack ? <StackCard stack={latestStack} /> : null}
          <SamplesCard samples={samples} title={group.title} now={now} />
          {group.kind === "metric" && group.meta?.value !== undefined && (
            <div className="ops-card">
              <div className="ops-card-head">Metric</div>
              <div className="ops-card-body ops-num">
                {group.meta.value} against a line at {group.meta.threshold} ({group.meta.direction})
              </div>
            </div>
          )}
        </div>
        <aside className="min-w-0 ops-col">
          <ReleaseCard group={group} />
          <CauseCard group={group} />
          <TriggersCard group={group} sourceName={source?.name ?? null} />
          <ReplaysCard group={group} samples={samples} />
          <TransitionsCard group={group} now={now} />
        </aside>
      </div>
    </div>
  );
}

function StatusActions({ group, samples }: { group: OpsGroup; samples: OpsSample[] }) {
  const set = (status: GroupStatus) => useInboxStore.getState().setOpsGroupStatus(group._id, status);
  const startFix = () => {
    const latest = samples[0];
    startOpsFixSession(
      {
        groupRefs: [group.short_id || group._id],
        title: group.title,
        culprit: group.culprit,
        frame: topInAppFrame(samples.find((s) => s.stack)?.stack),
        release: group.last_release,
        url: latest?.url,
      },
      group.source_id,
    );
  };
  const fix = (
    <button type="button" className="ops-btn" onClick={startFix} title="A session seeded with this issue, in the project its source is attached to">
      <Wand2 className="w-3.5 h-3.5" /> Start fix session
    </button>
  );
  if (group.status === "open") {
    return (
      <div className="flex gap-2 shrink-0 mt-2">
        {fix}
        <button type="button" className="ops-btn" onClick={() => set("ignored")} title="Stop counting this as open; new occurrences do not reopen it">Ignore</button>
        <button type="button" className="ops-btn" data-tone="primary" onClick={() => set("resolved")} title="Resolve; an occurrence from a newer release reopens it as a regression">Resolve</button>
      </div>
    );
  }
  return (
    <div className="flex gap-2 shrink-0 mt-2">
      {fix}
      <button type="button" className="ops-btn" onClick={() => set("open")}>Reopen</button>
    </div>
  );
}

function StackCard({ stack }: { stack: string }) {
  const lines = useMemo(() => readStack(stack), [stack]);
  const [all, setAll] = useState(false);
  const outside = lines.filter((l) => l.frame && !l.in_app).length;
  const shown = all ? lines : lines.filter((l) => !l.frame || l.in_app);
  return (
    <div className="ops-card">
      <div className="ops-card-head">
        <span>Stack</span>
        {outside > 0 && (
          <button type="button" className="ops-dim text-[11px] font-normal hover:text-sol-text" onClick={() => setAll((v) => !v)}>
            {all ? "your code only" : `show ${outside} library frame${outside === 1 ? "" : "s"}`}
          </button>
        )}
      </div>
      <div className="ops-stack ops-mono">
        {shown.map((l, i) => (
          <div key={i} data-frame={l.frame ? "true" : "false"} data-inapp={l.in_app ? "true" : "false"}>{l.text}</div>
        ))}
      </div>
    </div>
  );
}

function parseJson(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/**
 * A sample's line leads with what tells it apart. The message is the group's
 * title on nearly every sample, so it shows only when it differs; otherwise
 * the place and the person carry the row.
 */
function sampleLine(s: OpsSample, title: string): { lead: string; who: string | null } {
  const who = s.user?.email ?? s.user?.name ?? s.user?.id ?? null;
  const message = s.message && s.message !== title ? s.message : null;
  return { lead: message ?? replayPlace(s.url) ?? s.message ?? "occurrence", who };
}

function SamplesCard({ samples, title, now }: { samples: OpsSample[]; title: string; now: number }) {
  const [open, setOpen] = useState<string | null>(null);
  // Samples that read alike in a row fold into one line with a count; opening it shows the newest.
  const runs = useMemo(() => foldRuns(samples, (s) => {
    const l = sampleLine(s, title);
    return [l.lead, l.who, s.release, s.environment, s.replay_id].join("|");
  }), [samples, title]);
  return (
    <div className="ops-card">
      <div className="ops-card-head"><span>Samples <span className="ops-dim ops-num">{samples.length}</span></span><span className="ops-dim text-[11px] font-normal">the newest occurrences, 20 kept</span></div>
      {samples.length === 0 ? (
        <div className="ops-card-body ops-dim">No samples kept for this group.</div>
      ) : (
        runs.map(({ row: s, count, oldest }) => {
          const tags = parseJson(s.tags_json);
          const context = parseJson(s.context_json);
          const expanded = open === s._id;
          const line = sampleLine(s, title);
          return (
            <div key={s._id} className="border-b last:border-b-0" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 55%, transparent)" }}>
              <button type="button" className="w-full text-left px-3 py-2 flex items-baseline gap-2 text-[12px] hover:bg-[color-mix(in_srgb,var(--sol-text)_4%,transparent)]" onClick={() => setOpen(expanded ? null : s._id)}>
                <span className="ops-num ops-dim w-[54px] shrink-0" title={count > 1 ? `${new Date(oldest.at).toLocaleString()} to ${new Date(s.at).toLocaleString()}` : new Date(s.at).toLocaleString()}>
                  {count > 1 && relTimeShort(oldest.at, now) !== relTimeShort(s.at, now) ? `${relTimeShort(s.at, now)}-${relTimeShort(oldest.at, now)}` : relTimeShort(s.at, now)}
                </span>
                <span className="truncate flex-1 text-sol-text ops-mono" title={s.url ?? undefined}>{line.lead}</span>
                {count > 1 && <span className="ops-pill ops-num" style={{ color: "var(--sol-text-muted)", background: "color-mix(in srgb, var(--sol-text-muted) 12%, transparent)" }}>{count} alike</span>}
                {line.who && <span className="ops-quiet text-[11px] truncate max-w-[180px]">{line.who}</span>}
                {s.release && <span className="ops-mono ops-dim text-[11px]">{s.release}</span>}
                {s.environment && <span className="ops-dim text-[11px]">{s.environment}</span>}
              </button>
              {expanded && (
                <dl className="ops-kv px-3 pb-3">
                  {s.url && (<><dt>url</dt><dd className="ops-mono">{s.url}</dd></>)}
                  {s.user && (<><dt>person</dt><dd>{s.user.email ?? s.user.name ?? s.user.id}</dd></>)}
                  {s.level && (<><dt>level</dt><dd>{s.level}</dd></>)}
                  {tags && Object.entries(tags).map(([k, v]) => (<Fragment key={k}><dt className="ops-mono">{k}</dt><dd className="ops-mono">{String(v)}</dd></Fragment>))}
                  {context && (<><dt>context</dt><dd><pre className="ops-code">{JSON.stringify(context, null, 2)}</pre></dd></>)}
                  {s.replay_id && (<><dt>replay</dt><dd><Link className="text-sol-link hover:underline" href={opsHref.replay(s.replay_id)}>open the replay</Link></dd></>)}
                </dl>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

function ReleaseCard({ group }: { group: OpsGroup }) {
  const sha = groupSha(group);
  useSyncShaCommit(sha);
  const commit = useShaCommit(sha);
  const href = commit?.repository && commit?.sha ? commitPath({ repository: commit.repository, sha: commit.sha }) : null;
  return (
    <div className="ops-card">
      <div className="ops-card-head">Release</div>
      <div className="ops-card-body">
        <dl className="ops-kv">
          <dt>last seen in</dt>
          <dd className="ops-mono">{group.last_release ?? <span className="ops-dim">no release sent</span>}</dd>
          {group.first_release && group.first_release !== group.last_release && (<><dt>first seen in</dt><dd className="ops-mono">{group.first_release}</dd></>)}
          {group.resolved_in && (<><dt>resolved in</dt><dd className="ops-mono">{group.resolved_in}</dd></>)}
          <dt>commit</dt>
          <dd>
            {commit ? (
              href ? <Link href={href} className="hover:underline"><span className="ops-mono">{commit.sha.slice(0, 7)}</span> <span className="ops-quiet">{String(commit.message ?? "").split("\n")[0]}</span></Link>
                : <span className="ops-mono">{commit.sha.slice(0, 7)}</span>
            ) : sha ? <span className="ops-mono ops-dim">{sha.slice(0, 7)}, not a commit codecast has seen</span> : <span className="ops-dim">send a sha with the deploy to join it</span>}
          </dd>
          <dt>written in</dt>
          <dd>{commit?.conversation_id ? <EntityIdPill type="session" id={commit.conversation_id} /> : <span className="ops-dim">{commit ? "not made in a codecast session" : "unknown"}</span>}</dd>
        </dl>
      </div>
    </div>
  );
}

function CauseCard({ group }: { group: OpsGroup }) {
  return (
    <div className="ops-card">
      <div className="ops-card-head">Cause on the line</div>
      <div className="ops-card-body ops-ref-fit">
        {group.signal_task_id ? (
          <EntityIdPill type="task" id={group.signal_task_id} />
        ) : (
          <span className="ops-dim text-[12px]">Not promoted. A source promotes the transitions it lists (new and regressed errors by default).</span>
        )}
      </div>
    </div>
  );
}

function TriggersCard({ group, sourceName }: { group: OpsGroup; sourceName: string | null }) {
  const { tasks } = useTriggers();
  const hits = useMemo(() => triggersOnGroup(tasks, group, sourceName), [tasks, group, sourceName]);
  // The event to suggest is the contract's, the same list triggersOnGroup matches.
  const wakeEvent = kindTriggerEvents(group.kind)[0];
  return (
    <div className="ops-card">
      <div className="ops-card-head"><span>Triggers <span className="ops-dim ops-num">{hits.length}</span></span></div>
      <div className="ops-card-body flex flex-col gap-1.5">
        {hits.length === 0 ? (
          <span className="ops-dim text-[12px]">
            {wakeEvent ? (
              <>Nothing wakes on this. <span className="ops-mono">cast trigger add --on {wakeEvent}{sourceName ? ` --source ${sourceName}` : ""}</span></>
            ) : (
              <>A {group.kind.replace("_", " ")} group fires no trigger events, so nothing can wake on it.</>
            )}
          </span>
        ) : (
          hits.map(({ trigger, event, waiting }) => (
            <Link key={trigger._id} href={`/triggers/${trigger._id}`} className="flex items-baseline gap-2 text-[12px] hover:underline">
              <span className="truncate flex-1 text-sol-text">{trigger.display_title ?? trigger.title ?? trigger.prompt?.slice(0, 60)}</span>
              <span className="ops-mono ops-dim text-[11px]">{event}</span>
              {waiting && <span className="ops-pill" style={{ color: "var(--sol-amber)", background: "color-mix(in srgb, var(--sol-amber) 14%, transparent)" }}>fired</span>}
            </Link>
          ))
        )}
      </div>
    </div>
  );
}

function ReplaysCard({ group, samples }: { group: OpsGroup; samples: OpsSample[] }) {
  const replays = useOpsReplays();
  const linked = useMemo(() => {
    const fromSamples = new Set(samples.map((s) => s.replay_id).filter(Boolean) as string[]);
    return replays.filter((r) => r.group_ids.includes(group._id) || fromSamples.has(r._id));
  }, [replays, samples, group._id]);
  if (linked.length === 0) return null;
  return (
    <div className="ops-card">
      <div className="ops-card-head"><span>Replays <span className="ops-dim ops-num">{linked.length}</span></span></div>
      <div className="ops-card-body flex flex-col gap-1.5">
        {linked.slice(0, 8).map((r) => (
          <Link key={r._id} href={opsHref.replay(r.short_id || r._id)} className="flex items-baseline gap-2 text-[12px] hover:underline">
            <span className="ops-mono">{r.short_id}</span>
            <span className="ops-quiet truncate flex-1">{r.user?.email ?? r.user?.name ?? r.url ?? ""}</span>
            <span className="ops-dim ops-num text-[11px]">{r.duration_ms ? formatReplayTime(r.duration_ms) : ""}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function TransitionsCard({ group, now }: { group: OpsGroup; now: number }) {
  const events = useOpsEvents();
  const mine = useMemo(() => events.filter((e) => e.group_id === group._id || e.data?.group_short_id === group.short_id), [events, group._id, group.short_id]);
  if (mine.length === 0) return null;
  return (
    <div className="ops-card">
      <div className="ops-card-head">Transitions</div>
      <div className="ops-card-body flex flex-col gap-1">
        {mine.slice(0, 12).map((e) => {
          const st = externalEventStyle(e.kind);
          return (
            <div key={e._id} className="flex items-baseline gap-2 text-[12px]">
              <span className="text-sol-text">{st.verb}</span>
              {e.data?.release && <span className="ops-mono ops-dim text-[11px]">{e.data.release}</span>}
              <span className="ops-dim ops-num ml-auto text-[11px]">{relTimeShort(e.created_at, now)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
