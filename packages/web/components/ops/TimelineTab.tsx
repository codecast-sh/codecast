// The Timeline tab: every transition across the workspace's sources on one
// time axis, one lane per source, with deploys drawn across all lanes so a
// regression reads against the release that brought it. Under it, the same
// transitions as rows, rendered by the one external event row.
import { useMemo, useState } from "react";
import Link from "next/link";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useOpsEvents, useOpsSources, useSyncOpsEvents } from "../../hooks/useSyncOps";
import { accentVar, eventAccent, externalEventRowToExternalEvent, externalEventStyle } from "../../lib/externalEvents";
import { ExternalEventRow } from "../feed/ExternalEventRow";
import { TIMELINE_WINDOWS, clusterMarks, eventSourceName, fitTimelineWindow, layoutTimeline, type TimelineWindowKey } from "./opsModel";
import { opsHref } from "./opsPaths";
import { OpsFeedEmpty, ProviderIcon, SETUP_HREF, useOpsFeed } from "./parts";
import type { OpsEvent } from "./opsTypes";

function tickLabel(at: number, windowMs: number): string {
  const d = new Date(at);
  if (windowMs > 72 * 3600_000) return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return windowMs <= 3600_000 ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleTimeString([], { hour: "numeric" });
}

/** Marks nearer than this share of the track merge into one counted cluster. */
const CLUSTER_GAP = 0.012;

function markTitle(e: OpsEvent): string {
  const verb = externalEventStyle(e.kind).verb;
  const when = new Date(e.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `${e.data?.group_short_id ?? ""} ${verb}: ${e.title}\n${when}${e.data?.release ? ` · ${e.data.release}` : ""}`.trim();
}

export function TimelineTab({ source }: { source: string | null }) {
  const eventsFeed = useSyncOpsEvents();
  const sourcesFeed = useOpsFeed("sources");
  const all = useOpsEvents();
  const sources = useOpsSources();
  const now = useCoarseNow(60_000);
  // Until a person picks a window, it fits the activity: a burst from the last
  // hour spreads across the axis instead of piling onto its right edge.
  const [picked, setPicked] = useState<TimelineWindowKey | null>(null);
  const events = useMemo(() => (source ? all.filter((e) => eventSourceName(e) === source) : all), [all, source]);
  const fitted = useMemo(() => fitTimelineWindow(events, now), [events, now]);
  const windowKey = picked ?? fitted;
  const windowMs = TIMELINE_WINDOWS.find((w) => w.key === windowKey)!.ms;
  const layout = useMemo(() => layoutTimeline(events, now, windowMs), [events, now, windowMs]);
  const providerOf = useMemo(() => new Map(sources.map((s) => [s.name, s.provider])), [sources]);
  const rows = useMemo(() => events.slice(0, 100).map((e) => externalEventRowToExternalEvent(e as any)), [events]);

  if (!sources.length && !all.length) {
    return (
      <OpsFeedEmpty feeds={[sourcesFeed, eventsFeed]} what="the timeline" title="No sources yet">
        Errors, failed jobs, checks, metrics and deploys from your product show up here once a source feeds this
        workspace. <Link href={SETUP_HREF} className="text-sol-link hover:underline">Add an SDK source</Link> or connect
        Sentry or PostHog on Settings, or run <span className="ops-mono">cast sources add</span>.
      </OpsFeedEmpty>
    );
  }

  return (
    <div className="ops-pad">
      <div className="ops-filters">
        <div className="ops-section-label !m-0">Transitions</div>
        <span className="ops-dim text-[11.5px] ops-num">
          {layout.lanes.reduce((n, l) => n + l.marks.length, 0)} in the last {windowKey}
          {layout.releases.length ? `, ${layout.releases.length} deploy${layout.releases.length === 1 ? "" : "s"}` : ""}
        </span>
        <div className="flex-1" />
        <div className="ops-seg" role="group" aria-label="Window">
          {TIMELINE_WINDOWS.map((w) => (
            <button key={w.key} type="button" data-on={w.key === windowKey ? "true" : undefined} aria-pressed={w.key === windowKey} onClick={() => setPicked(w.key)}>
              {w.key}
            </button>
          ))}
        </div>
      </div>

      <div className="ops-tl">
        <div className="ops-tl-axis">
          {layout.ticks.map((t) => (
            <span key={t.at} className="ops-tl-tick ops-num" style={{ left: `${t.x * 100}%` }}>{tickLabel(t.at, windowMs)}</span>
          ))}
        </div>
        <div className="relative ops-tl-lanes" data-releases={layout.releases.length ? "true" : undefined}>
          {layout.lanes.length === 0 && (
            <div className="ops-tl-lane">
              <div className="ops-tl-name ops-dim">nothing</div>
              <div className="ops-tl-track" />
            </div>
          )}
          {layout.lanes.map((lane) => (
            <div key={lane.source} className="ops-tl-lane">
              <div className="ops-tl-name" title={lane.source}>
                {providerOf.get(lane.source) && <ProviderIcon provider={providerOf.get(lane.source)!} />}
                <span className="truncate">{lane.source}</span>
                <span className="ops-dim ops-num ml-auto">{lane.marks.length}</span>
              </div>
              <div className="ops-tl-track">
                {clusterMarks(lane.marks, CLUSTER_GAP).map(({ x, marks }) => {
                  // A cluster leads with its newest red mark (else its newest), takes
                  // that mark's color and issue, and names every mark on hover: a
                  // recovery on top must not paint over the failures under it.
                  const accentOf = (e: OpsEvent) => eventAccent(externalEventRowToExternalEvent(e as any));
                  const event = (marks.find((m) => accentOf(m.event) === "red") ?? marks[0]).event;
                  const href = event.data?.group_short_id ? opsHref.issue(event.data.group_short_id) : undefined;
                  const color = accentVar(accentOf(event));
                  const many = marks.length > 1;
                  const title = many
                    ? `${marks.length} transitions\n${marks.slice(0, 8).map((m) => markTitle(m.event).split("\n")[0]).join("\n")}${marks.length > 8 ? `\n+${marks.length - 8} more` : ""}`
                    : markTitle(event);
                  const props = {
                    className: many ? "ops-tl-cluster ops-num" : "ops-tl-mark",
                    style: { left: `${x * 100}%`, background: color },
                    title,
                    children: many ? marks.length : undefined,
                  };
                  return href ? <Link key={event._id} href={href} aria-label={title} {...props} /> : <span key={event._id} {...props} />;
                })}
              </div>
            </div>
          ))}
          {layout.releases.length > 0 && <div className="ops-tl-strip-name">deploys</div>}
          <div className="ops-tl-overlay">
            {layout.releases.map(({ event, x }) => (
              <div key={event._id} className="ops-tl-release" data-edge={x > 0.85 ? "end" : undefined} style={{ left: `${x * 100}%` }} title={markTitle(event)}>
                <span className="ops-mono">{event.data?.release ?? "deploy"}</span>
              </div>
            ))}
            <div className="ops-tl-now" />
          </div>
        </div>
      </div>

      <div className="mt-6">
        <div className="ops-section-label">Newest first</div>
        {rows.length === 0 ? (
          <div className="ops-quiet text-[12.5px] py-6">Nothing has moved{source ? ` on ${source}` : ""}. A new error, a regression, a failed check or a deploy lands here.</div>
        ) : (
          <div className="flex flex-col">
            {rows.map((r) => (
              <ExternalEventRow key={r.id} event={r} density="compact" showActor={false} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
