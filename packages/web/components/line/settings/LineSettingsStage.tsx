"use client";
// The line's settings as a page of the /line app (line-journeys.md LJ8.7): the
// gear opens the settings of the line drawn in the header, in the same
// workspace, with the app's nav and switchers around it. Settings live on a
// project (its `.codecast/line.toml`), so the page resolves the line to the
// project that runs it. A line two projects run asks which; with no line known
// yet, the page lists the lines the header's switcher lists.
import Link from "next/link";
import { processName, type ProjectGraph } from "../../../lib/line/lineGraphs";
import { lineFilterParam } from "../../../lib/line/lineWorkspaceUrl";
import type { LineProject, RollupRow } from "../../../lib/lineFlow";
import { NO_PROJECT } from "../../../lib/lineFlow";
import { LineSettingsPage } from "./LineSettingsPage";
import { LineStarts } from "./LineStarts";
import { useSearchParams } from "next/navigation";

/** The projects whose problems a line works, read off the same process index the header's picker uses. */
export function projectsOfLine(line: string | null, rollups: ReadonlyArray<RollupRow>, processOf: (projectId: string) => string): string[] {
  if (!line) return [];
  return rollups.filter((r) => r.key !== NO_PROJECT && processOf(r.key) === line).map((r) => r.key);
}

export function LineSettingsStage({ projectId, line, lines, projects, rollups, processOf, href }: {
  /** The project the address filters to, when it does. */
  projectId: string | null;
  /** The line drawn in the header. */
  line: string | null;
  /** Every line the header's switcher lists. */
  lines: ReadonlyArray<ProjectGraph>;
  projects: ReadonlyArray<LineProject>;
  rollups: ReadonlyArray<RollupRow>;
  processOf: (projectId: string) => string;
  /** The settings address for a project (and the line it runs). */
  href: (patch: { project?: string | null; graph?: string | null }) => string;
}) {
  // Who starts work on every line (?section=starts): its own page, whatever line the header draws.
  const section = useSearchParams()?.get("section");
  const running = projectsOfLine(line, rollups, processOf);
  if (section === "starts") return <LineStarts projects={projects} rollups={rollups} />;
  const pick = projectId ?? (running.length === 1 ? running[0] : null);
  const project = pick ? projects.find((p) => p._id === pick) ?? null : null;
  if (project) {
    return (
      <div className="lw-stage-fill" data-line-settings-stage={project._id}>
        <div className="lset-head">
          <h2 className="lset-head-t">{project.title}</h2>
          {line && <span className="lset-dim">{processName(line).title}</span>}
        </div>
        <LineSettingsPage project={project._id} />
      </div>
    );
  }
  const name = (key: string) => projects.find((p) => p._id === key)?.title ?? rollups.find((r) => r.key === key)?.title ?? key;
  const param = (key: string) => {
    const p = projects.find((x) => x._id === key);
    return p ? lineFilterParam(p, projects) : rollups.find((r) => r.key === key)?.short_id ?? key;
  };
  // A line several projects run: which project's settings.
  if (running.length > 1) {
    return (
      <div className="lw-stage-fill lset-pick" data-lset-pick="project">
        <div className="lset-head"><h2 className="lset-head-t">{line ? processName(line).title : "Line"}</h2><span className="lset-dim">runs in {running.length} projects</span></div>
        <ul className="lset-pick-list" role="list">
          {running.map((k) => <li key={k}><Link href={href({ project: param(k), graph: line })} className="lset-pick-row" data-lset-pick-row={k}>{name(k)}</Link></li>)}
        </ul>
      </div>
    );
  }
  // No line resolves to a project: the lines the switcher lists, each opening the settings of the project that runs it.
  const rows = lines.map((g) => ({ g, projects: projectsOfLine(g.key, rollups, processOf) })).filter((x) => x.projects.length > 0);
  return (
    <div className="lw-stage-fill lset-pick" data-lset-pick="line">
      <div className="lset-head"><h2 className="lset-head-t">Settings</h2><span className="lset-dim">{rows.length ? "pick a line" : "no line has run here yet"}</span></div>
      <ul className="lset-pick-list" role="list">
        <li><Link href="/line/settings?section=starts" className="lset-pick-row" data-lset-pick-row="starts"><span>Who starts work</span><span className="lset-dim">every line's switch and limits</span></Link></li>
        {rows.map(({ g, projects: ps }) => (
          <li key={g.key}>
            <Link href={href(ps.length === 1 ? { project: param(ps[0]), graph: g.key } : { graph: g.key })} className="lset-pick-row" data-lset-pick-row={g.key}>
              <span>{processName(g.key, g.title).title}</span>
              <span className="lset-dim">{ps.map(name).join(", ")}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
