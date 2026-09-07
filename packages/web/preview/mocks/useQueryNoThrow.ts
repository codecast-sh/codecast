// Fixture-backed useQueryNoThrow for the migration-panel preview. The
// generated-api mock hands every function ref over as "module:function".
import { batches, candidates, devices } from "./fixtures";

export const queryCircuitOpenError = new Error("circuit open");

const answers: Record<string, unknown> = {
  "sessionMigrations:candidates": candidates,
  "sessionMigrations:listBatches": batches,
  "devices:listDevices": devices,
};

export function useQueryNoThrow(ref: unknown, args: unknown): { data: unknown; error: null } {
  if (args === "skip") return { data: undefined, error: null };
  return { data: answers[String(ref)] ?? null, error: null };
}
