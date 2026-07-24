import type {
  GrantKey,
  LocalCommitSequence,
  OpaquePrincipalKey,
  PrincipalId,
  SourceCoverage,
  SourceEpoch,
  SourceSequence,
  WriterEpoch,
} from "../types";

// v3 is intentional even though v2 introduced `viewWriters`: an intermediate
// development build may already have opened a v2-named database without that
// table. Shipping another version guarantees that those real browser profiles
// execute the idempotent repair below instead of trusting a same-version schema.
export const PRINCIPAL_STORE_SCHEMA_VERSION = 3;

export type PrincipalStoreFence = {
  principalKey: OpaquePrincipalKey;
  generation: number;
};

export type PrincipalStoreMetadata = {
  key: "store";
  schemaVersion: number;
  principalKey: OpaquePrincipalKey;
  principalId: PrincipalId;
  activeGeneration: number;
  fenced: boolean;
  fencedAtGeneration?: number;
  head: LocalCommitSequence;
  createdAt: number;
  updatedAt: number;
};

export type EntityRecord = {
  key: string;
  entityType: string;
  entityId: string;
  version: string;
  /** Monotonic order produced by the registered contract's version rule. */
  versionOrder: number;
  canonicalOwnerContractId: string;
  grantKeys: readonly GrantKey[];
  value: unknown;
};

export type EntityTombstoneRecord = {
  key: string;
  entityType: string;
  entityId: string;
  tombstoneVersion: string;
  tombstoneVersionOrder: number;
  deletionOwnerContractId: string;
};

export type ViewRecord = {
  key: string;
  contractId: string;
  grantKeys: readonly GrantKey[];
  revision: string | number;
  writerEpoch: WriterEpoch;
  sourceEpoch: SourceEpoch;
  sourceSequence: SourceSequence;
  coverage: SourceCoverage;
};

export type ViewMemberRecord = {
  key: string;
  viewKey: string;
  entityKey: string;
  segmentKey: string;
  grantKeys: readonly GrantKey[];
};

export type ViewProjectionRecord = {
  key: string;
  viewKey: string;
  entityKey: string;
  segmentKey: string;
  value: unknown;
};

export type ViewSegmentRecord = {
  key: string;
  viewKey: string;
  segmentKey: string;
  segmentKind: "window" | "page";
  grantKeys: readonly GrantKey[];
  writerEpoch: WriterEpoch;
  sourceEpoch: SourceEpoch;
  sourceSequence: SourceSequence;
  coverage: SourceCoverage;
};

export type ViewWriterRecord = {
  key: string;
  contractId: string;
  writerEpoch: WriterEpoch;
  /** Last authoritative coverage survives view deletion and writer handoff. */
  lastCoverage?: SourceCoverage;
  sourceEpoch?: SourceEpoch;
  sourceSequence?: SourceSequence;
  lastAccess?: "granted" | "forbidden" | "missing";
};

type ViewAccessTransitionFence = {
  key: string;
  contractId: string;
  writerEpoch: WriterEpoch;
  sourceEpoch: SourceEpoch;
  sourceSequence: SourceSequence;
  coverage: SourceCoverage;
};

/**
 * Clearing content and changing its grant lifecycle are one semantic storage
 * operation. Keeping the exact keys on the record prevents callers from
 * deleting the membership evidence before revocation has found everything it
 * retained.
 */
export type ViewAccessTransitionRecord = ViewAccessTransitionFence & (
  | { access: "forbidden"; revokedGrantKeys: readonly GrantKey[] }
  | { access: "missing"; releasedGrantKeys: readonly GrantKey[] }
);

export type DeltaCursorRecord = {
  key: string;
  contractId: string;
  cursor: string;
  sourceEpoch: SourceEpoch;
  sourceSequence: SourceSequence;
  coverage: SourceCoverage;
};

export type GrantRecord = {
  key: string;
  contractId: string;
  scopeKey: string;
  grantedAt: number;
};

export type CommandStatus =
  | "queued"
  | "sending"
  | "checking-receipt"
  | "acknowledged-awaiting-coverage"
  | "reconciled"
  | "rejected"
  | "ambiguous"
  | "replay-expired"
  | "blocked";

export const ALLOWED_COMMAND_TRANSITIONS: Readonly<Record<CommandStatus, readonly CommandStatus[]>> = {
  queued: ["sending", "rejected", "replay-expired", "blocked"],
  sending: ["checking-receipt", "acknowledged-awaiting-coverage", "reconciled", "rejected", "ambiguous", "blocked", "replay-expired"],
  "checking-receipt": ["sending", "acknowledged-awaiting-coverage", "reconciled", "rejected", "replay-expired", "blocked"],
  "acknowledged-awaiting-coverage": ["reconciled", "rejected", "blocked"],
  ambiguous: ["reconciled", "rejected", "replay-expired", "blocked"],
  reconciled: [],
  rejected: [],
  "replay-expired": [],
  blocked: [],
};

export function isAllowedCommandTransition(from: CommandStatus, to: CommandStatus): boolean {
  return ALLOWED_COMMAND_TRANSITIONS[from].includes(to);
}

export type OptimisticOperation =
  | { kind: "upsert-projection"; viewKey: string; entityKey: string; value: unknown }
  | { kind: "remove-projection"; viewKey: string; entityKey: string }
  | { kind: "set-entity-field"; entityKey: string; field: string; value: unknown }
  | { kind: "hide-entity"; entityKey: string };

export type CommandCoverageRequirement =
  | { kind: "canonical-write-set"; entityKeys: readonly string[] }
  | { kind: "view-revision"; contractId: string; viewKey: string }
  | { kind: "command-id"; contractId: string; viewKey: string }
  | { kind: "coverage-token"; contractId: string; viewKey: string };

export type CommandReceiptCoverage =
  | {
      kind: "view-revision";
      contractId: string;
      viewKey: string;
      minimumRevision: string;
      minimumRevisionOrder: number;
    }
  | {
      kind: "canonical-write-set";
      entityVersions: Readonly<Record<string, { version: string; versionOrder: number }>>;
    }
  | { kind: "command-id"; contractId: string; viewKey: string; commandId: string }
  | { kind: "coverage-token"; contractId: string; viewKey: string; token: string };

export type CommandRecord = {
  id: string;
  principalId: PrincipalId;
  contractId: string;
  commandType: string;
  conflictKey: string;
  status: CommandStatus;
  createdAt: number;
  localSequence: number;
  operationSchemaVersion: number;
  targetGrantKeys: readonly GrantKey[];
  targetEntityKeys: readonly string[];
  optimisticActive: boolean;
  retryUntil?: number;
  replayPolicy: "server-deduplicated" | "non-replayable";
  payload: unknown;
  requiredCoverage: CommandCoverageRequirement;
  optimisticOperations: readonly OptimisticOperation[];
};

export type CommandReceiptRecord = {
  commandId: string;
  principalId: PrincipalId;
  commandType: string;
  outcome: "acknowledged" | "rejected";
  receivedAt: number;
  result?: unknown;
  rejection?: { code: string; message: string; correction?: unknown };
  coverage: readonly CommandReceiptCoverage[];
  retryUntil: number | null;
};

export type SyncMetadataRecord = {
  key: string;
  grantKeys: readonly GrantKey[];
  value: unknown;
};

export type ConversationMessagesRecord = {
  conversationId: string;
  messages: unknown[];
  pagination: unknown;
  latestTimestamp: number;
};

/** Temporary compatibility rows. They live inside the principal DB only. */
export type LegacyCollectionRecord = {
  key: string;
  collection: string;
  rowId: string;
  value: Record<string, unknown>;
};

export type LegacyMetaRecord = { key: string; value: unknown };

/**
 * A bridge-stamped legacy dispatch. Untagged entries in `codecast-store` are
 * deliberately not represented by this type and can never enter this table.
 */
export type LegacyOutboxRecord = {
  id: string;
  principalId: PrincipalId;
  action: string;
  args: unknown;
  patches: unknown;
  result: unknown;
  ts: number;
  attempts?: number;
};

export type StoreOperation =
  | { kind: "put-entity"; record: EntityRecord; expectedVersion?: string | null }
  | { kind: "garbage-collect-entity"; key: string }
  | { kind: "put-entity-tombstone"; record: EntityTombstoneRecord; expectedEntityVersion?: string | null }
  | { kind: "garbage-collect-entity-tombstone"; key: string }
  | {
      kind: "replace-complete-view";
      view: ViewRecord;
      members: readonly ViewMemberRecord[];
      projections: readonly ViewProjectionRecord[];
    }
  | {
      kind: "replace-view-segment";
      view: ViewRecord;
      segment: ViewSegmentRecord;
      members: readonly ViewMemberRecord[];
      projections: readonly ViewProjectionRecord[];
    }
  | { kind: "clear-authoritative-view"; record: ViewAccessTransitionRecord }
  | { kind: "put-delta-cursor"; record: DeltaCursorRecord; expectedCursor: string | null }
  | { kind: "put-grant"; record: GrantRecord }
  | { kind: "revoke-grant"; grantKey: string }
  | { kind: "release-grant"; grantKey: string }
  | { kind: "put-command"; record: CommandRecord }
  | { kind: "queue-command"; record: Omit<CommandRecord, "localSequence"> }
  | { kind: "delete-command"; id: string }
  | { kind: "settle-command-receipt"; record: CommandReceiptRecord }
  | { kind: "put-sync-meta"; record: SyncMetadataRecord }
  | { kind: "delete-sync-meta"; key: string }
  | { kind: "put-conversation-messages"; record: ConversationMessagesRecord }
  | { kind: "delete-conversation-messages"; conversationId: string }
  | { kind: "put-legacy-collection"; record: LegacyCollectionRecord }
  | { kind: "delete-legacy-collection"; key: string }
  | { kind: "put-legacy-meta"; record: LegacyMetaRecord }
  | { kind: "delete-legacy-meta"; key: string }
  | { kind: "put-legacy-outbox"; record: LegacyOutboxRecord }
  | { kind: "delete-legacy-outbox"; id: string };

export type PrincipalStoreSnapshot = {
  metadata: PrincipalStoreMetadata;
  entities: EntityRecord[];
  entityTombstones: EntityTombstoneRecord[];
  views: ViewRecord[];
  viewWriters: ViewWriterRecord[];
  viewSegments: ViewSegmentRecord[];
  viewMembers: ViewMemberRecord[];
  viewProjections: ViewProjectionRecord[];
  grants: GrantRecord[];
  commands: CommandRecord[];
  commandReceipts: CommandReceiptRecord[];
  syncMetadata: SyncMetadataRecord[];
  deltaCursors: DeltaCursorRecord[];
};

export type LegacyCacheSnapshot = {
  collections: Record<string, Record<string, Record<string, unknown>>>;
  meta: Record<string, unknown>;
};

export type CommitResult = {
  head: LocalCommitSequence;
  affectedKeys: readonly string[];
};

export type WriterClaimResult = CommitResult & {
  writerEpoch: WriterEpoch;
};

export type PrincipalStoreInspection = {
  /** Random local namespace hint; never the principal ID or credential binding. */
  storeKeyHint: string;
  schemaVersion: number;
  head: LocalCommitSequence;
  activeGeneration: number;
  fenced: boolean;
  views: Array<{
    key: string;
    contractId: string;
    revision: string | number | null;
    writerEpoch: WriterEpoch;
    sourceEpoch: SourceEpoch | null;
    sourceSequence: SourceSequence | null;
    access: "granted" | "forbidden" | "missing" | "unknown";
  }>;
  commands: Array<{
    id: string;
    type: string;
    status: CommandStatus;
    ageMs: number;
  }>;
  grantCount: number;
  legacy: {
    collectionRowCount: number;
    metaRowCount: number;
    outboxCount: number;
    conversationCacheCount: number;
  };
};

export class PrincipalStoreFenceError extends Error {
  constructor(message = "Principal store fence rejected the operation") {
    super(message);
    this.name = "PrincipalStoreFenceError";
  }
}

export class PrincipalStoreIdentityError extends Error {
  constructor(message = "Principal store identity does not match") {
    super(message);
    this.name = "PrincipalStoreIdentityError";
  }
}

export interface PrincipalStoreAdapter {
  readonly databaseName: string;
  readonly principalKey: OpaquePrincipalKey;

  /** Server proof is required to initialize or re-activate a fenced store. */
  activateVerified(generation: number, principalId: PrincipalId): Promise<PrincipalStoreMetadata>;
  /** Offline open never creates, rebinds, or un-fences a store. */
  openOffline(fence: PrincipalStoreFence): Promise<PrincipalStoreMetadata>;
  readMetadata(): Promise<PrincipalStoreMetadata | null>;
  readHead(fence: PrincipalStoreFence): Promise<LocalCommitSequence>;
  readSnapshot(fence: PrincipalStoreFence): Promise<PrincipalStoreSnapshot>;
  readCommands(
    fence: PrincipalStoreFence,
    statuses?: readonly CommandStatus[],
  ): Promise<CommandRecord[]>;
  readCommand(fence: PrincipalStoreFence, commandId: string): Promise<CommandRecord | null>;
  /** Payload-free diagnostic summary suitable for a developer inspector. */
  inspect(fence: PrincipalStoreFence, now?: number): Promise<PrincipalStoreInspection>;
  /** Atomically supersede every previous writer for this exact durable view. */
  claimViewWriter(
    fence: PrincipalStoreFence,
    viewKey: string,
    contractId: string,
  ): Promise<WriterClaimResult>;
  commit(
    fence: PrincipalStoreFence,
    operations: readonly StoreOperation[],
    guard?: () => void,
  ): Promise<CommitResult>;
  fence(currentGeneration: number, nextGeneration: number): Promise<void>;

  readLegacyCache(fence: PrincipalStoreFence): Promise<LegacyCacheSnapshot>;
  readConversationMessages(
    fence: PrincipalStoreFence,
    conversationId: string,
  ): Promise<ConversationMessagesRecord | null>;
  readLegacyOutbox(fence: PrincipalStoreFence): Promise<LegacyOutboxRecord[]>;

  close(): void;
  purge(): Promise<void>;
}

export type PrincipalStoreFactory = {
  exists(principalKey: OpaquePrincipalKey): Promise<boolean>;
  open(principalKey: OpaquePrincipalKey): Promise<PrincipalStoreAdapter>;
};
