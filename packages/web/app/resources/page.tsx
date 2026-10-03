// /resources: every machine you run, what it spends, and which sessions spend it.
import { AuthGuard } from "../../components/AuthGuard";
import { ResourceMonitor } from "../../components/resources/ResourceMonitor";
import { useResourceMonitor } from "../../hooks/useResourceMonitor";
import { useResourceActions } from "../../hooks/useResourceActions";

function ResourcesView() {
  const data = useResourceMonitor();
  const { actions, plans } = useResourceActions(data.sessions, data.plans, data.batches, data.now);
  return (
    <div className="h-full min-h-0">
      <ResourceMonitor
        machines={data.machines}
        sessions={data.sessions}
        ready={data.ready}
        now={data.now}
        plans={plans}
        runs={data.runs}
        actions={actions}
      />
    </div>
  );
}

export default function ResourcesPage() {
  return (
    <AuthGuard>
      <ResourcesView />
    </AuthGuard>
  );
}
