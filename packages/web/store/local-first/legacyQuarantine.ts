import Dexie from "dexie";
import type { LauncherStore } from "./persistence/launcher";

export const LEGACY_GLOBAL_DATABASE_NAME = "codecast-store";

export type LegacyQuarantineStatus =
  | { status: "absent" }
  | { status: "quarantined"; tableCount: number; outboxCount: number | null };

/**
 * Inspect only schema/count metadata. Protected legacy payloads are never read
 * into memory and are never assigned to the currently authenticated user.
 */
export async function inspectLegacyQuarantine(): Promise<LegacyQuarantineStatus> {
  if (!(await Dexie.exists(LEGACY_GLOBAL_DATABASE_NAME))) return { status: "absent" };
  const db = new Dexie(LEGACY_GLOBAL_DATABASE_NAME);
  try {
    await db.open();
    const outbox = db.tables.find((table) => table.name === "dispatchOutbox");
    return {
      status: "quarantined",
      tableCount: db.tables.length,
      outboxCount: outbox ? await outbox.count() : null,
    };
  } finally {
    db.close();
  }
}

/** Explicit recovery UI may call this; startup and account switching never do. */
export async function purgeLegacyQuarantine(): Promise<void> {
  await Dexie.delete(LEGACY_GLOBAL_DATABASE_NAME);
}

export class LegacyQuarantineRecovery {
  constructor(private readonly launcher: LauncherStore) {}

  async inspect(): Promise<LegacyQuarantineStatus> {
    const status = await inspectLegacyQuarantine();
    if (status.status === "quarantined") await this.launcher.markLegacyQuarantined();
    return status;
  }

  /**
   * Return an opaque download payload. No row is exposed to application state,
   * assigned to a principal, or made executable by this operation.
   */
  async exportArchive(): Promise<Blob> {
    if (!(await Dexie.exists(LEGACY_GLOBAL_DATABASE_NAME))) {
      throw new Error("No legacy quarantine exists");
    }
    const db = new Dexie(LEGACY_GLOBAL_DATABASE_NAME);
    try {
      await db.open();
      const tables: Record<string, unknown[]> = {};
      for (const table of db.tables) tables[table.name] = await table.toArray();
      const archive = new Blob([
        JSON.stringify({
          format: "codecast-legacy-quarantine-v1",
          database: LEGACY_GLOBAL_DATABASE_NAME,
          exportedAt: Date.now(),
          tables,
        }, (_key, value) => typeof value === "bigint"
          ? { $codecastType: "bigint", value: value.toString() }
          : value),
      ], { type: "application/octet-stream" });
      await this.launcher.setLegacyQuarantineStatus("exported");
      return archive;
    } finally {
      db.close();
    }
  }

  async abandon(): Promise<void> {
    await this.launcher.setLegacyQuarantineStatus("abandoned");
    await Dexie.delete(LEGACY_GLOBAL_DATABASE_NAME);
  }

  async purge(): Promise<void> {
    await Dexie.delete(LEGACY_GLOBAL_DATABASE_NAME);
    await this.launcher.setLegacyQuarantineStatus("purged");
  }
}
