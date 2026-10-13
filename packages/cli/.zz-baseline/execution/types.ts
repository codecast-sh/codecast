import type {
  AgentClientId,
  Delivery,
  ExecutionTargetSpec,
  ReadyBinding,
  RuntimeCapability,
  RuntimeConfiguration,
  RuntimeTransport,
  StartedDeliveryPermit,
  StructuredFailure,
} from "@codecast/shared/contracts";

export interface EnsureBindingRequest {
  target: ExecutionTargetSpec;
  configuration: RuntimeConfiguration;
  ownerDeviceId: string;
  /** Exact daemon process incarnation; device identity alone is not a worker fence. */
  daemonBootId: string;
  requiredCapabilities: readonly RuntimeCapability[];
  protocolVersion: number;
  /** Observability only. Both triggers use the same single-flight operation. */
  trigger: "start-session" | "delivery" | "recovery";
}

export interface RuntimeHandle {
  runtimeId: string;
  handle: string;
  actualAgent: AgentClientId;
  transport: RuntimeTransport;
  capabilities: readonly RuntimeCapability[];
}

export interface RuntimeStartRequest extends EnsureBindingRequest {
  operationId: string;
}

export type RuntimeStartResult =
  | { state: "started"; handle: RuntimeHandle }
  | { state: "failed-before-effect"; failure: StructuredFailure }
  | {
      state: "ambiguous";
      failure: StructuredFailure;
      suspectedRuntimeId?: string;
    };

export interface RuntimeAdoptionRequest extends RuntimeStartRequest {
  knownHandle?: RuntimeHandle;
}

export type RuntimeAdoptionResult =
  | { state: "adopted"; handle: RuntimeHandle }
  /** Positive inspection proof that no exact runtime exists; safe to start. */
  | { state: "missing" }
  /** Lookup/inspection uncertainty. Never reinterpret this as missing. */
  | { state: "unknown"; failure: StructuredFailure }
  | {
      state: "conflict";
      failure: StructuredFailure;
      conflictingHandles?: readonly string[];
    };

export type DriverDeliveryResult =
  | { state: "delivered"; externalDeliveryId?: string }
  | { state: "failed-before-effect"; failure: StructuredFailure }
  | { state: "ambiguous"; failure: StructuredFailure };

export interface RuntimeDeliveryRequest {
  binding: ReadyBinding;
  permit: StartedDeliveryPermit;
  delivery: Delivery;
}

export interface DeliverFencedRequest {
  binding: EnsureBindingRequest;
  permit: StartedDeliveryPermit;
  delivery: Delivery;
  timeoutMs?: number;
}

export type DeliveryOutcome = DriverDeliveryResult;

export interface ActiveDeliverySnapshot {
  conversationId: string;
  attemptId: string;
  deliveryId: string;
  runtimeId: string;
  state: "running" | "ambiguous";
}

export type ExecutionCoordinatorErrorCode =
  | "FENCED_CONTROL_PLANE_DORMANT"
  | "INVALID_BINDING_REQUEST"
  | "BINDING_REQUEST_CONFLICT"
  | "RUNTIME_DRIVER_NOT_FOUND"
  | "RUNTIME_CAPABILITY_MISMATCH"
  | "START_BUSY"
  | "START_REJECTED"
  | "START_FAILED_BEFORE_EFFECT"
  | "START_AMBIGUOUS"
  | "STALE_START_COMPLETION"
  | "BINDING_FENCE_MISMATCH"
  | "DELIVERY_SLOT_BUSY"
  | "JOURNAL_CONFLICT";

export class ExecutionCoordinatorError extends Error {
  constructor(
    readonly code: ExecutionCoordinatorErrorCode,
    message: string,
    readonly failure?: StructuredFailure,
  ) {
    super(message);
    this.name = "ExecutionCoordinatorError";
  }
}

export function structuredFailure(
  code: string,
  error: unknown,
  retryable = false,
): StructuredFailure {
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    retryable,
  };
}
