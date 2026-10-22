// The words of a pinned release filled in for one instance: the receipt's
// values substituted into the charter, a routine's prompt, a title or a setup
// guide. One renderer (the manifest's substitute), read by install, bind,
// instructions and status in orgTemplateRun.ts.
import * as path from "node:path";
import { canonicalDirectory, inputToken, quoteTemplateArg, inputTokens, noSymlink, substitute, templateSlug, toolIds, toolSummary, toolToken, type OrgTemplate, type TemplateArtifact, type TemplateTool } from "./orgTemplateArtifact.js";
import type { SetupText } from "./orgTemplateState.js";
import type { TemplateReceipt } from "./orgTemplateRun.js";

export function receiptPath(dir: string, instance: string): string {
  if (!templateSlug(instance)) throw new Error("Instance must be a lowercase slug (at most 48 characters)");
  const file = path.join(canonicalDirectory(dir), ".codecast", "org-templates", `${instance}.json`);
  noSymlink(file);
  return file;
}
/** One shell argument, single quoted: how every command a template prints names its values. */
export { quoteTemplateArg };
/** How the role uses one tool: a command through `cast org template run` (the pin it runs from follows the instance), a skill at its SKILL.md in the pinned release. */
export function toolUse(receipt: Pick<TemplateReceipt, "instance" | "project" | "template">, tool: TemplateTool): string {
  return tool.kind === "skill" ? path.join(receipt.template.root, tool.path, "SKILL.md") : `cast org template run ${quoteTemplateArg(receipt.instance)} ${quoteTemplateArg(tool.id)} --dir ${quoteTemplateArg(receipt.project.dir)} --`;
}
function values(receipt: TemplateReceipt, manifest?: Pick<OrgTemplate, "inputs" | "tools">): Record<string, string> {
  const base: Record<string, string> = { instance: receipt.instance, "project.ref": receipt.project.ref, "project.name": receipt.project.name, "project.dir": receipt.project.dir, "template.root": receipt.template.root, "instance.file": receiptPath(receipt.project.dir, receipt.instance) };
  // Every declared input substitutes: the answer, or the empty string for an
  // unanswered optional one (a required one never reaches here unanswered).
  for (const input of manifest?.inputs ?? []) base[inputToken(input.key)] = receipt.config?.[input.key] ?? "";
  for (const tool of manifest?.tools ?? []) base[toolToken(tool.id)] = toolUse(receipt, tool);
  return base;
}
/** Fill a release's text with this instance's values: the one renderer behind the charter, a routine's prompt, a setup guide and every title. */
export const fill = (text: string, receipt: TemplateReceipt, manifest: OrgTemplate) => substitute(text, values(receipt, manifest), inputTokens(manifest), toolIds(manifest));
/** Guides the instance row carries for the role page stay well under a document's size; one past the budget is read with `instructions setup:<id>`. */
const SETUP_GUIDE_BUDGET = 256 * 1024;
type SetupItem = NonNullable<OrgTemplate["setup"]>[number];
/** One setup item's words for this instance (H5): its title and price, and its how-to guide from the pinned release. */
export function setupWords(artifact: TemplateArtifact, receipt: TemplateReceipt, item: SetupItem, withGuide: boolean): SetupText[string] {
  return {
    title: fill(item.title, receipt, artifact.manifest),
    ...(item.price ? { price: fill(item.price, receipt, artifact.manifest) } : {}),
    ...(withGuide && item.how ? { guide: fill(artifact.files.get(item.how)!.toString("utf8"), receipt, artifact.manifest) } : {}),
  };
}
/** Every setup item's words: what the instance row carries for the role page (with guides) and what the terminal lists (without). */
export function setupText(artifact: TemplateArtifact, receipt: TemplateReceipt, withGuides: boolean): SetupText {
  let budget = SETUP_GUIDE_BUDGET;
  return Object.fromEntries((artifact.manifest.setup ?? []).map((item) => {
    const { guide, ...words } = setupWords(artifact, receipt, item, withGuides);
    return [item.id, guide !== undefined && (budget -= guide.length) >= 0 ? { ...words, guide } : words];
  }));
}
/**
 * The tools a release ships, as the block every `instructions` answer ends
 * its header with: each id, its one line, and how to use it. Empty when the
 * template declares none.
 */
export function toolsBlock(artifact: TemplateArtifact, receipt: Pick<TemplateReceipt, "instance" | "project" | "template">): string {
  const tools = artifact.manifest.tools ?? [];
  if (!tools.length) return "";
  const lines = tools.map((tool) => `- ${tool.id} (${tool.kind}): ${toolSummary(tool, artifact.files, artifact.executable)}\n  ${tool.kind === "skill" ? "Read" : "Run"}: ${toolUse(receipt, tool)}${tool.kind === "command" ? " <args>" : ""}`);
  return `Tools this template ships. Change one in a draft: cast org template edit ${quoteTemplateArg(receipt.instance)} --dir ${quoteTemplateArg(receipt.project.dir)}, then diff and release.\n${lines.join("\n")}`;
}
