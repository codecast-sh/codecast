import type { SourceCoverage } from "./types";

/**
 * Coverage ordering shared by the persistence adapter (durable fences) and the
 * view session (writer-handoff decisions). Two kinds, two guarantee strengths:
 *
 * - `view-revision` is a WATERMARK minted by server writers. It under-covers
 *   the query result by construction (joins and access inputs drift without a
 *   covered write), so equal coverage carries no content guarantee.
 * - `log-ts` is a RESULT VERSION: the backend log position at which the whole
 *   query result is valid. Convex's read-set tracking recomputes the result
 *   when anything it read changes, so equal ts implies identical results and
 *   an unchanged access outcome. Timestamps are globally comparable across
 *   tabs, devices, and reconnects.
 *
 * Kinds never compare with each other; a slice migrates kinds only through
 * the explicit contract-supersession path, which resets its durable coverage.
 */
export type CoverageOrder = "older" | "equal" | "newer" | "incomparable";

export class CoverageIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoverageIntegrityError";
  }
}

/** Numeric comparison of unsigned decimal strings (u64 log timestamps). */
export function compareLogTs(left: string, right: string): -1 | 0 | 1 {
  if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) {
    throw new CoverageIntegrityError("A log-ts coverage value must be an unsigned decimal string");
  }
  const a = left.replace(/^0+(?=\d)/, "");
  const b = right.replace(/^0+(?=\d)/, "");
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => structurallyEqual(value, right[index]));
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  return aKeys.length === bKeys.length &&
    aKeys.every((key, index) => key === bKeys[index] && structurallyEqual(a[key], b[key]));
}

export function compareSourceCoverage(
  current: SourceCoverage,
  next: SourceCoverage,
): CoverageOrder {
  if (current.kind === "log-ts" && next.kind === "log-ts") {
    const order = compareLogTs(current.ts, next.ts);
    return order === 0 ? "equal" : order < 0 ? "newer" : "older";
  }
  if (current.kind === "view-revision" && next.kind === "view-revision") {
    const currentOrder = current.revisionOrder;
    const nextOrder = next.revisionOrder;
    if (current.revision === next.revision) {
      if (currentOrder !== undefined && nextOrder !== undefined && currentOrder !== nextOrder) {
        throw new CoverageIntegrityError("One server revision has conflicting order values");
      }
      return "equal";
    }
    if (currentOrder === undefined || nextOrder === undefined) return "incomparable";
    if (currentOrder === nextOrder) {
      throw new CoverageIntegrityError("One server revision order names different revisions");
    }
    return nextOrder < currentOrder ? "older" : "newer";
  }
  // Cross-kind (and every other kind pairing): comparable only by identity.
  return structurallyEqual(current, next) ? "equal" : "incomparable";
}
