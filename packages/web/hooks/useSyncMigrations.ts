// Session migrations, store-fed: the candidate list and the batch list each
// live in one meta key (registry: migrationCandidates, migrationBatches).
// Settings → Migration and the resource monitor read them from here.
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";

const api = _api as any;

export function useMigrationCandidates(enabled = true) {
  const { ready, error, retry } = useSyncCollection("migrationCandidates", api.sessionMigrations.candidates, enabled ? {} : "skip");
  const candidates = useInboxStore((s) => s.migrationCandidates);
  // Undefined until the first answer or a cached copy, so callers can tell cold from empty.
  return { candidates: candidates ?? (ready ? [] : undefined), ready, error, retry };
}

export function useMigrationBatches(enabled = true) {
  const { ready, error } = useSyncCollection("migrationBatches", api.sessionMigrations.listBatches, enabled ? {} : "skip");
  const batches = useInboxStore((s) => s.migrationBatches);
  return { batches: batches ?? (ready ? [] : undefined), ready, error };
}
