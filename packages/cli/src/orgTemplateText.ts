// The words of a pinned release filled in for one instance: the receipt's
// values substituted into the charter, a routine's prompt, a title or a setup
// guide. One renderer (the manifest's substitute), read by install, bind,
// instructions and status in orgTemplateRun.ts.
import * as path from "node:path";
import { canonicalDirectory, inputToken, inputTokens, noSymlink, substitute, templateSlug, type OrgTemplate, type TemplateArtifact } from "./orgTemplateArtifact.js";
import type { SetupText } from "./orgTemplateState.js";
import type { TemplateReceipt } from "./orgTemplateRun.js";

export function receiptPath(dir: string, instance: string): string {
  if (!templateSlug(instance)) throw new Error("Instance must be a lowercase slug (at most 48 characters)");
  const file = path.join(canonicalDirectory(dir), ".codecast", "org-templates", `${instance}.json`);
  noSymlink(file);
  return file;
}
function values(receipt: TemplateReceipt, manifest?: Pick<OrgTemplate, "inputs">): Record<string, string> {
  const base: Record<string, string> = { instance: receipt.instance, "project.ref": receipt.project.ref, "project.name": receipt.project.name, "project.dir": receipt.project.dir, "template.root": receipt.template.root, "instance.file": receiptPath(receipt.project.dir, receipt.instance) };
  // Every declared input substitutes: the answer, or the empty string for an
  // unanswered optional one (a required one never reaches here unanswered).
  for (const input of manifest?.inputs ?? []) base[inputToken(input.key)] = receipt.config?.[input.key] ?? "";
  return base;
}
/** Fill a release's text with this instance's values: the one renderer behind the charter, a routine's prompt, a setup guide and every title. */
export const fill = (text: string, receipt: TemplateReceipt, manifest: OrgTemplate) => substitute(text, values(receipt, manifest), inputTokens(manifest));
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
