import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { DexiePrincipalStoreFactory } from "../persistence/dexieAdapter";
import {
  DexieLauncherStore,
  launcherDatabaseName,
  type LauncherStore,
} from "../persistence/launcher";
import { PrincipalStoreFenceError } from "../persistence/adapter";
import { PrincipalRuntime, type PrincipalRuntimeHooks } from "../principalRuntime";
import {
  asPrincipalId,
  type CredentialBinding,
  type OpaquePrincipalKey,
} from "../types";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

type HydrateBehavior = (input: {
  isCurrent: () => boolean;
}) => Promise<boolean>;

function makeRuntime(launcher: LauncherStore, deployment: string) {
  const hydrateQueue: HydrateBehavior[] = [];
  const calls = { bind: 0, unbind: 0 };
  const hooks: PrincipalRuntimeHooks = {
    stopProtectedIO: () => {},
    clearProtectedMemory: () => {},
    bindPersistence: () => { calls.bind++; },
    unbindPersistence: () => { calls.unbind++; },
    hydrate: async (input) => {
      const behavior = hydrateQueue.shift();
      if (behavior) return await behavior(input);
      return input.isCurrent();
    },
  };
  const runtime = new PrincipalRuntime(
    launcher,
    new DexiePrincipalStoreFactory(deployment),
    hooks,
  );
  return { runtime, hydrateQueue, calls };
}

// Establish a durable verified binding, then discard the runtime — leaving the
// launcher unlocked with an active binding, exactly the durable state a page
// reload resolves offline against.
async function verifyThenSimulateReload(
  launcher: DexieLauncherStore,
  deployment: string,
  credential: CredentialBinding,
): Promise<void> {
  const first = makeRuntime(launcher, deployment);
  expect(
    await first.runtime.verify({
      credentialBinding: credential,
      principalId: asPrincipalId("principal-setup"),
    }),
  ).toBe(true);
  first.runtime.close();
}

async function waitFor(
  condition: () => boolean,
  label: string,
): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`never satisfied: ${label}`);
}

describe("PrincipalRuntime supersession discipline", () => {
  test("a same-binding launcher observation cannot cancel startup before generation adoption", async () => {
    const deployment = `runtime-startup-echo-${randomUUID()}`;
    const principalKey = randomUUID() as OpaquePrincipalKey;
    const launcher = new DexieLauncherStore(deployment, () => principalKey);
    const credential = randomUUID() as CredentialBinding;
    await verifyThenSimulateReload(launcher, deployment, credential);
    let releaseResolve!: () => void;
    const resolveGate = new Promise<void>((resolve) => { releaseResolve = resolve; });
    const delayedLauncher: LauncherStore = {
      read: async () => await launcher.read(),
      resolveOffline: async (binding) => {
        await resolveGate;
        return await launcher.resolveOffline(binding);
      },
      activateVerified: async (binding) => await launcher.activateVerified(binding),
      lock: async (options) => await launcher.lock(options),
      markLegacyQuarantined: async () => await launcher.markLegacyQuarantined(),
      setLegacyQuarantineStatus: async (status) => await launcher.setLegacyQuarantineStatus(status),
      subscribe: (listener) => launcher.subscribe(listener),
      close: () => launcher.close(),
    };
    const { runtime } = makeRuntime(delayedLauncher, deployment);
    try {
      const opened = runtime.resolveOffline(credential);
      await waitFor(() => runtime.getSnapshot().phase === "resolving", "phase resolving");

      // This is the fresh-tab window: the runtime still says generation 0,
      // while the durable same-binding launcher is already on a later one.
      await runtime.reconcileLauncherGeneration();
      expect(runtime.getSnapshot().phase).toBe("resolving");
      releaseResolve();

      expect(await opened).toBe(true);
      expect(runtime.getSnapshot().phase).toBe("offline-ready");
    } finally {
      releaseResolve();
      await runtime.lock({ purge: true, removeActiveBinding: true, reason: "test-cleanup" });
      runtime.close();
      await Dexie.delete(launcherDatabaseName(deployment));
    }
  });

  // The launcher's own subscription echoes a tick after resolve touches the
  // launcher, landing while the install is mid-hydration in phase "opening".
  // Reconciliation against an UNCHANGED durable generation must leave the
  // in-flight install alone instead of tearing down its fresh bindings.
  test("launcher echo during install does not tear down the in-flight binding", async () => {
    const deployment = `runtime-echo-${randomUUID()}`;
    const principalKey = randomUUID() as OpaquePrincipalKey;
    const launcher = new DexieLauncherStore(deployment, () => principalKey);
    const credential = randomUUID() as CredentialBinding;
    await verifyThenSimulateReload(launcher, deployment, credential);
    const { runtime, hydrateQueue } = makeRuntime(launcher, deployment);
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      hydrateQueue.push(async ({ isCurrent }) => {
        await gate;
        return isCurrent();
      });
      const opened = runtime.resolveOffline(credential);
      await waitFor(() => runtime.getSnapshot().phase === "opening", "phase opening");

      await runtime.reconcileLauncherGeneration();
      release();

      expect(await opened).toBe(true);
      expect(runtime.getSnapshot().phase).toBe("offline-ready");
    } finally {
      await runtime.lock({ purge: true, removeActiveBinding: true, reason: "test-cleanup" });
      runtime.close();
      launcher.close();
      await Dexie.delete(launcherDatabaseName(deployment));
    }
  });

  // Two resolves race (dev double-mount, token refresh). The loser's hydration
  // trips the persistence fence; it must swallow that as supersession and must
  // NOT run the shared unbind/teardown that would destroy the winner's install.
  test("a superseded resolve leaves its successor's bindings untouched", async () => {
    const deployment = `runtime-race-${randomUUID()}`;
    const principalKey = randomUUID() as OpaquePrincipalKey;
    const launcher = new DexieLauncherStore(deployment, () => principalKey);
    const credential = randomUUID() as CredentialBinding;
    await verifyThenSimulateReload(launcher, deployment, credential);
    const { runtime, hydrateQueue, calls } = makeRuntime(launcher, deployment);
    try {
      let releaseLoser!: () => void;
      const loserGate = new Promise<void>((resolve) => { releaseLoser = resolve; });
      hydrateQueue.push(async () => {
        await loserGate;
        throw new PrincipalStoreFenceError("Principal changed during persistence");
      });
      const loser = runtime.resolveOffline(credential);
      await waitFor(() => runtime.getSnapshot().phase === "opening", "phase opening");

      const winner = runtime.resolveOffline(credential);
      // bind #1 = loser's install, bind #2 = winner's install.
      await waitFor(() => calls.bind >= 2, "winner bound persistence");
      const unbindsBeforeLoserFails = calls.unbind;
      releaseLoser();

      expect(await loser).toBe(false);
      expect(await winner).toBe(true);
      // The stale loser must not have torn down the winner's bindings.
      expect(calls.unbind).toBe(unbindsBeforeLoserFails);
      expect(runtime.getSnapshot().phase).toBe("offline-ready");
    } finally {
      await runtime.lock({ purge: true, removeActiveBinding: true, reason: "test-cleanup" });
      runtime.close();
      launcher.close();
      await Dexie.delete(launcherDatabaseName(deployment));
    }
  });
});
