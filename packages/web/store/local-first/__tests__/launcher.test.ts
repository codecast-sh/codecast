import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import Dexie from "dexie";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import {
  createOpaquePrincipalKey,
  DexieLauncherStore,
  launcherDatabaseName,
  PrincipalKeyRandomnessUnavailableError,
} from "../persistence/launcher";
import type { CredentialBinding } from "../types";

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

describe("principal launcher key generation", () => {
  const databases: string[] = [];

  afterEach(async () => {
    await Promise.all(databases.splice(0).map((name) => Dexie.delete(name)));
  });

  test("fails closed when cryptographic randomness is unavailable", async () => {
    expect(() => createOpaquePrincipalKey(null))
      .toThrow(PrincipalKeyRandomnessUnavailableError);

    const deployment = `launcher-randomness-${randomUUID()}`;
    const database = launcherDatabaseName(deployment);
    databases.push(database);
    const launcher = new DexieLauncherStore(
      deployment,
      () => createOpaquePrincipalKey(null),
    );
    try {
      await expect(launcher.activateVerified("binding-a" as CredentialBinding))
        .rejects.toBeInstanceOf(PrincipalKeyRandomnessUnavailableError);
      const state = await launcher.read();
      expect(state).toMatchObject({ locked: true, generation: 0, bindings: {} });
      expect(state.activeBinding).toBeUndefined();
      expect(state.activePrincipalKey).toBeUndefined();
    } finally {
      launcher.close();
    }
  });
});
