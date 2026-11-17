import { awsDescribe } from "./aws.js";
import type { HostProvider } from "./types.js";

export const scalewayMacProvider: HostProvider = {
  images: false,
  clones: false,
  resizes: false,
  macOnly: true,
  display: true,
  systemd: false,
  describe: awsDescribe,
  state: (host) => ({ state: "running", address: host.address }),
  inspect: (host) => ({ state: "running", address: host.address }),
  stop(host) {
    throw new Error(
      `${host.id} is an Apple silicon Mac and cannot be stopped — Apple's licensing has a 24-hour ` +
        `minimum lease, so the only "off" is deleting it. Use the Scaleway console.`,
    );
  },
};
