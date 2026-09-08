import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "../../atomicWrite.js";
import { readHosts } from "../../browser/cloudHost.js";
import { defaultConfigDir } from "../../config/configDir.js";

import { remoteHome, type RemoteHost } from "../../remote/session-move.js";
import { withMirrorLock } from "./apply.js";
import { assertSafePath } from "./bundle.js";
import { INSTRUCTION_FILE_RE } from "./discovery.js";

export interface ProjectRegistration {
  host: string;
  sourceRoot: string;
  targetRoot: string;
  hostId?: string;
  retired?: boolean;
}

export const projectRegistrationsFile = () => path.join(defaultConfigDir(), "browser", "mirror-projects.json");

function registeredHostId(host: RemoteHost): string | undefined {
  return readHosts().find((r) => r.user === host.user && r.address === host.address)?.id;
}

export function readProjectRegistrations(host?: RemoteHost, file = projectRegistrationsFile(), hostId?: string): ProjectRegistration[] {
  if (!fs.existsSync(file)) return [];
  const rows: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(rows) || rows.some((r) => !r || typeof r.host !== "string" || typeof r.sourceRoot !== "string" || typeof r.targetRoot !== "string" || !path.isAbsolute(r.sourceRoot) || !path.posix.isAbsolute(r.targetRoot))) throw new Error("invalid mirror project registrations");
  const id = host ? hostId ?? registeredHostId(host) : undefined;
  return host ? rows.filter((r) => r.host === `${host.user}@${host.address}` || (id && r.hostId === id)) : rows;
}

export async function registerProjectContext(host: RemoteHost, sourceRoot: string, targetRoot: string, opts: { file?: string; hostId?: string; previousAddress?: string } = {}): Promise<void> {
  const file = opts.file ?? projectRegistrationsFile();
  sourceRoot = await fs.promises.realpath(sourceRoot);
  targetRoot = path.posix.normalize(targetRoot);
  assertSafePath(path.posix.relative(remoteHome(host), targetRoot));
  const key = `${host.user}@${host.address}`;
  const hostId = opts.hostId ?? registeredHostId(host);
  await withMirrorLock(path.join(path.dirname(file), "registrations-lock"), async () => {
    const rows = readProjectRegistrations(undefined, file);
    let migrated = false;
    if (opts.previousAddress && hostId) for (const row of rows) {
      if (!row.hostId && row.host === `${host.user}@${opts.previousAddress}`) { row.hostId = hostId; row.host = key; migrated = true; }
    }
    const previous = rows.find((r) => (r.host === key || (hostId && r.hostId === hostId)) && r.targetRoot === targetRoot);
    if (!migrated && previous?.sourceRoot === sourceRoot && !previous.retired && previous.host === key && previous.hostId === hostId) return;
    if (previous && previous.sourceRoot !== sourceRoot) throw new Error(`mirror target ${targetRoot} already belongs to ${previous.sourceRoot}`);
    if (previous) { previous.retired = false; previous.host = key; if (hostId) previous.hostId = hostId; }
    else rows.push({ host: key, sourceRoot, targetRoot, ...(hostId ? { hostId } : {}) });
    rows.sort((a, b) => `${a.host}:${a.targetRoot}`.localeCompare(`${b.host}:${b.targetRoot}`));
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    atomicWriteFile(file, JSON.stringify(rows, null, 2) + "\n", { mode: 0o600 });
  });
}

export async function unregisterProjectContext(host: RemoteHost, targetRoot: string, opts: { file?: string; hostId?: string } = {}): Promise<void> {
  const file = opts.file ?? projectRegistrationsFile();
  const id = opts.hostId ?? registeredHostId(host);
  await withMirrorLock(path.join(path.dirname(file), "registrations-lock"), async () => {
    const rows = readProjectRegistrations(undefined, file);
    for (const row of rows) if (row.targetRoot === targetRoot && (row.host === `${host.user}@${host.address}` || (id && row.hostId === id))) row.retired = true;
    atomicWriteFile(file, JSON.stringify(rows, null, 2) + "\n", { mode: 0o600 });
  });
}

export function projectPathMappings(project: ProjectRegistration, home: string, hostHome: string, contextPaths: readonly string[] = []): Array<{ from: string; to: string }> {
  const out = [{ from: project.sourceRoot, to: project.targetRoot }];
  let from = path.dirname(project.sourceRoot);
  let to = path.posix.dirname(project.targetRoot);
  while (from !== home && from.startsWith(`${home}/`) && to !== hostHome && to.startsWith(`${hostHome}/`)) {
    const names = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.local.md", "GEMINI.md", "GROK.md", "OPENCODE.md", "AGENTS.override.md", ".mcp.json"]);
    for (const file of contextPaths) if (path.dirname(file) === from && INSTRUCTION_FILE_RE.test(path.basename(file))) names.add(path.basename(file));
    for (const name of names) out.push({ from: path.join(from, name), to: path.posix.join(to, name) });
    from = path.dirname(from);
    to = path.posix.dirname(to);
  }
  return out;
}

export function projectDestination(sourcePath: string, project: ProjectRegistration, home: string, hostHome: string): string {
  const mapping = projectPathMappings(project, home, hostHome, [sourcePath]).find((m) => sourcePath === m.from || sourcePath.startsWith(`${m.from}/`));
  const dest = mapping ? mapping.to + sourcePath.slice(mapping.from.length) : hostHome + sourcePath.slice(home.length);
  if (!mapping && !sourcePath.startsWith(`${home}/`)) throw new Error(`context source lies outside home: ${sourcePath}`);
  const rel = path.posix.relative(hostHome, dest);
  assertSafePath(rel);
  return rel;
}
