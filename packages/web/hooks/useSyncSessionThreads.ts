// Crosstalk graph — store-fed singleton.
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";

const api = _api as any;

export function useSessionThreads(limit?: number): { threads: { links: any[]; nodes: any[] } | null; ready: boolean } {
  const { ready } = useSyncCollection("sessionThreads", api.sessionThreads.listSessionThreads, limit ? { limit } : {});
  const threads = useInboxStore((s) => s.sessionThreads);
  return { threads, ready };
}
