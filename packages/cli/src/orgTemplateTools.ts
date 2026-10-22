// The tools a template ships, on the host (org-templates.md "Tools a template
// ships"): the list a role reads, the stable `run` entry point, and the draft
// loop that edits a tool and releases it as the template's next version.
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "./proc.js";
import { bumpVersion, explainRelease, REQUIRED_BUMP, type ReleaseClass } from "@codecast/shared/contracts/orgTemplateRelease";
import type { OrgInitDeps } from "./orgInit.js";
import { canonicalDirectory, compareVersions, noSymlink, readArtifact, toolSummary, type TemplateArtifact, type TemplateTool } from "./orgTemplateArtifact.js";
import { bindTemplate, boundary, lessonTemplate, publishTemplate, readReceipt, request, verifiedArtifact, type TemplateOptions, type TemplateReceipt } from "./orgTemplateRun.js";
import { quoteTemplateArg, receiptPath, toolUse } from "./orgTemplateText.js";

/** Where an instance's draft lives: a writable copy of its pinned release, beside the receipt. */
export function draftRoot(dir: string, instance: string): string {
  receiptPath(dir, instance); // validates the instance slug and the checkout
  const root = path.join(canonicalDirectory(dir), ".codecast", "org-templates", "drafts", instance);
  noSymlink(root);
  return root;
}
const hasDraft = (dir: string, instance: string) => fs.existsSync(draftRoot(dir, instance));

/** Programs a tool needs that this host's PATH lacks. */
function missingPrograms(needs: string[] = []): string[] {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return needs.filter((name) => !dirs.some((d) => { try { fs.accessSync(path.join(d, name), fs.constants.X_OK); return true; } catch { return false; } }));
}

export type ToolRow = { id: string; kind: TemplateTool["kind"]; summary: string; use: string; missing: string[] };
/** Every tool the instance's pinned release ships, with how to use it and what this host lacks for it. */
export function listTools(instance: string, options: Pick<TemplateOptions, "dir">): { instance: string; release: string; draft: string | null; tools: ToolRow[] } {
  const receipt = readReceipt(options.dir, instance);
  const artifact = verifiedArtifact(receipt);
  return {
    instance,
    release: `${receipt.template.id}@${receipt.template.version}`,
    draft: hasDraft(options.dir, instance) ? draftRoot(options.dir, instance) : null,
    tools: (artifact.manifest.tools ?? []).map((tool) => ({ id: tool.id, kind: tool.kind, summary: toolSummary(tool, artifact.files, artifact.executable), use: toolUse(receipt, tool), missing: missingPrograms(tool.needs) })),
  };
}

/**
 * Run one command tool from the pinned release (or, with `draft`, from the
 * instance's draft), in the project checkout, with the instance named in the
 * environment. Returns the tool's exit code; stdio passes straight through.
 */
export function runTool(instance: string, id: string, args: string[], options: Pick<TemplateOptions, "dir"> & { draft?: boolean }): number {
  const receipt = readReceipt(options.dir, instance);
  const artifact = options.draft ? draftArtifact(receipt) : verifiedArtifact(receipt);
  const root = options.draft ? draftRoot(options.dir, instance) : receipt.template.root;
  const tool = (artifact.manifest.tools ?? []).find((t) => t.id === id);
  if (!tool) throw new Error(`${receipt.template.id}@${artifact.manifest.version} ships no tool ${id}${artifact.manifest.tools?.length ? ` (it ships: ${artifact.manifest.tools.map((t) => t.id).join(", ")})` : ""}`);
  if (tool.kind !== "command") throw new Error(`${id} is a skill: read ${toolUse({ ...receipt, template: { ...receipt.template, root } }, tool)}`);
  toolSummary(tool, artifact.files, artifact.executable);
  const missing = missingPrograms(tool.needs);
  if (missing.length) throw new Error(`${id} needs ${missing.join(", ")} on PATH, and this host has none of it`);
  const file = path.join(root, tool.path);
  const [program, argv] = tool.run ? [tool.run, [file, ...args]] : [file, args];
  const result = spawnSync(program, argv, {
    cwd: receipt.project.dir,
    stdio: "inherit",
    env: { ...process.env, CODECAST_TEMPLATE_ROOT: root, CODECAST_TEMPLATE_INSTANCE: instance, CODECAST_INSTANCE_FILE: receiptPath(receipt.project.dir, instance), CODECAST_PROJECT_DIR: receipt.project.dir },
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** The draft as a release: read and validated exactly as a folder is, and still this template. */
function draftArtifact(receipt: TemplateReceipt): TemplateArtifact {
  const root = draftRoot(receipt.project.dir, receipt.instance);
  if (!fs.existsSync(root)) throw new Error(`No draft for ${receipt.instance}; start one with cast org template edit ${quoteTemplateArg(receipt.instance)}`);
  const artifact = readArtifact(root);
  if (artifact.manifest.id !== receipt.template.id) throw new Error(`The draft's org-template.json names ${artifact.manifest.id}, not ${receipt.template.id}`);
  return artifact;
}

/** Start (or find) the instance's draft: a writable copy of its pinned release. `reset` copies the pin again over it. */
export function editTemplate(instance: string, options: Pick<TemplateOptions, "dir"> & { reset?: boolean }): { draft: string; created: boolean; from: string; next: string } {
  const receipt = readReceipt(options.dir, instance);
  const root = draftRoot(options.dir, instance);
  const from = `${receipt.template.id}@${receipt.template.version}`;
  const next = `Edit files under ${root}. Try a command with cast org template run ${quoteTemplateArg(instance)} <tool> --draft -- <args>; see the change with cast org template diff ${quoteTemplateArg(instance)}; ship it with cast org template release ${quoteTemplateArg(instance)} --changelog "<what changed and why>".`;
  if (fs.existsSync(root) && !options.reset) return { draft: root, created: false, from, next };
  const artifact = verifiedArtifact(receipt);
  fs.rmSync(root, { recursive: true, force: true });
  for (const [name, bytes] of artifact.files) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, { mode: artifact.executable.has(name) ? 0o755 : 0o644 });
  }
  return { draft: root, created: true, from, next };
}

export type DraftDiff = { from: string; added: string[]; changed: string[]; removed: string[]; class: ReleaseClass | null; why: string[]; version: string | null; patch?: string };
const RANK: Record<ReleaseClass, number> = { content: 0, structure: 1, authority: 2 };
/** The draft against the pin: files, the release class, and the smallest version that class allows. */
function compare(receipt: TemplateReceipt, pinned: TemplateArtifact, draft: TemplateArtifact, base: string): DraftDiff {
  const added = [...draft.files.keys()].filter((f) => !pinned.files.has(f) && f !== "org-template.json").sort();
  const removed = [...pinned.files.keys()].filter((f) => !draft.files.has(f)).sort();
  const changed = [...draft.files.keys()].filter((f) => pinned.files.has(f) && (!pinned.files.get(f)!.equals(draft.files.get(f)!) || pinned.executable.has(f) !== draft.executable.has(f))).sort();
  const from = `${receipt.template.id}@${receipt.template.version}`;
  // A version the draft already moved by hand is not a change of its own.
  const manifestOnlyVersion = changed.length === 1 && changed[0] === "org-template.json" && JSON.stringify({ ...draft.manifest, version: pinned.manifest.version }) === JSON.stringify(pinned.manifest);
  if ((!added.length && !removed.length && !changed.length) || (manifestOnlyVersion && !added.length && !removed.length)) return { from, added: [], changed: [], removed: [], class: null, why: [], version: null };
  const explained = explainRelease(pinned.manifest, draft.manifest);
  return { from, added, changed, removed, class: explained.class, why: explained.why, version: bumpVersion(base, REQUIRED_BUMP[explained.class]) };
}
export function diffTemplate(instance: string, options: Pick<TemplateOptions, "dir"> & { patch?: boolean }): DraftDiff {
  const receipt = readReceipt(options.dir, instance);
  const pinned = verifiedArtifact(receipt);
  const diff = compare(receipt, pinned, draftArtifact(receipt), receipt.template.version);
  if (options.patch && diff.class) {
    // diff exits 1 when the trees differ; its output is the patch.
    // diff exits 1 when the trees differ; its output is the patch.
    diff.patch = spawnSync("diff", ["-ruN", receipt.template.root, draftRoot(options.dir, instance)], { encoding: "utf8" }).stdout;
  }
  return diff;
}

export type ReleaseResult = { from: string; to: string; class: ReleaseClass; workspace: string; lesson?: unknown; lesson_error?: string; receipt: TemplateReceipt };
/**
 * Ship the draft: refuse an authority change (a person publishes those),
 * stamp the next version and its changelog into the draft, publish it as a
 * canary release in the instance's own workspace (or Codecast's library with
 * `codecast`), move this instance onto it through the host step, and drop the
 * draft, which is now the pin. A Codecast template edited in another
 * workspace is also filed upstream as a lesson, before the instance leaves it.
 */
export async function releaseDraft(deps: OrgInitDeps, instance: string, options: TemplateOptions & { changelog?: string; codecast?: boolean }): Promise<ReleaseResult> {
  const changelog = options.changelog?.trim();
  if (!changelog) throw new Error("Say what changed and why with --changelog: the role's next session and every other instance read it");
  const receipt = readReceipt(options.dir, instance);
  const pinned = verifiedArtifact(receipt);
  const draft = draftArtifact(receipt);
  const workspace = boundary(receipt);
  // The row a release lands in: Codecast's library, else this workspace's own copy (created by the first release).
  const target = options.codecast ? "codecast" : receipt.workspace.kind === "team" ? `team:${receipt.workspace.id}` : `user:${receipt.workspace.id}`;
  const visible = await request(deps, "/cli/org/template/get", { template_id: receipt.template.id, ...workspace }).catch(() => null);
  const own = visible?.workspace === target ? visible.releases ?? [] : [];
  const newest = own.map((r: any) => r.version as string).filter((v: string) => compareVersions(v, receipt.template.version) > 0).sort(compareVersions).at(-1);
  let diff = compare(receipt, pinned, draft, newest ?? receipt.template.version);
  if (!diff.class) throw new Error(`The draft is the same as ${diff.from}; nothing to release`);
  // Against the copy's own newest release too, when it moved past the pin: the wider class wins.
  const prevOwn = newest ? own.find((r: any) => r.version === newest)?.manifest : null;
  if (prevOwn) {
    const against = explainRelease(prevOwn, draft.manifest);
    if (RANK[against.class] > RANK[diff.class]) diff = { ...diff, class: against.class, why: against.why, version: bumpVersion(newest!, REQUIRED_BUMP[against.class]) };
  }
  if (diff.class === "authority") throw new Error(`This draft changes what the role may do (${diff.why.join("; ")}). A role never widens its own authority: a person publishes it with cast org template publish ${quoteTemplateArg(draftRoot(options.dir, instance))}.`);
  const version = diff.version!;
  const root = draftRoot(options.dir, instance);
  const manifestFile = path.join(root, "org-template.json");
  fs.writeFileSync(manifestFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifestFile, "utf8")), version }, null, 2) + "\n");
  const changelogFile = path.join(root, "CHANGELOG.md");
  const before = fs.existsSync(changelogFile) ? fs.readFileSync(changelogFile, "utf8") : "";
  const title = /^# .*\n+/.exec(before)?.[0] ?? "";
  fs.writeFileSync(changelogFile, `${title}## ${version}\n\n${changelog}\n\n${before.slice(title.length)}`);
  const result: ReleaseResult = { from: diff.from, to: `${receipt.template.id}@${version}`, class: diff.class!, workspace: target, receipt };
  if (visible?.workspace === "codecast" && target !== "codecast" && receipt.instanceId) {
    const files = [...diff.added.map((f) => `added ${f}`), ...diff.changed.map((f) => `changed ${f}`), ...diff.removed.map((f) => `removed ${f}`)];
    try { result.lesson = await lessonTemplate(deps, instance, `Edited on this instance and released as its workspace's own ${receipt.template.id}@${version} (from ${diff.from}, a ${diff.class} change).\n\n${changelog}\n\nFiles: ${files.join(", ")}`, { dir: options.dir }); }
    catch (error) { result.lesson_error = error instanceof Error ? error.message : String(error); }
  }
  const publisher = options.codecast ? { codecast: true } : receipt.workspace.kind === "team" ? { team: receipt.workspace.id } : { personal: true };
  await publishTemplate(deps, root, { ...publisher, status: "canary" });
  result.receipt = await bindTemplate(deps, instance, { ...options, to: version });
  fs.rmSync(root, { recursive: true, force: true });
  return result;
}
