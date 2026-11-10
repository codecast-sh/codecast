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

export { writeFileAtomic } from "../fsAtomic.js";
