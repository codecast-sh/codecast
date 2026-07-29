/**
 * Core types for the v2 local-first runtime.
 *
 * These brands are intentionally structural at runtime. Their purpose is to
 * stop feature code from accidentally crossing principal, source, and view
 * boundaries without going through the runtime that validates them.
 */
export type PrincipalId = string & { readonly __principalId: unique symbol };
export type OpaquePrincipalKey = string & { readonly __opaquePrincipalKey: unique symbol };
export type CredentialBinding = string & { readonly __credentialBinding: unique symbol };
export type ViewKey = string & { readonly __viewKey: unique symbol };
export type GrantKey = string & { readonly __grantKey: unique symbol };

export type PrincipalEpoch = number & { readonly __principalEpoch: unique symbol };
export type WriterEpoch = number & { readonly __writerEpoch: unique symbol };
export type SourceEpoch = string & { readonly __sourceEpoch: unique symbol };
export type SourceSequence = number & { readonly __sourceSequence: unique symbol };
export type LocalCommitSequence = number & { readonly __localCommitSequence: unique symbol };

export type SourceCoverage =
  | { kind: "none" }
  | { kind: "view-revision"; revision: string; revisionOrder?: number }
  | { kind: "command-ids"; commandIds: readonly string[] }
  | { kind: "coverage-token"; token: string };

export type ExplicitEntityRemoval = {
  entityType: string;
  entityId: string;
  tombstoneVersion: string;
  tombstoneVersionOrder: number;
  deletionOwnerContractId: string;
};

export type CanonicalEntityInput = {
  entityType: string;
  entityId: string;
  entityVersion: string;
  entityVersionOrder: number;
  canonicalOwnerContractId: string;
  grantKeys: readonly GrantKey[];
  value: unknown;
};

/** A query-owned row. It has stable view identity but no canonical owner/version. */
export type ProjectionViewRowInput = {
  entityKey: string;
  grantKeys: readonly GrantKey[];
  projection: unknown;
};

export type PrincipalLifecycle =
  | { phase: "locked"; generation: number; reason?: string }
  | { phase: "failed"; generation: number; reason: string; error: string }
  | { phase: "resolving"; generation: number }
  | { phase: "opening"; generation: number; principalKey: OpaquePrincipalKey }
  | {
      phase: "offline-ready";
      generation: number;
      principalEpoch: PrincipalEpoch;
      principalId: PrincipalId;
      principalKey: OpaquePrincipalKey;
      credentialBinding: CredentialBinding;
      head: LocalCommitSequence;
      storageHealth: "healthy" | "degraded";
      storageError?: string;
    }
  | {
      phase: "server-verified";
      generation: number;
      principalEpoch: PrincipalEpoch;
      principalId: PrincipalId;
      principalKey: OpaquePrincipalKey;
      credentialBinding: CredentialBinding;
      head: LocalCommitSequence;
      storageHealth: "healthy" | "degraded";
      storageError?: string;
    }
  | { phase: "locking" | "purging"; generation: number; reason?: string };

/** The one access algebra accepted by persisted view transitions. */
export type AccessResult<T> =
  | { access: "unavailable"; reason?: string }
  | { access: "unauthenticated" }
  | { access: "forbidden"; revokedGrantKeys: readonly GrantKey[] }
  | { access: "missing"; releasedGrantKeys: readonly GrantKey[]; removals: readonly ExplicitEntityRemoval[] }
  | { access: "granted"; grantKeys: readonly GrantKey[]; value: T };

export type ViewMember = {
  entityKey: string;
  projection?: unknown;
};

export type CompleteViewPayload = {
  revision: string | number;
  members: readonly ViewMember[];
};

export type AuthoritativeFence = {
  principalId: PrincipalId;
  principalEpoch: PrincipalEpoch;
  contractId: string;
  writerEpoch: WriterEpoch;
  sourceEpoch: SourceEpoch;
  sourceSequence: SourceSequence;
  coverage: SourceCoverage;
};

export type CompleteViewInput = AuthoritativeFence & {
  viewKey: ViewKey;
} & (
  | {
      storage: "canonical";
      access: "granted";
      grantKeys: readonly GrantKey[];
      rows: readonly CanonicalEntityInput[];
      projections?: Readonly<Record<string, unknown>>;
    }
  | {
      storage: "projection";
      access: "granted";
      grantKeys: readonly GrantKey[];
      rows: readonly ProjectionViewRowInput[];
    }
  | {
      storage: "canonical" | "projection";
      access: "forbidden";
      revokedGrantKeys: readonly GrantKey[];
    }
  | {
      storage: "canonical" | "projection";
      access: "missing";
      releasedGrantKeys: readonly GrantKey[];
      removals: readonly ExplicitEntityRemoval[];
    }
);

export type BoundedSegmentFence = AuthoritativeFence & {
  viewKey: ViewKey;
} & (
  | {
      storage: "canonical";
      grantKeys: readonly GrantKey[];
      rows: readonly CanonicalEntityInput[];
      projections?: Readonly<Record<string, unknown>>;
    }
  | {
      storage: "projection";
      grantKeys: readonly GrantKey[];
      rows: readonly ProjectionViewRowInput[];
    }
);

export type BoundedWindowInput = BoundedSegmentFence & {
  segmentKind: "window";
  windowKey: string;
};

export type BoundedPageInput = BoundedSegmentFence & {
  segmentKind: "page";
  pageKey: string;
};

export type OrderedDeltaChange =
  | { type: "upsert"; entity: CanonicalEntityInput }
  | { type: "delete"; removal: ExplicitEntityRemoval }
  | { type: "revokeGrant"; grantKey: GrantKey };

export type OrderedDeltaInput = Omit<AuthoritativeFence, "writerEpoch"> & {
  streamKey: string;
  /** `null` is the contract's explicit bootstrap cursor. */
  previousCursor: string | null;
  nextCursor: string;
  changes: readonly OrderedDeltaChange[];
};

export type ExplicitRemovalInput = Omit<AuthoritativeFence, "writerEpoch"> & {
  removals: readonly ExplicitEntityRemoval[];
};

export type ScopeRevocationInput = AuthoritativeFence & {
  viewKey: ViewKey;
  revokedGrantKeys: readonly GrantKey[];
  reason: "forbidden" | "membership-removed" | "policy-revoked";
};

export type MaterializedView = {
  contractId: string;
  viewKey: ViewKey;
  grantKeys: readonly GrantKey[];
  revision: string | number;
  writerEpoch: WriterEpoch;
  sourceEpoch: SourceEpoch;
  sourceSequence: SourceSequence;
  coverage: SourceCoverage;
  members: Record<string, true>;
  projections: Record<string, unknown>;
};

export type MaterializedState = {
  principalKey: OpaquePrincipalKey;
  principalEpoch: PrincipalEpoch;
  views: Record<string, MaterializedView>;
  grants: Record<string, true>;
};

export type ApplyCompleteViewInput = {
  contractId: string;
  viewKey: ViewKey;
  capturedPrincipalEpoch: PrincipalEpoch;
  writerEpoch: WriterEpoch;
  capturedSourceEpoch: SourceEpoch;
  activeSourceEpoch: SourceEpoch;
  sourceSequence: SourceSequence;
  coverage: SourceCoverage;
  result: AccessResult<CompleteViewPayload>;
};

export type TransitionOutcome =
  | { kind: "applied"; state: MaterializedState }
  | { kind: "retained"; state: MaterializedState; reason: "unavailable" | "unauthenticated" }
  | { kind: "revoked" | "missing"; state: MaterializedState }
  | { kind: "stale"; state: MaterializedState; reason: "principal" | "source" };

export function asPrincipalId(value: string): PrincipalId {
  return value as PrincipalId;
}

export function asPrincipalEpoch(value: number): PrincipalEpoch {
  return value as PrincipalEpoch;
}

export function asSourceEpoch(value: string | number): SourceEpoch {
  return String(value) as SourceEpoch;
}

export function asWriterEpoch(value: number): WriterEpoch {
  return value as WriterEpoch;
}

export function asSourceSequence(value: number): SourceSequence {
  return value as SourceSequence;
}

export function asCommitSequence(value: number): LocalCommitSequence {
  return value as LocalCommitSequence;
}

export function asViewKey(value: string): ViewKey {
  return value as ViewKey;
}

export function asGrantKey(value: string): GrantKey {
  return value as GrantKey;
}
