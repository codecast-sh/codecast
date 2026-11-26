import { readPlanSql, readPlanSizesSql, readKeysSql, rowsToMap, sliceKeys } from "./idbCacheKeys.native";

// The native cache's bulk reads over kv-store's `storage` table, on a
// connection idbCache.native opens.
//
// expo-sqlite's Android getAll holds a statement's whole result as Java strings
// before JS sees any of it, and the Java heap stops at 256 MB (a Daylight
// tablet). A big account's boot read in one statement filled it, and the next
// allocation, often a Convex frame on OkHttp's thread, crashed the app mid-sync.
// So Android lists the read's keys with their sizes first (octet_length; no
// value leaves SQLite), then reads the values in batches of at most this many
// bytes. iOS keeps the one statement: its results never pass through a Java heap.
// The batches are separate statements, so a flush landing mid-read gives later
// batches newer rows than earlier ones; every row is still one written to disk.
let readSliceBytes: number | null = (() => {
  try {
    return require("react-native").Platform.OS === "android" ? 8_000_000 : null;
  } catch {
    return null;
  }
})();

// Test hook: slice reads off the phone.
export function _setReadSliceBytes(bytes: number | null) {
  readSliceBytes = bytes;
}

type ReadPlan = { prefixes: string[]; exact: string[] };
type Row = { key: string; value: string | null };
type Sized = { key: string; bytes: number | null };

// Batches answer in their own order; hand rows back in the listing's order,
// the one statement's. A key deleted between the listing and its batch is gone.
function inListedOrder(listed: Sized[], read: Map<string, string | null>): Map<string, string | null> {
  const byKey = new Map<string, string | null>();
  for (const { key } of listed) if (read.has(key)) byKey.set(key, read.get(key)!);
  return byKey;
}

export async function readRows(db: any, plan: ReadPlan): Promise<Map<string, string | null>> {
  if (readSliceBytes == null) {
    const { sql, params } = readPlanSql(plan);
    return rowsToMap(await db.getAllAsync(sql, params));
  }
  const sizes = readPlanSizesSql(plan);
  const listed: Sized[] = await db.getAllAsync(sizes.sql, sizes.params);
  const read = new Map<string, string | null>();
  for (const keys of sliceKeys(listed, readSliceBytes)) {
    const { sql, params } = readKeysSql(keys);
    for (const row of (await db.getAllAsync(sql, params)) as Row[]) read.set(row.key, row.value);
  }
  return inListedOrder(listed, read);
}

export function readRowsSync(db: any, plan: ReadPlan): Map<string, string | null> {
  if (readSliceBytes == null) {
    const { sql, params } = readPlanSql(plan);
    return rowsToMap(db.getAllSync(sql, params));
  }
  const sizes = readPlanSizesSql(plan);
  const listed: Sized[] = db.getAllSync(sizes.sql, sizes.params);
  const read = new Map<string, string | null>();
  for (const keys of sliceKeys(listed, readSliceBytes)) {
    const { sql, params } = readKeysSql(keys);
    for (const row of db.getAllSync(sql, params) as Row[]) read.set(row.key, row.value);
  }
  return inListedOrder(listed, read);
}
