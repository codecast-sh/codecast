import { useEffect } from "react";
import {
  compareShadowRows,
  type ShadowComparison,
  type ShadowDigestRow,
} from "./shadowDigest";

/**
 * Live cutover gate: while a slice runs in "shadow" mode, every quiescent
 * state of the v2 materialized view is digest-compared against the rows the
 * v1 path is rendering right now. Cutover is justified only by this evidence:
 * same principal, same data, both pipelines live, digests equal.
 *
 * Everything recorded here is payload-free — view identities, row counts, and
 * one-way SHA-256 digests — so the summary is safe to read, copy, or ship as
 * telemetry.
 */
export type ShadowValidationEntry = ShadowComparison & {
  at: number;
  samples: number;
  mismatches: number;
};

const entries = new Map<string, ShadowValidationEntry>();

export type ShadowValidationSummary = {
  views: ShadowValidationEntry[];
  totalViews: number;
  /** Views whose LATEST quiescent comparison is unequal — the cutover blocker. */
  mismatchedViews: number;
  totalSamples: number;
  totalMismatches: number;
};

export function shadowValidationSummary(): ShadowValidationSummary {
  const views = [...entries.values()].sort((a, b) => a.viewKey.localeCompare(b.viewKey));
  return {
    views,
    totalViews: views.length,
    mismatchedViews: views.filter((view) => !view.equal).length,
    totalSamples: views.reduce((sum, view) => sum + view.samples, 0),
    totalMismatches: views.reduce((sum, view) => sum + view.mismatches, 0),
  };
}

export function resetShadowValidationForTests(): void {
  entries.clear();
}

declare global {
  interface Window {
    /** Payload-free digest-equivalence evidence for the v1→v2 cutover gate. */
    __CODECAST_SHADOW_VALIDATION__?: () => ShadowValidationSummary;
  }
}

export async function recordShadowComparison(input: {
  contractId: string;
  viewKey: string;
  authoritative: readonly ShadowDigestRow[];
  materialized: readonly ShadowDigestRow[];
}): Promise<ShadowComparison> {
  const comparison = await compareShadowRows(input);
  const previous = entries.get(input.viewKey);
  entries.set(input.viewKey, {
    ...comparison,
    at: Date.now(),
    samples: (previous?.samples ?? 0) + 1,
    mismatches: (previous?.mismatches ?? 0) + (comparison.equal ? 0 : 1),
  });
  if (typeof window !== "undefined") {
    window.__CODECAST_SHADOW_VALIDATION__ = shadowValidationSummary;
  }
  if (!comparison.equal) {
    console.error(
      `[local-first] SHADOW MISMATCH ${input.contractId} ${input.viewKey}: ` +
      `v1=${comparison.authoritativeRowCount} rows ${comparison.authoritativeDigest} ` +
      `v2=${comparison.materializedRowCount} rows ${comparison.materializedDigest}`,
    );
  }
  return comparison;
}

/** Milliseconds both feeds must hold still before a state counts as quiescent. */
const QUIESCENCE_MS = 600;

/**
 * Compare the two live feeds whenever they reach a quiescent state. The v1
 * query and the v2 view converge at slightly different moments, so mid-flight
 * states are skipped rather than recorded as false mismatches; the latest
 * recorded comparison is always a settled one.
 */
export function useShadowEquivalence(input: {
  enabled: boolean;
  contractId: string;
  viewKey: string;
  authoritative: readonly ShadowDigestRow[] | null;
  materialized: readonly ShadowDigestRow[] | null;
}): void {
  const { enabled, contractId, viewKey, authoritative, materialized } = input;
  useEffect(() => {
    if (!enabled || !authoritative || !materialized) return;
    const timer = setTimeout(() => {
      void recordShadowComparison({ contractId, viewKey, authoritative, materialized })
        .catch((error) => console.error("[local-first] shadow comparison failed", error));
    }, QUIESCENCE_MS);
    return () => clearTimeout(timer);
  }, [enabled, contractId, viewKey, authoritative, materialized]);
}
