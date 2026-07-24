import { LocalFirstEngine } from "./engine";
import {
  asPrincipalEpoch,
  type CredentialBinding,
  type OpaquePrincipalKey,
  type PrincipalEpoch,
  type PrincipalId,
  type PrincipalLifecycle,
} from "./types";
import {
  PrincipalStoreFenceError,
  PrincipalStoreIdentityError,
  type PrincipalStoreAdapter,
  type PrincipalStoreFactory,
  type PrincipalStoreFence,
  type PrincipalStoreInspection,
  type PrincipalStoreMetadata,
} from "./persistence/adapter";
import type { LauncherStore } from "./persistence/launcher";

/** Health restorations allowed per activation before degradation is permanent. */
const MAX_STORAGE_RECOVERIES = 3;

export type PrincipalRuntimeHooks = {
  stopProtectedIO(principalEpoch?: PrincipalEpoch): void;
  clearProtectedMemory(): void;
  bindPersistence(input: {
    adapter: PrincipalStoreAdapter;
    fence: PrincipalStoreFence;
    principalId: PrincipalId;
    principalEpoch: PrincipalEpoch;
  }): void;
  unbindPersistence(principalEpoch?: PrincipalEpoch): void;
  hydrate(input: { principalEpoch: PrincipalEpoch; isCurrent: () => boolean }): Promise<boolean>;
  flushCompatibility?(): Promise<void>;
  discardCompatibility?(principalEpoch?: PrincipalEpoch): void;
  onServerVerified?(): void;
  onExternalCommit?(): void | Promise<void>;
};

export type VerifyPrincipalInput = {
  credentialBinding: CredentialBinding;
  principalId: PrincipalId;
};

export type PrincipalRuntimeInspection = {
  lifecycle: {
    phase: PrincipalLifecycle["phase"];
    generation: number;
    principalEpoch: number | null;
    storageHealth: "healthy" | "degraded" | "unavailable";
    head: number | null;
  };
  store: PrincipalStoreInspection | null;
  inspectionError: string | null;
  lastFailure: { reason: string; category: string; at: number } | null;
};

export class PrincipalRuntime {
  private state: PrincipalLifecycle = { phase: "locked", generation: 0 };
  private readonly listeners = new Set<() => void>();
  private operationEpoch = 0;
  private adapter: PrincipalStoreAdapter | null = null;
  private adapterGeneration: number | null = null;
  private adapterPrincipalEpoch: PrincipalEpoch | undefined;
  private engine: LocalFirstEngine | null = null;
  private unsubscribeLauncher: (() => void) | null = null;
  private launcherMutationDepth = 0;
  private lastFailure: PrincipalRuntimeInspection["lastFailure"] = null;
  private storageRecoveries = 0;

  constructor(
    private readonly launcher: LauncherStore,
    private readonly stores: PrincipalStoreFactory,
    private readonly hooks: PrincipalRuntimeHooks,
  ) {
    this.unsubscribeLauncher = launcher.subscribe(() => {
      if (this.launcherMutationDepth > 0) return;
      void this.reconcileLauncherGeneration();
    });
  }

  private async mutateLauncher<T>(operation: () => Promise<T>): Promise<T> {
    this.launcherMutationDepth++;
    try {
      return await operation();
    } finally {
      this.launcherMutationDepth--;
    }
  }

  getSnapshot = (): PrincipalLifecycle => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get materializer(): LocalFirstEngine | null {
    return this.engine;
  }

  get canDispatch(): boolean {
    return this.state.phase === "server-verified" && this.state.storageHealth === "healthy";
  }

  get dispatchPrincipalEpoch(): number | null {
    return this.state.phase === "server-verified" ? this.state.principalEpoch : null;
  }

  private rememberFailure(reason: string, error?: unknown): void {
    const category = error && typeof error === "object" &&
      typeof (error as { name?: unknown }).name === "string"
      ? String((error as { name: string }).name)
      : error === undefined ? "RuntimeFailure" : typeof error;
    this.lastFailure = { reason, category, at: Date.now() };
  }

  /**
   * Payload-free diagnostic seam. It intentionally omits the principal ID,
   * credential binding, raw database name, entity values, projections,
   * command arguments/results, and message content.
   */
  async inspect(now = Date.now()): Promise<PrincipalRuntimeInspection> {
    const state = this.state;
    const active = state.phase === "offline-ready" || state.phase === "server-verified";
    let store: PrincipalStoreInspection | null = null;
    let inspectionError: string | null = null;
    if (active && this.adapter && this.adapterGeneration !== null) {
      try {
        store = await this.adapter.inspect({
          principalKey: this.adapter.principalKey,
          generation: this.adapterGeneration,
        }, now);
      } catch (error) {
        inspectionError = error && typeof error === "object" &&
          typeof (error as { name?: unknown }).name === "string"
          ? String((error as { name: string }).name)
          : "InspectionFailure";
      }
    }
    return {
      lifecycle: {
        phase: state.phase,
        generation: state.generation,
        principalEpoch: active ? state.principalEpoch : null,
        storageHealth: active ? state.storageHealth : "unavailable",
        head: active ? state.head : null,
      },
      store,
      inspectionError,
      lastFailure: this.lastFailure ? { ...this.lastFailure } : null,
    };
  }

  reportStorageFailure(error: unknown): void {
    const current = this.state;
    if (current.phase !== "offline-ready" && current.phase !== "server-verified") return;
    this.rememberFailure("storage-failure", error);
    this.emit({
      ...current,
      storageHealth: "degraded",
      storageError: String((error as { message?: unknown })?.message ?? error),
    });
  }

  /**
   * A durable commit landed after degradation: the storage path demonstrably
   * works, so restore capability instead of keeping dispatch closed until a
   * reload. Bounded per activation — a store that keeps flapping between
   * failure and success stays degraded, preserving fail-closed for genuinely
   * unhealthy storage (invariant 12 covers capability changes, not latching a
   * one-shot transient forever).
   */
  reportStorageRecovery(): void {
    const current = this.state;
    if (current.phase !== "offline-ready" && current.phase !== "server-verified") return;
    if (current.storageHealth !== "degraded") return;
    if (this.storageRecoveries >= MAX_STORAGE_RECOVERIES) return;
    this.storageRecoveries++;
    this.emit({ ...current, storageHealth: "healthy", storageError: undefined });
  }

  async failClosed(reason: string): Promise<void> {
    this.rememberFailure(reason);
    await this.lock({ purge: false, removeActiveBinding: false, reason });
    this.emit({
      phase: "failed",
      generation: this.state.generation,
      reason,
      error: reason,
    });
  }

  private emit(next: PrincipalLifecycle): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private isCurrent(operation: number, principalEpoch?: PrincipalEpoch): boolean {
    if (operation !== this.operationEpoch) return false;
    if (principalEpoch === undefined) return true;
    return (this.state.phase === "opening" || this.state.phase === "offline-ready" || this.state.phase === "server-verified")
      && this.state.generation === principalEpoch;
  }

  private gateSynchronously(reason: string): number {
    const operation = ++this.operationEpoch;
    this.emit({ phase: "resolving", generation: this.state.generation });
    this.engine?.invalidatePrincipal(asPrincipalEpoch(this.state.generation + 1));
    this.hooks.stopProtectedIO();
    this.hooks.clearProtectedMemory();
    return operation;
  }

  private async installStore(input: {
    operation: number;
    binding: CredentialBinding;
    resolved: { generation: number; principalKey: OpaquePrincipalKey };
    metadata: PrincipalStoreMetadata;
    adapter: PrincipalStoreAdapter;
    verified: boolean;
  }): Promise<boolean> {
    const principalEpoch = asPrincipalEpoch(input.resolved.generation);
    if (!this.isCurrent(input.operation)) {
      input.adapter.close();
      return false;
    }
    const fence: PrincipalStoreFence = {
      principalKey: input.resolved.principalKey,
      generation: input.resolved.generation,
    };
    this.adapter = input.adapter;
    this.adapterGeneration = input.resolved.generation;
    this.adapterPrincipalEpoch = principalEpoch;
    this.hooks.bindPersistence({
      adapter: input.adapter,
      fence,
      principalId: input.metadata.principalId,
      principalEpoch,
    });
    this.engine?.close();
    this.engine = new LocalFirstEngine({
      adapter: input.adapter,
      fence,
      principalEpoch,
      principalId: input.metadata.principalId,
      initialHead: input.metadata.head,
      onExternalCommit: async () => { await this.hooks.onExternalCommit?.(); },
      onStorageFailure: (error) => this.reportStorageFailure(error),
      onStorageRecovered: () => this.reportStorageRecovery(),
    });
    const hydrated = await this.hooks.hydrate({
      principalEpoch,
      isCurrent: () => this.isCurrent(input.operation, principalEpoch),
    });
    if (!hydrated || !this.isCurrent(input.operation, principalEpoch)) {
      this.hooks.unbindPersistence(principalEpoch);
      this.hooks.clearProtectedMemory();
      this.engine?.close();
      this.engine = null;
      if (this.adapter === input.adapter) {
        this.adapter = null;
        this.adapterGeneration = null;
        this.adapterPrincipalEpoch = undefined;
      }
      input.adapter.close();
      return false;
    }
    this.emit({
      phase: input.verified ? "server-verified" : "offline-ready",
      generation: input.resolved.generation,
      principalEpoch,
      principalId: input.metadata.principalId,
      principalKey: input.resolved.principalKey,
      credentialBinding: input.binding,
      head: input.metadata.head,
      storageHealth: "healthy",
    });
    this.storageRecoveries = 0;
    if (input.verified) this.hooks.onServerVerified?.();
    return true;
  }

  /** Open only an exact durable binding that was previously server verified. */
  async resolveOffline(credentialBinding: CredentialBinding | null): Promise<boolean> {
    const current = this.state;
    if (credentialBinding &&
      (current.phase === "offline-ready" || current.phase === "server-verified") &&
      current.credentialBinding === credentialBinding) return true;

    const operation = this.gateSynchronously(
      credentialBinding ? "resolving-credential" : "missing-credential",
    );
    if (!credentialBinding) {
      this.emit({ phase: "locked", generation: this.state.generation, reason: "missing-credential-binding" });
      return false;
    }
    let resolved;
    try {
      resolved = await this.mutateLauncher(() => this.launcher.resolveOffline(credentialBinding));
    } catch (error) {
      await this.failClosed("launcher-read-failed");
      throw error;
    }
    if (!this.isCurrent(operation)) return false;
    if (!resolved) {
      this.emit({
        phase: "locked",
        generation: this.state.generation,
        reason: "credential-not-previously-verified",
      });
      return false;
    }
    let exists: boolean;
    try {
      exists = await this.stores.exists(resolved.principalKey);
    } catch (error) {
      await this.failClosed("principal-store-existence-check-failed");
      throw error;
    }
    if (!exists) {
      this.emit({
        phase: "locked",
        generation: resolved.generation,
        reason: "credential-not-previously-verified",
      });
      return false;
    }
    this.emit({ phase: "opening", generation: resolved.generation, principalKey: resolved.principalKey });
    let adapter: PrincipalStoreAdapter | null = null;
    try {
      adapter = await this.stores.open(resolved.principalKey);
      const metadata = await adapter.openOffline({
        principalKey: resolved.principalKey,
        generation: resolved.generation,
      });
      return await this.installStore({
        operation,
        binding: credentialBinding,
        resolved,
        metadata,
        adapter,
        verified: false,
      });
    } catch (error) {
      this.engine?.close();
      this.engine = null;
      this.hooks.unbindPersistence();
      this.hooks.clearProtectedMemory();
      if (this.adapter === adapter) {
        this.adapter = null;
        this.adapterGeneration = null;
        this.adapterPrincipalEpoch = undefined;
      }
      adapter?.close();
      if (this.isCurrent(operation)) {
        if (error instanceof PrincipalStoreFenceError) {
          this.emit({ phase: "locked", generation: resolved.generation, reason: "offline-store-fenced" });
          return false;
        }
        await this.failClosed(error instanceof PrincipalStoreIdentityError
          ? "offline-store-identity-mismatch"
          : "offline-store-read-failed");
      }
      throw error;
    }
  }

  /** The caller must correlate this binding to the server-accepted auth session. */
  async verify(input: VerifyPrincipalInput): Promise<boolean> {
    const current = this.state;
    if ((current.phase === "offline-ready" || current.phase === "server-verified") &&
      current.credentialBinding === input.credentialBinding &&
      current.principalId === input.principalId &&
      this.adapter) {
      if (current.phase === "server-verified") return true;
      const metadata = await this.adapter.activateVerified(current.generation, input.principalId);
      if (this.state !== current) return false;
      this.engine?.close();
      this.engine = new LocalFirstEngine({
        adapter: this.adapter,
        fence: { principalKey: current.principalKey, generation: current.generation },
        principalEpoch: current.principalEpoch,
        principalId: current.principalId,
        initialHead: metadata.head,
        onExternalCommit: async () => { await this.hooks.onExternalCommit?.(); },
        onStorageFailure: (error) => this.reportStorageFailure(error),
      });
      this.emit({ ...current, phase: "server-verified", head: metadata.head });
      this.hooks.onServerVerified?.();
      return true;
    }

    if (current.phase === "offline-ready" || current.phase === "server-verified") {
      await this.lock({ purge: false, removeActiveBinding: false, reason: "principal-switch" });
    }
    const operation = this.gateSynchronously("server-verification");
    const resolved = await this.mutateLauncher(() =>
      this.launcher.activateVerified(input.credentialBinding));
    if (!this.isCurrent(operation)) return false;
    this.emit({ phase: "opening", generation: resolved.generation, principalKey: resolved.principalKey });
    const adapter = await this.stores.open(resolved.principalKey);
    try {
      const metadata = await adapter.activateVerified(resolved.generation, input.principalId);
      return await this.installStore({
        operation,
        binding: input.credentialBinding,
        resolved,
        metadata,
        adapter,
        verified: true,
      });
    } catch (error) {
      this.engine?.close();
      this.engine = null;
      this.hooks.unbindPersistence();
      this.hooks.clearProtectedMemory();
      if (this.adapter === adapter) this.adapter = null;
      this.adapterGeneration = null;
      this.adapterPrincipalEpoch = undefined;
      adapter.close();
      if (this.isCurrent(operation)) {
        await this.mutateLauncher(() => this.launcher.lock());
        this.emit({ phase: "locked", generation: resolved.generation, reason: "principal-store-identity-mismatch" });
      }
      throw error;
    }
  }

  async lock(options: {
    purge: boolean;
    removeActiveBinding: boolean;
    reason?: string;
  }): Promise<void> {
    const previous = this.state;
    const previousGeneration = this.adapterGeneration ?? previous.generation;
    const previousEpoch = this.adapterPrincipalEpoch ??
      (previous.phase === "offline-ready" || previous.phase === "server-verified"
        ? previous.principalEpoch
        : undefined);
    ++this.operationEpoch;
    this.emit({ phase: "locking", generation: previousGeneration, reason: options.reason });
    this.engine?.invalidatePrincipal(asPrincipalEpoch(previousGeneration + 1));
    // Stop accepting callbacks/dispatches before the first asynchronous lock
    // step. `flush` may commit only the buffer captured before this suspension.
    this.hooks.stopProtectedIO(previousEpoch);
    this.hooks.clearProtectedMemory();
    if (options.purge) this.hooks.discardCompatibility?.(previousEpoch);
    let failureGeneration = previous.generation;
    try {
      if (!options.purge) await this.hooks.flushCompatibility?.();
      const launcherState = await this.mutateLauncher(() => this.launcher.lock({
        removeActiveBinding: options.removeActiveBinding,
      }));
      failureGeneration = launcherState.generation;
      if (this.adapter && this.adapterGeneration !== null) {
        await this.adapter.fence(this.adapterGeneration, launcherState.generation);
      }
      // The launcher lock and principal-store fence are both durable before
      // bindings are released or logout/account-switch reports completion.
      this.hooks.unbindPersistence(previousEpoch);
      this.engine?.close();
      this.engine = null;
      const oldAdapter = this.adapter;
      if (options.purge && oldAdapter) {
        this.emit({ phase: "purging", generation: launcherState.generation, reason: options.reason });
        await oldAdapter.purge();
      } else {
        oldAdapter?.close();
      }
      this.adapter = null;
      this.adapterGeneration = null;
      this.adapterPrincipalEpoch = undefined;
      this.emit({ phase: "locked", generation: launcherState.generation, reason: options.reason });
    } catch (error) {
      this.rememberFailure(options.reason ?? "principal-lock-failed", error);
      this.emit({
        phase: "failed",
        generation: failureGeneration,
        reason: options.reason ?? "principal-lock-failed",
        error: String((error as { message?: unknown })?.message ?? error),
      });
      throw error;
    }
  }

  async reconcileLauncherGeneration(): Promise<void> {
    const durable = await this.launcher.read();
    const current = this.state;
    if (current.phase === "locked" && durable.locked && current.generation === durable.generation) return;
    if ((current.phase === "offline-ready" || current.phase === "server-verified") &&
      !durable.locked &&
      durable.generation === current.generation &&
      durable.activePrincipalKey === current.principalKey) {
      try {
        await this.engine?.reconcileDurableHead();
      } catch (error) {
        this.reportStorageFailure(error);
      }
      return;
    }
    if (durable.generation === current.generation && current.phase === "resolving") return;

    ++this.operationEpoch;
    this.emit({ phase: "locking", generation: durable.generation, reason: "launcher-generation-changed" });
    this.engine?.invalidatePrincipal(asPrincipalEpoch(durable.generation));
    this.hooks.stopProtectedIO();
    this.hooks.clearProtectedMemory();
    this.hooks.unbindPersistence();
    this.engine?.close();
    this.engine = null;
    this.adapter?.close();
    this.adapter = null;
    this.adapterGeneration = null;
    this.adapterPrincipalEpoch = undefined;
    this.emit({ phase: "locked", generation: durable.generation, reason: "launcher-generation-changed" });
  }

  close(): void {
    ++this.operationEpoch;
    this.unsubscribeLauncher?.();
    this.unsubscribeLauncher = null;
    this.engine?.close();
    this.adapter?.close();
    this.adapterGeneration = null;
    this.adapterPrincipalEpoch = undefined;
    this.listeners.clear();
  }
}
