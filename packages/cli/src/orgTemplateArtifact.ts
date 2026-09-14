import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type OrgTemplate = {
  schemaVersion: 1;
  id: string;
  version: string;
  name: string;
  description: string;
  role: { name: string; handle: string; charter: string; caps: { hands_per_day: number; wakes_per_day: number; tokens_per_day: number } };
  routines: { id: string; title: string; every: string; prompt: string }[];
};
export type TemplateArtifact = { manifest: OrgTemplate; hash: string; root: string; files: Map<string, Buffer>; executable: Set<string> };
const TOKENS = new Set(["instance", "project.ref", "project.name", "project.dir", "template.root", "instance.file"]);
export const templateSlug = (value: string) => /^[a-z][a-z0-9-]{0,47}$/.test(value);

function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !keys.includes(key)) || keys.some((key) => !(key in row))) throw new Error(`${label} has missing or unknown fields`);
  return row;
}
function string(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${label} must be nonempty text`);
  validateTokens(value);
}
export function validateTokens(text: string): void {
  const rest = text.replace(/\{\{([^{}]+)\}\}/g, (_, token: string) => {
    if (!TOKENS.has(token)) throw new Error(`Unknown template token: ${token}`);
    return "";
  });
  if (rest.includes("{{") || rest.includes("}}")) throw new Error("Malformed template token");
}
export function substitute(text: string, values: Record<string, string>): string {
  validateTokens(text);
  return text.replace(/\{\{([^{}]+)\}\}/g, (_, token: string) => {
    if (!(token in values)) throw new Error(`Missing template value: ${token}`);
    return values[token];
  });
}
export function templatePath(value: string): string {
  if (!value || path.isAbsolute(value) || value.includes("\\") || value.includes("\0") || value.split("/").some((p) => !p || p === "." || p === "..") || value.includes("{{")) throw new Error(`Unsafe artifact path: ${value}`);
  return value;
}
export function intervalMs(every: string): number {
  const match = /^([1-9][0-9]*)(m|h|d|w)$/.exec(every);
  if (!match) throw new Error(`Invalid cadence: ${every}`);
  const value = Number(match[1]) * ({ m: 60000, h: 3600000, d: 86400000, w: 604800000 }[match[2]]!);
  if (!Number.isSafeInteger(value) || value > 365 * 86400000) throw new Error(`Cadence exceeds one year: ${every}`);
  return value;
}
export function validateTemplate(value: unknown): OrgTemplate {
  const row = object(value, ["schemaVersion", "id", "version", "name", "description", "role", "routines"], "Template");
  if (row.schemaVersion !== 1) throw new Error("Unsupported template schemaVersion");
  for (const key of ["id", "version", "name", "description"]) string(row[key], key);
  if (!templateSlug(row.id as string) || !/^\d+\.\d+\.\d+$/.test(row.version as string)) throw new Error("Invalid template id or version");
  const role = object(row.role, ["name", "handle", "charter", "caps"], "Role");
  for (const key of ["name", "handle", "charter"]) string(role[key], `role.${key}`);
  templatePath(role.charter as string);
  const caps = object(role.caps, ["hands_per_day", "wakes_per_day", "tokens_per_day"], "Caps");
  for (const cap of Object.values(caps)) if (!Number.isSafeInteger(cap) || (cap as number) < 0) throw new Error("Caps must be nonnegative safe integers");
  if (!Array.isArray(row.routines) || row.routines.length > 50) throw new Error("Routines must be an array of at most 50 entries");
  const ids = new Set<string>();
  for (const raw of row.routines) {
    const routine = object(raw, ["id", "title", "every", "prompt"], "Routine");
    for (const key of ["id", "title", "every", "prompt"]) string(routine[key], `routine.${key}`);
    if (!templateSlug(routine.id as string) || routine.id === "charter" || ids.has(routine.id as string)) throw new Error("Invalid or duplicate routine id");
    ids.add(routine.id as string);
    intervalMs(routine.every as string);
    templatePath(routine.prompt as string);
  }
  return value as OrgTemplate;
}
export function noSymlink(file: string): void {
  const resolved = path.resolve(file);
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symlink refused: ${current}`);
  }
}
export function canonicalDirectory(dir: string): string {
  const canonical = fs.realpathSync(path.resolve(dir));
  if (!fs.statSync(canonical).isDirectory()) throw new Error("Expected an existing directory");
  return canonical;
}
export function readArtifact(root: string): TemplateArtifact {
  root = canonicalDirectory(root);
  const files = new Map<string, Buffer>();
  const executable = new Set<string>();
  let total = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      const rel = path.relative(root, file).split(path.sep).join("/");
      templatePath(rel);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`Symlink refused: ${rel}`);
      if (rel === "INSTANCES.toml" || rel === ".git") continue;
      if (entry.name === ".codecast" || entry.name === ".env" || entry.name.startsWith(".env.") && !entry.name.endsWith(".example")) throw new Error(`Mutable state or credentials are not release artifacts: ${rel}`);
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) {
        if (stat.size > 16 * 1024 * 1024 || files.size >= 10000) throw new Error("Artifact exceeds file limits");
        const bytes = fs.readFileSync(file);
        total += bytes.length;
        if (total > 64 * 1024 * 1024) throw new Error("Artifact exceeds 64 MiB");
        files.set(rel, bytes);
        if (stat.mode & 0o111) executable.add(rel);
      } else throw new Error(`Non-file artifact entry: ${rel}`);
    }
  };
  walk(root);
  const raw = files.get("org-template.json");
  if (!raw) throw new Error("Release is missing org-template.json");
  const manifest = validateTemplate(JSON.parse(raw.toString("utf8")));
  for (const file of [manifest.role.charter, ...manifest.routines.map((r) => r.prompt)]) {
    if (!files.has(file)) throw new Error(`Missing template instruction file: ${file}`);
    validateTokens(files.get(file)!.toString("utf8"));
  }
  const digest = createHash("sha256");
  for (const [name, bytes] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) digest.update(JSON.stringify([name, bytes.length, executable.has(name)]) + "\n").update(bytes);
  return { root, manifest, files, executable, hash: digest.digest("hex") };
}
export function releaseRoot(dir: string, artifact: { id: string; version: string; hash: string }): string {
  if (!templateSlug(artifact.id) || !/^\d+\.\d+\.\d+$/.test(artifact.version) || !/^[a-f0-9]{64}$/.test(artifact.hash)) throw new Error("Invalid release identity");
  return path.join(dir, ".codecast", "org-templates", "releases", artifact.id, `${artifact.version}-${artifact.hash}`);
}
export function checkReleaseVersion(dir: string, artifact: TemplateArtifact): void {
  const root = releaseRoot(dir, { ...artifact.manifest, hash: artifact.hash });
  noSymlink(root);
  const parent = path.dirname(root);
  if (fs.existsSync(parent) && fs.readdirSync(parent).some((name) => name.startsWith(`${artifact.manifest.version}-`) && !name.includes(".tmp-") && name !== path.basename(root))) throw new Error("This release version is already pinned with different content; publish a new version");
}
export function freezeArtifact(dir: string, artifact: TemplateArtifact): string {
  checkReleaseVersion(dir, artifact);
  const root = releaseRoot(dir, { ...artifact.manifest, hash: artifact.hash });
  noSymlink(root);
  if (fs.existsSync(root)) {
    if (readArtifact(root).hash !== artifact.hash) throw new Error("Frozen artifact was modified");
    return root;
  }
  fs.mkdirSync(path.dirname(root), { recursive: true });
  const stage = `${root}.tmp-${randomUUID()}`;
  fs.mkdirSync(stage);
  for (const [name, bytes] of artifact.files) {
    const file = path.join(stage, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, { flag: "wx", mode: artifact.executable.has(name) ? 0o555 : 0o444 });
  }
  if (readArtifact(stage).hash !== artifact.hash) throw new Error("Snapshot verification failed");
  const seal = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) seal(path.join(dir, entry.name));
    fs.chmodSync(dir, 0o555);
  };
  fs.renameSync(stage, root);
  seal(root);
  return root;
}
export function atomicJson(file: string, value: unknown): void {
  noSymlink(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${randomUUID()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  fs.renameSync(tmp, file);
}
