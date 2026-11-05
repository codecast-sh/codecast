// .codecast/deploy.toml: a repository's deploy targets (docs/architecture/deploys.md DP10).
// They live in their own file so workspace.toml keeps the schema every released CLI
// reads; an older CLI never opens this one.

import * as fs from "node:fs";
import * as path from "node:path";
import { parseDeployTargetEntries, type DeployTarget, type ShipStepRef } from "@codecast/shared/contracts/deployTargets";

export const DEPLOY_TARGETS_REL_PATH = ".codecast/deploy.toml";

/** The checkout's declared targets; none when the file is absent. Throws DeployTargetError (or a TOML error) naming the file. */
export function readDeployTargets(root: string, ship: readonly ShipStepRef[]): DeployTarget[] {
  return readDeployTargetEntries(root, ship).map((e) => e.target);
}

/** The same, each with the [[ship.deploy]] step that sends it at a ship. */
export function readDeployTargetEntries(root: string, ship: readonly ShipStepRef[]): Array<{ target: DeployTarget; ship_step?: string }> {
  const file = path.join(root, DEPLOY_TARGETS_REL_PATH);
  if (!fs.existsSync(file)) return [];
  return parseDeployTargetsText(fs.readFileSync(file, "utf-8"), ship, file);
}

export function parseDeployTargetsText(text: string, ship: readonly ShipStepRef[], file = DEPLOY_TARGETS_REL_PATH): Array<{ target: DeployTarget; ship_step?: string }> {
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(text);
  } catch (err) {
    throw new Error(`${file}: invalid TOML: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return parseDeployTargetEntries(raw, ship);
  } catch (err) {
    throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
