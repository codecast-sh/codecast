// IndexedDB helpers for salvageLocalFirstV2Data (idbCache.ts): read the
// retired v2 databases' parked outbox rows, then delete those databases.

export function readV2LegacyOutbox(name: string): Promise<unknown[]> {
  return new Promise((resolve) => {
    const req = indexedDB.open(name);
    // A database wedged by the very failure mode that retired v2 must not
    // wedge boot: give up quietly and let deletion (or the next boot) win.
    const timer = setTimeout(() => resolve([]), 10_000);
    req.onerror = () => { clearTimeout(timer); resolve([]); };
    req.onsuccess = () => {
      const vdb = req.result;
      try {
        if (!vdb.objectStoreNames.contains("legacyOutbox")) {
          clearTimeout(timer); vdb.close(); resolve([]); return;
        }
        const get = vdb.transaction("legacyOutbox", "readonly").objectStore("legacyOutbox").getAll();
        get.onsuccess = () => { clearTimeout(timer); vdb.close(); resolve(get.result ?? []); };
        get.onerror = () => { clearTimeout(timer); vdb.close(); resolve([]); };
      } catch {
        clearTimeout(timer); vdb.close(); resolve([]);
      }
    };
  });
}

export function deleteDatabaseWithTimeout(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    // deleteDatabase blocks while another tab holds a connection; don't let
    // that stall boot — the next boot retries.
    const timer = setTimeout(() => resolve(), 10_000);
    const done = () => { clearTimeout(timer); resolve(); };
    req.onsuccess = done;
    req.onerror = done;
    req.onblocked = () => { /* keep waiting until timeout */ };
  });
}
