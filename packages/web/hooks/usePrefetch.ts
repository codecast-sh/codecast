import { useCallback, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { usePathname } from "next/navigation";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useWorkspaceArgs } from "./useWorkspaceArgs";
import { useConvexSync } from "./useConvexSync";
import { useMountEffect } from "./useMountEffect";

const api = _api as any;

export function usePrefetch() {
  const pathname = usePathname();
  const workspaceArgs = useWorkspaceArgs();
  const isOnTasksPage = pathname === "/tasks" || pathname?.startsWith("/tasks/");
  const isOnDocsPage = pathname === "/docs" || pathname?.startsWith("/docs/");

  const tasks = useQuery(api.tasks.webList,
    isOnTasksPage || workspaceArgs === "skip" ? "skip" : { ...workspaceArgs }
  );
  const docsResult = useQuery(api.docs.webList,
    isOnDocsPage || workspaceArgs === "skip" ? "skip" : { ...workspaceArgs }
  );
  const syncTable = useInboxStore((s) => s.syncTable);

  const dispatchMutation = useMutation(api.dispatch.dispatch);
  const _setDispatch = useInboxStore((s) => s._setDispatch);
  const dispatchRef = useRef(dispatchMutation);
  dispatchRef.current = dispatchMutation;

  useMountEffect(() => {
    _setDispatch((action, args, patches) => dispatchRef.current({ action, args, patches }));
  });

  useConvexSync(tasks, useCallback((data: any) => {
    syncTable("tasks", (data?.items ?? data) as any);
  }, [syncTable]));

  useConvexSync(docsResult, useCallback((data: any) => {
    const { docs, projectPaths } = data as any;
    syncTable("docs", docs as any, { extra: { docProjectPaths: projectPaths } });
  }, [syncTable]));
}
