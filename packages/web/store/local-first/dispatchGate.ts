import { useSyncExternalStore } from "react";

type DispatchRuntime = {
  readonly canDispatch: boolean;
  readonly dispatchPrincipalEpoch?: number | null;
  subscribe(listener: () => void): () => void;
};

let runtime: DispatchRuntime | null = null;
const registrationListeners = new Set<() => void>();
let correlationEpoch = 0;
let correlatedPrincipalEpoch: number | null = null;
let notificationQueued = false;

function scheduleNotification(): void {
  if (notificationQueued) return;
  notificationQueued = true;
  const notify = () => {
    notificationQueued = false;
    for (const listener of registrationListeners) listener();
  };
  if (typeof queueMicrotask === "function") queueMicrotask(notify);
  else void Promise.resolve().then(notify);
}

export function subscribePrincipalDispatchCorrelation(listener: () => void): () => void {
  registrationListeners.add(listener);
  return () => registrationListeners.delete(listener);
}

export type DispatchAuthorizationCapture = {
  correlationEpoch: number;
  principalEpoch: number;
};

export function registerPrincipalDispatchRuntime(next: DispatchRuntime | null): void {
  runtime = next;
  correlationEpoch++;
  correlatedPrincipalEpoch = null;
  scheduleNotification();
}

/**
 * Called during the provider render so a token change closes dispatch
 * synchronously. Listener publication is queued until after the render stack,
 * keeping the useSyncExternalStore bridge React-safe without weakening the
 * immediate authorization predicate used by in-flight work.
 */
export function updatePrincipalDispatchCorrelation(principalEpoch: number | null): void {
  if (correlatedPrincipalEpoch === principalEpoch) return;
  correlatedPrincipalEpoch = principalEpoch;
  correlationEpoch++;
  scheduleNotification();
}

export function capturePrincipalDispatchAuthorization(): DispatchAuthorizationCapture | null {
  if (!runtime?.canDispatch || correlatedPrincipalEpoch === null) return null;
  return { correlationEpoch, principalEpoch: correlatedPrincipalEpoch };
}

export function isPrincipalDispatchAuthorizationCurrent(
  capture: DispatchAuthorizationCapture,
): boolean {
  return runtime?.canDispatch === true &&
    correlatedPrincipalEpoch === capture.principalEpoch &&
    correlationEpoch === capture.correlationEpoch;
}

export function usePrincipalDispatchAllowed(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const unsubscribeCorrelation = subscribePrincipalDispatchCorrelation(listener);
      const unsubscribe = runtime?.subscribe(listener);
      return () => {
        unsubscribeCorrelation();
        unsubscribe?.();
      };
    },
    () => runtime?.canDispatch === true && correlatedPrincipalEpoch !== null,
    () => false,
  );
}
