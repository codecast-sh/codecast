// The breadcrumbs row above a code file: where it lives (each folder reveals
// itself in the explorer), then the symbol path at the cursor (class ›
// method), then the file's actions. The symbol path is written by the editor
// itself (lib/code/workspace/symbolPath.ts) into the span bound here, so the
// cursor moving never renders this component.

import { memo, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import { BookmarkToggle } from "../vault/VaultBookmarksPane";
import { RevealButton } from "../vault/VaultFileHeader";
import { useVaultStore } from "../../store/vaultStore";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { bindGroupCrumbs, focusGroup } from "../../lib/code/workspace/groupRegistry";
import { ContextMenu, CtxItem, useContextMenu } from "../ui/context-menu";
import { useCodeGroup } from "./workspace/groupContext";

const reveal = (path: string) => () => useVaultStore.getState().requestReveal(path);

/** A crumb: a quiet press, and a ring when keys reach it. */
const CRUMB = "rounded-sm outline-none transition-colors focus-visible:ring-1 focus-visible:ring-sol-cyan";

/** Width the "…" crumb takes with its chevron, in px. */
const ELLIPSIS_PX = 30;

/** How many leading folders to fold into "…" so the rest fit `avail` px:
 *  none when everything fits, never the nearest folder. */
export function foldedFolders(widths: readonly number[], avail: number): number {
  let total = widths.reduce((a, b) => a + b, 0);
  if (total <= avail) return 0;
  for (let hide = 1; hide < widths.length; hide++) {
    total -= widths[hide - 1];
    if (total + ELLIPSIS_PX <= avail) return hide;
  }
  return Math.max(0, widths.length - 1);
}

/** The folder crumbs. Each crumb's width is measured once per path; after
 *  that a resize (of the row, or of the symbol path beside it) only compares
 *  numbers, and React hears of it only when the fold count changes. Leading
 *  folders fold first, so the nearest one stays readable. */
function FolderCrumbs({ path, navRef, siblingsRef }: { path: string; navRef: React.RefObject<HTMLElement | null>; siblingsRef: React.RefObject<HTMLElement | null> }) {
  const segments = path.split("/").slice(0, -1);
  const [hide, setHide] = useState(0);
  const listRef = useRef<HTMLSpanElement | null>(null);
  const widths = useRef<number[]>([]);
  const menu = useContextMenu<number>();
  // The first render shows every folder; read their widths before paint.
  useLayoutEffect(() => {
    const list = listRef.current;
    const nav = navRef.current;
    if (!list || !nav) return;
    widths.current = [...list.querySelectorAll<HTMLElement>("[data-crumb]")].map((el) => el.offsetWidth);
    const fit = () => {
      // The file name and the symbol path keep their width; folders get the rest.
      const others = [...nav.children].filter((c) => c !== list).reduce((n, c) => n + (c as HTMLElement).offsetWidth, 0);
      const next = foldedFolders(widths.current, nav.clientWidth - others);
      setHide((h) => (h === next ? h : next));
    };
    fit();
    if (typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(fit);
    ro.observe(nav);
    if (siblingsRef.current) ro.observe(siblingsRef.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const prefix = (i: number) => segments.slice(0, i + 1).join("/");
  return (
    <span ref={listRef} className="flex min-w-0 items-center">
      {hide > 0 && (
        <span className="flex shrink-0 items-center">
          <button
            type="button"
            aria-label={`${hide} more folders`}
            aria-haspopup="menu"
            className={`px-0.5 hover:text-sol-text-muted ${CRUMB}`}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              menu.openAt(r.left, r.bottom + 2, hide);
            }}
          >
            …
          </button>
          <ChevronRight className="mx-0.5 h-3 w-3 shrink-0 opacity-60" />
        </span>
      )}
      {segments.map((seg, i) =>
        i < hide ? null : (
          // The nearest folder alone may truncate, when even it has no room.
          <span key={i} data-crumb className={`flex items-center ${i === segments.length - 1 && (hide > 0 || segments.length === 1) ? "min-w-0" : "shrink-0"}`}>
            <button type="button" className={`truncate hover:text-sol-text-muted ${CRUMB}`} title="Reveal in explorer" aria-label={`Reveal ${seg} in file tree`} onClick={reveal(prefix(i))}>
              {seg}
            </button>
            <ChevronRight className="mx-0.5 h-3 w-3 shrink-0 opacity-60" />
          </span>
        ),
      )}
      <ContextMenu state={menu}>
        {(n) => (
          <>
            {segments.slice(0, n).map((seg, i) => (
              <CtxItem key={i} icon={Folder} onSelect={reveal(prefix(i))}>
                <span style={{ paddingLeft: i * 8 }}>{seg}</span>
              </CtxItem>
            ))}
          </>
        )}
      </ContextMenu>
    </span>
  );
}

export const CodeFileBar = memo(function CodeFileBar({ path, actions }: { path: string; actions?: ReactNode }) {
  const canReveal = useVaultStore((s) => !!s.endpoint && !s.isRemote);
  const group = useCodeGroup();
  const navRef = useRef<HTMLElement | null>(null);
  const symbolsRef = useRef<HTMLSpanElement | null>(null);
  useWatchEffect(() => {
    const el = symbolsRef.current;
    if (!el || !group) return;
    return bindGroupCrumbs(group.key, el);
  }, [group?.key]);
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    <div className="flex h-7 shrink-0 items-center gap-3 border-b border-sol-border/30 pl-2.5 pr-2">
      <nav
        ref={navRef}
        aria-label="Path"
        data-crumbs
        className="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap text-meta text-sol-text-dim"
        // Reached by breadcrumbs.focus (Cmd-Shift-.): arrows walk the crumbs,
        // Escape goes back to the editor.
        onKeyDown={(e) => {
          const crumbs = [...e.currentTarget.querySelectorAll<HTMLElement>("button")];
          const i = crumbs.indexOf(e.target as HTMLElement);
          if (i < 0) return;
          if (e.key === "ArrowLeft") crumbs[Math.max(0, i - 1)].focus();
          else if (e.key === "ArrowRight") crumbs[Math.min(crumbs.length - 1, i + 1)].focus();
          else if (e.key === "Home") crumbs[0].focus();
          else if (e.key === "End") crumbs[crumbs.length - 1].focus();
          else if (e.key === "Escape" && group) focusGroup(group.key);
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {/* Keyed by path: a new file measures its own folders. */}
        <FolderCrumbs key={path} path={path} navRef={navRef} siblingsRef={symbolsRef} />
        <button type="button" aria-current="page" className={`shrink-0 text-sol-text-muted hover:text-sol-text ${CRUMB}`} title="Reveal in explorer" aria-label={`Reveal ${name} in file tree`} onClick={reveal(path)}>
          {name}
        </button>
        {/* The symbol path wins over extra folders, up to two fifths of the row. */}
        <span ref={symbolsRef} className="flex max-w-[40%] shrink-0 items-center overflow-hidden" />
      </nav>
      <span className="flex shrink-0 items-center gap-2">
        <BookmarkToggle target={{ kind: "note", path }} label="Bookmark this file" size="h-3.5 w-3.5" />
        {canReveal && (
          <RevealButton path={path} className="text-sol-text-dim transition-colors hover:text-sol-text">
            <FolderOpen className="h-3.5 w-3.5" />
          </RevealButton>
        )}
        {actions}
      </span>
    </div>
  );
});
