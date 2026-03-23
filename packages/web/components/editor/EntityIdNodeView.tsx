import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { EntityIdPill } from "../EntityIdPill";

export function EntityIdNodeView({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper as="span" style={{ display: "inline" }}>
      <EntityIdPill shortId={node.attrs.shortId} />
    </NodeViewWrapper>
  );
}
