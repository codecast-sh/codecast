"use client";
// A project's Line tab (the-line-model.md LM6, LM7; line-workspace.md LW1):
// the project's own line in one place. Its workspace leads: the graph,
// notebook, replay, chat and timeline over one model, with the start switch
// and what waits on you in its header. Under it, what each version of the line delivered (LE14). The project's
// expectations have their own tab (components/expectations/ExpectationsTab).
import { useMemo, type ReactNode } from "react";
import type { PublishedLineProfile } from "@codecast/shared/contracts/lineProfile";
import { useInboxStore } from "../../store/inboxStore";
import { isCause } from "../../lib/lineFlow";
import { lineSettingsHref } from "../../lib/lineSettings";
import { projectLineVersions, shortDay, type LineVersion } from "../../lib/line/runReport";
import { LineSetup } from "./LineSetup";
import { ReportSection } from "./RunReport";
import { LineWorkspace } from "./workspace/LineWorkspace";
import type { LineWorkspace as LineWorkspaceModel } from "../../hooks/useLineWorkspace";
import "./line.css";

type Project = { _id: string; short_id?: string | null; title?: string | null; workspace?: string | null; team_id?: string | null; line_profile?: PublishedLineProfile | null };


export function ProjectLineTab({ projectId }: { projectId: string }) {
  return <LineWorkspace projectId={projectId} embedded Frame={ProjectFrame} />;
}

/** The tab around the app: the app (or, for a line with nothing on it, what it would do and the one step that starts it), then its versions.
 *  It reads the app's own workspace, so the floor is derived once. */
function ProjectFrame({ app, ws }: { app: ReactNode; ws: LineWorkspaceModel }) {
  const projectId = ws.project?._id ?? "";
  const project = useInboxStore((s) => (s.projects as Record<string, Project>)[projectId] ?? null);
  const settings = lineSettingsHref({ project: project ?? projectId });
  const lp = project?.line_profile ?? null;
  const rows = ws.rows;
  const versions = useMemo(() => projectLineVersions(rows), [rows]);
  const empty = !rows.tasks.some(isCause) && rows.signals.length === 0 && rows.runs.length === 0;

  return (
    <div className="max-w-[96rem] mx-auto px-4 sm:px-6 py-5 space-y-8" data-project-line-tab={projectId} data-line-tab-empty={empty ? "" : undefined}>
      {empty && !lp ? (
        <LineSetup title={project?.title ?? "this project"} profiled={false} href={settings} />
      ) : (
        <div className="rounded-xl border border-sol-border/30 overflow-hidden h-[max(560px,calc(100vh-11rem))]" data-project-line-flow>
          {app}
        </div>
      )}

      {/* Versions of codecast's line: only a project that runs it has any; no section, no note, for one that does not. */}
      {!empty && versions.length > 0 && <Versions versions={versions} />}
    </div>
  );
}

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "");
const usd = (n: number | null) => (n == null ? "" : n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);

function Versions({ versions }: { versions: LineVersion[] }) {
  return (
    <ReportSection title="Versions of codecast's line" aside="each time its steps changed, what changed and what the runs after it delivered, newest first">
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
              <th className="font-normal py-1 pr-3 text-right">Billed</th>
              <th className="font-normal py-1 text-right" title="Subscription sessions at API list price: an equivalent, not billed">List price</th>
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
                <td className="py-1.5 pr-3 text-right text-sol-text-muted">{usd(v.billedUsd)}</td>
                <td className="py-1.5 text-right text-sol-text-dim">{usd(v.listUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
    </ReportSection>
  );
}
