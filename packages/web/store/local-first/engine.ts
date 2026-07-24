import {
  asSourceEpoch,
  asSourceSequence,
  asWriterEpoch,
  type BoundedPageInput,
  type BoundedWindowInput,
  type CompleteViewInput,
  type ExplicitEntityRemoval,
  type ExplicitRemovalInput,
  type GrantKey,
  type LocalCommitSequence,
  type OrderedDeltaInput,
  type PrincipalEpoch,
  type PrincipalId,
  type ScopeRevocationInput,
  type SourceEpoch,
  type SourceSequence,
  type WriterEpoch,
} from "./types";
import type {
  CommitResult,
  PrincipalStoreAdapter,
  PrincipalStoreFence,
  StoreOperation,
} from "./persistence/adapter";
import { PrincipalStoreFenceError } from "./persistence/adapter";

export type SourceToken = {
  viewKey: string;
  contractId: string;
  principalEpoch: PrincipalEpoch;
  writerEpoch: WriterEpoch;
  sourceEpoch: SourceEpoch;
  sourceSequence: SourceSequence;
};

export type SourceHandle = Omit<SourceToken, "sourceSequence">;

export class StaleLocalFirstSourceError extends Error {
  constructor(readonly reason: "principal" | "source") {
    super(`Rejected stale local-first ${reason} epoch`);
    this.name = "StaleLocalFirstSourceError";
  }
}

type CommitBroadcast = {
  principalKey: string;
  head: number;
  affectedKeys: readonly string[];
};

export type ExternalCommit = {
  head: LocalCommitSequence;
  affectedKeys: readonly string[];
  fullReload: boolean;
};

export type LocalFirstEngineOptions = {
  adapter: PrincipalStoreAdapter;
  fence: PrincipalStoreFence;
  principalEpoch: PrincipalEpoch;
  initialHead: LocalCommitSequence;
  principalId: PrincipalId;
  onExternalCommit?: (commit: ExternalCommit) => void | Promise<void>;
  onStorageFailure?: (error: unknown) => void;
  /** A durable commit succeeded — proof the storage path works again. */
  onStorageRecovered?: () => void;
  channelFactory?: (name: string) => BroadcastChannel | null;
  sourceEpochFactory?: () => SourceEpoch;
};

/**
 * The only memory publication boundary for v2 materialized state. A caller
 * supplies the already-computed semantic operations and a publication closure;
 * the closure is invoked only after the durable transaction has committed and
 * its captured principal/source epochs are still current.
 */
export class LocalFirstEngine {
  private principalEpoch: PrincipalEpoch;
  private readonly sources = new Map<string, {
    sourceEpoch: SourceEpoch;
    contractId: string;
    writerEpoch: WriterEpoch;
    nextSequence: number;
    lastCommittedSequence: number;
  }>();
  private observedHead: LocalCommitSequence;
  private readonly channel: BroadcastChannel | null;
  private closed = false;

  constructor(private readonly options: LocalFirstEngineOptions) {
    this.principalEpoch = options.principalEpoch;
    this.observedHead = options.initialHead;
    const makeChannel = options.channelFactory ?? ((name: string) =>
      typeof BroadcastChannel === "function" ? new BroadcastChannel(name) : null);
    this.channel = makeChannel(`${options.adapter.databaseName}:commits`);
    if (this.channel) {
      this.channel.onmessage = (event: MessageEvent<CommitBroadcast>) => {
        void this.receiveBroadcast(event.data);
      };
    }
  }

  get head(): LocalCommitSequence {
    return this.observedHead;
  }

  get principalId(): PrincipalId {
    return this.options.principalId;
  }

  async beginSource(
    viewKey: string,
    contractId: string,
  ): Promise<SourceHandle> {
    const capturedPrincipalEpoch = this.principalEpoch;
    if (this.closed) throw new StaleLocalFirstSourceError("principal");
    let claim;
    try {
      claim = await this.options.adapter.claimViewWriter(
        this.options.fence,
        viewKey,
        contractId,
      );
    } catch (error) {
      if (!(error instanceof PrincipalStoreFenceError)) this.options.onStorageFailure?.(error);
      throw error;
    }
    this.observedHead = claim.head;
    this.channel?.postMessage({
      principalKey: this.options.fence.principalKey,
      head: claim.head,
      affectedKeys: claim.affectedKeys,
    } satisfies CommitBroadcast);
    if (this.closed || capturedPrincipalEpoch !== this.principalEpoch) {
      throw new StaleLocalFirstSourceError("principal");
    }
    const makeSourceEpoch = this.options.sourceEpochFactory ?? (() => {
      if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
        throw new Error("A cryptographically unique source epoch is unavailable");
      }
      return asSourceEpoch(crypto.randomUUID());
    });
    const sourceEpoch = makeSourceEpoch();
    if (!sourceEpoch) throw new Error("Source epoch factory returned an empty epoch");
    this.sources.set(viewKey, {
      sourceEpoch,
      contractId,
      writerEpoch: claim.writerEpoch,
      nextSequence: 0,
      lastCommittedSequence: 0,
    });
    return {
      viewKey,
      contractId,
      principalEpoch: this.principalEpoch,
      writerEpoch: claim.writerEpoch,
      sourceEpoch,
    };
  }

  nextSourceResult(handle: SourceHandle): SourceToken {
    const active = this.sources.get(handle.viewKey);
    if (!active || active.sourceEpoch !== handle.sourceEpoch ||
      active.writerEpoch !== handle.writerEpoch || active.contractId !== handle.contractId) {
      throw new StaleLocalFirstSourceError("source");
    }
    return { ...handle, sourceSequence: asSourceSequence(++active.nextSequence) };
  }

  invalidateSource(viewKey: string): void {
    this.sources.delete(viewKey);
  }

  invalidatePrincipal(nextEpoch: PrincipalEpoch): void {
    this.principalEpoch = nextEpoch;
    this.sources.clear();
  }

  private assertCurrent(token: SourceToken): void {
    if (this.closed || token.principalEpoch !== this.principalEpoch) {
      throw new StaleLocalFirstSourceError("principal");
    }
    const active = this.sources.get(token.viewKey);
    if (!active || active.sourceEpoch !== token.sourceEpoch ||
      active.writerEpoch !== token.writerEpoch || active.contractId !== token.contractId) {
      throw new StaleLocalFirstSourceError("source");
    }
    if (token.sourceSequence <= active.lastCommittedSequence) {
      throw new StaleLocalFirstSourceError("source");
    }
  }

  async commit(
    token: SourceToken,
    operations: readonly StoreOperation[],
    publish: (result: CommitResult) => void,
  ): Promise<CommitResult> {
    this.assertCurrent(token);
    let result: CommitResult;
    try {
      result = await this.options.adapter.commit(
        this.options.fence,
        operations,
        () => this.assertCurrent(token),
      );
    } catch (error) {
      if (!(error instanceof PrincipalStoreFenceError) &&
        !(error instanceof StaleLocalFirstSourceError)) {
        this.options.onStorageFailure?.(error);
      }
      throw error;
    }
    // The durable transaction landed even if the token went stale below.
    this.options.onStorageRecovered?.();
    this.assertCurrent(token);
    this.observedHead = result.head;
    this.sources.get(token.viewKey)!.lastCommittedSequence = token.sourceSequence;
    // Disk is authoritative. Publication happens only after the transaction.
    publish(result);
    this.channel?.postMessage({
      principalKey: this.options.fence.principalKey,
      head: result.head,
      affectedKeys: result.affectedKeys,
    } satisfies CommitBroadcast);
    return result;
  }

  private tokenForAuthoritativeInput(
    key: string,
    input: {
      principalId: PrincipalId;
      principalEpoch: PrincipalEpoch;
      contractId: string;
      sourceEpoch: SourceEpoch;
      sourceSequence: SourceSequence;
      writerEpoch?: WriterEpoch;
    },
  ): SourceToken {
    if (input.principalId !== this.options.principalId ||
      input.principalEpoch !== this.principalEpoch) {
      throw new StaleLocalFirstSourceError("principal");
    }
    const active = this.sources.get(key);
    return {
      viewKey: key,
      contractId: input.contractId,
      principalEpoch: input.principalEpoch,
      writerEpoch: input.writerEpoch ?? active?.writerEpoch ?? asWriterEpoch(0),
      sourceEpoch: input.sourceEpoch,
      sourceSequence: input.sourceSequence,
    };
  }

  private grantOperations(
    contractId: string,
    scopeKey: string,
    grantKeys: readonly GrantKey[],
  ): StoreOperation[] {
    return grantKeys.map((grantKey) => ({
      kind: "put-grant" as const,
      record: { key: grantKey, contractId, scopeKey, grantedAt: Date.now() },
    }));
  }

  private allGrantKeys(
    viewGrantKeys: readonly GrantKey[],
    rows: readonly { grantKeys: readonly GrantKey[] }[],
  ): GrantKey[] {
    return [...new Set([...viewGrantKeys, ...rows.flatMap((row) => [...row.grantKeys])])];
  }

  private entityOperations(rows: readonly {
    entityType: string;
    entityId: string;
    entityVersion: string;
    entityVersionOrder: number;
    canonicalOwnerContractId: string;
    grantKeys: readonly GrantKey[];
    value: unknown;
  }[], grantOwnership: "direct" | "view-member" = "direct"): StoreOperation[] {
    return rows.map((row) => ({
      kind: "put-entity" as const,
      record: {
        key: `${row.entityType}:${row.entityId}`,
        entityType: row.entityType,
        entityId: row.entityId,
        version: row.entityVersion,
        versionOrder: row.entityVersionOrder,
        canonicalOwnerContractId: row.canonicalOwnerContractId,
        grantKeys: grantOwnership === "direct" ? row.grantKeys : [],
        value: row.value,
      },
    }));
  }

  private removalOperations(removals: readonly ExplicitEntityRemoval[]): StoreOperation[] {
    return removals.map((removal) => ({
      kind: "put-entity-tombstone" as const,
      record: {
        key: `${removal.entityType}:${removal.entityId}`,
        entityType: removal.entityType,
        entityId: removal.entityId,
        tombstoneVersion: removal.tombstoneVersion,
        tombstoneVersionOrder: removal.tombstoneVersionOrder,
        deletionOwnerContractId: removal.deletionOwnerContractId,
      },
    }));
  }

  private revisionFromCoverage(coverage: CompleteViewInput["coverage"]): string {
    switch (coverage.kind) {
      case "view-revision": return coverage.revision;
      case "coverage-token": return coverage.token;
      case "command-ids": return coverage.commandIds.join(",");
      case "none": return "none";
    }
  }

  async replaceView(
    input: CompleteViewInput,
    publish: (result: CommitResult) => void = () => {},
  ): Promise<CommitResult> {
    const token = this.tokenForAuthoritativeInput(input.viewKey, input);
    if (input.access === "forbidden") {
      const result = await this.commit(token, [
        {
          kind: "clear-authoritative-view",
          record: {
            key: input.viewKey,
            contractId: input.contractId,
            writerEpoch: input.writerEpoch,
            sourceEpoch: input.sourceEpoch,
            sourceSequence: input.sourceSequence,
            coverage: input.coverage,
            access: "forbidden",
            revokedGrantKeys: input.revokedGrantKeys,
          },
        },
      ], publish);
      this.invalidateSource(input.viewKey);
      return result;
    }
    if (input.access === "missing") {
      const result = await this.commit(token, [
        {
          kind: "clear-authoritative-view",
          record: {
            key: input.viewKey,
            contractId: input.contractId,
            writerEpoch: input.writerEpoch,
            sourceEpoch: input.sourceEpoch,
            sourceSequence: input.sourceSequence,
            coverage: input.coverage,
            access: "missing",
            releasedGrantKeys: input.releasedGrantKeys,
          },
        },
        ...this.removalOperations(input.removals),
      ], publish);
      this.invalidateSource(input.viewKey);
      return result;
    }

    const members = input.storage === "canonical"
      ? input.rows.map((row) => {
          const entityKey = `${row.entityType}:${row.entityId}`;
          return {
            key: `${input.viewKey}\0complete\0${entityKey}`,
            viewKey: input.viewKey,
            entityKey,
            segmentKey: "complete",
            grantKeys: row.grantKeys,
          };
        })
      : input.rows.map((row) => ({
          key: `${input.viewKey}\0complete\0${row.entityKey}`,
          viewKey: input.viewKey,
          entityKey: row.entityKey,
          segmentKey: "complete",
          grantKeys: row.grantKeys,
        }));
    const projections = input.storage === "projection"
      ? input.rows.map((row) => ({
          key: `${input.viewKey}\0complete\0${row.entityKey}`,
          viewKey: input.viewKey,
          entityKey: row.entityKey,
          segmentKey: "complete",
          value: row.projection,
        }))
      : input.rows.flatMap((row) => {
          const entityKey = `${row.entityType}:${row.entityId}`;
          const value = input.projections?.[entityKey] ?? input.projections?.[row.entityId];
          return value === undefined ? [] : [{
            key: `${input.viewKey}\0complete\0${entityKey}`,
            viewKey: input.viewKey,
            entityKey,
            segmentKey: "complete",
            value,
          }];
        });
    return await this.commit(token, [
      ...this.grantOperations(
        input.contractId,
        input.viewKey,
        this.allGrantKeys(input.grantKeys, input.rows),
      ),
      ...(input.storage === "canonical"
        ? this.entityOperations(input.rows, "view-member")
        : []),
      {
        kind: "replace-complete-view",
        view: {
          key: input.viewKey,
          contractId: input.contractId,
          grantKeys: input.grantKeys,
          revision: this.revisionFromCoverage(input.coverage),
          writerEpoch: input.writerEpoch,
          sourceEpoch: input.sourceEpoch,
          sourceSequence: input.sourceSequence,
          coverage: input.coverage,
        },
        members,
        projections,
      },
    ], publish);
  }

  private async replaceSegment(
    input: BoundedWindowInput | BoundedPageInput,
    segmentKey: string,
    segmentKind: "window" | "page",
    publish: (result: CommitResult) => void,
  ): Promise<CommitResult> {
    const token = this.tokenForAuthoritativeInput(input.viewKey, input);
    const storedSegmentKey = `${segmentKind}:${segmentKey}`;
    const members = input.storage === "canonical"
      ? input.rows.map((row) => {
          const entityKey = `${row.entityType}:${row.entityId}`;
          return {
            key: `${input.viewKey}\0${storedSegmentKey}\0${entityKey}`,
            viewKey: input.viewKey,
            entityKey,
            segmentKey: storedSegmentKey,
            grantKeys: row.grantKeys,
          };
        })
      : input.rows.map((row) => ({
          key: `${input.viewKey}\0${storedSegmentKey}\0${row.entityKey}`,
          viewKey: input.viewKey,
          entityKey: row.entityKey,
          segmentKey: storedSegmentKey,
          grantKeys: row.grantKeys,
        }));
    const projections = input.storage === "projection"
      ? input.rows.map((row) => ({
          key: `${input.viewKey}\0${storedSegmentKey}\0${row.entityKey}`,
          viewKey: input.viewKey,
          entityKey: row.entityKey,
          segmentKey: storedSegmentKey,
          value: row.projection,
        }))
      : input.rows.flatMap((row) => {
          const entityKey = `${row.entityType}:${row.entityId}`;
          const value = input.projections?.[entityKey] ?? input.projections?.[row.entityId];
          return value === undefined ? [] : [{
            key: `${input.viewKey}\0${storedSegmentKey}\0${entityKey}`,
            viewKey: input.viewKey,
            entityKey,
            segmentKey: storedSegmentKey,
            value,
          }];
        });
    const view = {
      key: input.viewKey,
      contractId: input.contractId,
      grantKeys: input.grantKeys,
      revision: this.revisionFromCoverage(input.coverage),
      writerEpoch: input.writerEpoch,
      sourceEpoch: input.sourceEpoch,
      sourceSequence: input.sourceSequence,
      coverage: input.coverage,
    };
    return await this.commit(token, [
      ...this.grantOperations(
        input.contractId,
        input.viewKey,
        this.allGrantKeys(input.grantKeys, input.rows),
      ),
      ...(input.storage === "canonical"
        ? this.entityOperations(input.rows, "view-member")
        : []),
      {
        kind: "replace-view-segment",
        view,
        segment: {
          key: `${input.viewKey}\0${storedSegmentKey}`,
          viewKey: input.viewKey,
          segmentKey: storedSegmentKey,
          segmentKind,
          grantKeys: input.grantKeys,
          writerEpoch: input.writerEpoch,
          sourceEpoch: input.sourceEpoch,
          sourceSequence: input.sourceSequence,
          coverage: input.coverage,
        },
        members,
        projections,
      },
    ], publish);
  }

  async replaceWindow(
    input: BoundedWindowInput,
    publish: (result: CommitResult) => void = () => {},
  ): Promise<CommitResult> {
    return await this.replaceSegment(input, input.windowKey, "window", publish);
  }

  async replacePage(
    input: BoundedPageInput,
    publish: (result: CommitResult) => void = () => {},
  ): Promise<CommitResult> {
    return await this.replaceSegment(input, input.pageKey, "page", publish);
  }

  async applyDelta(
    input: OrderedDeltaInput,
    publish: (result: CommitResult) => void = () => {},
  ): Promise<CommitResult> {
    const token = this.tokenForAuthoritativeInput(input.streamKey, input);
    const operations: StoreOperation[] = [];
    for (const change of input.changes) {
      if (change.type === "upsert") {
        operations.push(
          ...this.grantOperations(
            input.contractId,
            input.streamKey,
            change.entity.grantKeys,
          ),
          ...this.entityOperations([change.entity]),
        );
      }
      else if (change.type === "delete") operations.push(...this.removalOperations([change.removal]));
      else operations.push({ kind: "revoke-grant", grantKey: change.grantKey });
    }
    operations.push({
      kind: "put-delta-cursor",
      expectedCursor: input.previousCursor,
      record: {
        key: input.streamKey,
        contractId: input.contractId,
        cursor: input.nextCursor,
        sourceEpoch: input.sourceEpoch,
        sourceSequence: input.sourceSequence,
        coverage: input.coverage,
      },
    });
    return await this.commit(token, operations, publish);
  }

  async removeEntities(
    input: ExplicitRemovalInput,
    publish: (result: CommitResult) => void = () => {},
  ): Promise<CommitResult> {
    const key = `removals:${input.contractId}`;
    return await this.commit(
      this.tokenForAuthoritativeInput(key, input),
      this.removalOperations(input.removals),
      publish,
    );
  }

  async revokeScope(
    input: ScopeRevocationInput,
    publish: (result: CommitResult) => void = () => {},
  ): Promise<CommitResult> {
    const result = await this.commit(
      this.tokenForAuthoritativeInput(input.viewKey, input),
      [{
        kind: "clear-authoritative-view",
        record: {
          key: input.viewKey,
          contractId: input.contractId,
          writerEpoch: input.writerEpoch,
          sourceEpoch: input.sourceEpoch,
          sourceSequence: input.sourceSequence,
          coverage: input.coverage,
          access: "forbidden",
          revokedGrantKeys: input.revokedGrantKeys,
        },
      }],
      publish,
    );
    this.invalidateSource(input.viewKey);
    return result;
  }

  async reconcileDurableHead(hint?: CommitBroadcast): Promise<void> {
    if (this.closed) return;
    const durableHead = await this.options.adapter.readHead(this.options.fence);
    if (durableHead <= this.observedHead) return;
    const previous = this.observedHead;
    this.observedHead = durableHead;
    const contiguous = durableHead === previous + 1 && hint?.head === durableHead;
    await this.options.onExternalCommit?.({
      head: durableHead,
      affectedKeys: contiguous ? hint!.affectedKeys : [],
      fullReload: !contiguous,
    });
  }

  private async receiveBroadcast(message: CommitBroadcast): Promise<void> {
    if (!message || message.principalKey !== this.options.fence.principalKey) return;
    if (message.head <= this.observedHead) return;
    try {
      await this.reconcileDurableHead(message);
    } catch (error) {
      // A launcher generation/fence change owns teardown. A broadcast is only a
      // liveness hint and must never reopen a fenced store.
      if (!(error instanceof PrincipalStoreFenceError)) {
        this.options.onStorageFailure?.(error);
      }
    }
  }

  close(): void {
    this.closed = true;
    this.channel?.close();
  }
}
