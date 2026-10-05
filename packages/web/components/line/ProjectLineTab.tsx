"use client";
// A project's Line tab (the-line-model.md LM6, LM7; the-line-end-to-end.md
// LE14, LE16): the project's own line in one place. Its flow is the /line
// floor pinned to the project; its sources are a health readout from the
// same Sense derivation; its stations are the graph's, by phase, each said
// in the words a run's path uses, with the way to edit it in line settings;
// its versions are what each graph the line ran delivered; and its
// expectations, when the project has them. Edits go through /line/settings,
// which writes the repo.
import { useMemo } from "react";
import Link from "next/link";
import { ArrowRight, SlidersHorizontal } from "lucide-react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { PublishedLineProfile } from "@codecast/shared/contracts/lineProfile";
import { useInboxStore } from "../../store/inboxStore";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useWorkflowBySlug } from "../../hooks/useSyncWorkflows";
import { ageShort, buildLineFlow, isCause, scopeLine, silentText } from "../../lib/lineFlow";
import { cn } from "../../lib/utils";
import { lineSettingsHref } from "../../lib/lineSettings";
import { lineForkSlug, stationText, type LineNode } from "../../lib/line/lineStations";
import { SHIPPED_LINE } from "../../lib/line/shippedLine.generated";
import { LINE_PHASES, lineVersions, shortDay, stationWords, type ReportRun } from "../../lib/line/runReport";
import { LinePage } from "./LinePage";
import { useLineFloor } from "./useLineFloor";
import { ReportSection } from "./RunReport";
import "./line.css";

const api = _api as any;

type Project = { _id: string; short_id?: string | null; title?: string | null; line_profile?: PublishedLineProfile | null };

export function ProjectLineTab({ projectId }: { projectId: string }) {
  const project = useInboxStore((s) => (s.projects as Record<string, Project>)[projectId] ?? null);
  const settings = (section?: string, station?: string) => lineSettingsHref({ project: project ?? projectId, ...(station ? { station } : section ? { section: section as any } : {}) });
  const lp = project?.line_profile ?? null;
  // A line with nothing on it has no flow to draw: it leads with what the
  // line would do here and the one step that starts it.
  const { lineRows } = useLineFloor(projectId);
  const empty = useMemo(() => {
    const scoped = scopeLine(lineRows, projectId);
    return !scoped.tasks.some(isCause) && scoped.signals.length === 0 && scoped.runs.length === 0;
  }, [lineRows, projectId]);

  return (
    <div className="max-w-[78rem] mx-auto px-4 sm:px-6 py-5 space-y-8" data-project-line-tab={projectId} data-line-tab-empty={empty ? "" : undefined}>
      {empty ? (
        <LineSetup title={project?.title ?? "this project"} profiled={!!lp} href={settings()} />
      ) : (
        <div className="rounded-xl border border-sol-border/30 overflow-hidden h-[420px] sm:h-[560px]" data-project-line-flow>
          <LinePage project={projectId} />
        </div>
      )}

      {empty && !lp ? (
        <Expectations projectId={projectId} hideEmpty />
      ) : (
        <div className="grid gap-8 lg:grid-cols-2">
          <Sources projectId={projectId} lp={lp} settingsHref={settings("listens")} />
          <Expectations projectId={projectId} />
        </div>
      )}

      <Stations project={project ?? { _id: projectId }} settings={settings} />

      {!empty && <Versions projectId={projectId} />}
    </div>
  );
}

/** The Line tab of a project with nothing on its line: what the line does,
 *  and the one place to start it. */
function LineSetup({ title, profiled, href }: { title: string; profiled: boolean; href: string }) {
  return (
    <section className="rounded-xl border border-sol-border/40 bg-sol-bg-alt/40 px-5 py-4 max-w-[46rem]" data-line-setup>
      <h2 className="text-[15px] font-semibold text-sol-text">{profiled ? "Nothing on the line yet" : `Set up the line for ${title}`}</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-sol-text-muted">
        {profiled
          ? "The line is set up and no source has filed anything. When one does, its cause shows here with every step the line takes on it."
          : "The line listens to this project's sources, like its error tracker and its evals, and groups what they file into causes. For each one it proves the miss, builds and checks a fix, and brings you one card to ship, revise or drop. After a ship it watches for the miss to come back."}
      </p>
      <Link href={href} className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-sol-cyan/50 text-[12.5px] font-medium text-sol-cyan hover:bg-sol-cyan/10 transition-colors" data-line-setup-action>
        {profiled ? "Open line settings" : "Set up the line"}
        <ArrowRight className="w-3.5 h-3.5" />
      </Link>
    </section>
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
function Sources({ projectId, lp, settingsHref }: { projectId: string; lp: PublishedLineProfile | null; settingsHref: string }) {
  const { now, lineRows } = useLineFloor(projectId);
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

/** The project's expectations (LM5): one living document, each line with its sources. Renders when the project has one. */
function Expectations({ projectId, hideEmpty }: { projectId: string; hideEmpty?: boolean }) {
  // An enrichment: the tab reads honestly without it (useQueryNoThrow).
  const { data } = useQueryNoThrow(api.expectations.forProject, { project_id: projectId });
  const doc = data?.doc as { version: number; applied_at: number; items: Array<{ id: string; text: string; part: string; status: string; note?: string; citations: Array<{ kind: string; ref: string }> }> } | null | undefined;
  const active = useMemo(() => (doc?.items ?? []).filter((e) => e.status === "active"), [doc]);
  const parts = useMemo(() => {
    const by = new Map<string, typeof active>();
    for (const e of active) by.set(e.part, [...(by.get(e.part) ?? []), e]);
    return [...by.entries()];
  }, [active]);
  const pending = (data?.proposals ?? []).filter((p: { status: string }) => p.status === "open").length;
  if (!doc && hideEmpty) return null;
  return (
    <ReportSection title="Expectations" aside={doc ? `version ${doc.version} · ${shortDay(doc.applied_at)}${pending ? ` · ${pending} proposed` : ""}` : undefined}>
      {!doc ? (
        <p className="text-[12.5px] text-sol-text-dim" data-expectations-empty>No expectations yet. They say how the project should behave, each with the call, thread or task it came from, and the judges compare what happened against them.</p>
      ) : (
        <div className="space-y-3 max-h-[22rem] overflow-y-auto pr-1" data-expectations>
          {parts.map(([part, items]) => (
            <div key={part}>
              <div className="text-[11px] font-semibold text-sol-text-dim mb-1">{part}</div>
              <ul className="space-y-1">
                {items.map((e) => (
                  <li key={e.id} className="text-[12.5px] text-sol-text leading-snug" data-expectation={e.id}>
                    {e.text}
                    <span className="ml-1.5 text-[11px] text-sol-text-dim">{e.citations.map((c) => c.ref).slice(0, 3).join(", ")}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </ReportSection>
  );
}

/** The stations by phase, each in the words a run's path uses for it, linked
 *  to where its prompt or script is read and edited. */
function Stations({ project, settings }: { project: Project; settings: (section?: string, station?: string) => string }) {
  const fork = useWorkflowBySlug(lineForkSlug(project));
  const nodes = ((fork?.nodes ?? SHIPPED_LINE.nodes) as LineNode[]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  return (
    <ReportSection title="Stations" aside={<span className="inline-flex items-center gap-3">{fork ? "this project's copy" : "the shipped line"}<EditLink href={settings("stations")} /></span>}>
      <ol className="space-y-3" data-line-tab-stations>
        {LINE_PHASES.map((p) => (
          // Below sm the phase sits above its stations, as on a run's path.
          <li key={p.key} className="grid grid-cols-1 sm:grid-cols-[6.5rem_1fr] gap-x-4 gap-y-0.5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-sol-text-dim sm:pt-0.5">{p.label}</div>
            <ul className="space-y-1 min-w-0">
              {p.stations.map((id) => byId.get(id)).filter((n): n is LineNode => !!n).map((n) => {
                const t = stationText(n, SHIPPED_LINE);
                const words = stationWords(n.id) ?? (t.kind === "prompt" ? "An agent works this step" : t.kind === "script" ? "A script runs this step" : "");
                return (
                  <li key={n.id} data-line-tab-station={n.id}>
                    <Link href={settings(undefined, n.id)} className="group flex items-baseline gap-2 text-[12.5px] min-w-0 rounded px-1 -mx-1 hover:bg-sol-bg-alt/60" title={`Read or edit ${n.label}'s ${t.kind ?? "settings"} in line settings`}>
                      <span className="w-24 shrink-0 text-sol-text">{n.label}</span>
                      <span className="min-w-0 flex-1 text-sol-text-muted group-hover:text-sol-text" data-station-words>{words}</span>
                      {t.kind && <span className="hidden sm:inline shrink-0 text-[10.5px] text-sol-text-dim/70 group-hover:text-sol-blue">{t.kind === "prompt" ? "read prompt" : "read script"}</span>}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ol>
    </ReportSection>
  );
}

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "");
const usd = (n: number | null) => (n == null ? "" : n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);

/** What each version of the line delivered (LE14), keyed by the graph hash every run records. */
function Versions({ projectId }: { projectId: string }) {
  const { lineRows } = useLineFloor(projectId);
  const scoped = useMemo(() => scopeLine(lineRows, projectId), [lineRows, projectId]);
  const reopenedAt = useMemo(() => {
    const by = new Map<string, number[]>();
    for (const s of scoped.signals) if (s.reopened) by.set(s.task_id, [...(by.get(s.task_id) ?? []), s.created_at]);
    return (taskId: string) => by.get(taskId) ?? [];
  }, [scoped.signals]);
  const versions = useMemo(() => lineVersions(scoped.runs as unknown as ReportRun[], reopenedAt), [scoped.runs, reopenedAt]);
  return (
    <ReportSection title="Versions" aside="each graph the line ran, newest first">
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
              <th className="font-normal py-1 pr-3 text-right">Reopened</th>
              <th className="font-normal py-1 text-right">Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-sol-border/20">
            {versions.map((v, i) => (
              <tr key={v.hash} data-line-version={v.hash}>
                <td className="py-1.5 pr-3 font-mono text-[11.5px] text-sol-text">{v.hash === "unrecorded" ? <span className="font-sans text-sol-text-dim">not recorded</span> : v.hash.slice(0, 8)}{i === 0 && v.hash !== "unrecorded" && <span className="ml-2 font-sans text-[10.5px] text-sol-text-dim">latest</span>}</td>
                <td className="py-1.5 pr-3 text-sol-text-muted">{shortDay(v.first)}{v.last - v.first > 86_400_000 ? ` to ${shortDay(v.last)}` : ""}</td>
                <td className="py-1.5 pr-3 text-right text-sol-text">{v.runs}{v.live ? <span className="text-sol-cyan"> ({v.live} live)</span> : null}</td>
                <td className="py-1.5 pr-3 text-right text-sol-green">{v.shipped} <span className="text-sol-text-dim">{pct(v.shipped, v.runs)}</span></td>
                <td className="py-1.5 pr-3 text-right text-sol-text">{v.revised} <span className="text-sol-text-dim">{pct(v.revised, v.runs)}</span></td>
                <td className="py-1.5 pr-3 text-right text-sol-text">{v.dropped}</td>
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
