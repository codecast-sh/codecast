"use client";
// The Change slot of a map panel (docs/architecture/line-map.md LX3, LX6): a
// composer that asks an agent for a change to this node of the line. It files
// a cause in the project with category `line`, its subject the node
// (`line:station:prove`, `line:finder:agentwatch`), and the line runs it to a
// card like any change.
//
// This is the slot's placeholder, which the LX6 work (ct-57576) replaces with
// the composer. It says what the composer will do and the command that does
// it today, so the panel never shows an empty section.
import type { MapNode } from "../../../lib/line/lineMap";

/** The subject a line cause names its node by (LX6). */
export function lineSubject(node: Pick<MapNode, "id" | "kind" | "source">): string {
  if (node.kind === "source" && node.source) return `line:finder:${node.source.toLowerCase()}`;
  if (node.kind === "station" || node.kind === "decide" || node.kind === "ship" || node.kind === "watch") return `line:station:${node.id}`;
  return `line:${node.id}`;
}

export function ChangeComposer({ node, projectId }: { node: Pick<MapNode, "id" | "kind" | "label" | "source">; projectId: string | null }) {
  const subject = lineSubject(node);
  return (
    <div className="flex flex-col gap-2" data-change-composer={subject} data-project={projectId ?? undefined}>
      <p className="lmap-empty">
        Ask for a change to {node.label} in your own words. The line files it as a cause against itself and runs it like any change: it proves the problem, edits the line in the repo and brings you a card.
      </p>
      <code className="text-[11px] text-sol-text-muted break-all">cast signal add --source person --kind request --fingerprint {subject} --subject {subject} --title "What should change"</code>
    </div>
  );
}
