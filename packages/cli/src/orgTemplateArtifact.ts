import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { inputTokens, manifestFiles, templatePath, templateSlug, validateTemplate, validateTokens, type OrgTemplate } from "@codecast/shared/contracts/orgTemplateManifest";

// The manifest's types, validator and tokens live in shared, read by the CLI,
// the server and the web alike; this module is the release folder on disk.
export * from "@codecast/shared/contracts/orgTemplateManifest";
export type TemplateArtifact = { manifest: OrgTemplate; hash: string; root: string; files: Map<string, Buffer>; executable: Set<string> };
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
  const inputs = inputTokens(manifest);
  for (const file of manifestFiles(manifest)) {
    if (!files.has(file)) throw new Error(`Missing template instruction file: ${file}`);
    validateTokens(files.get(file)!.toString("utf8"), inputs);
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
