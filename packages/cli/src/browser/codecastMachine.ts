/**
 * A host on codecast's account (provider "codecast", `cast cloud`): the EC2
 * calls the host code makes (describe, start, stop) go to the backend's
 * /cli/cast/env-machine route, since this laptop holds no AWS keys for that
 * account. Synchronous, like the aws CLI calls they stand in for, and the
 * describe answer has describe-instances' shape.
 */

import { spawnSync } from "../proc.js";
import { readAuthConfig, defaultConfigDir } from "../config/readAuthConfig.js";

export const CODECAST_MACHINE_PATH = "/cli/cast/env-machine";

export type CodecastMachineOp = "request" | "describe" | "start" | "stop";

export class CodecastMachineError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "CodecastMachineError"; }
}

export interface CodecastMachineDeps {
  config?: { auth_token?: string; convex_url?: string } | null;
  post?: (url: string, body: string) => { status: number; text: string };
}

function curlPost(url: string, body: string): { status: number; text: string } {
  const r = spawnSync("curl", ["-sS", "--max-time", "90", "-X", "POST", "-H", "Content-Type: application/json", "--data-binary", "@-", "-w", "\n%{http_code}", url],
    { input: body, encoding: "utf-8", timeout: 100_000, stdio: ["pipe", "pipe", "pipe"] });
  if (r.status !== 0) throw new CodecastMachineError(`could not reach codecast (${(r.stderr ?? "").trim().split("\n").pop() || `curl exit ${r.status}`})`);
  const out = r.stdout ?? "";
  const nl = out.lastIndexOf("\n");
  return { status: Number(out.slice(nl + 1)), text: out.slice(0, nl) };
}

/** One call to the route for this laptop's machine. Throws with the backend's reason. */
export function codecastMachine(op: CodecastMachineOp, extra: { ssh_public_key?: string } = {}, deps: CodecastMachineDeps = {}): any {
  const config = deps.config === undefined ? readAuthConfig(defaultConfigDir()) : deps.config;
  if (!config?.auth_token || !config.convex_url) throw new CodecastMachineError("not signed in to codecast: cast login");
  const url = `${config.convex_url.replace(".cloud", ".site").replace(/\/$/, "")}${CODECAST_MACHINE_PATH}`;
  const { status, text } = (deps.post ?? curlPost)(url, JSON.stringify({ api_token: config.auth_token, op, ...extra }));
  let body: any;
  try { body = JSON.parse(text); } catch { throw new CodecastMachineError(`codecast answered ${status} with no JSON`, status); }
  if (status >= 400 || body?.error) throw new CodecastMachineError(body?.error ?? `codecast answered ${status}`, status);
  return body;
}
