/**
 * The team machine marker as every daemon on the box reads it for its
 * heartbeat (docs/architecture/team-machines.md). A leaf: the daemon imports
 * it, and nothing here reaches the provisioning code.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import { parseTeamHostMarker, type TeamHostMarker } from "@codecast/shared/contracts/teamHosts";
import { SHARED_HOST_MARKER } from "../remote/sharedHostGuard.js";

let markerCache: { mtimeMs: number; value: TeamHostMarker } | null = null;

/** The box's marker, or null off a shared host. Re-read only when the file changes. */
export function readTeamHostMarker(file = SHARED_HOST_MARKER): TeamHostMarker | null {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { markerCache = null; return null; }
  if (markerCache?.mtimeMs === st.mtimeMs) return markerCache.value;
  let value: TeamHostMarker = {};
  try { value = parseTeamHostMarker(fs.readFileSync(file, "utf-8")); } catch { /* unreadable reads as unregistered */ }
  markerCache = { mtimeMs: st.mtimeMs, value };
  return value;
}

/** The heartbeat's team_host field: this daemon runs on a registered team machine, as this Linux user. */
export function teamHostHeartbeat(): { key: string; linux_user: string } | undefined {
  if (process.platform !== "linux") return undefined;
  const key = readTeamHostMarker()?.key;
  if (!key) return undefined;
  return { key, linux_user: os.userInfo().username };
}

