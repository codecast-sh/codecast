const DB_NAME = "codecast-auth";
const STORE_NAME = "tokens";
const DB_VERSION = 1;

let cachedDB: IDBDatabase | null = null;
let dbOpenPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (cachedDB) return Promise.resolve(cachedDB);
  if (dbOpenPromise) return dbOpenPromise;
  dbOpenPromise = new Promise<IDBDatabase>((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
      req.onsuccess = () => {
        cachedDB = req.result;
        cachedDB.onclose = () => { cachedDB = null; dbOpenPromise = null; };
        resolve(cachedDB);
      };
      req.onerror = () => { dbOpenPromise = null; reject(req.error); };
    } catch (e) {
      dbOpenPromise = null;
      reject(e);
    }
  });
  return dbOpenPromise;
}

function idbGet(key: string): Promise<string | null> {
  return openDB().then(
    (db) =>
      new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, "readonly");
        const req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = () => resolve((req.result as string) ?? null);
        req.onerror = () => resolve(null);
      }),
    () => null,
  );
}

function idbSet(key: string, value: string): void {
  openDB().then(
    (db) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(value, key);
    },
    () => {},
  );
}

function idbRemove(key: string): void {
  openDB().then(
    (db) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(key);
    },
    () => {},
  );
}

/**
 * Dual-write storage: localStorage (fast sync read) + IndexedDB (durable backup).
 *
 * getItem returns synchronously when localStorage has the value.
 * When localStorage is empty it returns a Promise that checks IDB — the
 * @convex-dev/auth client `await`s getItem results, so both paths work.
 * On recovery from IDB the value is written back to localStorage so
 * subsequent reads are instant.
 */
export const durableAuthStorage: Storage = {
  get length() {
    return localStorage.length;
  },
  key(index: number) {
    return localStorage.key(index);
  },
  getItem(key: string): any {
    try {
      const v = localStorage.getItem(key);
      if (v !== null) {
        idbSet(key, v); // ensure IDB backup exists
        return v;
      }
    } catch {}
    return idbGet(key).then((v) => {
      if (v !== null) {
        try { localStorage.setItem(key, v); } catch {}
      }
      return v;
    });
  },
  setItem(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch {}
    idbSet(key, value);
  },
  removeItem(key: string): void {
    try { localStorage.removeItem(key); } catch {}
    // The auth library removes the refresh token from storage BEFORE making
    // the server call. If that call fails (network blip), the token is lost
    // forever. Keep the IDB copy as a safety net — it gets overwritten on
    // the next successful setItem. For all other keys, remove from both.
    if (!key.includes("RefreshToken")) {
      idbRemove(key);
    }
  },
  clear(): void {
    localStorage.clear();
  },
};
