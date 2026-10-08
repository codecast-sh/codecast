import { permissionsSig } from "@codecast/shared/contracts/mods";
import type { ModRow } from "./host";

/**
 * Whether a mod is on for the viewer: their own by its switch, a teammate's
 * when the author left it on and the viewer installed it at its current grants
 * (`<id>:<permissionsSig>`), so widened grants stop it until they review them.
 */
export function modIsActive(r: ModRow, installed: readonly string[]): boolean {
  return r.enabled && (r.is_mine !== false || installed.includes(`${r._id}:${permissionsSig(r.manifest)}`));
}
