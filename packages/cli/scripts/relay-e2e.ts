#!/usr/bin/env bun
/**
 * End-to-end check of the host -> laptop relay, run from the laptop.
 *
 * Files the same `cloud.requestBrowserSync` a cloud host's `cast browser sync`
 * files (the host's device id, a CDP port on the host), names THIS laptop as
 * the carrier, and waits for the laptop daemon's answer on the command row.
 * The answer only arrives if the whole rail works: Convex queues the command,
 * the daemon's subscription picks it up, resolveCarryHost finds an address,
 * and the carry reaches the host over SSH.
 *
 *   bun scripts/relay-e2e.ts --host-device <id> --cdp-port <port> [--origin https://example.com] [--wait 120]
 *
 * example.com is the default origin because it holds no cookies: the run
 * proves the path without moving a login.
 */

import { convexClient } from "../src/remote/convexClient.js";
import { awaitCommandOutcome } from "../src/cloud/askLaptop.js";
import { deviceId } from "../src/remote/device.js";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (!v) { console.error(`missing --${name}`); process.exit(2); }
  return v;
}

const hostDevice = arg("host-device");
const cdpPort = Number(arg("cdp-port"));
const origin = arg("origin", "https://example.com");
const waitS = Number(arg("wait", "120"));

const { client, token, api } = await convexClient();
const started = Date.now();
const asked = await client.mutation(api.cloud.requestBrowserSync, {
  api_token: token, device_id: hostDevice, cdp_port: cdpPort, origin, via_device_id: deviceId(),
});
console.log(`asked ${asked.label ?? asked.device_id} (command ${asked.command_id})`);
const row = await awaitCommandOutcome(
  (id) => client.query(api.cloud.commandOutcome, { api_token: token, command_id: id }),
  asked.command_id, started + waitS * 1000, { pollMs: 500 },
);
const took = ((Date.now() - started) / 1000).toFixed(1);
if (!row) { console.log(`NO ANSWER after ${took}s`); process.exit(1); }
if (row.error) { console.log(`ERROR after ${took}s: ${row.error}`); process.exit(1); }
console.log(`OK after ${took}s: ${row.result}`);
