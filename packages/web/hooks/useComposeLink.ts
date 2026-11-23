// Opens the new-session composer a compose link asks for (lib/composeLink),
// once per link, then takes the link's parameters out of the address. Waits
// for what the composer resolves at mount (the person's settings, and the
// task or machines the link names) so it opens on the right agent and folder;
// past LINK_WAIT_MS it opens with whatever resolved, never with nothing.
import { useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useInboxStore, findProjectPathByName } from "../store/inboxStore";
import { parseComposeLink, draftForTask, resolveLinkProject, stripComposeLink } from "../lib/composeLink";
import { resolveContextProjectPath } from "../lib/contextProjectPath";
import { useSyncTaskDetail } from "./useSyncTasks";
import { useWatchEffect } from "./useWatchEffect";

// How long a link waits on the server and the machine roster on a cold load.
const LINK_WAIT_MS = 5000;

export function useComposeLink(active: boolean): void {
  // The router's address, not window.location: inside a tab the page's own
  // path and query live in the tab context.
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const key = searchParams.toString();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const link = useMemo(() => parseComposeLink(searchParams), [key]);
  const handled = useRef<string | null>(null);
  if (!link) handled.current = null;

  // undefined while the server has not answered; null when the viewer cannot
  // see the task (unknown, or another workspace's): the draft opens unbound.
  const task = useSyncTaskDetail(active && link?.task ? link.task : undefined);
  const settingsReady = useInboxStore((s) => s.clientStateInitialized);
  const rosterReady = useInboxStore((s) => s.machineRosterLive);

  const [timedOut, setTimedOut] = useState(false);
  useWatchEffect(() => {
    if (!active || !link) return;
    setTimedOut(false);
    const t = setTimeout(() => setTimedOut(true), LINK_WAIT_MS);
    return () => clearTimeout(t);
  }, [active, key]);

  useWatchEffect(() => {
    if (!active || !link || handled.current === key) return;
    const waiting = !settingsReady || (link.task && task === undefined) || (link.project && !rosterReady);
    if (waiting && !timedOut) return;
    handled.current = key;

    const st = useInboxStore.getState();
    const known = {
      paths: [
        ...st.recentProjects.map((p) => p.path),
        ...st.machineRoster.flatMap((d) => d.local_project_roots ?? []),
      ],
      byName: (name: string) => findProjectPathByName(name, st),
    };
    const linked = task && typeof task.short_id === "string" && task.short_id.toLowerCase() === link.task ? task : null;
    const projectPath = resolveLinkProject(link.project, known)
      ?? (linked ? resolveContextProjectPath(st, linked) : undefined);
    const draft = linked ? draftForTask(link.draft, linked.short_id) : link.draft;
    st.openCompose(draft || undefined, {
      ...(projectPath ? { projectPath, gitRoot: projectPath } : {}),
      ...(link.agent ? { agentType: link.agent } : {}),
      ...(linked ? { linkedTask: { _id: String(linked._id), short_id: linked.short_id, title: linked.title, status: linked.status } } : {}),
    });
    router.replace(stripComposeLink(pathname, key));
  }, [active, key, settingsReady, rosterReady, task, timedOut]);
}
