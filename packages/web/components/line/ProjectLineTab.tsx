"use client";
// A project's Line tab (the-line-model.md LM6, LM7; the-line-end-to-end.md
// LE14, LE16): the project's own line in one place. Its flow is the /line
// floor pinned to the project; its sources are a health readout from the
// same Sense derivation; its stations are the graph's, by phase, each said
// in the words a run's path uses, with the way to edit it in line settings;
// its versions are what each graph the line ran delivered; and its
// expectations (ExpectationsPanel), read and changed in place. Line edits go
// through /line/settings, which writes the repo.
import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight, SlidersHorizontal } from "lucide-react";
import type { PublishedLineProfile } from "@codecast/shared/contracts/lineProfile";
import { useInboxStore } from "../../store/inboxStore";
import { useActiveWorkspaceKey } from "../../hooks/useWorkspaceCollection";
import { workspaceRefOf } from "../../lib/workspaceScope";
import { useProjectExpectations, useSyncProjectExpectations } from "../../hooks/useSyncProjectExpectations";
import { useWorkflowBySlug } from "../../hooks/useSyncWorkflows";
import { ageShort, buildLineFlow, isCause, scopeLine, silentText } from "../../lib/lineFlow";
import { cn } from "../../lib/utils";
import { lineSettingsHref } from "../../lib/lineSettings";
import { lineForkSlug, stationText, type LineNode } from "../../lib/line/lineStations";
import { SHIPPED_LINE } from "../../lib/line/shippedLine.generated";
import { LINE_PHASES, isMainStation, lineVersions, shortDay, stationWords, type LineVersion, type ReportRun } from "../../lib/line/runReport";
import { LinePage } from "./LinePage";
import { LineSetup } from "./LineSetup";
import { useLineFloor } from "./useLineFloor";
import { ReportSection } from "./RunReport";
import { ExpectationsPanel } from "./expectations/ExpectationsPanel";
import "./line.css";

type Project = { _id: string; short_id?: string | null; title?: string | null; workspace?: string | null; team_id?: string | null; line_profile?: PublishedLineProfile | null };

/** The project's own workspace key when it is not the active one: the tab
 *  then reads the line where the project lives (useLineFloor). */
function useProjectWorkspace(project: Project | null): string | null {
  const active = useActiveWorkspaceKey();
  const ref = project ? workspaceRefOf(project) : null;
  const key = ref ? `${ref.kind}:${ref.id}` : null;
  return key && key !== active ? key : null;
}

export function ProjectLineTab({ projectId }: { projectId: string }) {
  const project = useInboxStore((s) => (s.projects as Record<string, Project>)[projectId] ?? null);
  const workspace = useProjectWorkspace(project);
  const settings = (section?: string, station?: string) => lineSettingsHref({ project: project ?? projectId, ...(station ? { station } : section ? { section: section as any } : {}) });
  const lp = project?.line_profile ?? null;
  // A line with nothing on it has no flow to draw: it leads with what the
  // line would do here and the one step that starts it.
  const { lineRows } = useLineFloor(projectId, workspace);
  // Fed here as well as in the panel: whether the project has expectations
  // decides what the tab leads with, even before the panel mounts.
  useSyncProjectExpectations(projectId);
  const hasExpectations = !!useProjectExpectations(projectId)?.doc;
  const versions = useVersions(lineRows, projectId);
  const empty = useMemo(() => {
    const scoped = scopeLine(lineRows, projectId);
    return !scoped.tasks.some(isCause) && scoped.signals.length === 0 && scoped.runs.length === 0;
  }, [lineRows, projectId]);

  return (
    <div className="max-w-[78rem] mx-auto px-4 sm:px-6 py-5 space-y-8" data-project-line-tab={projectId} data-line-tab-empty={empty ? "" : undefined}>
      {/* A line with nothing on it but expectations leads with them, and
          setting the line up is one action in their header. */}
      {empty && hasExpectations ? (
        <ExpectationsPanel projectId={projectId} setupHref={lp ? undefined : settings()} scroll={false} />
      ) : empty ? (
        <LineSetup title={project?.title ?? "this project"} profiled={!!lp} href={settings()} />
      ) : (
        <div className="rounded-xl border border-sol-border/30 overflow-hidden h-[420px] sm:h-[560px]" data-project-line-flow>
          <LinePage project={projectId} workspace={workspace} />
        </div>
      )}

      {empty && !lp ? null : (
        <div className="grid gap-8 lg:grid-cols-2">
          <Sources projectId={projectId} workspace={workspace} lp={lp} settingsHref={settings("listens")} />
          {!(empty && hasExpectations) && <ExpectationsPanel projectId={projectId} />}
        </div>
      )}

      <Stations project={project ?? { _id: projectId }} settings={settings} newest={versions.find((v) => v.hash !== "unrecorded")?.hash ?? null} />

      {!empty && <Versions versions={versions} />}
    </div>
  );
}

function EditLink({ href, label = "Edit in line settings" }: { href: string; label?: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 hover:text-sol-text" data-line-edit-link>
      <SlidersHorizontal className="w-3 h-3" />{label}
    </Link>
  );
}

/** What the line listens to and how each source is doing, as a readout: one
 *  row per source with its last signal, its count this week and its state.
 *  The health is the flow's Sense column (buildLineFlow), so both say the same
 *  thing; what a source is and how it groups is edited in line settings. */
function Sources({ projectId, workspace, lp, settingsHref }: { projectId: string; workspace: string | null; lp: PublishedLineProfile | null; settingsHref: string }) {
  const { now, lineRows } = useLineFloor(projectId, workspace);
  const sense = useMemo(() => buildLineFlow({ ...scopeLine(lineRows, projectId), initiatives: [], projects: [], now, finders: lp?.finders, findersSince: lp?.changed_at }).sense.items, [lp, lineRows, projectId, now]);
  return (
    <ReportSection title="Sources" aside={<EditLink href={settingsHref} />}>
      {sense.length === 0 ? (
        <p className="text-[12.5px] text-sol-text-dim">{lp ? "The profile declares no source and nothing has been filed in the last two weeks. A person can file with cast signal add; a source files on its own." : "This project has published no line profile yet. Run cast line profile in its repo, or set it up in line settings."}</p>
      ) : (
        <ul className="divide-y divide-sol-border/20" data-line-tab-sources>
          {sense.map((src) => {
            const state = src.undeclared ? { text: "not declared", cls: "text-sol-yellow" } : src.silent ? { text: silentText(src, now), cls: "text-sol-orange" } : src.newest ? { text: "live", cls: "text-sol-green" } : { text: "nothing filed yet", cls: "text-sol-text-dim" };
            return (
              <li key={src.source} className="grid grid-cols-[minmax(5rem,auto)_1fr_auto] items-baseline gap-x-3 py-1.5 text-[12.5px]" data-line-tab-source={src.source}>
                <span className="text-sol-text truncate" title={src.finder?.id}>{src.source}</span>
                <span className="min-w-0 truncate text-sol-text-muted" title={src.newest?.title}>
                  {src.newest ? <><span className="text-sol-text-dim tabular-nums">{ageShort(now - src.newest.created_at)} ago</span> · {src.newest.title}</> : <span className="text-sol-text-dim">no signal in two weeks</span>}
                </span>
                <span className="shrink-0 text-right tabular-nums">
                  <span className="text-sol-text-muted">{src.week} this week</span>
                  <span className={cn("ml-2", state.cls)} data-source-state={state.text}>{state.text}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </ReportSection>
  );
}

/** The stations by phase, each said by what it does, linked to where its
 *  prompt or script is read and edited. The path every cause takes leads; the
 *  branches and the card's routine steps fold under their phase. `newest` is
 *  the version the newest run ran. */
function Stations({ project, settings, newest }: { project: Project; settings: (section?: string, station?: string) => string; newest: string | null }) {
  const fork = useWorkflowBySlug(lineForkSlug(project));
  const nodes = ((fork?.nodes ?? SHIPPED_LINE.nodes) as LineNode[]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const which = fork ? "This project's own line" : "The team's line";
  return (
    <ReportSection title="Stations" aside={<span className="inline-flex items-center gap-3"><span title={newest ? `The graph version ${newest}, as the newest run on this project ran it` : undefined}>{which}{newest ? <>, running version <span className="font-mono">{newest.slice(0, 8)}</span></> : ""}</span><EditLink href={settings("stations")} /></span>}>
      <ol className="space-y-3" data-line-tab-stations>
        {LINE_PHASES.map((p) => {
          const own = p.stations.map((id) => byId.get(id)).filter((n): n is LineNode => !!n);
          return <StationPhase key={p.key} label={p.label} main={own.filter((n) => isMainStation(n.id))} more={own.filter((n) => !isMainStation(n.id))} settings={settings} />;
        })}
      </ol>
    </ReportSection>
  );
}

function StationPhase({ label, main, more, settings }: { label: string; main: LineNode[]; more: LineNode[]; settings: (section?: string, station?: string) => string }) {
  const [open, setOpen] = useState(false);
  return (
    // Below sm the phase sits above its stations, as on a run's path.
    <li className="grid grid-cols-1 sm:grid-cols-[6.5rem_1fr] gap-x-4 gap-y-0.5">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-sol-text-dim sm:pt-0.5">{label}</div>
      <div className="min-w-0">
        <ul className="space-y-1">{main.map((n) => <StationRow key={n.id} n={n} settings={settings} />)}</ul>
        {more.length > 0 && (
          <>
            {open && <ul className="mt-1 space-y-1 opacity-80" data-station-more>{more.map((n) => <StationRow key={n.id} n={n} settings={settings} />)}</ul>}
            <button type="button" onClick={() => setOpen((o) => !o)} className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-text-muted" aria-expanded={open} data-station-fold={more.length}>
              <ChevronRight className={cn("w-3 h-3 transition-transform", open && "rotate-90")} />
              {open ? "fewer" : `${more.length} more: ${more.map((n) => n.label).join(", ")}`}
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function StationRow({ n, settings }: { n: LineNode; settings: (section?: string, station?: string) => string }) {
  const t = stationText(n, SHIPPED_LINE);
  const words = stationWords(n.id) ?? (t.kind === "prompt" ? "An agent works this step" : t.kind === "script" ? "A script runs this step" : "");
  return (
    <li data-line-tab-station={n.id}>
      <Link href={settings(undefined, n.id)} className="group flex items-baseline gap-2 text-[12.5px] min-w-0 rounded px-1 -mx-1 hover:bg-sol-bg-alt/60" title={`Read or edit ${n.label}'s ${t.kind ?? "settings"} in line settings`}>
        <span className="w-24 shrink-0 text-[11.5px] text-sol-text-dim">{n.label}</span>
        <span className="min-w-0 flex-1 text-sol-text group-hover:text-sol-text" data-station-words>{words}</span>
        {t.kind && <span className="hidden sm:inline shrink-0 text-[10.5px] text-sol-text-dim/70 group-hover:text-sol-blue">{t.kind === "prompt" ? "read prompt" : "read script"}</span>}
      </Link>
    </li>
  );
}

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "");
const usd = (n: number | null) => (n == null ? "" : n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);

/** What each version of the line on this project delivered (LE14), keyed by
 *  the graph hash every run records, newest first. */
function useVersions(lineRows: ReturnType<typeof useLineFloor>["lineRows"], projectId: string): LineVersion[] {
  const scoped = useMemo(() => scopeLine(lineRows, projectId), [lineRows, projectId]);
  const reopenedAt = useMemo(() => {
    const by = new Map<string, number[]>();
    for (const s of scoped.signals) if (s.reopened) by.set(s.task_id, [...(by.get(s.task_id) ?? []), s.created_at]);
    return (taskId: string) => by.get(taskId) ?? [];
  }, [scoped.signals]);
  return useMemo(() => lineVersions(scoped.runs as unknown as ReportRun[], reopenedAt), [scoped.runs, reopenedAt]);
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
