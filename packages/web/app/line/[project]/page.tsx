"use client";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { lineRefOf, lineWorkspaceRedirect } from "../../../lib/line/lineWorkspaceUrl";

// /line/<project>: the line app filtered to that project, /line?project=<project>
// (docs/architecture/line-workspace.md LW1). A project is a filter, never a line of its own.
export default function LineProjectRoute() {
  const { project } = useParams<{ project: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const to = lineWorkspaceRedirect(search, lineRefOf(project ?? ""));
  useWatchEffect(() => { if (to) router.replace(to); }, [router, to]);
  return null;
}
