import * as fs from "fs";
import * as path from "path";
import { defaultConfigDir } from "./config/configDir.js";

export function fleetStoreDir(): string {
  return path.join(defaultConfigDir(), "cc-fleet").normalize("NFC");
}

export function fleetStatePath(): string {
  return path.join(fleetStoreDir(), "state.json");
}

export interface FleetState {
  profile: string;
  via: "token" | "login";
  expires_at: number;
  written_at: number;
  /** A copy of the keychain login (fleetStoreLaunches). */
  keychain?: true;
}

export function readFleetState(): FleetState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(fleetStatePath(), "utf-8"));
    if (typeof parsed?.profile === "string" && typeof parsed?.expires_at === "number") return parsed;
  } catch {}
  return null;
}
