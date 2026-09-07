import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFile } from "../../atomicWrite.js";
import { localConfigDir } from "../../config/readLocalConfig.js";
import { remoteHome, type RemoteHost } from "../../remote/session-move.js";
import { withMirrorLock } from "./apply.js";
import { assertSafePath } from "./bundle.js";

export interface ProjectRegistration {
  host: string;
  sourceRoot: string;
  targetRoot: string;
}

export const projectRegistrationsFile = () => path.join(localConfigDir(), "browser", "mirror-projects.json");

export function readProjectRegistrations(host?: RemoteHost, file = projectRegistrationsFile()): ProjectRegistration[] {
  if (!fs.existsSync(file)) return [];
  const rows: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(rows) || rows.some((r) => !r || typeof r.host !== "string" || typeof r.sourceRoot !== "string" || typeof r.targetRoot !== "string" || !path.isAbsolute(r.sourceRoot) || !path.posix.isAbsolute(r.targetRoot))) throw new Error("invalid mirror project registrations");
  return host ? rows.filter((r) => r.host === `${host.user}@${host.address}`) : rows;
}

export async function registerProjectContext(host: RemoteHost, sourceRoot: string, targetRoot: string, opts: { file?: string } = {}): Promise<void> {
  const file = opts.file ?? projectRegistrationsFile();
  sourceRoot = await fs.promises.realpath(sourceRoot);
  targetRoot = path.posix.normalize(targetRoot);
  assertSafePath(path.posix.relative(remoteHome(host), targetRoot));
  const key = `${host.user}@${host.address}`;
  await withMirrorLock(path.join(path.dirname(file), "registrations-lock"), async () => {
    const rows = readProjectRegistrations(undefined, file);
    const previous = rows.find((r) => r.host === key && r.targetRoot === targetRoot);
    if (previous?.sourceRoot === sourceRoot) return;
    if (previous) throw new Error(`mirror target ${targetRoot} already belongs to ${previous.sourceRoot}`);
    rows.push({ host: key, sourceRoot, targetRoot });
    rows.sort((a, b) => `${a.host}:${a.targetRoot}`.localeCompare(`${b.host}:${b.targetRoot}`));
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    atomicWriteFile(file, JSON.stringify(rows, null, 2) + "\n", { mode: 0o600 });
  });
}

export function projectPathMappings(project: ProjectRegistration, home: string, hostHome: string): Array<{ from: string; to: string }> {
  const out = [{ from: project.sourceRoot, to: project.targetRoot }];
  let from = path.dirname(project.sourceRoot);
  let to = path.posix.dirname(project.targetRoot);
  while (from !== home && from.startsWith(`${home}/`) && to !== hostHome && to.startsWith(`${hostHome}/`)) {
    for (const name of ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "GEMINI.md", "AGENTS.override.md"]) out.push({ from: path.join(from, name), to: path.posix.join(to, name) });
    from = path.dirname(from);
    to = path.posix.dirname(to);
  }
  return out;
}

export function projectDestination(sourcePath: string, project: ProjectRegistration, home: string, hostHome: string): string {
  const mapping = projectPathMappings(project, home, hostHome).find((m) => sourcePath === m.from || sourcePath.startsWith(`${m.from}/`));
  const dest = mapping ? mapping.to + sourcePath.slice(mapping.from.length) : hostHome + sourcePath.slice(home.length);
  if (!mapping && !sourcePath.startsWith(`${home}/`)) throw new Error(`context source lies outside home: ${sourcePath}`);
  const rel = path.posix.relative(hostHome, dest);
  assertSafePath(rel);
  return rel;
}
