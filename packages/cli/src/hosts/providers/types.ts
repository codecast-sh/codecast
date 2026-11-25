import type { WakePhase } from "@codecast/shared/contracts";
import type { CloudHost, HostState } from "../../browser/cloudHost.js";

export interface HostFacts {
  state: HostState;
  address?: string;
  startedAt?: number;
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
  readonly display: boolean;
  readonly systemd: boolean;
  describe(host: CloudHost): any;
  describeAsync?(host: CloudHost): Promise<any>;
  forget?(host: CloudHost): string | undefined;
  hourlyUsd?(host: CloudHost, instanceType: string): number | undefined;
  state(host: CloudHost): HostFacts;
  inspect(host: CloudHost): HostInspection;
  stop(host: CloudHost): void;
  start?(host: CloudHost, hooks: HostBootHooks): Promise<HostBoot>;
  /** The machine runs but its OS is hung (EC2's instance status check failing). */
  impaired?(host: CloudHost): boolean;
  /** Restart the OS of a running machine, keeping its disk. */
  reboot?(host: CloudHost): void;
  /** Let `publicKey` log in as the host's user for the next minute, without
   *  holding the key the host was launched with (EC2 Instance Connect). */
  grantKey?(host: CloudHost, publicKey: string): void;
}
