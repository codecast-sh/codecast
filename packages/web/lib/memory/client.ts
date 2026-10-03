// Loopback client for the daemon's /memory routes (cli/src/memory/memoryServer.ts).
// Claude Code memories live on the machine the browser is on, so they are read
// straight off its disk through the same bridge, token and endpoint discovery
// as the Files page.

import type { MemoryProject, MemoryProjectSummary } from "@codecast/shared/memory";
import { loopbackFetch, type VaultEndpoint } from "../vault/client";

/** Carries the status, so a daemon without these routes (404, too old) reads
 *  differently from one that refused (403) or a conflict (409). */
export class MemoryRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: { current?: string | null; mtime?: number | null } = {},
  ) {
    super(message);
  }
}

async function call<T>(ep: VaultEndpoint, path: string, init?: RequestInit): Promise<T> {
  const res = await loopbackFetch(ep, path, init?.body ? { ...init, headers: { "Content-Type": "application/json" } } : init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new MemoryRequestError(body.error ?? `memory: ${res.status}`, res.status, body);
  return body as T;
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

export async function listMemoryProjects(ep: VaultEndpoint): Promise<MemoryProjectSummary[]> {
  return (await call<{ projects: MemoryProjectSummary[] }>(ep, "/memory/projects")).projects;
}

export function readMemoryProject(ep: VaultEndpoint, project: string): Promise<MemoryProject> {
  return call(ep, `/memory/project?${q({ project })}`);
}

/** `baseMtime` null creates (and refuses an existing name); a number is the
 *  version the editor opened, and a newer file on disk answers 409. */
export function writeMemoryFile(ep: VaultEndpoint, project: string, file: string, raw: string, baseMtime: number | null): Promise<{ file: string; mtime: number }> {
  return call(ep, `/memory/file?${q({ project, file })}`, { method: "PUT", body: JSON.stringify({ raw, baseMtime }) });
}

export function trashMemoryFile(ep: VaultEndpoint, project: string, file: string, unindex: boolean): Promise<{ trashed: string; removedLines: number }> {
  return call(ep, "/memory/op", { method: "POST", body: JSON.stringify({ op: "delete", project, file, unindex }) });
}
