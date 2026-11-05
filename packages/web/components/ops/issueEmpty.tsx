// What the Issues tab shows when it has no issues to list: nothing connected,
// sources that have sent nothing yet, or one source that never made an issue.
import { useContext } from "react";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useOpsReplays, useOpsWatches } from "../../hooks/useSyncOps";
import { relTimeShort } from "../../lib/utils";
import { opsHref, sourceConnectHref } from "./opsPaths";
import { OpsFeedEmpty, ProviderIcon, SETUP_HREF, SOURCE_PROVIDER_LABEL, SourceChip, SourceHealthContext, sourceFacts, type useOpsFeed } from "./parts";
import type { OpsSource } from "./opsTypes";
import { HealthBadge, HealthFixButton } from "./SourceHealthParts";
import { useSourceHealth } from "./useSourceHealth";

/** No groups at all: whether anything is connected, and if so, what each source last sent. */
export function IssuesEmpty({ feed, sources }: { feed: ReturnType<typeof useOpsFeed>; sources: OpsSource[] }) {
  if (!feed?.ready || feed.error) return <OpsFeedEmpty feeds={[feed]} what="issues" title="No issues" />;
  if (sources.length === 0) {
    return (
      <div className="iss-empty">
        <div className="text-[14px] text-sol-text font-medium">No sources connected</div>
        <div className="iss-providers">
          {(["sentry", "posthog", "app", "github", "sdk"] as const).map((p) => (
            <a key={p} href={sourceConnectHref(p)} className="iss-provider" data-provider={p}><ProviderIcon provider={p} className="w-4 h-4" />{p === "sdk" ? "Ingest key" : p === "github" ? "GitHub CI" : SOURCE_PROVIDER_LABEL[p]}</a>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="iss-empty">
      <div className="text-[14px] text-sol-text font-medium">No issues yet</div>
      <div className="iss-quiet-sources">
        {sources.map((s) => <QuietSource key={s._id} source={s} />)}
      </div>
      <a href={SETUP_HREF} className="ops-btn">Sources</a>
    </div>
  );
}

/** One source under No issues yet: what it last sent, and the press that fixes it when its health says it stopped or fails. */
function QuietSource({ source }: { source: OpsSource }) {
  // The shell's one health reading per source, the one its chip reads.
  const health = useContext(SourceHealthContext)?.get(source._id);
  const bad = !!health && (health.tone === "bad" || health.tone === "warn");
  return (
    <div className="iss-quiet-source" data-bad={bad ? "true" : undefined}>
      <SourceChip source={source} href={opsHref.tab("timeline", { source: source.name })} />
      <span className="ops-dim text-[11.5px] truncate">{sourceFacts(source).join(" · ")}</span>
      {bad && health && <HealthFixButton source={source} health={health} />}
    </div>
  );
}

/**
 * A source that has never produced an issue: its health first (with the
 * press that fixes it when something is wrong), then where its data does
 * land, each a count that opens the tab holding it. Not "all clear": a
 * source that sends moments or replays never makes issues at all.
 */
export function SourceNoIssues({ source }: { source: OpsSource }) {
  const health = useSourceHealth(source);
  const replays = useOpsReplays();
  const watches = useOpsWatches();
  const now = useCoarseNow(60_000);
  const nReplays = replays.filter((r) => r.source_id === source._id).length;
  const nWatches = watches.filter((w) => w.source_id === source._id).length;
  const days = source.days ?? [];
  const nEvents = days.reduce((a, d) => a + d.events, 0);
  const lands = [
    { tab: "timeline" as const, label: "Timeline", n: nEvents, unit: "events, 30d" },
    { tab: "replays" as const, label: "Replays", n: nReplays, unit: nReplays === 1 ? "replay" : "replays" },
    { tab: "metrics" as const, label: "Metrics", n: nWatches, unit: nWatches === 1 ? "watch" : "watches" },
  ].filter((l) => l.n > 0);
  const bad = health && (health.tone === "bad" || health.tone === "warn");
  return (
    <div className="ops-pad iss-list">
      <div className="iss-src-empty" data-bad={bad ? "true" : undefined}>
        <div className="iss-src-empty-head">
          <ProviderIcon provider={source.provider} className="w-4 h-4" />
          <span className="text-[14px] text-sol-text font-medium">{source.name}</span>
          {health && <HealthBadge health={health} />}
          <span className="ops-num ops-dim text-[12px]">0 issues</span>
        </div>
        <dl className="iss-src-facts ops-num">
          <dt>last event</dt>
          <dd>{health?.lastAt ?? source.last_event_at ? `${relTimeShort((health?.lastAt ?? source.last_event_at)!, now)} ago` : "never"}</dd>
          {health?.polledAt ? (<><dt>last poll</dt><dd>{relTimeShort(health.polledAt, now)} ago</dd></>) : null}
          {bad && health?.reason ? (<><dt>problem</dt><dd className="iss-src-reason" title={health.reason}>{health.reason}</dd></>) : null}
        </dl>
        {lands.length > 0 && (
          <div className="iss-src-lands">
            {lands.map((l) => (
              <a key={l.tab} href={opsHref.tab(l.tab, { source: source.name })} className="iss-src-land">
                <span className="iss-src-land-k">{l.label}</span>
                <span className="ops-num"><b>{l.n.toLocaleString()}</b> <span className="ops-dim">{l.unit}</span></span>
              </a>
            ))}
          </div>
        )}
        <div className="flex gap-2 flex-wrap">
          {health && bad && <HealthFixButton source={source} health={health} primary />}
          <a href={opsHref.home({ source: source.name })} className="ops-btn" data-tone={bad ? undefined : "primary"}>Open {source.name}</a>
        </div>
      </div>
    </div>
  );
}
