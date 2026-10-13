"use client";
// /line (docs/architecture/line-journeys.md LJ5): the line app over every
// project, `?project=` filtering it to one. It reads one workspace of its own
// (useLineSpace), not the app's active one, so the founder's lines never
// vanish when the app sits on another workspace; the header names it and
// switches it.
import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useLineSpace } from "../../hooks/useLineSpace";
import { useOrgScope } from "../../hooks/useSyncOrgTree";
import { WorkspaceScopeProvider } from "../../hooks/useWorkspaceScope";
import { readLineSelection } from "../../lib/line/lineWorkspaceUrl";
import { LineWorkspace } from "./workspace/LineWorkspace";

/** `settings`: the stage holds the drawn line's settings (/line/settings). */
export function LinePage({ settings = false }: { settings?: boolean } = {}) {
  const search = useSearchParams();
  const selection = useMemo(() => readLineSelection(search), [search]);
  const space = useLineSpace(selection);
  // Who runs each line, its start switch and its slots are the org's: the org this page reads is its workspace's.
  useOrgScope(space.key);
  return (
    <WorkspaceScopeProvider value={space.key}>
      <LineWorkspace space={space} settings={settings} />
    </WorkspaceScopeProvider>
  );
}
