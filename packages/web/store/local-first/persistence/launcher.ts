import Dexie, { type Table } from "dexie";
import type { CredentialBinding, OpaquePrincipalKey } from "../types";

export const LAUNCHER_SCHEMA_VERSION = 1;

export type VerifiedBindingRecord = {
  principalKey: OpaquePrincipalKey;
  verifiedAt: number;
  adapterVersion: 1;
};

export type LauncherState = {
  key: "launcher";
  schemaVersion: number;
  generation: number;
  locked: boolean;
  activeBinding?: CredentialBinding;
  activePrincipalKey?: OpaquePrincipalKey;
  bindings: Record<string, VerifiedBindingRecord>;
  legacyQuarantine?: {
    status: "detected" | "exported" | "abandoned" | "purged";
    detectedAt: number;
    updatedAt: number;
  };
  updatedAt: number;
};

export type ResolvedLauncherBinding = {
  generation: number;
  principalKey: OpaquePrincipalKey;
};

export interface LauncherStore {
  read(): Promise<LauncherState>;
  resolveOffline(binding: CredentialBinding): Promise<ResolvedLauncherBinding | null>;
  activateVerified(binding: CredentialBinding): Promise<ResolvedLauncherBinding>;
  lock(options?: { removeActiveBinding?: boolean }): Promise<LauncherState>;
  markLegacyQuarantined(): Promise<void>;
  setLegacyQuarantineStatus(status: "exported" | "abandoned" | "purged"): Promise<void>;
  subscribe(listener: () => void): () => void;
  close(): void;
}

class LauncherDexie extends Dexie {
  state!: Table<LauncherState, string>;

  constructor(name: string) {
    super(name);
    this.version(LAUNCHER_SCHEMA_VERSION).stores({ state: "key" });
  }
}

function normalizeDatabasePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 160);
}

export function launcherDatabaseName(deploymentKey: string): string {
  return `codecast-launcher-v2:${normalizeDatabasePart(deploymentKey)}`;
}

export class PrincipalKeyRandomnessUnavailableError extends Error {
  constructor() {
    super("Cryptographic randomness is unavailable for principal storage isolation");
    this.name = "PrincipalKeyRandomnessUnavailableError";
  }
}

export function createOpaquePrincipalKey(
  randomUUID: (() => string) | null,
): OpaquePrincipalKey {
  if (!randomUUID) throw new PrincipalKeyRandomnessUnavailableError();
  return randomUUID() as OpaquePrincipalKey;
}

function newOpaquePrincipalKey(): OpaquePrincipalKey {
  return createOpaquePrincipalKey(
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID.bind(crypto)
      : null,
  );
}

export class DexieLauncherStore implements LauncherStore {
  private readonly db: LauncherDexie;
  private readonly listeners = new Set<() => void>();
  private readonly channel: BroadcastChannel | null;

  constructor(
    deploymentKey: string,
    private readonly createPrincipalKey: () => OpaquePrincipalKey = newOpaquePrincipalKey,
  ) {
    const name = launcherDatabaseName(deploymentKey);
    this.db = new LauncherDexie(name);
    this.channel = typeof BroadcastChannel === "function"
      ? new BroadcastChannel(`${name}:changes`)
      : null;
    if (this.channel) this.channel.onmessage = () => this.emit();
  }

  private initialState(): LauncherState {
    return {
      key: "launcher",
      schemaVersion: LAUNCHER_SCHEMA_VERSION,
      generation: 0,
      locked: true,
      bindings: {},
      updatedAt: Date.now(),
    };
  }

  private async inWriteTransaction(
    update: (current: LauncherState) => LauncherState,
    notify: boolean | ((previous: LauncherState, next: LauncherState) => boolean) = true,
  ): Promise<LauncherState> {
    const result = await this.db.transaction("rw", this.db.state, async () => {
      const current = (await this.db.state.get("launcher")) ?? this.initialState();
      const value = update(current);
      await this.db.state.put(value);
      return { previous: current, next: value };
    });
    const shouldNotify = typeof notify === "function"
      ? notify(result.previous, result.next)
      : notify;
    if (shouldNotify) {
      this.emit();
      this.channel?.postMessage({ generation: result.next.generation });
    }
    return result.next;
  }

  async read(): Promise<LauncherState> {
    const existing = await this.db.state.get("launcher");
    if (existing) return existing;
    return await this.inWriteTransaction((state) => state);
  }

  async resolveOffline(binding: CredentialBinding): Promise<ResolvedLauncherBinding | null> {
    const state = await this.read();
    if (state.locked || state.activeBinding !== binding) return null;
    const verified = state.bindings[binding];
    if (!verified || verified.principalKey !== state.activePrincipalKey) return null;
    return { generation: state.generation, principalKey: verified.principalKey };
  }

  async activateVerified(binding: CredentialBinding): Promise<ResolvedLauncherBinding> {
    const state = await this.inWriteTransaction((current) => {
      const existing = current.bindings[binding];
      const principalKey = existing?.principalKey ?? this.createPrincipalKey();
      const sameActive =
        !current.locked &&
        current.activeBinding === binding &&
        current.activePrincipalKey === principalKey;
      return {
        ...current,
        generation: sameActive ? current.generation : current.generation + 1,
        locked: false,
        activeBinding: binding,
        activePrincipalKey: principalKey,
        bindings: {
          ...current.bindings,
          [binding]: {
            principalKey,
            verifiedAt: Date.now(),
            adapterVersion: 1,
          },
        },
        updatedAt: Date.now(),
      };
    }, (previous, next) =>
      previous.generation !== next.generation ||
      previous.locked !== next.locked ||
      previous.activeBinding !== next.activeBinding ||
      previous.activePrincipalKey !== next.activePrincipalKey,
    );
    return { generation: state.generation, principalKey: state.activePrincipalKey! };
  }

  async lock(options: { removeActiveBinding?: boolean } = {}): Promise<LauncherState> {
    return await this.inWriteTransaction((current) => {
      if (current.locked && !current.activeBinding) return current;
      const bindings = { ...current.bindings };
      if (options.removeActiveBinding && current.activeBinding) delete bindings[current.activeBinding];
      return {
        ...current,
        generation: current.generation + 1,
        locked: true,
        activeBinding: undefined,
        activePrincipalKey: undefined,
        bindings,
        updatedAt: Date.now(),
      };
    });
  }

  async markLegacyQuarantined(): Promise<void> {
    // Quarantine metadata does not change the active principal generation.
    // Publishing it through the auth-state channel can race a fresh tab's
    // offline resolve and incorrectly supersede that cache open.
    await this.inWriteTransaction((current) => current.legacyQuarantine
      ? current
      : {
          ...current,
          legacyQuarantine: {
            status: "detected",
            detectedAt: Date.now(),
            updatedAt: Date.now(),
          },
          updatedAt: Date.now(),
        }, false);
  }

  async setLegacyQuarantineStatus(status: "exported" | "abandoned" | "purged"): Promise<void> {
    // See markLegacyQuarantined: lifecycle subscribers only observe changes
    // that can invalidate or replace an active principal binding.
    await this.inWriteTransaction((current) => ({
      ...current,
      legacyQuarantine: {
        status,
        detectedAt: current.legacyQuarantine?.detectedAt ?? Date.now(),
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    }), false);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  close(): void {
    this.channel?.close();
    this.db.close();
  }
}
