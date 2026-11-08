// The auth-aware write of ~/.codecast/config.json, shared by the CLI
// (index.ts writeConfig) and the daemon (patchConfig): the managed policy
// overlay stripped, the bearer stored encrypted, and the file published by
// rename. Readers on every hot path (the bridge host reads the site policy on
// each agent-tab landing) must never see a half-written file.

import { atomicWriteFile } from "../atomicWrite.js";
import { storedFromBearer } from "../bearerToken.js";
import { stripManagedPolicy } from "./managedPolicy.js";
import type { Config } from "./types.js";

export function writeStoredConfig(file: string, config: Config): void {
  const toWrite = { ...stripManagedPolicy(config) };
  if (toWrite.auth_token) toWrite.auth_token = storedFromBearer(toWrite.auth_token);
  atomicWriteFile(file, JSON.stringify(toWrite, null, 2), { mode: 0o600 });
}
