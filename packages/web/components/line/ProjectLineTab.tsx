"use client";
// A project's Line tab (the-line-model.md LM6, LM7; line-map.md LX1): the
// project's own line in one place. Its map leads: the stations of its actual
// graph with the data over them, a panel per node where every value of the
// line (finders, station prompts, checks, limits) is read and edited in place.
// Under it, what each version of the line delivered (LE14). The project's
// expectations have their own tab (components/expectations/ExpectationsTab).
import { useMemo } from "react";
import type { PublishedLineProfile } from "@codecast/shared/contracts/lineProfile";
import { useInboxStore } from "../../store/inboxStore";
import { isCause, scopeLine } from "../../lib/lineFlow";
import { lineSettingsHref } from "../../lib/lineSettings";
import { projectLineVersions, shortDay, type LineVersion } from "../../lib/line/runReport";
import { LinePage } from "./LinePage";
import { LineSetup } from "./LineSetup";
import { useLineFloor, useProjectWorkspace } from "./useLineFloor";
import { ReportSection } from "./RunReport";
import "./line.css";

type Project = { _id: string; short_id?: string | null; title?: string | null; workspace?: string | null; team_id?: string | null; line_profile?: PublishedLineProfile | null };


export function ProjectLineTab({ projectId }: { projectId: string }) {
  const project = useInboxStore((s) => (s.projects as Record<string, Project>)[projectId] ?? null);
  const workspace = useProjectWorkspace(project);
  const settings = lineSettingsHref({ project: project ?? projectId });
  const lp = project?.line_profile ?? null;
  // A line with nothing on it has no flow to draw: it leads with what the
  // line would do here and the one step that starts it.
  const { lineRows } = useLineFloor(projectId, workspace);
  const versions = useVersions(lineRows, projectId);
  const empty = useMemo(() => {
    const scoped = scopeLine(lineRows, projectId);
    return !scoped.tasks.some(isCause) && scoped.signals.length === 0 && scoped.runs.length === 0;
  }, [lineRows, projectId]);

  return (
    <div className="max-w-[96rem] mx-auto px-4 sm:px-6 py-5 space-y-8" data-project-line-tab={projectId} data-line-tab-empty={empty ? "" : undefined}>
      {empty && !lp ? (
        <LineSetup title={project?.title ?? "this project"} profiled={false} href={settings} />
      ) : (
        <div className="rounded-xl border border-sol-border/30 overflow-hidden h-[560px] sm:h-[680px]" data-project-line-flow>
          <LinePage project={projectId} workspace={workspace} />
        </div>
      )}

      {!empty && <Versions versions={versions} />}
    </div>
  );
}

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "");
const usd = (n: number | null) => (n == null ? "" : n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);

/** What each version of the line on this project delivered (LE14), keyed by
 *  the graph hash every run records, newest first. */
function useVersions(lineRows: ReturnType<typeof useLineFloor>["lineRows"], projectId: string): LineVersion[] {
  return useMemo(() => projectLineVersions(scopeLine(lineRows, projectId)), [lineRows, projectId]);
}

function Versions({ versions }: { versions: LineVersion[] }) {
  return (
    <ReportSection title="Versions" aside="each version of the line, what it changed and what it delivered, newest first">
      {versions.length === 0 ? (
        <p className="text-[12.5px] text-sol-text-dim">No line run on this project yet. Each run records the version of the line it ran, so a change to a station can be compared by what it delivered.</p>
      ) : (
        <table className="cast-table w-full text-[12.5px] tabular-nums" data-line-versions>
          <thead>
            <tr className="text-left text-[11px] text-sol-text-dim">
              <th className="font-normal py-1 pr-3">Version</th>
              <th className="font-normal py-1 pr-3">Ran</th>
              <th className="font-normal py-1 pr-3 text-right">Runs</th>
              <th className="font-normal py-1 pr-3 text-right">Shipped</th>
              <th className="font-normal py-1 pr-3 text-right">Revised</th>
              <th className="font-normal py-1 pr-3 text-right">Dropped</th>
              <th className="font-normal py-1 pr-3 text-right" title="Stopped before an answer: a step failed, looped or ran out of time">Stopped</th>
              <th className="font-normal py-1 pr-3 text-right">Reopened</th>
              <th className="font-normal py-1 text-right">Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-sol-border/20">
            {versions.map((v, i) => (
              <tr key={v.hash} data-line-version={v.hash}>
                <td className="py-1.5 pr-3 text-sol-text">
                  <span className={v.hash === "unrecorded" ? "text-sol-text-dim" : undefined}>{v.change}</span>
                  {v.hash !== "unrecorded" && <span className="ml-2 font-mono text-[10.5px] text-sol-text-dim" title={`Graph ${v.hash}`}>{v.hash.slice(0, 8)}</span>}
                  {i === 0 && v.hash !== "unrecorded" && <span className="ml-2 text-[10.5px] text-sol-text-dim">latest</span>}
                </td>
                <td className="py-1.5 pr-3 text-sol-text-muted">{shortDay(v.first)}{v.last - v.first > 86_400_000 ? ` to ${shortDay(v.last)}` : ""}</td>
                <td className="py-1.5 pr-3 text-right text-sol-text">{v.runs}{v.live ? <span className="text-sol-cyan"> ({v.live} live)</span> : null}</td>
                <td className="py-1.5 pr-3 text-right text-sol-green">{v.shipped} <span className="text-sol-text-dim">{pct(v.shipped, v.runs)}</span></td>
                <td className="py-1.5 pr-3 text-right text-sol-text">{v.revised} <span className="text-sol-text-dim">{pct(v.revised, v.runs)}</span></td>
                <td className="py-1.5 pr-3 text-right text-sol-text">{v.dropped}</td>
                <td className={v.stopped ? "py-1.5 pr-3 text-right text-sol-orange" : "py-1.5 pr-3 text-right text-sol-text"}>{v.stopped}</td>
                <td className={v.reopened ? "py-1.5 pr-3 text-right text-sol-red" : "py-1.5 pr-3 text-right text-sol-text"}>{v.reopened}</td>
                <td className="py-1.5 text-right text-sol-text-muted">{usd(v.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ReportSection>
  );
}
