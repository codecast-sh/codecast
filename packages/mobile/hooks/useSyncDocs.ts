import { useSyncDocsPaginated } from "@codecast/web/hooks/useSyncDocs";
import { useWorkspaceArgs } from "./useWorkspaceArgs";

export function useSyncDocs() {
  return useSyncDocsPaginated(useWorkspaceArgs());
}
