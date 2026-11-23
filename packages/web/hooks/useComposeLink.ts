// Opens the new-session composer a compose link asks for (lib/composeLink),
// once per link, then takes the link's parameters out of the address. Waits
// for what the composer resolves at mount (the person's settings, and the
// task or machines the link names) so it opens on the right agent and folder;
// past composeLinkWait it opens with whatever resolved, never with nothing, and
// never sends: the person presses Enter.
import { useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useServerAuthenticated } from "./useServerAuthSettled";
import { toast } from "sonner";
import { useInboxStore, findProjectPathByName } from "../store/inboxStore";
import { parseComposeLink, draftForTask, resolveLinkProject, stripComposeLink } from "../lib/composeLink";
import { useSyncTaskDetail } from "./useSyncTasks";
import { useWatchEffect } from "./useWatchEffect";

// How long a link waits on the server and the machine roster on a cold load.
// A cold boot (sign-in, then the task's read) has taken over 5s on a slow
// machine; opening unbound then would quietly lose the task.
export const composeLinkWait = { ms: 15_000 };

const noticeId = (key: string) => `compose-link:${key}`;

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
  // Asked only once the socket is signed in: before that the server answers
  // null for a caller it does not know yet, which would read as "not yours".
  const isAuthenticated = useServerAuthenticated();
  const answer = useSyncTaskDetail(active && isAuthenticated && link?.task ? link.task : undefined);
  const settingsReady = useInboxStore((s) => s.clientStateInitialized);
  const rosterReady = useInboxStore((s) => s.machineRosterLive);
  // No machine known yet may mean none at all, where only the hosted
  // assistant can answer: the agent waits on the live roster then.
  const rosterEmpty = useInboxStore((s) => s.machineRoster.length === 0);

  // Which link's wait ran out: a flag would carry one link's timeout over to
  // the next link that arrives on the same page.
  const [timedOutKey, setTimedOutKey] = useState<string | null>(null);
  const timedOut = timedOutKey === key;
  // A task link waits on the server, so the click says it was heard; the
  // notice goes when the composer opens or the link is left.
  useWatchEffect(() => {
    if (!active || !link) return;
    const t = setTimeout(() => setTimedOutKey(key), composeLinkWait.ms);
    // One notice per link, by id: a remount updates it instead of stacking a
    // second.
    const notice = link.task ? toast.loading(`Opening ${link.task}…`, { id: noticeId(key) }) : undefined;
    return () => {
      clearTimeout(t);
      setTimedOutKey(null);
      if (notice !== undefined) toast.dismiss(notice);
    };
  }, [active, key]);

  useWatchEffect(() => {
    if (!active || !link || handled.current === key) return;
    const st = useInboxStore.getState();
    // The server decides, never the store: whether a link may bind a task is
    // an access question, and the store keeps rows from workspaces the viewer
    // has left (a bind the server then drops on send without a word).
    const task = answer;
    const waiting = !settingsReady || (link.task && task === undefined) || ((link.project || rosterEmpty) && !rosterReady);
    if (waiting && !timedOut) return;
    handled.current = key;
    // Dismissed now and once more a beat later: sonner adds a toast on a
    // timer and dismisses on an animation frame, so a dismiss in the same
    // commit as the add can land first and leave a loading toast that never
    // expires.
    if (link.task) {
      const id = noticeId(key);
      toast.dismiss(id);
      setTimeout(() => toast.dismiss(id), 500);
    }

    const known = {
      paths: [
        ...st.recentProjects.map((p) => p.path),
        ...st.machineRoster.flatMap((d) => d.local_project_roots ?? []),
      ],
      byName: (name: string) => findProjectPathByName(name, st),
    };
    const linked = task && typeof task.short_id === "string" && task.short_id.toLowerCase() === link.task ? task : null;
    // A folder the task pins wins over the link's, as it does on the server
    // (resolveTaskGitContext), so the composer shows where the session runs.
    const taskPath: string | undefined = linked
      ? linked.project_path || (linked.project_id ? st.projects[linked.project_id]?.project_path : undefined)
      : undefined;
    const projectPath = taskPath || resolveLinkProject(link.project, known);
    const draft = linked ? draftForTask(link.draft, linked.short_id) : link.draft;
    st.openCompose(draft || undefined, {
      ...(projectPath ? { projectPath, gitRoot: projectPath } : {}),
      ...(link.agent ? { agentType: link.agent } : {}),
      ...(linked ? { linkedTask: { _id: String(linked._id), short_id: linked.short_id, title: linked.title, status: linked.status } } : {}),
    });
    // What the link asked for and did not get is said, never dropped quietly:
    // a task the session will not be linked to, a folder it will not start in.
    if (link.task && !linked) {
      toast(task === null
        ? `${link.task} isn't a task you can open, so this session won't be linked to it`
        : `Codecast didn't answer about ${link.task} in time, so this session won't be linked to it`);
    }
    if (link.project && !projectPath) {
      toast(`No folder "${link.project}" on your machines, so this session starts in your usual one`);
    }
    router.replace(stripComposeLink(pathname, key));
  }, [active, key, settingsReady, rosterReady, rosterEmpty, answer, timedOut]);
}
