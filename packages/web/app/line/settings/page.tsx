"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AuthGuard } from "../../../components/AuthGuard";
import { ErrorBoundary } from "../../../components/ErrorBoundary";
import { LineSettingsPage } from "../../../components/line/settings/LineSettingsPage";
import { useLineProjectId } from "../../../hooks/useLineWorkspace";
import { useInboxStore } from "../../../store/inboxStore";
import { lineWorkspaceHref } from "../../../lib/line/lineWorkspaceUrl";
import "../../../components/line/workspace/workspace.css";

// /line/settings?project=<p>: one project's line settings, every value of its
// line at once (lineSettingsHref links here, with a ?section= or ?station= to
// land on). The crumb leads back to the project's workspace.
export default function LineSettingsRoute() {
  const project = useSearchParams()?.get("project") ?? "";
  const projectId = useLineProjectId(project || null);
  const title = useInboxStore((s) => (projectId ? ((s.projects as Record<string, { title?: string }>)[projectId]?.title ?? null) : null));
  return (
    <AuthGuard>
      <ErrorBoundary name="Line settings">
        <div className="lw" data-line-settings-route={project}>
          <header className="lw-head">
            <div className="lw-id">
              <Link href="/line" className="lw-crumb">Line</Link>
              {project && (
                <>
                  <span className="lw-crumb-sep" aria-hidden>/</span>
                  <Link href={lineWorkspaceHref(project)} className="lw-crumb">{title ?? project}</Link>
                </>
              )}
              <span className="lw-crumb-sep" aria-hidden>/</span>
              <h1 className="lw-title">Settings</h1>
            </div>
          </header>
          <div className="flex-1 min-h-0 flex flex-col"><LineSettingsPage project={projectId} /></div>
        </div>
      </ErrorBoundary>
    </AuthGuard>
  );
}
