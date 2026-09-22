import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { EntityIdPill } from "../EntityIdPill";
import { ClaudeArtifactPill, PublishedPagePill } from "../PublishedPageEmbed";
import { parseClaudeArtifactUrl, parseEntityUrl, parsePublishedPageUrl } from "../../lib/entityLinks";

/**
 * Renders an entityRef atom with the SAME components the read view uses
 * (EntityAwareLink → EntityIdPill / PublishedPagePill), so an object reference
 * looks identical whether the doc is being read or edited.
 */
export function EntityRefNodeView({ node }: NodeViewProps) {
  const { form, href, label, refId } = node.attrs;

  let inner: React.ReactNode;
  if (form === "mention") {
    inner = (
      <EntityIdPill
        shortId={refId}
        fallback={<span className="editor-mention mention-doc">@{label || refId}</span>}
      />
    );
  } else {
    const entity = parseEntityUrl(href);
    const page = entity ? null : parsePublishedPageUrl(href);
    const claude = entity || page ? null : parseClaudeArtifactUrl(href);
    const text = label && label !== href ? label : undefined;
    inner = entity ? (
      <EntityIdPill type={entity.type} id={entity.id} />
    ) : page ? (
      <PublishedPagePill slug={page.slug} href={href} label={text} />
    ) : claude ? (
      <ClaudeArtifactPill id={claude.id} href={href} label={text} />
    ) : (
      // Shouldn't happen (only pillable hrefs are converted), but degrade to
      // the ordinary editor link rather than dropping the reference.
      <a className="editor-link" href={href} target="_blank" rel="noopener noreferrer">
        {label || href}
      </a>
    );
  }

  return (
    <NodeViewWrapper as="span" style={{ display: "inline" }}>
      {inner}
    </NodeViewWrapper>
  );
}
