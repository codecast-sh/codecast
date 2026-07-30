export type StoragePersistenceStatus =
  | "unrequested"
  | "requesting"
  | "granted"
  | "denied"
  | "unsupported"
  | "error";

type StorageManagerLike = {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
};

const listeners = new Set<() => void>();
let status: StoragePersistenceStatus = "unrequested";
let requestInFlight: Promise<StoragePersistenceStatus> | null = null;

function publish(next: StoragePersistenceStatus): StoragePersistenceStatus {
  status = next;
  for (const listener of listeners) listener();
  return next;
}

export function getStoragePersistenceStatus(): StoragePersistenceStatus {
  return status;
}

export function subscribeStoragePersistence(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function withDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Persistent-storage request timed out")),
      deadlineMs,
    );
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Request persistent browser storage before final-mode durable writes can be
 * authored. Denial does not lock the read cache: it advertises a reduced
 * capability, and offline durable commands are rejected explicitly.
 */
export function requestPersistentStorage(
  storage: StorageManagerLike | undefined =
    typeof navigator === "undefined" ? undefined : navigator.storage,
  deadlineMs = 5_000,
): Promise<StoragePersistenceStatus> {
  if (status === "granted" || status === "denied" || status === "unsupported") {
    return Promise.resolve(status);
  }
  if (requestInFlight) return requestInFlight;
  if (!storage?.persist || !storage.persisted) {
    return Promise.resolve(publish("unsupported"));
  }
  publish("requesting");
  requestInFlight = withDeadline((async () => {
    if (await storage.persisted!()) return publish("granted");
    return publish((await storage.persist!()) ? "granted" : "denied");
  })(), deadlineMs).catch(() => publish("error")).finally(() => {
    requestInFlight = null;
  });
  return requestInFlight;
}

export class DurableOfflineWritesUnavailableError extends Error {
  constructor(readonly persistenceStatus: StoragePersistenceStatus) {
    super(
      "Offline edits are unavailable because this browser did not grant persistent storage. Reconnect before editing.",
    );
    this.name = "DurableOfflineWritesUnavailableError";
  }
}

/** Fail before optimistic paint when the reduced-capability browser is offline. */
export function assertDurableOfflineWriteCapability(
  online: boolean =
    typeof navigator === "undefined" ? true : navigator.onLine,
): void {
  if (online) return;
  if (status === "granted") return;
  throw new DurableOfflineWritesUnavailableError(status);
}

/** Test-only reset; production state is monotonic for the lifetime of a page. */
export function resetStoragePersistenceForTests(): void {
  status = "unrequested";
  requestInFlight = null;
  listeners.clear();
}
