export type MobileDispatchOutboxEntry = {
  id: string;
  action: string;
  args: unknown;
  patches: unknown;
  result: unknown;
  ts: number;
  attempts?: number;
};

export type MobileDispatchDatabase = {
  execAsync(source: string): Promise<unknown>;
  runSync(source: string, ...params: unknown[]): unknown;
  runAsync(source: string, ...params: unknown[]): Promise<unknown>;
  getAllAsync(source: string, ...params: unknown[]): Promise<unknown[]>;
};

export type PrincipalDispatchOutbox = {
  enqueue(entry: MobileDispatchOutboxEntry): void;
  remove(id: string): Promise<void>;
  load(): Promise<MobileDispatchOutboxEntry[]>;
};

type StoredDispatchRow = {
  id: string;
  entry_json: string;
};

const DATABASE_NAME = "codecast-mobile-dispatch.db";

const CREATE_SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS mobile_dispatch_outbox (
    principal_id TEXT NOT NULL,
    id TEXT NOT NULL,
    entry_json TEXT NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (principal_id, id)
  );
  CREATE INDEX IF NOT EXISTS mobile_dispatch_outbox_by_principal_ts
    ON mobile_dispatch_outbox (principal_id, ts, id);
`;

const UPSERT_ENTRY = `
  INSERT INTO mobile_dispatch_outbox (principal_id, id, entry_json, ts)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(principal_id, id) DO UPDATE SET
    entry_json = excluded.entry_json,
    ts = excluded.ts
`;

const DELETE_ENTRY = `
  DELETE FROM mobile_dispatch_outbox
  WHERE principal_id = ? AND id = ?
`;

const LOAD_ENTRIES = `
  SELECT id, entry_json
  FROM mobile_dispatch_outbox
  WHERE principal_id = ?
  ORDER BY ts ASC, id ASC
`;

function parseEntry(value: string): MobileDispatchOutboxEntry | null {
  try {
    const parsed = JSON.parse(value) as Partial<MobileDispatchOutboxEntry>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.action !== "string" ||
      typeof parsed.ts !== "number" ||
      !Number.isFinite(parsed.ts)
    ) {
      return null;
    }
    if (
      parsed.attempts !== undefined &&
      (!Number.isInteger(parsed.attempts) || parsed.attempts < 0)
    ) {
      return null;
    }
    return {
      id: parsed.id,
      action: parsed.action,
      args: parsed.args,
      patches: parsed.patches,
      result: parsed.result,
      ts: parsed.ts,
      ...(parsed.attempts !== undefined ? { attempts: parsed.attempts } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Principal identity is captured in the returned closure. An old in-flight
 * enqueue/remove can therefore touch only its original account even if auth
 * rotates before the SQLite operation completes.
 */
export function createPrincipalDispatchOutbox(
  database: MobileDispatchDatabase,
  principalId: string,
): PrincipalDispatchOutbox {
  if (!principalId.trim()) throw new Error("A verified principal is required for the mobile dispatch outbox");

  return {
    enqueue(entry) {
      const encoded = JSON.stringify(entry);
      if (encoded === undefined) throw new Error("Dispatch entry could not be serialized");
      // The shared middleware reports `parked:true` immediately after this
      // callback returns. Keep this critical insert synchronous so that status
      // means the row is already on disk, not merely that an async write began.
      database.runSync(
        UPSERT_ENTRY,
        principalId,
        entry.id,
        encoded,
        entry.ts,
      );
    },

    async remove(id) {
      await database.runAsync(DELETE_ENTRY, principalId, id);
    },

    async load() {
      const rows = await database.getAllAsync(
        LOAD_ENTRIES,
        principalId,
      ) as StoredDispatchRow[];
      const entries: MobileDispatchOutboxEntry[] = [];
      for (const row of rows) {
        const entry = parseEntry(row.entry_json);
        if (entry && entry.id === row.id) {
          entries.push(entry);
          continue;
        }
        // A corrupt row can never be dispatched safely. Quarantine it from the
        // hot drain rather than letting every app launch fail on the same JSON.
        await database.runAsync(DELETE_ENTRY, principalId, row.id);
      }
      return entries;
    },
  };
}

let databasePromise: Promise<MobileDispatchDatabase> | null = null;

async function openDatabase(): Promise<MobileDispatchDatabase> {
  if (!databasePromise) {
    databasePromise = import("expo-sqlite")
      .then(async ({ openDatabaseAsync }) => {
        const database = await openDatabaseAsync(DATABASE_NAME);
        await database.execAsync(CREATE_SCHEMA);
        return {
          execAsync: (source) => database.execAsync(source),
          runSync: (source, ...params) => database.runSync(source, ...(params as any[])),
          runAsync: (source, ...params) => database.runAsync(source, ...(params as any[])),
          getAllAsync: (source, ...params) => database.getAllAsync(source, ...(params as any[])),
        } satisfies MobileDispatchDatabase;
      })
      .catch((error) => {
        databasePromise = null;
        throw error;
      });
  }
  return await databasePromise;
}

export async function openPrincipalDispatchOutbox(
  principalId: string,
): Promise<PrincipalDispatchOutbox> {
  const database = await openDatabase();
  return createPrincipalDispatchOutbox(database, principalId);
}
