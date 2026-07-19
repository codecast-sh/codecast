import { createContext, useContext } from "react";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import Link from "next/link";
import { FileText, ArrowUpRight } from "lucide-react";
import { MarkdownBlocks } from "./tools/MarkdownRenderer";
import { EntityIdPill } from "./EntityIdPill";

const api = _api as any;

// Embeds may nest (a transcluded doc can itself contain ![[doc:…]]). One level
// of nesting renders; anything deeper degrades to a pill. This also terminates
// self-referencing docs, which would otherwise recurse forever.
const MAX_EMBED_DEPTH = 2;
const EmbedDepth = createContext(0);

/**
 * Full inline transclusion of a doc: `![[doc:<id>]]` on its own line renders
 * the referenced doc's body in place (title header + markdown content), not
 * just a pill. The body comes from `docs.content`, which docSync writes back
 * on every collab snapshot, so an embed stays live as the doc is edited.
 */
export function DocEmbed({ id }: { id: string }) {
  const depth = useContext(EmbedDepth);
  const doc = useQuery(api.docs.webGet, depth < MAX_EMBED_DEPTH ? { id } : "skip");

  if (depth >= MAX_EMBED_DEPTH) return <EntityIdPill type="doc" id={id} />;

  if (doc === undefined) {
    return (
      <span className="not-prose my-3 block rounded-md border border-sol-border bg-sol-bg-alt px-3 py-2 text-xs text-sol-text-dim">
        Loading doc…
      </span>
    );
  }

  // Not found or not accessible (webGet enforces creator-or-team access).
  if (doc === null) {
    return (
      <span className="not-prose my-3 block rounded-md border border-dashed border-sol-border bg-sol-bg-alt px-3 py-2 text-xs text-sol-text-dim">
        Doc unavailable <span className="font-mono">{id}</span>
      </span>
    );
  }

  const title = doc.display_title || doc.title || doc.name || "Untitled";
  const typeLabel = doc.doc_type
    ? doc.doc_type.charAt(0).toUpperCase() + doc.doc_type.slice(1)
    : "Doc";

  // No `not-prose` on the card: the body must inherit the surrounding prose
  // typography (list indentation, margins) — tailwind-typography cannot
  // re-enable prose inside a not-prose ancestor, so exclusion is scoped to the
  // header link only. data-doc-embed / data-doc-embed-body are the contract
  // with lib/quoteUnits: the review system descends into the body so each
  // block of a transcluded doc is quotable on its own.
  return (
    <span data-doc-embed className="my-3 block overflow-hidden rounded-md border border-sol-green/25">
      <Link
        href={`/docs/${doc._id}`}
        className="not-prose flex items-center gap-2 border-b border-sol-green/15 bg-sol-green/[0.06] px-3 py-1.5 no-underline group"
      >
        <FileText className="h-3.5 w-3.5 flex-shrink-0 text-sol-green" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-sol-text">{title}</span>
        <span className="text-[10px] font-medium text-sol-green">{typeLabel}</span>
        <ArrowUpRight className="h-3 w-3 text-sol-text-dim opacity-0 transition-opacity group-hover:opacity-100" />
      </Link>
      {/* MarkdownBlocks' shared component map renders lists as `list-inside`,
          which hangs wrapped bullet lines under the marker instead of the text —
          visibly worse than the `list-outside` prose lists in the surrounding
          message, and these notes have long wrapping bullets. Override to
          `list-outside` (scoped to the embed; the shared doc/file renderer is
          untouched) so an embedded note's bullets match the thread around it. */}
      <span
        data-doc-embed-body
        className="block px-3 py-2 [&_ul]:!list-outside [&_ul]:!pl-5 [&_ol]:!list-outside [&_ol]:!pl-5"
      >
        <EmbedDepth.Provider value={depth + 1}>
          <MarkdownBlocks content={doc.content || ""} />
        </EmbedDepth.Provider>
      </span>
    </span>
  );
}
