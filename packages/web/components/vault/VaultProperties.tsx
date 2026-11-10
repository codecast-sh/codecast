// Frontmatter rendered as a typed property table (read-only for now; editing
// is a later phase). Types render distinctly: booleans as checks, lists as
// chips, tags/aliases specially, [[wiki link]] values as live links, ISO dates
// with a calendar glyph. The engine's YAML-subset parse is the source; the raw
// text stays reachable behind a source toggle for anything it couldn't type.

import { memo, useContext, useState } from "react";
import { Calendar, Check, ChevronRight, Hash, Text as TextIcon, X } from "lucide-react";
import { VaultLinkContext } from "./VaultMarkdown";
import { parseWikiInner } from "../../lib/vault/remarkWikiLink";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/;

function PropValue({ value }: { value: unknown }) {
  const ctx = useContext(VaultLinkContext);

  if (typeof value === "boolean") {
    return value ? (
      <Check className="w-3.5 h-3.5 text-sol-green" />
    ) : (
      <X className="w-3.5 h-3.5 text-sol-text-dim" />
    );
  }
  if (typeof value === "number") {
    return <span className="tabular-nums text-sol-cyan">{value}</span>;
  }
  if (Array.isArray(value)) {
    return (
      <span className="flex flex-wrap gap-1">
        {value.map((v, i) => (
          <span
            key={i}
            className="px-1.5 rounded-full text-[11px] border border-sol-border/40 bg-sol-bg-alt/60 text-sol-text-muted"
          >
            <PropValue value={v} />
          </span>
        ))}
      </span>
    );
  }
  if (typeof value === "string") {
    // A quoted "[[Note]]" property value is a live link.
    const wiki = parseWikiInner(value.trim().startsWith("[[") ? value.trim() : `[[${""}]]`);
    if (value.trim().startsWith("[[") && wiki && ctx) {
      const inner = parseWikiInner(value.trim());
      if (inner) {
        const res = ctx.resolve(inner.target, inner);
        return (
          <a
            href="#"
            className={`wiki-link ${res.path ? "" : "wiki-link-unresolved"}`}
            onClick={(e) => {
              e.preventDefault();
              if (res.path) ctx.navigate(res.path, inner.subpath, inner.subpathType);
              else ctx.createNote?.(inner.target);
            }}
          >
            {inner.alias ?? inner.target}
          </a>
        );
      }
    }
    if (ISO_DATE_RE.test(value)) {
      return (
        <span className="inline-flex items-center gap-1 text-sol-text-secondary">
          <Calendar className="w-3 h-3 opacity-60" />
          {value}
        </span>
      );
    }
    return <span className="text-sol-text-secondary break-words">{value}</span>;
  }
  if (value == null) return <span className="text-sol-text-dim">—</span>;
  return <span className="text-sol-text-muted">{String(value)}</span>;
}

function keyIcon(key: string, value: unknown) {
  if (key === "tags" || key === "tag") return <Hash className="w-3 h-3" />;
  if (typeof value === "string" && ISO_DATE_RE.test(value)) return <Calendar className="w-3 h-3" />;
  return <TextIcon className="w-3 h-3" />;
}

export const VaultProperties = memo(function VaultProperties({
  frontmatter,
  raw,
  onTagClick,
}: {
  frontmatter: Record<string, unknown> | null;
  raw: string;
  onTagClick?: (tag: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [showSource, setShowSource] = useState(false);

  const entries = frontmatter ? Object.entries(frontmatter) : [];
  if (!entries.length && !raw) return null;

  return (
    <div className="mb-4 border border-sol-border/30 rounded" data-vault-properties>
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex-1 flex items-center gap-1 text-left px-2.5 py-1.5 text-[11px] text-sol-text-dim hover:text-sol-text-muted"
        >
          <ChevronRight className={`w-3 h-3 transition-transform ${open ? "rotate-90" : ""}`} />
          Properties
          <span className="tabular-nums">({entries.length})</span>
        </button>
        {open && (
          <button
            type="button"
            onClick={() => setShowSource((v) => !v)}
            className="px-2.5 py-1.5 text-[10px] text-sol-text-dim hover:text-sol-text-muted"
          >
            {showSource ? "table" : "source"}
          </button>
        )}
      </div>
      {open &&
        (showSource || !entries.length ? (
          <pre className="px-3 pb-2 text-[11px] text-sol-text-muted whitespace-pre-wrap font-mono">{raw}</pre>
        ) : (
          <table className="w-full text-[12px] mb-1">
            <tbody>
              {entries.map(([key, value]) => (
                <tr key={key} className="align-top">
                  <td className="pl-3 pr-2 py-[3px] w-[32%] max-w-[180px]">
                    <span className="inline-flex items-center gap-1.5 text-sol-text-dim truncate">
                      {keyIcon(key, value)}
                      {key}
                    </span>
                  </td>
                  <td className="pr-3 py-[3px]">
                    {(key === "tags" || key === "tag") && Array.isArray(value) && onTagClick ? (
                      <span className="flex flex-wrap gap-1">
                        {value.map((t, i) => (
                          <a
                            key={i}
                            href="#"
                            className="vault-tag"
                            onClick={(e) => {
                              e.preventDefault();
                              onTagClick(String(t));
                            }}
                          >
                            #{String(t)}
                          </a>
                        ))}
                      </span>
                    ) : (
                      <PropValue value={value} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </div>
  );
});
