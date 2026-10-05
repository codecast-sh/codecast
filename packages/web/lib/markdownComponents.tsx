import type { Components } from "react-markdown";
import { renderPre } from "./fenceRenderers";
import { EntityAwareCode, EntityAwareLink } from "../components/EntityIdPill";
import { MarkdownImg, ImageRowParagraph } from "../components/tools/MarkdownImages";


// Exported for surfaces that reuse this component set with a few overrides
// (the vault reading view swaps `a`/`img` for wiki-link-aware variants).
export const MD_COMPONENTS: Components = {
          code: EntityAwareCode,
          a: EntityAwareLink,
          pre: ({ node, children, ...props }) => renderPre(node, children, props, { mermaid: true }),
          h1: ({ children }) => (
            <h1 className="text-lg font-bold mt-0 mb-3 text-sol-text">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-base font-semibold mt-4 mb-2 text-sol-text">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-sm font-semibold mt-3 mb-1 text-sol-text-muted">
              {children}
            </h3>
          ),
          ul: ({ children }) => (
            <ul className="my-2 space-y-1 list-disc list-inside">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-2 space-y-1 list-decimal list-inside">{children}</ol>
          ),
          li: ({ children }) => {
            const text = String(children);
            const isCheckbox = text.startsWith('[ ]') || text.startsWith('[x]') || text.startsWith('[X]');
            if (isCheckbox) {
              const checked = text.startsWith('[x]') || text.startsWith('[X]');
              const label = text.slice(3).trim();
              return (
                <li className="flex items-start gap-2 list-none -ml-4">
                  <span className={`mt-0.5 ${checked ? 'text-emerald-400' : 'text-sol-text-dim'}`}>
                    {checked ? '✓' : '○'}
                  </span>
                  <span className={checked ? 'text-sol-text-muted line-through' : ''}>{label}</span>
                </li>
              );
            }
            return <li className="text-sol-text-secondary">{children}</li>;
          },
          strong: ({ children }) => (
            <strong className="font-semibold">{children}</strong>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-sol-border pl-3 my-2 text-sol-text-muted italic">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-3">
              <table className="min-w-full text-xs border-collapse border border-sol-border/50">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-sol-border/50 px-2 py-1 bg-sol-bg-highlight text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-sol-border/50 px-2 py-1">{children}</td>
          ),
          img: MarkdownImg,
          p: ImageRowParagraph,
};

