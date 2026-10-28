// A project's numbers on its page (lib/metricSeries): each read live from the
// series it names, against its target, with its trend, and edited in place
// with the goal's editor. The lead role reads the same lines in its brief.
import { useState } from "react";
import { Hash, Pencil } from "lucide-react";
import { metricReadings, metricTrends } from "@codecast/shared/contracts/initiative";
import { useInboxStore, type ProjectItem } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useMetricSeries } from "../../hooks/useMetricSeries";
import { RecordSection } from "./InitiativeRecord";
import { MetricTile } from "./InitiativeAtoms";
import { MetricsEditor } from "./MetricsEditor";
import { GhostButton } from "./formBits";

export function ProjectMeasures({ project }: { project: ProjectItem }) {
  const [editing, setEditing] = useState(false);
  const { lookup, watches } = useMetricSeries();
  const now = useCoarseNow(60_000);
  const metrics = project.metrics ?? [];
  const readings = metricReadings({ metrics }, lookup);
  const trends = metricTrends({ metrics }, lookup);
  const action = !editing ? <GhostButton icon={metrics.length ? Pencil : Hash} onClick={() => setEditing(true)} data-project-edit-numbers="">{metrics.length ? "Edit" : "Add a number"}</GhostButton> : undefined;
  return (
    <RecordSection name="numbers" label="Measured by" action={action}>
      {editing ? (
        <MetricsEditor metrics={metrics} watches={watches} onCancel={() => setEditing(false)} onSave={(next) => { useInboxStore.getState().updateProject(project._id, { metrics: next }); setEditing(false); }} />
      ) : readings.length ? (
        <div className="initiative-metric-grid grid grid-cols-1 gap-2" data-count={readings.length} data-project-measures={project._id}>
          {readings.map((r) => <MetricTile key={r.key} reading={r} trend={trends[r.key]} now={now} size="tile" />)}
        </div>
      ) : null}
    </RecordSection>
  );
}
