import { useSyncExternalStore } from "react";

type DispatchRuntime = {
  readonly canDispatch: boolean;
  subscribe(listener: () => void): () => void;
};

/**
 * Native twin of dispatchGate: dispatch is wired unconditionally, no principal
 * correlation gates it. The API shape is preserved for shared callers.
 */
export type DispatchAuthorizationCapture = {
  correlationEpoch: number;
  principalEpoch: number;
};

const ALWAYS_AUTHORIZED: DispatchAuthorizationCapture = Object.freeze({
  correlationEpoch: 1,
  principalEpoch: 1,
});

export function subscribePrincipalDispatchCorrelation(_listener: () => void): () => void {
  return () => {};
}

export function registerPrincipalDispatchRuntime(_runtime: DispatchRuntime | null): void {}

export function updatePrincipalDispatchCorrelation(_principalEpoch: number | null): void {}

export function capturePrincipalDispatchAuthorization(): DispatchAuthorizationCapture | null {
  return ALWAYS_AUTHORIZED;
}

export function isPrincipalDispatchAuthorizationCurrent(
  _capture: DispatchAuthorizationCapture,
): boolean {
  return true;
}

export function getPrincipalDispatchCorrelationEpoch(): number | null {
  return ALWAYS_AUTHORIZED.correlationEpoch;
}

export function usePrincipalDispatchCorrelationEpoch(): number | null {
  return useSyncExternalStore(
    subscribePrincipalDispatchCorrelation,
    getPrincipalDispatchCorrelationEpoch,
    getPrincipalDispatchCorrelationEpoch,
  );
}

export function usePrincipalDispatchAllowed(): boolean {
  return true;
}
