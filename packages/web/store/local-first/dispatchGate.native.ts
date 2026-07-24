import { useSyncExternalStore } from "react";

type DispatchRuntime = {
  readonly canDispatch: boolean;
  subscribe(listener: () => void): () => void;
};

export type DispatchAuthorizationCapture = {
  correlationEpoch: number;
  principalEpoch: number;
};

let authorizedPrincipalEpoch: number | null = null;
let correlationEpoch = 0;
const listeners = new Set<() => void>();
let notificationQueued = false;

function scheduleNotification(): void {
  if (notificationQueued) return;
  notificationQueued = true;
  const notify = () => {
    notificationQueued = false;
    for (const listener of listeners) listener();
  };
  if (typeof queueMicrotask === "function") queueMicrotask(notify);
  else void Promise.resolve().then(notify);
}

export function subscribePrincipalDispatchCorrelation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Native intentionally advertises memory-only capability. Its principal
// boundary supplies server-verified authorization; it does not open v2 durable
// state or parse the web auth package's pinned refresh-token format.
export function registerPrincipalDispatchRuntime(_runtime: DispatchRuntime | null): void {}

export function updatePrincipalDispatchCorrelation(principalEpoch: number | null): void {
  if (authorizedPrincipalEpoch === principalEpoch) return;
  authorizedPrincipalEpoch = principalEpoch;
  correlationEpoch++;
  scheduleNotification();
}

export function capturePrincipalDispatchAuthorization(): DispatchAuthorizationCapture | null {
  return authorizedPrincipalEpoch === null
    ? null
    : { correlationEpoch, principalEpoch: authorizedPrincipalEpoch };
}

export function isPrincipalDispatchAuthorizationCurrent(
  capture: DispatchAuthorizationCapture,
): boolean {
  return capture.correlationEpoch === correlationEpoch &&
    capture.principalEpoch === authorizedPrincipalEpoch;
}

export function usePrincipalDispatchAllowed(): boolean {
  return useSyncExternalStore(
    (listener) => {
      return subscribePrincipalDispatchCorrelation(listener);
    },
    () => authorizedPrincipalEpoch !== null,
    () => false,
  );
}
