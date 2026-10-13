import type {
  ReadyBinding,
  StartedDeliveryPermit,
  StructuredFailure,
} from "@codecast/shared/contracts";
import type {
  DeliveryOutcome,
  EnsureBindingRequest,
} from "./types.js";
import { ExecutionCoordinatorError } from "./types.js";

export interface ClaimStartRequest extends EnsureBindingRequest {
  proposedOperationId: string;
}

export type StartClaimResult =
  | { state: "ready"; binding: ReadyBinding }
  | {
      state: "claimed";
      operationId: string;
      /**
       * Cross-boot recovery is explicit proof from the server, never inferred
       * from device identity or a local timeout.
       */
      recovery:
        | { state: "fresh" }
        | {
            state: "recovering";
            previousDaemonBootId: string;
            previousBootTerminated: true;
          };
    }
  | { state: "busy"; operationId?: string; failure: StructuredFailure }
  | { state: "rejected"; failure: StructuredFailure };

/**
 * The future Convex execution-binding module implements this port. The CLI rail
 * deliberately cannot mint epochs, claims, or delivery permits by itself.
 */
export interface ExecutionControlPlane {
  claimStart(request: ClaimStartRequest): Promise<StartClaimResult>;
  publishReady(binding: ReadyBinding): Promise<{ accepted: boolean }>;
  publishStartFailedBeforeEffect(input: {
    request: EnsureBindingRequest;
    operationId: string;
    failure: StructuredFailure;
  }): Promise<void>;
  publishStartAmbiguous(input: {
    request: EnsureBindingRequest;
    operationId: string;
    failure: StructuredFailure;
    suspectedRuntimeId?: string;
  }): Promise<void>;
  completeDelivery(input: {
    permit: StartedDeliveryPermit;
    outcome: Extract<DeliveryOutcome, { state: "delivered" }>;
  }): Promise<void>;
  failDeliveryBeforeEffect(input: {
    permit: StartedDeliveryPermit;
    outcome: Extract<DeliveryOutcome, { state: "failed-before-effect" }>;
  }): Promise<void>;
  markDeliveryAmbiguous(input: {
    permit: StartedDeliveryPermit;
    outcome: Extract<DeliveryOutcome, { state: "ambiguous" }>;
  }): Promise<void>;
}

/**
 * Safe default while the server-side CAS/permit APIs do not exist. Using the
 * additive rail without explicitly supplying an authority fails before any
 * driver is selected or any external effect is attempted.
 */
export class DormantExecutionControlPlane implements ExecutionControlPlane {
  private dormant(): ExecutionCoordinatorError {
    return new ExecutionCoordinatorError(
      "FENCED_CONTROL_PLANE_DORMANT",
      "Fenced execution is dormant until the server binding and delivery-permit APIs are installed",
    );
  }

  claimStart(_request: ClaimStartRequest): Promise<StartClaimResult> {
    return Promise.reject(this.dormant());
  }

  publishReady(_binding: ReadyBinding): Promise<{ accepted: boolean }> {
    return Promise.reject(this.dormant());
  }

  publishStartFailedBeforeEffect(_input: {
    request: EnsureBindingRequest;
    operationId: string;
    failure: StructuredFailure;
  }): Promise<void> {
    return Promise.reject(this.dormant());
  }

  publishStartAmbiguous(_input: {
    request: EnsureBindingRequest;
    operationId: string;
    failure: StructuredFailure;
    suspectedRuntimeId?: string;
  }): Promise<void> {
    return Promise.reject(this.dormant());
  }

  completeDelivery(_input: {
    permit: StartedDeliveryPermit;
    outcome: Extract<DeliveryOutcome, { state: "delivered" }>;
  }): Promise<void> {
    return Promise.reject(this.dormant());
  }

  failDeliveryBeforeEffect(_input: {
    permit: StartedDeliveryPermit;
    outcome: Extract<DeliveryOutcome, { state: "failed-before-effect" }>;
  }): Promise<void> {
    return Promise.reject(this.dormant());
  }

  markDeliveryAmbiguous(_input: {
    permit: StartedDeliveryPermit;
    outcome: Extract<DeliveryOutcome, { state: "ambiguous" }>;
  }): Promise<void> {
    return Promise.reject(this.dormant());
  }
}
