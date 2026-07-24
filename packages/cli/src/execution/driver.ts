import type {
  AgentClientId,
  ReadyBinding,
  RuntimeCapability,
  RuntimeTransport,
} from "@codecast/shared/contracts";
import {
  deliveryMatchesPermit,
  readyBindingMatchesPermit,
} from "@codecast/shared/contracts";
import type {
  DriverDeliveryResult,
  RuntimeAdoptionRequest,
  RuntimeAdoptionResult,
  RuntimeDeliveryRequest,
  RuntimeStartRequest,
  RuntimeStartResult,
} from "./types.js";
import { ExecutionCoordinatorError } from "./types.js";

export interface RuntimeDriver {
  readonly id: string;
  readonly transport: RuntimeTransport;
  readonly supportedAgents: ReadonlySet<AgentClientId>;
  readonly capabilities: readonly RuntimeCapability[];

  start(request: RuntimeStartRequest): Promise<RuntimeStartResult>;
  /**
   * `missing` is a proof, not a convenience fallback: the driver inspected its
   * complete managed namespace and found no exact runtime. Any lookup failure or
   * incomplete/uncertain inspection must return `unknown` and block startup.
   */
  adopt(request: RuntimeAdoptionRequest): Promise<RuntimeAdoptionResult>;
  deliver(request: RuntimeDeliveryRequest): Promise<DriverDeliveryResult>;
  stop(binding: ReadyBinding): Promise<void>;
  /** Make a stale/ambiguous runtime unreachable by this driver's delivery path. */
  quarantine(binding: ReadyBinding, reason: string): Promise<void>;
}

function driverKey(agent: AgentClientId, transport: RuntimeTransport): string {
  return `${agent}\u0000${transport}`;
}

/** Exact `(requested agent, transport)` lookup. There is intentionally no fallback. */
export class RuntimeDriverRegistry {
  private readonly drivers = new Map<string, RuntimeDriver>();

  constructor(drivers: readonly RuntimeDriver[] = []) {
    for (const driver of drivers) this.register(driver);
  }

  register(driver: RuntimeDriver): void {
    if (driver.supportedAgents.size === 0) {
      throw new TypeError(`Runtime driver ${driver.id} supports no agents`);
    }
    for (const agent of driver.supportedAgents) {
      const key = driverKey(agent, driver.transport);
      if (this.drivers.has(key)) {
        throw new TypeError(`Duplicate runtime driver for ${agent}/${driver.transport}`);
      }
      this.drivers.set(key, driver);
    }
  }

  resolve(agent: AgentClientId, transport: RuntimeTransport): RuntimeDriver {
    const driver = this.drivers.get(driverKey(agent, transport));
    if (!driver) {
      throw new ExecutionCoordinatorError(
        "RUNTIME_DRIVER_NOT_FOUND",
        `No fenced runtime driver is registered for ${agent}/${transport}`,
      );
    }
    return driver;
  }
}

export function assertRuntimeDeliveryFence(request: RuntimeDeliveryRequest): void {
  if (!readyBindingMatchesPermit(request.binding, request.permit)) {
    throw new ExecutionCoordinatorError(
      "BINDING_FENCE_MISMATCH",
      "Ready binding does not match the started delivery permit",
    );
  }
  if (!deliveryMatchesPermit(request.delivery, request.permit)) {
    throw new ExecutionCoordinatorError(
      "BINDING_FENCE_MISMATCH",
      "Delivery identity does not match the started delivery permit",
    );
  }
}
