import Dexie, { type Table, type Transaction } from "dexie";
import {
  asCommitSequence,
  asWriterEpoch,
  type OpaquePrincipalKey,
  type PrincipalId,
  type SourceCoverage,
} from "../types";
import {
  PRINCIPAL_STORE_SCHEMA_VERSION,
  PrincipalStoreFenceError,
  PrincipalStoreIdentityError,
  type CommandReceiptRecord,
  type CommandRecord,
  type CommandStatus,
  type CommitResult,
  type ConversationMessagesRecord,
  type DeltaCursorRecord,
  type EntityRecord,
  type EntityTombstoneRecord,
  type GrantRecord,
  type LegacyCacheSnapshot,
  type LegacyCollectionRecord,
  type LegacyMetaRecord,
  type LegacyOutboxRecord,
  type PrincipalStoreAdapter,
  type PrincipalStoreFactory,
  type PrincipalStoreFence,
  type PrincipalStoreMetadata,
  type PrincipalStoreInspection,
  type PrincipalStoreSnapshot,
  type StoreOperation,
  type SyncMetadataRecord,
  type ViewMemberRecord,
  type ViewProjectionRecord,
  type ViewAccessTransitionRecord,
  type ViewRecord,
  type ViewSegmentRecord,
  type ViewWriterRecord,
  type WriterClaimResult,
  isAllowedCommandTransition,
} from "./adapter";

export type DexieFaultPoint = "after-operations" | "after-head-write";
export type DexieFaultInjector = (point: DexieFaultPoint) => void | Promise<void>;

/**
 * Kept as an exported fixture so migration tests create the exact schema that
 * shipped, rather than a hand-written approximation that can drift silently.
 */
export const PRINCIPAL_DEXIE_V1_STORES = {
  meta: "key",
  entities: "key, [entityType+entityId], canonicalOwnerContractId, *grantKeys",
  entityTombstones: "key, [entityType+entityId], deletionOwnerContractId",
  views: "key, contractId, *grantKeys, writerEpoch",
  viewSegments: "key, viewKey, segmentKey, [viewKey+segmentKey]",
  viewMembers: "key, viewKey, entityKey, segmentKey, [viewKey+segmentKey], *grantKeys",
  viewProjections: "key, viewKey, entityKey, segmentKey, [viewKey+segmentKey]",
  grants: "key, contractId, scopeKey",
  commands: "id, principalId, status, createdAt, localSequence, *targetGrantKeys",
  commandReceipts: "commandId, principalId, receivedAt",
  syncMetadata: "key",
  deltaCursors: "key, contractId, cursor",
  conversationMessages: "conversationId, latestTimestamp",
  legacyCollections: "key, collection, rowId",
  legacyMeta: "key",
  legacyOutbox: "id, principalId, ts",
} as const;

export const PRINCIPAL_DEXIE_V2_STORES = {
  ...PRINCIPAL_DEXIE_V1_STORES,
  viewWriters: "key, contractId, writerEpoch",
} as const;

async function seedOrRepairViewWriters(transaction: Transaction): Promise<void> {
  const views = await transaction.table<ViewRecord>("views").toArray();
  const table = transaction.table<ViewWriterRecord>("viewWriters");
  for (const view of views) {
    const current = await table.get(view.key);
    if (current && current.contractId !== view.contractId) {
      throw new PrincipalStoreIdentityError("Migrated view writer contract changed");
    }
    if (!current || current.writerEpoch < view.writerEpoch) {
      await table.put({
        key: view.key,
        contractId: view.contractId,
        writerEpoch: view.writerEpoch,
        lastCoverage: view.coverage,
        sourceEpoch: view.sourceEpoch,
        sourceSequence: view.sourceSequence,
        lastAccess: "granted",
      });
    } else if (current.lastCoverage === undefined) {
      await table.put({
        ...current,
        lastCoverage: view.coverage,
        lastAccess: current.lastAccess ?? "granted",
      });
    }
  }
  const metadata = await transaction.table<PrincipalStoreMetadata>("meta").get("store");
  if (metadata) {
    await transaction.table<PrincipalStoreMetadata>("meta").put({
      ...metadata,
      schemaVersion: PRINCIPAL_STORE_SCHEMA_VERSION,
    });
  }
}

class PrincipalDexie extends Dexie {
  meta!: Table<PrincipalStoreMetadata, string>;
  entities!: Table<EntityRecord, string>;
  entityTombstones!: Table<EntityTombstoneRecord, string>;
  views!: Table<ViewRecord, string>;
  viewWriters!: Table<ViewWriterRecord, string>;
  viewSegments!: Table<ViewSegmentRecord, string>;
  viewMembers!: Table<ViewMemberRecord, string>;
  viewProjections!: Table<ViewProjectionRecord, string>;
  grants!: Table<GrantRecord, string>;
  commands!: Table<CommandRecord, string>;
  commandReceipts!: Table<CommandReceiptRecord, string>;
  syncMetadata!: Table<SyncMetadataRecord, string>;
  deltaCursors!: Table<DeltaCursorRecord, string>;
  conversationMessages!: Table<ConversationMessagesRecord, string>;
  legacyCollections!: Table<LegacyCollectionRecord, string>;
  legacyMeta!: Table<LegacyMetaRecord, string>;
  legacyOutbox!: Table<LegacyOutboxRecord, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores(PRINCIPAL_DEXIE_V1_STORES);
    this.version(2).stores(PRINCIPAL_DEXIE_V2_STORES);
    this.version(PRINCIPAL_STORE_SCHEMA_VERSION)
      .stores(PRINCIPAL_DEXIE_V2_STORES)
      .upgrade(seedOrRepairViewWriters);
  }
}

function normalizeDatabasePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 160);
}

export function principalDatabaseName(
  deploymentKey: string,
  principalKey: OpaquePrincipalKey,
): string {
  return `codecast-store-v2:${normalizeDatabasePart(deploymentKey)}:${normalizeDatabasePart(principalKey)}`;
}

function affectedKey(operation: StoreOperation): string {
  switch (operation.kind) {
    case "put-entity": return `entity:${operation.record.key}`;
    case "garbage-collect-entity": return `entity-gc:${operation.key}`;
    case "put-entity-tombstone": return `tombstone:${operation.record.key}`;
    case "garbage-collect-entity-tombstone": return `tombstone-gc:${operation.key}`;
    case "replace-complete-view": return `view:${operation.view.key}`;
    case "replace-view-segment": return `view-segment:${operation.segment.key}`;
    case "clear-authoritative-view": return `view-access:${operation.record.key}`;
    case "put-delta-cursor": return `delta:${operation.record.key}`;
    case "put-grant": return `grant:${operation.record.key}`;
    case "revoke-grant": return `grant:${operation.grantKey}`;
    case "release-grant": return `grant-release:${operation.grantKey}`;
    case "put-command": return `command:${operation.record.id}`;
    case "queue-command": return `command:${operation.record.id}`;
    case "delete-command": return `command:${operation.id}`;
    case "settle-command-receipt": return `receipt:${operation.record.commandId}`;
    case "put-sync-meta": return `sync:${operation.record.key}`;
    case "delete-sync-meta": return `sync:${operation.key}`;
    case "put-conversation-messages": return `messages:${operation.record.conversationId}`;
    case "delete-conversation-messages": return `messages:${operation.conversationId}`;
    case "put-legacy-collection": return `legacy:${operation.record.key}`;
    case "delete-legacy-collection": return `legacy:${operation.key}`;
    case "put-legacy-meta": return `legacy-meta:${operation.record.key}`;
    case "delete-legacy-meta": return `legacy-meta:${operation.key}`;
    case "put-legacy-outbox": return `legacy-outbox:${operation.record.id}`;
    case "delete-legacy-outbox": return `legacy-outbox:${operation.id}`;
  }
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (typeof left !== "object" || typeof right !== "object") return false;
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => valuesEqual(value, right[index]));
  }
  if (left instanceof ArrayBuffer || right instanceof ArrayBuffer) {
    if (!(left instanceof ArrayBuffer) || !(right instanceof ArrayBuffer) ||
      left.byteLength !== right.byteLength) return false;
    const a = new Uint8Array(left);
    const b = new Uint8Array(right);
    return a.every((value, index) => value === b[index]);
  }
  if (ArrayBuffer.isView(left) || ArrayBuffer.isView(right)) {
    if (!ArrayBuffer.isView(left) || !ArrayBuffer.isView(right) ||
      left.constructor !== right.constructor || left.byteLength !== right.byteLength) return false;
    const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength);
    const b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength);
    return a.every((value, index) => value === b[index]);
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] &&
      valuesEqual(leftRecord[key], rightRecord[key]));
}

export class DexiePrincipalStoreAdapter implements PrincipalStoreAdapter {
  readonly databaseName: string;
  readonly principalKey: OpaquePrincipalKey;
  private readonly db: PrincipalDexie;

  constructor(
    databaseName: string,
    principalKey: OpaquePrincipalKey,
    private readonly injectFault?: DexieFaultInjector,
  ) {
    this.databaseName = databaseName;
    this.principalKey = principalKey;
    this.db = new PrincipalDexie(databaseName);
  }

  async ensureOpen(): Promise<void> {
    if (!this.db.isOpen()) await this.db.open();
  }

  private assertFence(metadata: PrincipalStoreMetadata | undefined, fence: PrincipalStoreFence) {
    if (!metadata) throw new PrincipalStoreFenceError("Principal store is not initialized");
    if (metadata.principalKey !== this.principalKey || fence.principalKey !== this.principalKey) {
      throw new PrincipalStoreIdentityError();
    }
    if (metadata.fenced || metadata.activeGeneration !== fence.generation) {
      throw new PrincipalStoreFenceError();
    }
  }

  async activateVerified(
    generation: number,
    principalId: PrincipalId,
  ): Promise<PrincipalStoreMetadata> {
    await this.ensureOpen();
    return await this.db.transaction("rw", this.db.meta, async () => {
      const existing = await this.db.meta.get("store");
      if (existing && existing.principalKey !== this.principalKey) {
        throw new PrincipalStoreIdentityError();
      }
      if (existing && existing.principalId !== principalId) {
        throw new PrincipalStoreIdentityError(
          "Server-verified principal does not own this local store",
        );
      }
      // Un-fencing is only legitimate at a strictly newer launcher generation.
      // Reaching here with a fenced store at the same-or-newer generation would
      // mean a stale verify raced a fence — currently impossible because
      // launcher.lock clears the active binding and generations are monotonic,
      // but this guard keeps that safety local instead of resting entirely on
      // launcher invariants.
      if (existing?.fenced && existing.activeGeneration >= generation) {
        throw new PrincipalStoreFenceError(
          "A fenced store cannot be re-activated at a stale generation",
        );
      }
      const now = Date.now();
      const metadata: PrincipalStoreMetadata = {
        key: "store",
        schemaVersion: PRINCIPAL_STORE_SCHEMA_VERSION,
        principalKey: this.principalKey,
        principalId,
        activeGeneration: generation,
        fenced: false,
        head: asCommitSequence((existing?.head ?? 0) + 1),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await this.db.meta.put(metadata);
      return metadata;
    });
  }

  async openOffline(fence: PrincipalStoreFence): Promise<PrincipalStoreMetadata> {
    await this.ensureOpen();
    const metadata = await this.db.meta.get("store");
    this.assertFence(metadata, fence);
    return metadata!;
  }

  async readMetadata(): Promise<PrincipalStoreMetadata | null> {
    await this.ensureOpen();
    return (await this.db.meta.get("store")) ?? null;
  }

  async readHead(fence: PrincipalStoreFence) {
    const metadata = await this.readMetadata();
    this.assertFence(metadata ?? undefined, fence);
    return metadata!.head;
  }

  async readSnapshot(fence: PrincipalStoreFence): Promise<PrincipalStoreSnapshot> {
    await this.ensureOpen();
    return await this.db.transaction("r", this.db.tables, async () => {
      const metadata = await this.db.meta.get("store");
      this.assertFence(metadata, fence);
      const [
        entities,
        entityTombstones,
        views,
        viewWriters,
        viewSegments,
        viewMembers,
        viewProjections,
        grants,
        commands,
        commandReceipts,
        syncMetadata,
        deltaCursors,
      ] = await Promise.all([
        this.db.entities.toArray(),
        this.db.entityTombstones.toArray(),
        this.db.views.toArray(),
        this.db.viewWriters.toArray(),
        this.db.viewSegments.toArray(),
        this.db.viewMembers.toArray(),
        this.db.viewProjections.toArray(),
        this.db.grants.toArray(),
        this.db.commands.toArray(),
        this.db.commandReceipts.toArray(),
        this.db.syncMetadata.toArray(),
        this.db.deltaCursors.toArray(),
      ]);
      return {
        metadata: metadata!,
        entities,
        entityTombstones,
        views,
        viewWriters,
        viewSegments,
        viewMembers,
        viewProjections,
        grants,
        commands,
        commandReceipts,
        syncMetadata,
        deltaCursors,
      };
    });
  }

  async claimViewWriter(
    fence: PrincipalStoreFence,
    viewKey: string,
    contractId: string,
  ): Promise<WriterClaimResult> {
    await this.ensureOpen();
    return await this.db.transaction("rw", [this.db.meta, this.db.viewWriters], async () => {
      const metadata = await this.db.meta.get("store");
      this.assertFence(metadata, fence);
      const current = await this.db.viewWriters.get(viewKey);
      if (current && current.contractId !== contractId) {
        throw new PrincipalStoreIdentityError("Durable view writer contract changed");
      }
      const writerEpoch = asWriterEpoch((current?.writerEpoch ?? 0) + 1);
      await this.db.viewWriters.put({
        key: viewKey,
        contractId,
        writerEpoch,
        // Content can be deleted by a forbidden/missing transition, but its
        // causal high-water mark must survive. Otherwise a newly claimed
        // writer could resurrect a pre-clear cached result as if it were the
        // first payload this store had ever seen.
        lastCoverage: current?.lastCoverage,
        lastAccess: current?.lastAccess,
      });
      await this.injectFault?.("after-operations");
      const next: PrincipalStoreMetadata = {
        ...metadata!,
        head: asCommitSequence(metadata!.head + 1),
        updatedAt: Date.now(),
      };
      await this.db.meta.put(next);
      await this.injectFault?.("after-head-write");
      return {
        writerEpoch,
        head: next.head,
        affectedKeys: [`view-writer:${viewKey}`],
      };
    });
  }

  async readCommands(
    fence: PrincipalStoreFence,
    statuses?: readonly CommandStatus[],
  ): Promise<CommandRecord[]> {
    await this.ensureOpen();
    return await this.db.transaction("r", [this.db.meta, this.db.commands], async () => {
      const metadata = await this.db.meta.get("store");
      this.assertFence(metadata, fence);
      const commands = statuses
        ? await this.db.commands.filter((row) => statuses.includes(row.status)).toArray()
        : await this.db.commands.toArray();
      return commands.sort((a, b) =>
        a.localSequence - b.localSequence || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    });
  }

  async readCommand(
    fence: PrincipalStoreFence,
    commandId: string,
  ): Promise<CommandRecord | null> {
    await this.ensureOpen();
    return await this.db.transaction("r", [this.db.meta, this.db.commands], async () => {
      const metadata = await this.db.meta.get("store");
      this.assertFence(metadata, fence);
      return (await this.db.commands.get(commandId)) ?? null;
    });
  }

  async inspect(
    fence: PrincipalStoreFence,
    now = Date.now(),
  ): Promise<PrincipalStoreInspection> {
    await this.ensureOpen();
    return await this.db.transaction("r", [
      this.db.meta,
      this.db.views,
      this.db.viewWriters,
      this.db.commands,
      this.db.grants,
      this.db.legacyCollections,
      this.db.legacyMeta,
      this.db.legacyOutbox,
      this.db.conversationMessages,
    ], async () => {
      const metadata = await this.db.meta.get("store");
      this.assertFence(metadata, fence);
      const [
        views,
        writers,
        commands,
        grantCount,
        collectionRowCount,
        metaRowCount,
        outboxCount,
        conversationCacheCount,
      ] = await Promise.all([
        this.db.views.toArray(),
        this.db.viewWriters.toArray(),
        this.db.commands.toArray(),
        this.db.grants.count(),
        this.db.legacyCollections.count(),
        this.db.legacyMeta.count(),
        this.db.legacyOutbox.count(),
        this.db.conversationMessages.count(),
      ]);
      const viewsByKey = new Map(views.map((view) => [view.key, view]));
      return {
        storeKeyHint: `${String(this.principalKey).slice(0, 8)}…`,
        schemaVersion: metadata!.schemaVersion,
        head: metadata!.head,
        activeGeneration: metadata!.activeGeneration,
        fenced: metadata!.fenced,
        views: writers
          .map((writer) => {
            const view = viewsByKey.get(writer.key);
            return {
              key: writer.key,
              contractId: writer.contractId,
              revision: view?.revision ?? null,
              writerEpoch: writer.writerEpoch,
              sourceEpoch: writer.sourceEpoch ?? view?.sourceEpoch ?? null,
              sourceSequence: writer.sourceSequence ?? view?.sourceSequence ?? null,
              access: writer.lastAccess ?? (view ? "granted" as const : "unknown" as const),
            };
          })
          .sort((a, b) => a.key.localeCompare(b.key)),
        commands: commands
          .map((command) => ({
            id: command.id,
            type: command.commandType,
            status: command.status,
            ageMs: Math.max(0, now - command.createdAt),
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        grantCount,
        legacy: { collectionRowCount, metaRowCount, outboxCount, conversationCacheCount },
      };
    });
  }

  private async deleteView(viewKey: string): Promise<void> {
    await Promise.all([
      this.db.views.delete(viewKey),
      this.db.viewSegments.where("viewKey").equals(viewKey).delete(),
      this.db.viewMembers.where("viewKey").equals(viewKey).delete(),
      this.db.viewProjections.where("viewKey").equals(viewKey).delete(),
    ]);
  }

  private async assertViewGrants(
    contractId: string,
    viewKey: string,
    grantKeys: Iterable<string>,
  ): Promise<void> {
    for (const grantKey of new Set(grantKeys)) {
      const grant = await this.db.grants.get(grantKey);
      if (!grant) {
        throw new PrincipalStoreFenceError("View references a grant that was not established");
      }
      if (grant.contractId !== contractId || grant.scopeKey !== viewKey) {
        throw new PrincipalStoreIdentityError("View grant belongs to another contract or scope");
      }
    }
  }

  private assertViewRows(
    view: ViewRecord,
    segmentKey: string,
    members: readonly ViewMemberRecord[],
    projections: readonly ViewProjectionRecord[],
  ): void {
    const memberKeys = new Set<string>();
    for (const member of members) {
      const expectedKey = `${view.key}\0${segmentKey}\0${member.entityKey}`;
      if (member.viewKey !== view.key || member.segmentKey !== segmentKey ||
        member.key !== expectedKey || memberKeys.has(member.key)) {
        throw new PrincipalStoreIdentityError("Malformed or duplicate view member identity");
      }
      memberKeys.add(member.key);
    }
    const projectionKeys = new Set<string>();
    for (const projection of projections) {
      const expectedKey = `${view.key}\0${segmentKey}\0${projection.entityKey}`;
      if (projection.viewKey !== view.key || projection.segmentKey !== segmentKey ||
        projection.key !== expectedKey || projectionKeys.has(projection.key) ||
        !memberKeys.has(expectedKey)) {
        throw new PrincipalStoreIdentityError(
          "Malformed, duplicate, or unowned view projection identity",
        );
      }
      projectionKeys.add(projection.key);
    }
  }

  private assertViewRevisionMatchesCoverage(view: ViewRecord): void {
    if (view.coverage.kind === "view-revision" &&
      String(view.revision) !== view.coverage.revision) {
      throw new PrincipalStoreIdentityError("View revision disagrees with its coverage proof");
    }
  }

  private compareCoverage(
    current: SourceCoverage,
    next: SourceCoverage,
  ): "older" | "equal" | "newer" | "incomparable" {
    if (current.kind !== "view-revision" || next.kind !== "view-revision") {
      return valuesEqual(current, next) ? "equal" : "incomparable";
    }
    const currentOrder = current.revisionOrder;
    const nextOrder = next.revisionOrder;
    if (current.revision === next.revision) {
      if (currentOrder !== undefined && nextOrder !== undefined && currentOrder !== nextOrder) {
        throw new PrincipalStoreIdentityError("One server revision has conflicting order values");
      }
      return "equal";
    }
    if (currentOrder === undefined || nextOrder === undefined) return "incomparable";
    if (currentOrder === nextOrder) {
      throw new PrincipalStoreIdentityError("One server revision order names different revisions");
    }
    return nextOrder < currentOrder ? "older" : "newer";
  }

  private assertMonotonicViewCoverage(
    current: ViewRecord | undefined,
    next: Pick<ViewRecord, "writerEpoch" | "coverage">,
    writer: ViewWriterRecord,
    nextAccess: "granted" | "forbidden" | "missing",
  ):
    "initial" | "equal" | "newer" | "source-ordered" {
    if (current) this.assertViewRevisionMatchesCoverage(current);
    if (current && writer.lastCoverage !== undefined &&
      !valuesEqual(current.coverage, writer.lastCoverage)) {
      throw new PrincipalStoreIdentityError("View and durable writer coverage disagree");
    }
    const durableCoverage = current?.coverage ?? writer.lastCoverage;
    if (!durableCoverage) return "initial";
    const previousAccess = current ? "granted" : writer.lastAccess;
    const comparison = this.compareCoverage(durableCoverage, next.coverage);
    if (comparison === "older") {
      throw new PrincipalStoreFenceError("Server view revision moved backwards");
    }
    if (comparison === "equal") {
      if (previousAccess !== undefined && previousAccess !== nextAccess) {
        throw new PrincipalStoreFenceError(
          "Equal server coverage cannot change authoritative access state",
        );
      }
      return "equal";
    }
    if (comparison === "newer") return "newer";
    if (!current || current.writerEpoch !== next.writerEpoch) {
      // A forbidden/missing transition only deletes: accepting it from a
      // successor writer cannot resurrect stale data, and rejecting it would
      // make a revocation that arrives after a reload (writer re-claimed, so
      // epochs differ, and the transition carries no comparable coverage)
      // permanently unpurgeable. Granted payloads still require comparable
      // monotonic coverage from a successor.
      if (nextAccess !== "granted") return "source-ordered";
      throw new PrincipalStoreFenceError(
        "A successor writer requires comparable monotonic view coverage",
      );
    }
    return "source-ordered";
  }

  private completeViewContentEqual(
    current: ViewRecord,
    currentMembers: readonly ViewMemberRecord[],
    currentProjections: readonly ViewProjectionRecord[],
    next: ViewRecord,
    nextMembers: readonly ViewMemberRecord[],
    nextProjections: readonly ViewProjectionRecord[],
  ): boolean {
    const stableView = (view: ViewRecord) => ({
      key: view.key,
      contractId: view.contractId,
      grantKeys: [...view.grantKeys].sort(),
      revision: view.revision,
      coverage: view.coverage,
    });
    const stableMembers = (members: readonly ViewMemberRecord[]) => [...members]
      .map((member) => ({ ...member, grantKeys: [...member.grantKeys].sort() }))
      .sort((a, b) => a.key.localeCompare(b.key));
    const stableProjections = (projections: readonly ViewProjectionRecord[]) =>
      [...projections].sort((a, b) => a.key.localeCompare(b.key));
    return valuesEqual(stableView(current), stableView(next)) &&
      valuesEqual(stableMembers(currentMembers), stableMembers(nextMembers)) &&
      valuesEqual(stableProjections(currentProjections), stableProjections(nextProjections));
  }

  private segmentContentEqual(
    current: ViewSegmentRecord,
    currentMembers: readonly ViewMemberRecord[],
    currentProjections: readonly ViewProjectionRecord[],
    next: ViewSegmentRecord,
    nextMembers: readonly ViewMemberRecord[],
    nextProjections: readonly ViewProjectionRecord[],
  ): boolean {
    const stableSegment = (segment: ViewSegmentRecord) => ({
      key: segment.key,
      viewKey: segment.viewKey,
      segmentKey: segment.segmentKey,
      segmentKind: segment.segmentKind,
      grantKeys: [...segment.grantKeys].sort(),
      coverage: segment.coverage,
    });
    const stableMembers = (members: readonly ViewMemberRecord[]) => [...members]
      .map((member) => ({ ...member, grantKeys: [...member.grantKeys].sort() }))
      .sort((a, b) => a.key.localeCompare(b.key));
    const stableProjections = (projections: readonly ViewProjectionRecord[]) =>
      [...projections].sort((a, b) => a.key.localeCompare(b.key));
    return valuesEqual(stableSegment(current), stableSegment(next)) &&
      valuesEqual(stableMembers(currentMembers), stableMembers(nextMembers)) &&
      valuesEqual(stableProjections(currentProjections), stableProjections(nextProjections));
  }

  private async grantIsReferenced(grantKey: string): Promise<boolean> {
    const [view, segment, member, entity, command, sync] = await Promise.all([
      this.db.views.filter((row) => row.grantKeys.includes(grantKey as any)).first(),
      this.db.viewSegments.filter((row) => row.grantKeys.includes(grantKey as any)).first(),
      this.db.viewMembers.filter((row) => row.grantKeys.includes(grantKey as any)).first(),
      this.db.entities.filter((row) => row.grantKeys.includes(grantKey as any)).first(),
      this.db.commands.filter((row) =>
        row.optimisticActive && row.targetGrantKeys.includes(grantKey as any)).first(),
      this.db.syncMetadata.filter((row) => row.grantKeys.includes(grantKey as any)).first(),
    ]);
    return !!(view || segment || member || entity || command || sync);
  }

  private async grantHasAuthoritativeEvidence(grantKey: string): Promise<boolean> {
    const [view, segment, member, entity, sync] = await Promise.all([
      this.db.views.filter((row) => row.grantKeys.includes(grantKey as any)).first(),
      this.db.viewSegments.filter((row) => row.grantKeys.includes(grantKey as any)).first(),
      this.db.viewMembers.filter((row) => row.grantKeys.includes(grantKey as any)).first(),
      this.db.entities.filter((row) => row.grantKeys.includes(grantKey as any)).first(),
      this.db.syncMetadata.filter((row) => row.grantKeys.includes(grantKey as any)).first(),
    ]);
    return !!(view || segment || member || entity || sync);
  }

  private async assertCommandAuthorization(command: CommandRecord): Promise<void> {
    if (command.targetGrantKeys.length === 0) {
      throw new PrincipalStoreFenceError(
        "Durable protected commands require authoritative grant evidence",
      );
    }
    const grants = new Map<string, GrantRecord>();
    for (const grantKey of new Set(command.targetGrantKeys)) {
      const grant = await this.db.grants.get(grantKey);
      if (!grant || !(await this.grantHasAuthoritativeEvidence(grantKey))) {
        throw new PrincipalStoreFenceError(
          "Command target grant is absent, revoked, or no longer authoritative",
        );
      }
      grants.set(grantKey, grant);
    }

    const requiredView = command.requiredCoverage.kind === "canonical-write-set"
      ? null
      : {
          key: command.requiredCoverage.viewKey,
          contractId: command.requiredCoverage.contractId,
        };
    const optimisticViews = command.optimisticOperations.flatMap((operation) =>
      operation.kind === "upsert-projection" || operation.kind === "remove-projection"
        ? [operation.viewKey]
        : []);
    const targetViews = new Map<string, string | null>();
    if (requiredView) targetViews.set(requiredView.key, requiredView.contractId);
    for (const viewKey of optimisticViews) {
      if (!targetViews.has(viewKey)) targetViews.set(viewKey, null);
    }
    for (const [viewKey, contractId] of targetViews) {
      const view = await this.db.views.get(viewKey);
      if (!view || (contractId !== null && view.contractId !== contractId)) {
        throw new PrincipalStoreFenceError("Command targets a view that is not authorized");
      }
      const memberGrants = await this.db.viewMembers.where("viewKey").equals(viewKey).toArray();
      const authorizedKeys = new Set([
        ...view.grantKeys,
        ...memberGrants.flatMap((member) => [...member.grantKeys]),
      ]);
      if (![...grants.keys()].some((grantKey) => authorizedKeys.has(grantKey as any))) {
        throw new PrincipalStoreFenceError("Command grant does not authorize its target view");
      }
    }
  }

  private async pruneUnreferencedGrants(grantKeys: Iterable<string>): Promise<void> {
    for (const grantKey of new Set(grantKeys)) {
      if (!(await this.grantIsReferenced(grantKey))) await this.db.grants.delete(grantKey);
    }
  }

  private async retireViewWriters(
    viewKeys: Iterable<string>,
    lastAccess: "forbidden" | "missing",
  ): Promise<void> {
    for (const viewKey of new Set(viewKeys)) {
      const writer = await this.db.viewWriters.get(viewKey);
      if (!writer) continue;
      await this.db.viewWriters.put({
        key: writer.key,
        contractId: writer.contractId,
        writerEpoch: asWriterEpoch(writer.writerEpoch + 1),
        lastAccess,
      });
    }
  }

  private async releaseGrant(grantKey: string): Promise<void> {
    const [views, segments, members, entities, syncRows] = await Promise.all([
      this.db.views.filter((view) => view.grantKeys.includes(grantKey as any)).toArray(),
      this.db.viewSegments.filter((segment) => segment.grantKeys.includes(grantKey as any)).toArray(),
      this.db.viewMembers.filter((member) => member.grantKeys.includes(grantKey as any)).toArray(),
      this.db.entities.filter((entity) => entity.grantKeys.includes(grantKey as any)).toArray(),
      this.db.syncMetadata.filter((row) => row.grantKeys.includes(grantKey as any)).toArray(),
    ]);

    // A release is ordinary lifecycle/retention bookkeeping, not a security
    // event. Remove the obsolete association, but do not purge canonical rows
    // or retire commands merely because a complete parent/detail view became
    // missing. Explicit server removals are applied as separate tombstones.
    for (const view of views) {
      await this.db.views.put({
        ...view,
        grantKeys: view.grantKeys.filter((key) => key !== grantKey),
      });
    }
    for (const member of members) {
      await this.db.viewMembers.put({
        ...member,
        grantKeys: member.grantKeys.filter((key) => key !== grantKey),
      });
    }
    for (const segment of segments) {
      await this.db.viewSegments.put({
        ...segment,
        grantKeys: segment.grantKeys.filter((key) => key !== grantKey),
      });
    }
    for (const entity of entities) {
      await this.db.entities.put({
        ...entity,
        grantKeys: entity.grantKeys.filter((key) => key !== grantKey),
      });
    }
    for (const row of syncRows) {
      const surviving = row.grantKeys.filter((key) => key !== grantKey);
      if (surviving.length === 0) await this.db.syncMetadata.delete(row.key);
      else await this.db.syncMetadata.put({ ...row, grantKeys: surviving });
    }
    await this.db.grants.delete(grantKey);
    await this.retireViewWriters([
      ...views.map((view) => view.key),
      ...segments.map((segment) => segment.viewKey),
      ...members.map((member) => member.viewKey),
    ], "missing");
  }

  private async revokeGrant(grantKey: string): Promise<void> {
    const [views, grantedSegments, grantedMembers, directlyGrantedEntities] = await Promise.all([
      this.db.views.filter((view) => view.grantKeys.includes(grantKey as any)).toArray(),
      this.db.viewSegments.filter((segment) => segment.grantKeys.includes(grantKey as any)).toArray(),
      this.db.viewMembers.filter((member) => member.grantKeys.includes(grantKey as any)).toArray(),
      this.db.entities.filter((entity) => entity.grantKeys.includes(grantKey as any)).toArray(),
    ]);
    const candidateEntityKeys = new Set<string>();
    for (const entity of directlyGrantedEntities) candidateEntityKeys.add(entity.key);
    for (const member of grantedMembers) candidateEntityKeys.add(member.entityKey);

    for (const segment of grantedSegments) {
      const survivingSegmentGrants = segment.grantKeys.filter((key) => key !== grantKey);
      if (survivingSegmentGrants.length === 0) {
        const members = await this.db.viewMembers.where("[viewKey+segmentKey]").equals([
          segment.viewKey,
          segment.segmentKey,
        ]).toArray();
        for (const member of members) candidateEntityKeys.add(member.entityKey);
        await Promise.all([
          this.db.viewSegments.delete(segment.key),
          this.db.viewMembers.where("[viewKey+segmentKey]").equals([
            segment.viewKey,
            segment.segmentKey,
          ]).delete(),
          this.db.viewProjections.where("[viewKey+segmentKey]").equals([
            segment.viewKey,
            segment.segmentKey,
          ]).delete(),
        ]);
      } else {
        await this.db.viewSegments.put({ ...segment, grantKeys: survivingSegmentGrants });
      }
    }

    // Membership grants are independently reference-counted from the grant on
    // the enclosing view. This matters when one view survives through another
    // scope but an individual row no longer does.
    for (const member of grantedMembers) {
      const survivingMemberGrants = member.grantKeys.filter((key) => key !== grantKey);
      if (survivingMemberGrants.length === 0) {
        await this.db.viewMembers.delete(member.key);
        await this.db.viewProjections
          .where("viewKey")
          .equals(member.viewKey)
          .filter((projection) =>
            projection.entityKey === member.entityKey &&
            projection.segmentKey === member.segmentKey)
          .delete();
      } else {
        await this.db.viewMembers.put({ ...member, grantKeys: survivingMemberGrants });
      }
    }

    for (const view of views) {
      const members = await this.db.viewMembers.where("viewKey").equals(view.key).toArray();
      for (const member of members) candidateEntityKeys.add(member.entityKey);
      const survivingViewGrants = view.grantKeys.filter((key) => key !== grantKey);
      if (survivingViewGrants.length === 0) {
        await this.deleteView(view.key);
      } else {
        await this.db.views.put({ ...view, grantKeys: survivingViewGrants });
      }
    }
    await this.db.grants.delete(grantKey);
    const commands = await this.db.commands.filter((command) =>
      command.optimisticActive && command.targetGrantKeys.includes(grantKey as any)).toArray();
    for (const command of commands) {
      const surviving = command.targetGrantKeys.filter((key) => key !== grantKey);
      if (surviving.length > 0) {
        await this.db.commands.put({ ...command, targetGrantKeys: surviving });
      } else {
        await this.db.commands.put({
          ...command,
          targetGrantKeys: [],
          targetEntityKeys: [],
          status: command.status === "sending" || command.status === "checking-receipt" ||
            command.status === "ambiguous"
            ? "ambiguous"
            : command.status === "acknowledged-awaiting-coverage"
              ? "reconciled"
              : "blocked",
          optimisticActive: false,
          // A command record is not an authorization grant. Once its final
          // target grant is revoked, retain only lifecycle/audit metadata.
          payload: null,
          optimisticOperations: [],
        });
      }
    }
    const syncRows = await this.db.syncMetadata.filter((row) =>
      row.grantKeys.includes(grantKey as any)).toArray();
    for (const row of syncRows) {
      const surviving = row.grantKeys.filter((key) => key !== grantKey);
      if (surviving.length === 0) await this.db.syncMetadata.delete(row.key);
      else await this.db.syncMetadata.put({ ...row, grantKeys: surviving });
    }
    for (const entityKey of candidateEntityKeys) {
      const survivingMembership = await this.db.viewMembers.where("entityKey").equals(entityKey).first();
      const entity = await this.db.entities.get(entityKey);
      if (entity) {
        const survivingEntityGrants = entity.grantKeys.filter((key) => key !== grantKey);
        const survivingCommand = await this.db.commands.filter((row) =>
          row.optimisticActive && row.targetEntityKeys.includes(entityKey)).first();
        if (!survivingMembership && !survivingCommand && survivingEntityGrants.length === 0) {
          await this.db.entities.delete(entityKey);
        } else {
          await this.db.entities.put({ ...entity, grantKeys: survivingEntityGrants });
        }
      }
    }
    await this.retireViewWriters([
      ...views.map((view) => view.key),
      ...grantedSegments.map((segment) => segment.viewKey),
      ...grantedMembers.map((member) => member.viewKey),
    ], "forbidden");
  }

  private async assertViewFence(
    next: Pick<ViewRecord, "key" | "contractId" | "writerEpoch" | "sourceEpoch" | "sourceSequence">,
  ): Promise<ViewWriterRecord> {
    const writer = await this.db.viewWriters.get(next.key);
    if (!writer || writer.contractId !== next.contractId || writer.writerEpoch !== next.writerEpoch) {
      throw new PrincipalStoreFenceError("View payload does not own the durable writer fence");
    }
    if (writer.sourceEpoch !== undefined && next.sourceEpoch !== writer.sourceEpoch) {
      throw new PrincipalStoreFenceError("Source epoch does not own the durable writer fence");
    }
    if (writer.sourceSequence !== undefined && next.sourceSequence <= writer.sourceSequence) {
      throw new PrincipalStoreFenceError("Stale or duplicate source sequence");
    }
    return writer;
  }

  private async recordGrantedViewHead(view: ViewRecord): Promise<void> {
    const writer = await this.assertViewFence(view);
    await this.db.viewWriters.put({
      ...writer,
      lastCoverage: view.coverage,
      sourceEpoch: view.sourceEpoch,
      sourceSequence: view.sourceSequence,
      lastAccess: "granted",
    });
  }

  private async purgeUnretainedEntities(entityKeys: Iterable<string>): Promise<void> {
    for (const entityKey of new Set(entityKeys)) {
      const entity = await this.db.entities.get(entityKey);
      if (!entity) continue;
      const [membership, command] = await Promise.all([
        this.db.viewMembers.where("entityKey").equals(entityKey).first(),
        this.db.commands.filter((row) =>
          row.optimisticActive && row.targetEntityKeys.includes(entityKey)).first(),
      ]);
      if (!membership && !command && entity.grantKeys.length === 0) {
        await this.db.entities.delete(entityKey);
      }
    }
  }

  private async clearAuthoritativeView(record: ViewAccessTransitionRecord): Promise<void> {
    const writer = await this.assertViewFence(record);
    const oldView = await this.db.views.get(record.key);
    this.assertMonotonicViewCoverage(oldView, record, writer, record.access);
    const oldMembers = await this.db.viewMembers.where("viewKey").equals(record.key).toArray();
    const oldSegments = await this.db.viewSegments.where("viewKey").equals(record.key).toArray();
    const oldGrantKeys = [...new Set([
      ...(oldView?.grantKeys ?? []),
      ...oldMembers.flatMap((member) => [...member.grantKeys]),
      ...oldSegments.flatMap((segment) => [...segment.grantKeys]),
    ])];
    const transitionedGrantKeys = record.access === "forbidden"
      ? record.revokedGrantKeys
      : record.releasedGrantKeys;
    if (oldGrantKeys.some((grantKey) => !transitionedGrantKeys.includes(grantKey))) {
      throw new PrincipalStoreFenceError(
        `${record.access} view transition omitted a previously bound grant`,
      );
    }
    await this.deleteView(record.key);

    // Grant lifecycle must run while the old membership keys are still held in
    // this transaction. In particular, a final revocation retires related
    // commands before the canonical rows formerly retained only by this view
    // are considered for physical deletion.
    for (const grantKey of transitionedGrantKeys) {
      if (record.access === "forbidden") await this.revokeGrant(grantKey);
      else await this.releaseGrant(grantKey);
    }
    if (record.access === "forbidden") {
      await this.purgeUnretainedEntities(oldMembers.map((member) => member.entityKey));
    }

    // Clearing a view also retires its writer. This durable head survives the
    // content deletion, so an old tab cannot recreate a forbidden/missing view.
    const latestWriter = await this.db.viewWriters.get(record.key);
    await this.db.viewWriters.put({
      key: writer.key,
      contractId: writer.contractId,
      writerEpoch: asWriterEpoch(Math.max(
        writer.writerEpoch,
        latestWriter?.writerEpoch ?? writer.writerEpoch,
      ) + 1),
      // An access transition without its own comparable proof may be accepted
      // only from the currently ordered source. Retain the prior comparable
      // high-water mark so the next writer still cannot resurrect older data.
      lastCoverage: record.coverage.kind === "none"
        ? oldView?.coverage ?? writer.lastCoverage ?? record.coverage
        : record.coverage,
      lastAccess: record.access,
    });
    await this.pruneUnreferencedGrants(oldGrantKeys);
  }

  private receiptMatchesCommandContract(
    command: CommandRecord,
    receipt: CommandReceiptRecord,
  ): boolean {
    const requirement = command.requiredCoverage;
    switch (requirement.kind) {
      case "view-revision":
        return receipt.coverage.some((coverage) =>
          coverage.kind === "view-revision" &&
          coverage.contractId === requirement.contractId &&
          coverage.viewKey === requirement.viewKey);
      case "canonical-write-set":
        return receipt.coverage.some((coverage) =>
          coverage.kind === "canonical-write-set" &&
          requirement.entityKeys.every((key) => coverage.entityVersions[key] !== undefined));
      case "command-id":
        return receipt.coverage.some((coverage) =>
          coverage.kind === "command-id" &&
          coverage.contractId === requirement.contractId &&
          coverage.viewKey === requirement.viewKey &&
          coverage.commandId === command.id);
      case "coverage-token":
        return receipt.coverage.some((coverage) =>
          coverage.kind === "coverage-token" &&
          coverage.contractId === requirement.contractId &&
          coverage.viewKey === requirement.viewKey);
    }
  }

  private async commandHasDurableCoverage(
    command: CommandRecord,
    receipt: CommandReceiptRecord,
  ): Promise<boolean> {
    const requirement = command.requiredCoverage;
    switch (requirement.kind) {
      case "view-revision": {
        const target = receipt.coverage.find((coverage) =>
          coverage.kind === "view-revision" &&
          coverage.contractId === requirement.contractId &&
          coverage.viewKey === requirement.viewKey);
        if (!target || target.kind !== "view-revision") return false;
        const view = await this.db.views.get(requirement.viewKey);
        return !!view && view.contractId === requirement.contractId &&
          view.coverage.kind === "view-revision" &&
          (view.coverage.revision === target.minimumRevision ||
            (view.coverage.revisionOrder !== undefined &&
              view.coverage.revisionOrder >= target.minimumRevisionOrder));
      }
      case "canonical-write-set": {
        const target = receipt.coverage.find((coverage) => coverage.kind === "canonical-write-set");
        if (!target || target.kind !== "canonical-write-set") return false;
        for (const entityKey of requirement.entityKeys) {
          const entity = await this.db.entities.get(entityKey);
          const requiredVersion = target.entityVersions[entityKey];
          if (!entity || !requiredVersion || entity.versionOrder < requiredVersion.versionOrder ||
            (entity.versionOrder === requiredVersion.versionOrder &&
              entity.version !== requiredVersion.version)) return false;
        }
        return true;
      }
      case "command-id": {
        const target = receipt.coverage.find((coverage) =>
          coverage.kind === "command-id" && coverage.commandId === command.id);
        if (!target || target.kind !== "command-id") return false;
        const view = await this.db.views.get(requirement.viewKey);
        return !!view && view.contractId === requirement.contractId &&
          view.coverage.kind === "command-ids" &&
          view.coverage.commandIds.includes(command.id);
      }
      case "coverage-token": {
        const target = receipt.coverage.find((coverage) => coverage.kind === "coverage-token");
        if (!target || target.kind !== "coverage-token") return false;
        const view = await this.db.views.get(requirement.viewKey);
        return !!view && view.contractId === requirement.contractId &&
          view.coverage.kind === "coverage-token" && view.coverage.token === target.token;
      }
    }
  }

  private async reconcileCommandsForView(view: ViewRecord): Promise<void> {
    const commands = await this.db.commands
      .where("status")
      .equals("acknowledged-awaiting-coverage")
      .toArray();
    for (const command of commands) {
      const requirement = command.requiredCoverage;
      if (requirement.kind === "canonical-write-set" ||
        requirement.contractId !== view.contractId || requirement.viewKey !== view.key) continue;
      const receipt = await this.db.commandReceipts.get(command.id);
      if (receipt && await this.commandHasDurableCoverage(command, receipt)) {
        await this.db.commands.put({
          ...command,
          status: "reconciled",
          optimisticActive: false,
        });
      }
    }
  }

  private async reconcileAcknowledgedCommands(): Promise<void> {
    const commands = await this.db.commands
      .where("status")
      .equals("acknowledged-awaiting-coverage")
      .toArray();
    for (const command of commands) {
      const receipt = await this.db.commandReceipts.get(command.id);
      if (receipt && await this.commandHasDurableCoverage(command, receipt)) {
        await this.db.commands.put({
          ...command,
          status: "reconciled",
          optimisticActive: false,
        });
      }
    }
  }

  private async settleCommandReceipt(
    receipt: CommandReceiptRecord,
    principalId: PrincipalId,
  ): Promise<void> {
    if (receipt.principalId !== principalId) throw new PrincipalStoreIdentityError();
    const command = await this.db.commands.get(receipt.commandId);
    if (!command || command.principalId !== principalId || command.commandType !== receipt.commandType) {
      throw new PrincipalStoreIdentityError("Receipt does not match a local command");
    }
    const existing = await this.db.commandReceipts.get(receipt.commandId);
    if (existing && !valuesEqual(existing, receipt)) {
      throw new PrincipalStoreIdentityError("Command receipt changed across replay");
    }
    if (receipt.outcome === "acknowledged") {
      if (!this.receiptMatchesCommandContract(command, receipt)) {
        throw new PrincipalStoreFenceError("Acknowledged receipt lacks the declared coverage target");
      }
      const covered = await this.commandHasDurableCoverage(command, receipt);
      if (command.status !== "reconciled") {
        if (!["sending", "checking-receipt", "ambiguous", "acknowledged-awaiting-coverage"]
          .includes(command.status)) {
          throw new PrincipalStoreFenceError(`Cannot acknowledge command in ${command.status}`);
        }
        await this.db.commands.put({
          ...command,
          retryUntil: receipt.retryUntil ?? command.retryUntil,
          status: covered ? "reconciled" : "acknowledged-awaiting-coverage",
          optimisticActive: !covered,
        });
      }
    } else {
      if (!receipt.rejection) {
        throw new PrincipalStoreFenceError("Rejected receipt is missing rejection details");
      }
      if (command.status !== "rejected") {
        if (!["queued", "sending", "checking-receipt", "ambiguous", "acknowledged-awaiting-coverage"]
          .includes(command.status)) {
          throw new PrincipalStoreFenceError(`Cannot reject command in ${command.status}`);
        }
        await this.db.commands.put({
          ...command,
          status: "rejected",
          optimisticActive: false,
        });
      }
    }
    await this.db.commandReceipts.put(receipt);
  }

  private async applyOperation(
    operation: StoreOperation,
    principalId: PrincipalId,
    nextHead: number,
  ): Promise<void> {
    switch (operation.kind) {
      case "put-entity": {
        if (operation.record.key !== `${operation.record.entityType}:${operation.record.entityId}`) {
          throw new PrincipalStoreIdentityError("Canonical entity key does not match its identity");
        }
        const current = await this.db.entities.get(operation.record.key);
        if (operation.expectedVersion !== undefined && (current?.version ?? null) !== operation.expectedVersion) {
          throw new PrincipalStoreFenceError("Entity version precondition failed");
        }
        if (current && (current.entityType !== operation.record.entityType ||
          current.entityId !== operation.record.entityId ||
          current.canonicalOwnerContractId !== operation.record.canonicalOwnerContractId)) {
          throw new PrincipalStoreIdentityError("Canonical entity owner contract changed");
        }
        if (current && operation.record.versionOrder < current.versionOrder) {
          throw new PrincipalStoreFenceError("Entity version moved backwards");
        }
        if (current && operation.record.versionOrder === current.versionOrder &&
          operation.record.version !== current.version) {
          throw new PrincipalStoreFenceError("Entity version order is not unique");
        }
        if (current && operation.record.versionOrder === current.versionOrder &&
          !valuesEqual(operation.record.value, current.value)) {
          throw new PrincipalStoreFenceError("Canonical entity changed without a new version");
        }
        const tombstone = await this.db.entityTombstones.get(operation.record.key);
        if (tombstone && tombstone.deletionOwnerContractId !==
          operation.record.canonicalOwnerContractId) {
          throw new PrincipalStoreIdentityError("Canonical entity and tombstone owners disagree");
        }
        if (tombstone && operation.record.versionOrder <= tombstone.tombstoneVersionOrder) {
          throw new PrincipalStoreFenceError("Older entity cannot resurrect a tombstone");
        }
        if (tombstone) await this.db.entityTombstones.delete(operation.record.key);
        await this.db.entities.put(current
          ? {
              ...operation.record,
              // A source may establish another independent access path, but it
              // may not silently erase one established by another source.
              // Explicit release/revocation transitions remove grants.
              grantKeys: [...new Set([...current.grantKeys, ...operation.record.grantKeys])],
            }
          : operation.record);
        return;
      }
      case "garbage-collect-entity": {
        const entity = await this.db.entities.get(operation.key);
        if (!entity) return;
        const membership = await this.db.viewMembers.where("entityKey").equals(operation.key).first();
        const command = await this.db.commands.filter((row) =>
          row.optimisticActive && row.targetEntityKeys.includes(operation.key)).first();
        if (membership || command || entity.grantKeys.length > 0) {
          throw new PrincipalStoreFenceError("Entity is still retained and cannot be garbage collected");
        }
        await this.db.entities.delete(operation.key);
        return;
      }
      case "put-entity-tombstone": {
        if (operation.record.key !== `${operation.record.entityType}:${operation.record.entityId}`) {
          throw new PrincipalStoreIdentityError("Entity tombstone key does not match its identity");
        }
        const currentEntity = await this.db.entities.get(operation.record.key);
        if (operation.expectedEntityVersion !== undefined &&
          (currentEntity?.version ?? null) !== operation.expectedEntityVersion) {
          throw new PrincipalStoreFenceError("Entity removal version precondition failed");
        }
        const currentTombstone = await this.db.entityTombstones.get(operation.record.key);
        if ((currentEntity && (currentEntity.entityType !== operation.record.entityType ||
          currentEntity.entityId !== operation.record.entityId ||
          currentEntity.canonicalOwnerContractId !== operation.record.deletionOwnerContractId)) ||
          (currentTombstone && (currentTombstone.entityType !== operation.record.entityType ||
            currentTombstone.entityId !== operation.record.entityId ||
            currentTombstone.deletionOwnerContractId !== operation.record.deletionOwnerContractId))) {
          throw new PrincipalStoreIdentityError("Entity deletion owner or identity changed");
        }
        if (currentTombstone &&
          operation.record.tombstoneVersionOrder < currentTombstone.tombstoneVersionOrder) {
          throw new PrincipalStoreFenceError("Tombstone version moved backwards");
        }
        if (currentTombstone &&
          operation.record.tombstoneVersionOrder === currentTombstone.tombstoneVersionOrder &&
          operation.record.tombstoneVersion !== currentTombstone.tombstoneVersion) {
          throw new PrincipalStoreFenceError("Tombstone version order is not unique");
        }
        if (currentEntity && currentEntity.versionOrder > operation.record.tombstoneVersionOrder) {
          throw new PrincipalStoreFenceError("Older tombstone cannot erase a newer entity");
        }
        const removedGrantKeys = [...(currentEntity?.grantKeys ?? [])];
        await this.db.entities.delete(operation.record.key);
        const memberships = await this.db.viewMembers.where("entityKey").equals(operation.record.key).toArray();
        if (memberships.length > 0) {
          removedGrantKeys.push(...memberships.flatMap((row) => [...row.grantKeys]));
          await this.db.viewMembers.bulkDelete(memberships.map((row) => row.key));
        }
        await this.db.viewProjections.where("entityKey").equals(operation.record.key).delete();
        await this.db.entityTombstones.put(operation.record);
        await this.pruneUnreferencedGrants(removedGrantKeys);
        return;
      }
      case "garbage-collect-entity-tombstone": await this.db.entityTombstones.delete(operation.key); return;
      case "replace-complete-view": {
        const writer = await this.assertViewFence(operation.view);
        this.assertViewRevisionMatchesCoverage(operation.view);
        this.assertViewRows(operation.view, "complete", operation.members, operation.projections);
        await this.assertViewGrants(operation.view.contractId, operation.view.key, [
          ...operation.view.grantKeys,
          ...operation.members.flatMap((member) => [...member.grantKeys]),
        ]);
        const oldView = await this.db.views.get(operation.view.key);
        const [oldMembers, oldProjections, oldSegments] = await Promise.all([
          this.db.viewMembers.where("viewKey").equals(operation.view.key).toArray(),
          this.db.viewProjections.where("viewKey").equals(operation.view.key).toArray(),
          this.db.viewSegments.where("viewKey").equals(operation.view.key).toArray(),
        ]);
        const coverageOrder = this.assertMonotonicViewCoverage(
          oldView,
          operation.view,
          writer,
          "granted",
        );
        if (coverageOrder === "equal" && oldView &&
          (oldSegments.length > 0 || !this.completeViewContentEqual(
            oldView,
            oldMembers,
            oldProjections,
            operation.view,
            operation.members,
            operation.projections,
          ))) {
          throw new PrincipalStoreFenceError(
            "Equal server view revision carried divergent complete content",
          );
        }
        const oldGrantKeys = [
          ...(oldView?.grantKeys ?? []),
          ...oldMembers.flatMap((member) => [...member.grantKeys]),
          ...oldSegments.flatMap((segment) => [...segment.grantKeys]),
        ];
        await this.deleteView(operation.view.key);
        await this.db.views.put(operation.view);
        if (operation.members.length) await this.db.viewMembers.bulkPut([...operation.members]);
        if (operation.projections.length) await this.db.viewProjections.bulkPut([...operation.projections]);
        await this.pruneUnreferencedGrants(oldGrantKeys);
        await this.recordGrantedViewHead(operation.view);
        await this.reconcileCommandsForView(operation.view);
        return;
      }
      case "replace-view-segment": {
        const oldView = await this.db.views.get(operation.view.key);
        const writer = await this.assertViewFence(operation.view);
        this.assertViewRevisionMatchesCoverage(operation.view);
        if (operation.segment.key !== `${operation.view.key}\0${operation.segment.segmentKey}` ||
          operation.segment.viewKey !== operation.view.key ||
          operation.segment.writerEpoch !== operation.view.writerEpoch ||
          operation.segment.sourceEpoch !== operation.view.sourceEpoch ||
          operation.segment.sourceSequence !== operation.view.sourceSequence ||
          !valuesEqual(operation.segment.coverage, operation.view.coverage)) {
          throw new PrincipalStoreIdentityError("View segment fence does not match its view");
        }
        this.assertViewRows(
          operation.view,
          operation.segment.segmentKey,
          operation.members,
          operation.projections,
        );
        await this.assertViewGrants(operation.view.contractId, operation.view.key, [
          ...operation.view.grantKeys,
          ...operation.segment.grantKeys,
          ...operation.members.flatMap((member) => [...member.grantKeys]),
        ]);
        const [oldSegment, oldMembers, oldProjections, otherSegments] = await Promise.all([
          this.db.viewSegments.get(operation.segment.key),
          this.db.viewMembers.where("[viewKey+segmentKey]").equals([
            operation.view.key,
            operation.segment.segmentKey,
          ]).toArray(),
          this.db.viewProjections.where("[viewKey+segmentKey]").equals([
            operation.view.key,
            operation.segment.segmentKey,
          ]).toArray(),
          this.db.viewSegments.where("viewKey").equals(operation.view.key)
            .filter((segment) => segment.key !== operation.segment.key)
            .toArray(),
        ]);
        const coverageOrder = this.assertMonotonicViewCoverage(
          oldView,
          operation.view,
          writer,
          "granted",
        );
        if (coverageOrder === "equal" && oldSegment && !this.segmentContentEqual(
          oldSegment,
          oldMembers,
          oldProjections,
          operation.segment,
          operation.members,
          operation.projections,
        )) {
          throw new PrincipalStoreFenceError(
            "Equal server view revision carried divergent segment content",
          );
        }
        await Promise.all([
          this.db.viewMembers.where("[viewKey+segmentKey]").equals([
            operation.view.key,
            operation.segment.segmentKey,
          ]).delete(),
          this.db.viewProjections.where("[viewKey+segmentKey]").equals([
            operation.view.key,
            operation.segment.segmentKey,
          ]).delete(),
        ]);
        const combinedViewGrants = [...new Set([
          ...operation.view.grantKeys,
          ...otherSegments.flatMap((segment) => [...segment.grantKeys]),
        ])];
        await this.db.views.put({ ...operation.view, grantKeys: combinedViewGrants });
        await this.db.viewSegments.put(operation.segment);
        if (operation.members.length) await this.db.viewMembers.bulkPut([...operation.members]);
        if (operation.projections.length) await this.db.viewProjections.bulkPut([...operation.projections]);
        await this.pruneUnreferencedGrants([
          ...(oldSegment?.grantKeys ?? []),
          ...oldMembers.flatMap((member) => [...member.grantKeys]),
          ...(oldView?.grantKeys ?? []),
        ]);
        await this.recordGrantedViewHead(operation.view);
        await this.reconcileCommandsForView(operation.view);
        return;
      }
      case "clear-authoritative-view": await this.clearAuthoritativeView(operation.record); return;
      case "put-delta-cursor": {
        const current = await this.db.deltaCursors.get(operation.record.key);
        if ((current?.cursor ?? null) !== operation.expectedCursor) {
          throw new PrincipalStoreFenceError("Ordered-delta cursor gap");
        }
        if (current && current.contractId !== operation.record.contractId) {
          throw new PrincipalStoreIdentityError("Delta stream owner contract changed");
        }
        if (operation.record.cursor === operation.expectedCursor) {
          throw new PrincipalStoreFenceError("Ordered-delta cursor did not advance");
        }
        if (current && current.sourceEpoch === operation.record.sourceEpoch &&
          operation.record.sourceSequence <= current.sourceSequence) {
          throw new PrincipalStoreFenceError("Stale ordered-delta source sequence");
        }
        await this.db.deltaCursors.put(operation.record);
        return;
      }
      case "put-grant": {
        const current = await this.db.grants.get(operation.record.key);
        if (current && (current.contractId !== operation.record.contractId ||
          current.scopeKey !== operation.record.scopeKey)) {
          throw new PrincipalStoreIdentityError("Opaque grant was rebound to another scope");
        }
        await this.db.grants.put(operation.record);
        return;
      }
      case "revoke-grant": await this.revokeGrant(operation.grantKey); return;
      case "release-grant": await this.releaseGrant(operation.grantKey); return;
      case "put-command": {
        if (operation.record.principalId !== principalId) throw new PrincipalStoreIdentityError();
        const current = await this.db.commands.get(operation.record.id);
        if (!current) throw new PrincipalStoreFenceError("Command must be durably queued before update");
        if (current.principalId !== operation.record.principalId ||
          current.contractId !== operation.record.contractId ||
          current.commandType !== operation.record.commandType ||
          current.conflictKey !== operation.record.conflictKey ||
          current.createdAt !== operation.record.createdAt ||
          current.localSequence !== operation.record.localSequence ||
          current.operationSchemaVersion !== operation.record.operationSchemaVersion ||
          current.replayPolicy !== operation.record.replayPolicy ||
          !valuesEqual(current.requiredCoverage, operation.record.requiredCoverage)) {
          throw new PrincipalStoreIdentityError("Immutable command identity changed");
        }
        if (current.status !== operation.record.status &&
          !isAllowedCommandTransition(current.status, operation.record.status)) {
          throw new PrincipalStoreFenceError(
            `Invalid command transition: ${current.status} -> ${operation.record.status}`,
          );
        }
        await this.db.commands.put(operation.record);
        return;
      }
      case "queue-command": {
        if (operation.record.principalId !== principalId) throw new PrincipalStoreIdentityError();
        if (operation.record.status !== "queued" || !operation.record.optimisticActive) {
          throw new PrincipalStoreFenceError("A new command must enter as an active queued command");
        }
        if (!operation.record.id.trim() || !operation.record.commandType.trim() ||
          !operation.record.contractId.trim() || !operation.record.conflictKey.trim()) {
          throw new PrincipalStoreIdentityError("Command identity fields must be non-empty");
        }
        if (new Set(operation.record.targetGrantKeys).size !== operation.record.targetGrantKeys.length) {
          throw new PrincipalStoreIdentityError("Command target grants must be unique");
        }
        if (await this.db.commands.get(operation.record.id)) {
          throw new PrincipalStoreFenceError("Command ID already exists locally");
        }
        await this.assertCommandAuthorization({ ...operation.record, localSequence: nextHead });
        await this.db.commands.put({ ...operation.record, localSequence: nextHead });
        return;
      }
      case "delete-command": await this.db.commands.delete(operation.id); return;
      case "settle-command-receipt": {
        await this.settleCommandReceipt(operation.record, principalId);
        return;
      }
      case "put-sync-meta": await this.db.syncMetadata.put(operation.record); return;
      case "delete-sync-meta": await this.db.syncMetadata.delete(operation.key); return;
      case "put-conversation-messages": await this.db.conversationMessages.put(operation.record); return;
      case "delete-conversation-messages": await this.db.conversationMessages.delete(operation.conversationId); return;
      case "put-legacy-collection": await this.db.legacyCollections.put(operation.record); return;
      case "delete-legacy-collection": await this.db.legacyCollections.delete(operation.key); return;
      case "put-legacy-meta": await this.db.legacyMeta.put(operation.record); return;
      case "delete-legacy-meta": await this.db.legacyMeta.delete(operation.key); return;
      case "put-legacy-outbox": {
        if (operation.record.principalId !== principalId) throw new PrincipalStoreIdentityError();
        await this.db.legacyOutbox.put(operation.record);
        return;
      }
      case "delete-legacy-outbox": await this.db.legacyOutbox.delete(operation.id); return;
    }
  }

  async commit(
    fence: PrincipalStoreFence,
    operations: readonly StoreOperation[],
    guard?: () => void,
  ): Promise<CommitResult> {
    if (operations.length === 0) return { head: await this.readHead(fence), affectedKeys: [] };
    // `localSequence` is the durable ordering key for optimistic intent and is
    // derived from the commit head. Allowing two queue operations in one commit
    // would silently assign the same order to distinct user intents, leaving
    // conflict resolution to an incidental ID sort. Make the one-intent/one-
    // sequence boundary structural instead.
    if (operations.filter((operation) => operation.kind === "queue-command").length > 1) {
      throw new PrincipalStoreFenceError("A commit may queue only one durable command");
    }
    await this.ensureOpen();
    return await this.db.transaction("rw", this.db.tables, async () => {
      const metadata = await this.db.meta.get("store");
      this.assertFence(metadata, fence);
      for (const operation of operations) {
        await this.applyOperation(operation, metadata!.principalId, metadata!.head + 1);
      }
      // Covers both receipt-before-view and view-before-receipt schedules,
      // including canonical write sets whose proof is not owned by a view row.
      await this.reconcileAcknowledgedCommands();
      guard?.();
      await this.injectFault?.("after-operations");
      const next: PrincipalStoreMetadata = {
        ...metadata!,
        head: asCommitSequence(metadata!.head + 1),
        updatedAt: Date.now(),
      };
      await this.db.meta.put(next);
      await this.injectFault?.("after-head-write");
      return {
        head: next.head,
        affectedKeys: [...new Set(operations.map(affectedKey))],
      };
    });
  }

  async fence(currentGeneration: number, nextGeneration: number): Promise<void> {
    await this.ensureOpen();
    await this.db.transaction("rw", this.db.meta, async () => {
      const metadata = await this.db.meta.get("store");
      if (!metadata) return;
      if (metadata.principalKey !== this.principalKey) throw new PrincipalStoreIdentityError();
      if (metadata.fenced && (metadata.fencedAtGeneration ?? 0) >= nextGeneration) return;
      if (metadata.activeGeneration !== currentGeneration) throw new PrincipalStoreFenceError();
      await this.db.meta.put({
        ...metadata,
        fenced: true,
        fencedAtGeneration: nextGeneration,
        head: asCommitSequence(metadata.head + 1),
        updatedAt: Date.now(),
      });
    });
  }

  async readLegacyCache(fence: PrincipalStoreFence): Promise<LegacyCacheSnapshot> {
    await this.ensureOpen();
    return await this.db.transaction(
      "r",
      [this.db.meta, this.db.legacyCollections, this.db.legacyMeta],
      async () => {
        const metadata = await this.db.meta.get("store");
        this.assertFence(metadata, fence);
        const [rows, metaRows] = await Promise.all([
          this.db.legacyCollections.toArray(),
          this.db.legacyMeta.toArray(),
        ]);
        const collections: LegacyCacheSnapshot["collections"] = {};
        for (const row of rows) {
          (collections[row.collection] ??= {})[row.rowId] = row.value;
        }
        const meta: Record<string, unknown> = {};
        for (const row of metaRows) meta[row.key] = row.value;
        return { collections, meta };
      },
    );
  }

  async readConversationMessages(
    fence: PrincipalStoreFence,
    conversationId: string,
  ): Promise<ConversationMessagesRecord | null> {
    await this.ensureOpen();
    return await this.db.transaction(
      "r",
      [this.db.meta, this.db.conversationMessages],
      async () => {
        const metadata = await this.db.meta.get("store");
        this.assertFence(metadata, fence);
        return (await this.db.conversationMessages.get(conversationId)) ?? null;
      },
    );
  }

  async readLegacyOutbox(fence: PrincipalStoreFence): Promise<LegacyOutboxRecord[]> {
    await this.ensureOpen();
    return await this.db.transaction(
      "r",
      [this.db.meta, this.db.legacyOutbox],
      async () => {
        const metadata = await this.db.meta.get("store");
        this.assertFence(metadata, fence);
        return await this.db.legacyOutbox.orderBy("ts").toArray();
      },
    );
  }

  close(): void {
    this.db.close();
  }

  async purge(): Promise<void> {
    await this.db.delete();
  }
}

export class DexiePrincipalStoreFactory implements PrincipalStoreFactory {
  constructor(
    private readonly deploymentKey: string,
    private readonly injectFault?: DexieFaultInjector,
  ) {}

  private name(principalKey: OpaquePrincipalKey): string {
    return principalDatabaseName(this.deploymentKey, principalKey);
  }

  async exists(principalKey: OpaquePrincipalKey): Promise<boolean> {
    return await Dexie.exists(this.name(principalKey));
  }

  async open(principalKey: OpaquePrincipalKey): Promise<PrincipalStoreAdapter> {
    const adapter = new DexiePrincipalStoreAdapter(
      this.name(principalKey),
      principalKey,
      this.injectFault,
    );
    await adapter.ensureOpen();
    return adapter;
  }
}
