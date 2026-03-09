import { useEffect } from "react";
import { useQuery } from "convex/react";
import { usePathname } from "next/navigation";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";

const api = _api as any;

export function usePrefetch() {
  const pathname = usePathname();
  const isOnTasksPage = pathname === "/tasks" || pathname?.startsWith("/tasks/");
  const isOnDocsPage = pathname === "/docs" || pathname?.startsWith("/docs/");

  const tasks = useQuery(api.tasks.webList, isOnTasksPage ? "skip" : {});
  const docsResult = useQuery(api.docs.webList, isOnDocsPage ? "skip" : {});
  const syncTable = useInboxStore((s) => s.syncTable);

  useEffect(() => {
    if (tasks) syncTable("tasks", tasks as any);
  }, [tasks, syncTable]);

  useEffect(() => {
    if (docsResult) {
      const { docs, projectPaths } = docsResult as any;
      syncTable("docs", docs as any, { docProjectPaths: projectPaths });
    }
  }, [docsResult, syncTable]);
}
