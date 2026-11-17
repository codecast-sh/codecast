import type { WakePhase } from "@codecast/shared/contracts";
import type { CloudHost, HostState } from "../../browser/cloudHost.js";

export interface HostFacts {
  state: HostState;
  address?: string;
}

export interface HostInspection extends HostFacts {
  instanceType?: string;
  name?: string;
  platform?: "linux" | "darwin";
  volumeGiB?: number;
}

export interface HostBootHooks {
  onProgress: (msg: string) => void;
  onPhase: (phase: WakePhase) => void;
}

export interface HostBoot {
  address: string;
  wasRunning: boolean;
}

export interface HostProvider {
  readonly images: boolean;
  readonly clones: boolean;
  readonly resizes: boolean;
  readonly macOnly: boolean;
  describe(host: CloudHost): any;
  state(host: CloudHost): HostFacts;
  inspect(host: CloudHost): HostInspection;
  stop(host: CloudHost): void;
  start?(host: CloudHost, hooks: HostBootHooks): Promise<HostBoot>;
}
