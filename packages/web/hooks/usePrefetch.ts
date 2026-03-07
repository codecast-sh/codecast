import { useEffect } from "react";
import { useQuery } from "convex/react";
import { usePathname } from "next/navigation";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, TaskItem, DocItem } from "../store/inboxStore";

const api = _api as any;

export function usePrefetch() {
  const pathname = usePathname();
  const isOnTasksPage = pathname === "/tasks" || pathname?.startsWith("/tasks/");
  const isOnDocsPage = pathname === "/docs" || pathname?.startsWith("/docs/");

  const tasks = useQuery(api.tasks.webList, isOnTasksPage ? "skip" : {});
  const docsResult = useQuery(api.docs.webList, isOnDocsPage ? "skip" : {});
  const syncTasks = useInboxStore((s) => s.syncTasks);
  const syncDocs = useInboxStore((s) => s.syncDocs);

  useEffect(() => {
    if (tasks) syncTasks(tasks as unknown as TaskItem[]);
  }, [tasks, syncTasks]);

  useEffect(() => {
    if (docsResult) {
      const { docs, projectPaths } = docsResult as any;
      syncDocs(docs as unknown as DocItem[], projectPaths);
    }
  }, [docsResult, syncDocs]);
}
