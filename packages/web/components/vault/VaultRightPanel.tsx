// Vault right panel: Backlinks | Outline | Tags, the Obsidian sidebar trio.
// Everything here is a render-time query against the vault index singleton,
// re-run when the index version bumps.

import { memo, useMemo, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { ChevronRight, Hash, Link2, List } from "lucide-react";
import { vaultIndex, useVaultIndexVersion } from "../../lib/vault/indexHost";
import type { TagTreeNode } from "../../lib/vault/vaultIndex";
import { headingSlugs } from "../../lib/vault/parseNote";
import { useVaultStore } from "../../store/vaultStore";
import { noteDisplayName } from "./VaultExplorer";

type PaneTab = "backlinks" | "outline" | "tags";

/** The line a backlink sits on, trimmed for display, with the raw link text
 *  emphasized by the caller via simple splitting. */
function contextLine(content: string | undefined, line: number): string {
  if (!content) return "";
  const text = content.split("\n")[line - 1] ?? "";
  return text.trim().slice(0, 200);
}

/** Files whose prose mentions this note's title (or an alias) as plain text
 *  without linking to it — Obsidian's "unlinked mentions". */
function findUnlinkedMentions(
  path: string,
  linkedSources: Set<string>,
): { source: string; needle: string }[] {
  const note = vaultIndex.note(path);
  if (!note) return [];
  const needles = [note.basename, ...(note.parsed?.aliases ?? [])]
    .filter((n) => n.length >= 3)
    .map((n) => n.toLowerCase());
  if (!needles.length) return [];
  const out: { source: string; needle: string }[] = [];
  for (const p of vaultIndex.paths()) {
    if (p === path || linkedSources.has(p)) continue;
    const text = vaultIndex.note(p)?.parsed?.plainText?.toLowerCase();
    if (!text) continue;
    const hit = needles.find((n) => text.includes(n));
    if (hit) out.push({ source: p, needle: hit });
  }
  return out.sort((a, b) => a.source.localeCompare(b.source));
}

const BacklinksPane = memo(function BacklinksPane({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: (path: string) => void;
}) {
  const version = useVaultIndexVersion();
  const bodies = useVaultStore((s) => s.bodies);
  const backlinks = vaultIndex.backlinks(path);
  const [showUnlinked, setShowUnlinked] = useState(false);

  const grouped = useMemo(() => {
    const bySource = new Map<string, typeof backlinks>();
    for (const bl of backlinks) {
      const arr = bySource.get(bl.source) ?? [];
      arr.push(bl);
      bySource.set(bl.source, arr);
    }
    return [...bySource.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [backlinks]);

  const unlinked = useMemo(
    () => (showUnlinked ? findUnlinkedMentions(path, new Set(backlinks.map((b) => b.source))) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showUnlinked, path, version],
  );

  return (
    <div className="py-1">
      {grouped.length === 0 ? (
        <div className="px-3 py-4 text-xs text-sol-text-dim text-center">
          No backlinks found. Notes that link here with{" "}
          <code className="text-sol-text-muted">[[{noteDisplayName(path.split("/").pop()!)}]]</code>{" "}
          will appear in this list.
        </div>
      ) : (
        <>
          <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-sol-text-dim">
            {backlinks.length} linked mention{backlinks.length === 1 ? "" : "s"}
          </div>
          {grouped.map(([source, links]) => (
            <div key={source} className="mb-1">
              <button
                type="button"
                onClick={() => onNavigate(source)}
                className="w-full text-left px-3 py-1 text-[12px] font-medium text-sol-text hover:bg-sol-bg-alt truncate"
                title={source}
              >
                {noteDisplayName(source.split("/").pop()!)}
                <span className="ml-1.5 text-[10px] text-sol-text-dim tabular-nums">{links.length}</span>
              </button>
              {links.map((bl, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => onNavigate(source)}
                  className="w-full text-left px-3 py-1 text-[11px] leading-4 text-sol-text-muted hover:bg-sol-bg-alt"
                >
                  <span className="line-clamp-2">{contextLine(bodies[source]?.content, bl.link.line)}</span>
                </button>
              ))}
            </div>
          ))}
        </>
      )}

      <button
        type="button"
        onClick={() => setShowUnlinked((v) => !v)}
        className="w-full flex items-center gap-1 px-3 py-1.5 text-[10px] uppercase tracking-wide text-sol-text-dim hover:text-sol-text-muted border-t border-sol-border/20 mt-1"
      >
        <ChevronRight className={`w-3 h-3 transition-transform ${showUnlinked ? "rotate-90" : ""}`} />
        Unlinked mentions
        {showUnlinked && <span className="tabular-nums normal-case">({unlinked.length})</span>}
      </button>
      {showUnlinked &&
        (unlinked.length === 0 ? (
          <div className="px-3 py-3 text-[11px] text-sol-text-dim text-center">
            No unlinked mentions.
          </div>
        ) : (
          unlinked.map(({ source }) => (
            <button
              key={source}
              type="button"
              onClick={() => onNavigate(source)}
              className="w-full text-left px-3 py-1 text-[12px] text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-text truncate"
              title={source}
            >
              {noteDisplayName(source.split("/").pop()!)}
            </button>
          ))
        ))}
    </div>
  );
});

const OutlinePane = memo(function OutlinePane({ path }: { path: string }) {
  const version = useVaultIndexVersion();
  const headings = vaultIndex.note(path)?.parsed?.headings ?? [];
  const [currentSlug, setCurrentSlug] = useState<string | null>(null);

  // Scroll-sync: the section whose heading is the last one above the fold is
  // "current". A rAF-throttled scroll listener beats IntersectionObserver here
  // because we want exactly one active section, not visibility ratios.
  useWatchEffect(() => {
    const container = document.querySelector("[data-vault-note-scroll]");
    if (!container) return;
    const slugs = headingSlugs(headings).map((s) => `vh-${s}`);
    let raf = 0;
    const update = () => {
      raf = 0;
      const cutoff = container.getBoundingClientRect().top + 90;
      let current: string | null = null;
      for (const slug of slugs) {
        const el = document.getElementById(slug);
        if (el && el.getBoundingClientRect().top <= cutoff) current = slug;
      }
      setCurrentSlug(current ?? slugs[0] ?? null);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, version]);

  if (headings.length === 0) {
    return (
      <div className="px-3 py-6 text-xs text-sol-text-dim text-center">
        No headings in this note.
      </div>
    );
  }
  const minLevel = Math.min(...headings.map((h) => h.level));
  const slugList = headingSlugs(headings);
  return (
    <div className="py-1">
      {headings.map((h, i) => {
        const slug = `vh-${slugList[i]}`;
        const isCurrent = slug === currentSlug;
        return (
          <button
            key={i}
            type="button"
            onClick={() => {
              document.getElementById(slug)?.scrollIntoView({ block: "start", behavior: "smooth" });
            }}
            className={`w-full text-left px-3 py-[3px] text-[12px] truncate border-l-2 transition-colors ${
              isCurrent
                ? "border-sol-cyan text-sol-text bg-sol-bg-alt/60"
                : "border-transparent text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt"
            }`}
            style={{ paddingLeft: 10 + (h.level - minLevel) * 14 }}
            title={h.text}
          >
            {h.text}
          </button>
        );
      })}
    </div>
  );
});

function TagNode({
  node,
  depth,
  onSelect,
  selected,
}: {
  node: TagTreeNode;
  depth: number;
  onSelect: (tag: string) => void;
  selected: string | null;
}) {
  const [open, setOpen] = useState(depth < 1);
  const hasChildren = node.children.length > 0;
  return (
    <>
      <div
        className={`flex items-center gap-1 px-3 py-[3px] text-[12px] cursor-pointer hover:bg-sol-bg-alt ${
          selected === node.tag ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted"
        }`}
        style={{ paddingLeft: 12 + depth * 14 }}
        onClick={() => onSelect(node.tag)}
      >
        {hasChildren ? (
          <ChevronRight
            className={`w-3 h-3 flex-shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              setOpen((v) => !v);
            }}
          />
        ) : (
          <span className="w-3 flex-shrink-0" />
        )}
        <Hash className="w-3 h-3 flex-shrink-0 opacity-50" />
        <span className="truncate">{node.name}</span>
        <span className="ml-auto text-[10px] text-sol-text-dim tabular-nums">{node.total}</span>
      </div>
      {open &&
        node.children.map((c) => (
          <TagNode key={c.tag} node={c} depth={depth + 1} onSelect={onSelect} selected={selected} />
        ))}
    </>
  );
}

const TagsPane = memo(function TagsPane({ onNavigate }: { onNavigate: (path: string) => void }) {
  useVaultIndexVersion();
  const selected = useVaultStore((s) => s.selectedTag);
  const setSelected = useVaultStore((s) => s.setSelectedTag);
  const tree = vaultIndex.tagTree();
  const files = selected ? vaultIndex.filesWithTag(selected) : [];

  if (tree.length === 0) {
    return (
      <div className="px-3 py-6 text-xs text-sol-text-dim text-center">
        No tags yet. Add <code className="text-sol-text-muted">#tags</code> inline or in frontmatter.
      </div>
    );
  }
  return (
    <div className="py-1 flex flex-col min-h-0 h-full">
      <div className="flex-1 overflow-y-auto min-h-0">
        {tree.map((n) => (
          <TagNode key={n.tag} node={n} depth={0} onSelect={(t) => setSelected(t === selected ? null : t)} selected={selected} />
        ))}
      </div>
      {selected && (
        <div className="border-t border-sol-border/30 max-h-[45%] overflow-y-auto">
          <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-sol-text-dim sticky top-0 bg-sol-bg">
            #{selected} — {files.length} note{files.length === 1 ? "" : "s"}
          </div>
          {files.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => onNavigate(f)}
              className="w-full text-left px-3 py-1 text-[12px] text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-text truncate"
              title={f}
            >
              {noteDisplayName(f.split("/").pop()!)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

const TABS: { id: PaneTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "backlinks", label: "Backlinks", icon: Link2 },
  { id: "outline", label: "Outline", icon: List },
  { id: "tags", label: "Tags", icon: Hash },
];

export const VaultRightPanel = memo(function VaultRightPanel({
  activePath,
  onNavigate,
}: {
  activePath: string | null;
  onNavigate: (path: string) => void;
}) {
  const tab = useVaultStore((s) => s.rightPanelTab);
  const setTab = useVaultStore((s) => s.setRightPanelTab);
  return (
    <div className="h-full flex flex-col bg-sol-bg-alt/40">
      <div className="flex items-center border-b border-sol-border/30">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            title={label}
            className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-2 text-[11px] transition-colors border-b-2 -mb-px ${
              tab === id
                ? "border-sol-cyan text-sol-text"
                : "border-transparent text-sol-text-dim hover:text-sol-text-muted"
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === "tags" ? (
          <TagsPane onNavigate={onNavigate} />
        ) : activePath ? (
          tab === "backlinks" ? (
            <BacklinksPane path={activePath} onNavigate={onNavigate} />
          ) : (
            <OutlinePane path={activePath} />
          )
        ) : (
          <div className="px-3 py-6 text-xs text-sol-text-dim text-center">Open a note first.</div>
        )}
      </div>
    </div>
  );
});
