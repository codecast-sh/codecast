// Where a Claude SDK host keeps its socket, state, spec and log: one set of
// files per Claude session id under ~/.codecast/claude-sdk. The daemon finds
// every live host after a restart by listing the state files.

import * as fs from "node:fs";
import * as path from "node:path";
import { defaultConfigDir } from "../config/configDir.js";

const SESSION_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export function sdkHostDir(root: string = process.env.CODECAST_CLAUDE_SDK_DIR || path.join(defaultConfigDir(), "claude-sdk")): string {
  return root;
}

export interface SdkHostPaths {
  socket: string;
  state: string;
  spec: string;
  log: string;
  plist: string;
  label: string;
}

export function sdkHostPaths(sessionId: string, dir: string = sdkHostDir()): SdkHostPaths {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error(`not a Claude session id: ${sessionId}`);
  return {
    socket: path.join(dir, `${sessionId}.sock`),
    state: path.join(dir, `${sessionId}.json`),
    spec: path.join(dir, `${sessionId}.spec.json`),
    log: path.join(dir, `${sessionId}.log`),
    plist: path.join(dir, `${sessionId}.plist`),
    label: `sh.codecast.claude-sdk.${sessionId}`,
  };
}

/** Session ids with a state file: every host that ran here and did not clean up. */
export function listSdkHostSessions(dir: string = sdkHostDir()): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith(".json") && !n.endsWith(".spec.json")).map((n) => n.slice(0, -5)).filter((id) => SESSION_ID_RE.test(id));
}

/** Atomic write: a reader never sees half a file. */
export function writeFileAtomic(file: string, text: string, mode = 0o600): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}
