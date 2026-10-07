// The Issues tab: every group across the workspace's sources, newest activity
// first, with the last 72 hours as bars from the group's own buckets. j and k
// move, Enter opens.
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { GroupKind, GroupStatus } from "@codecast/shared/contracts/ingest";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useOpsGroups, useOpsSources } from "../../hooks/useSyncOps";
import { hasOpenModal, isEditableTarget } from "../../shortcuts";
import { relTimeShort } from "../../lib/utils";
import { EntityIdPill } from "../EntityIdPill";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { Spark } from "../Spark";
import { bucketSeries } from "./opsModel";
import { opsHref } from "./opsPaths";
import { KIND_LOOK, KindGlyph, OpsFeedEmpty, SourceChip, StatusPill, pressable, useOpsFeed } from "./parts";
import type { OpsGroup } from "./opsTypes";
import { useWatchEffect } from "../../hooks/useWatchEffect";

const STATUS_FILTERS: { key: GroupStatus | "all"; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "resolved", label: "Resolved" },
  { key: "ignored", label: "Ignored" },
  { key: "all", label: "All" },
];

export function IssuesTab({ source }: { source: string | null }) {
  const all = useOpsGroups();
  const sources = useOpsSources();
  const feed = useOpsFeed("groups");
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const now = useCoarseNow(60_000);
  const router = useRouter();
  const [status, setStatus] = useState<GroupStatus | "all">("open");
  const [kind, setKind] = useState<GroupKind | null>(null);
  const [focus, setFocus] = useState(0);
  const sourceById = useMemo(() => new Map(sources.map((s) => [s._id, s])), [sources]);
  const sourceId = source ? sources.find((s) => s.name === source)?._id : undefined;

  const groups = useMemo(
    () =>
      all.filter(
        (g) =>
          (status === "all" || g.status === status || (status === "ignored" && g.status === "muted")) &&
          (!kind || g.kind === kind) &&
          (!source || g.source_id === sourceId),
      ),
    [all, status, kind, source, sourceId],
  );
  const kinds = useMemo(() => [...new Set(all.map((g) => g.kind))], [all]);

  useWatchEffect(() => setFocus(0), [status, kind, source]);
  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isEditableTarget(e.target) || hasOpenModal()) return;
      if (e.key === "j" || e.key === "ArrowDown") setFocus((f) => Math.min(groups.length - 1, f + 1));
      else if (e.key === "k" || e.key === "ArrowUp") setFocus((f) => Math.max(0, f - 1));
      else if (e.key === "Enter" && groups[focus]) router.push(opsHref.issue(groups[focus].short_id || groups[focus]._id));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [groups, focus, router]);
  // j and k can walk past the fold: keep the focused row on screen.
  useWatchEffect(() => {
    bodyRef.current?.querySelector<HTMLElement>("[data-focused]")?.scrollIntoView({ block: "nearest" });
  }, [focus]);

  if (all.length === 0) {
    return (
      <OpsFeedEmpty feeds={[feed]} what="issues" title="No issues">
        A group opens the first time a source sends an error, a failed job, a red check or a metric across its line.
      </OpsFeedEmpty>
    );
  }

  return (
    <div className="ops-pad">
      <div className="ops-filters">
        <div className="ops-seg" role="group" aria-label="Status">
          {STATUS_FILTERS.map((f) => (
            <button key={f.key} type="button" data-on={status === f.key ? "true" : undefined} aria-pressed={status === f.key} onClick={() => setStatus(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
        {kinds.length > 1 && (
          <div className="ops-seg" role="group" aria-label="Kind">
            <button type="button" data-on={!kind ? "true" : undefined} aria-pressed={!kind} onClick={() => setKind(null)}>every kind</button>
            {kinds.map((k) => (
              <button key={k} type="button" data-on={kind === k ? "true" : undefined} aria-pressed={kind === k} onClick={() => setKind(k)}>{KIND_LOOK[k].label}</button>
            ))}
          </div>
        )}
        <div className="flex-1" />
        <span className="ops-dim text-[11px] inline-flex items-center gap-1">
          <KeyCap size="xs">j</KeyCap><KeyCap size="xs">k</KeyCap> move <KeyCap size="xs">Enter</KeyCap> open
        </span>
      </div>

      {groups.length === 0 ? (
        <div className="ops-quiet text-[12.5px] py-8 text-center">Nothing {status === "all" ? "" : status} here{source ? ` on ${source}` : ""}.</div>
      ) : (
        <table className="ops-table ops-table-fixed">
          <thead>
            <tr>
              <th style={{ width: 34 }} />
              <th>Issue</th>
              <th style={{ width: 168 }}>Last 72h</th>
              <th style={{ width: 64, textAlign: "right" }}>Count</th>
              <th style={{ width: 64 }}>Seen</th>
              <th style={{ width: 140 }}>Source</th>
              <th style={{ width: 80 }}>Status</th>
              <th style={{ width: 150 }}>Cause</th>
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {groups.map((g, i) => (
              <IssueRow key={g._id} group={g} now={now} focused={i === focus} source={sourceById.get(g.source_id)} onOpen={() => router.push(opsHref.issue(g.short_id || g._id))} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function IssueRow({ group: g, now, focused, source, onOpen }: { group: OpsGroup; now: number; focused: boolean; source?: { name: string; provider: any; status: any; last_error?: string }; onOpen: () => void }) {
  const series = useMemo(() => bucketSeries(g.buckets, now), [g.buckets, now]);
  const failing = g.kind === "check" || g.kind === "metric" ? g.meta?.ok === false : undefined;
  return (
    <tr data-row data-focused={focused ? "true" : undefined} data-status={g.status} aria-label={`${g.short_id} ${g.title}`} {...pressable(onOpen, "link")}>
      <td><KindGlyph kind={g.kind} /></td>
      <td className="min-w-0">
        <div className="ops-row-title text-sol-text truncate" title={g.title}>{g.title}</div>
        <div className="ops-dim text-[11px] truncate">
          <span className="ops-mono">{g.short_id}</span>
          {g.culprit ? <span className="ops-mono"> · {g.culprit}</span> : null}
          {g.last_release ? <span> · {g.last_release}</span> : null}
        </div>
      </td>
      <td>
        <Spark values={series} bar={1.5} gap={0.5} height={18} tone={g.status === "open" ? "var(--sol-red)" : "var(--sol-text-muted)"} label={`${g.short_id}, per hour over 72 hours`} />
      </td>
      <td className="ops-num text-right">{g.count.toLocaleString()}</td>
      <td className="ops-num ops-quiet" title={new Date(g.last_seen).toLocaleString()}>{relTimeShort(g.last_seen, now)}</td>
      <td className="ops-cell-fit">{source ? <SourceChip source={source} /> : <span className="ops-dim">gone</span>}</td>
      <td><StatusPill status={g.status} failing={failing} /></td>
      <td className="ops-cell-fit ops-ref-fit" onClick={(e) => e.stopPropagation()}>{g.signal_task_id ? <EntityIdPill type="task" id={g.signal_task_id} compact /> : <span className="ops-dim">none</span>}</td>
    </tr>
  );
}
