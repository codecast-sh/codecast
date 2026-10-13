/**
 * Where the workspace trust records live. A leaf module: the host login push
 * (remote/agentAuth.ts) names these files and must not load the gate itself.
 */

import * as path from "node:path";
import { defaultConfigDir } from "../config/configDir.js";

export const TRUST_STORE_FILE = "workspace-trust.json";

/** Absolute path of the trust store. Outside every repo, on purpose. */
export function trustStorePath(): string {
  return path.join(defaultConfigDir(), TRUST_STORE_FILE);
}

/**
 * Approvals the person gave on their primary machine, pushed to a cloud host
 * alongside their logins (remote/agentAuth.ts). A host checkout sits at
 * another path, so they match by what was approved (the same target id and
 * digest) and not by repo: the person already read exactly this code.
 */
export function primaryTrustPath(): string {
  return path.join(defaultConfigDir(), "workspace-trust.primary.json");
}
