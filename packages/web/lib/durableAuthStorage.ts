// Dual-write storage for the auth token: localStorage (fast sync read) plus
// IndexedDB (durable backup). The implementation lives in @platform/auth/web —
// it was extracted from this file; the database name is codecast's.
import { createDurableAuthStorage } from "@platform/auth/web";

export const {
  storage: durableAuthStorage,
  readDurableAuthValue,
  purgeDurableAuthValues,
} = createDurableAuthStorage({ dbName: "codecast-auth" });
