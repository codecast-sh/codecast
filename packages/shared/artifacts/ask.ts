// The message an agent session gets when someone asks it to work on an
// artifact. Built once here so the web's Ask agent, a comment's "Send to
// agent" and any later caller send the same brief.
import type { ArtifactElement } from "./core";
import { artifactSpec } from "./registry";
import { artifactView, formatFields, type ArtifactType } from "./spec";

export type AskBriefInput = {
  prompt: string;
  doc: { _id: string; title: string; doc_type: ArtifactType };
  /** Absolute URL of the artifact's page. */
  url: string;
  /** The elements the asker had selected, as the page shows them. */
  selected?: ArtifactElement[];
  /** The comment pin this came from. */
  comment_key?: string;
  /** Work in the draft: the asker sees it before it lands. */
  draft?: boolean;
};

export function askAgentBrief(input: AskBriefInput): string {
  const spec = artifactSpec(input.doc.doc_type);
  const cli = `cast ${spec.cli}`;
  const id = input.doc._id;
  const lines = [
    input.prompt.trim(),
    "",
    `This is about the ${spec.label.toLowerCase()} "${input.doc.title}" (${input.url}).`,
  ];
  if (input.selected?.length) {
    lines.push("", `Selected (${input.selected.length}):`);
    for (const el of input.selected.slice(0, 40)) lines.push(`  ${el.key} ${el.kind} ${formatFields(el)}`);
  }
  lines.push(
    "",
    `Work on it through \`${cli}\`; your edits and cursor show live on the page while you work.`,
    `  ${cli} read ${id}            what is there now`,
    `  ${cli} apply ${id}${input.draft ? " --draft" : ""} < ops.json   write ops: [{"k":key,"put":{"kind":...}}, {"k":key,"set":{...}}, {"k":key,"del":true}]`,
  );
  for (const verb of Object.values(spec.verbs ?? {})) lines.push(`  ${cli} ${verb.usage.replace("<doc>", id)}   ${verb.summary.toLowerCase()}`);
  for (const verb of Object.values(spec.remote ?? {})) lines.push(`  ${cli} ${verb.usage.replace("<doc>", id)}   ${verb.summary.toLowerCase()}`);
  if (input.draft) lines.push("", `Write into the draft (--draft) so it can be reviewed, then leave it: the person saves or discards it.`);
  if (input.comment_key) lines.push("", `This came from comment ${input.comment_key}. Reply there when done: ${cli} comment ${id} ${input.comment_key} "<what you did>"`);
  lines.push("", spec.agentGuide);
  return lines.join("\n");
}

/** The describe() text for a set of elements. */
export function describeElements(type: ArtifactType, title: string, elements: ArtifactElement[]): string {
  return artifactSpec(type).describe(artifactView(type, title, elements));
}
