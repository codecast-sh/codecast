#!/usr/bin/env node
// The end of a run: turns off every guest link into the room that is still
// open, so a link made for a test never outlives it. Anyone holding one could
// otherwise knock on the room (often a real session's huddle) until it
// expired, days later. It is the same revoke the invite panel's "turn off"
// does (callGuests.revokeRoomGuestLinks, run against prod through
// packages/convex/run.sh), so a guest still waiting on such a link is told
// the link closed.
//
//   node cleanup.mjs <room>                every open link into the room
//   node cleanup.mjs <room> --since <time> only links made at or after <time>
//                                         (epoch ms or an ISO time: the
//                                         run's start, to leave a link a
//                                         person made by hand alone)
//
// Admitted guests stay in, as they do when a person turns a link off; the
// huddle ending lets them go.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { CONVEX_DIR, die, parseArgs } from "./livekit.mjs";

const { flags, positionals } = parseArgs(process.argv.slice(2));
const room = positionals[0];
if (!room) die("usage: node cleanup.mjs <room> [--since <epoch ms | ISO time>]", 2);
let since;
if (flags.since !== undefined) {
  since = /^\d+$/.test(flags.since) ? Number(flags.since) : Date.parse(flags.since);
  if (!Number.isFinite(since)) die(`--since ${flags.since} is not a time (epoch ms or ISO)`, 2);
}

const args = JSON.stringify({ room_key: room, ...(since !== undefined ? { since } : {}) });
let out;
try {
  out = execFileSync(join(CONVEX_DIR, "run.sh"), ["callGuests:revokeRoomGuestLinks", args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000,
  });
} catch (err) {
  die(`Could not revoke the room's links: ${String(err.stderr || err.message).trim()}`);
}
const revoked = JSON.parse(out.slice(out.indexOf("{"))).revoked;
console.log(revoked.length ? `Turned off ${revoked.length} guest link(s) into ${room}: ${revoked.join(", ")}` : `No open guest links into ${room}.`);
