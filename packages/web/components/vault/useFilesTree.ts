// The Files page's explorer column: open or closed, a split panel or an
// overlay drawer, and the width a full tab remembers. The column costs ~200px
// that a narrow pane can't spare (Files opened beside a conversation, mostly),
// so a split leaf starts with the tree hidden, as does any pane narrow at first
// layout; a full tab comes back as it was left.

import { useCallback, useRef, useState } from "react";
import { usePanelRef, type PanelSize } from "react-resizable-panels";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { collapsePanelSoon } from "../../lib/vault/collapsePanelSoon";
import { readTreeLayout, writeTreeLayout, type TreeLayout } from "../../store/vaultPrefs";
import type { VaultConnection } from "../../store/vaultTypes";

export function useFilesTree(inSplitPane: boolean, connection: VaultConnection, activePath: string | null) {
  const treePanelRef = usePanelRef();
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Below this width the explorer column and the content can no longer share
  // the pane (their pixel minimums do not fit), so the tree renders as an
  // overlay drawer instead of a split — and starts hidden. Typical case:
  // Files opened beside a conversation.
  // null until the first measure: the split panel only mounts once the pane
  // is known to be wide enough — mounting it into a pane that cannot satisfy
  // its pixel minimums livelocks the panel library.
  const [paneNarrow, setPaneNarrow] = useState<boolean | null>(null);
  // A full tab comes back with the tree as it was left; a split leaf starts closed.
  const savedTreeRef = useRef<TreeLayout | null | undefined>(undefined);
  if (savedTreeRef.current === undefined) savedTreeRef.current = inSplitPane ? null : readTreeLayout();
  const savedTree = savedTreeRef.current;
  const [treeOpen, setTreeOpen] = useState(savedTree?.open ?? false);
  const treeAppliedRef = useRef<boolean | null>(null);
  const treeExpandingRef = useRef(false);
  const firstMeasureRef = useRef(true);
  useWatchEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      const narrow = el.offsetWidth < 640;
      if (firstMeasureRef.current) {
        firstMeasureRef.current = false;
        if (narrow) setTreeOpen(false);
      }
      setPaneNarrow((prev) => {
        if (prev !== narrow) treeAppliedRef.current = null;
        return narrow;
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [connection]);
  // Mirror treeOpen onto the split panel (wide layout only; the overlay
  // renders from state directly).
  useWatchEffect(() => {
    if (paneNarrow !== false) return;
    const ref = treePanelRef.current;
    if (!ref) return;
    if (treeAppliedRef.current === treeOpen) return;
    const firstSync = treeAppliedRef.current === null;
    treeAppliedRef.current = treeOpen;
    if (!treeOpen) {
      // The mounting-commit case is real here: widening a narrow pane flips
      // paneNarrow to false and mounts the tree panel in the same commit this
      // effect runs in, so a direct collapse() throws.
      collapsePanelSoon(treePanelRef, () => treeAppliedRef.current === false);
      return;
    }
    if (firstSync) {
      // The panel mounts expanded at the default share; a saved width wins.
      if (savedTree?.px) ref.resize(`${savedTree.px}px`);
      return;
    }
    treeExpandingRef.current = true;
    ref.resize("20%");
    // 20% of a modest pane can fall under the pixel minimum and the library
    // collapses instead of resizing; ask for the minimum itself on the retry.
    requestAnimationFrame(() => {
      if (treePanelRef.current?.isCollapsed()) treePanelRef.current.resize("180px");
      requestAnimationFrame(() => {
        treeExpandingRef.current = false;
      });
    });
  }, [treeOpen, paneNarrow, connection]);
  // Only a choice made on a wide pane is remembered: the narrow overlay
  // closes itself after every pick.
  useWatchEffect(() => {
    if (savedTree && paneNarrow === false && treeOpen !== savedTree.open) {
      savedTree.open = treeOpen;
      writeTreeLayout({ open: treeOpen });
    }
  }, [treeOpen, paneNarrow]);
  // Picking a file from the overlay closes it — on a narrow pane the reader
  // is the point, and the drawer covers most of it.
  useWatchEffect(() => {
    if (paneNarrow) setTreeOpen(false);
  }, [activePath, paneNarrow]);

  // A drag ended: remember the tree's width.
  const rememberTreeWidth = useCallback(() => {
    const px = treePanelRef.current?.getSize().inPixels;
    if (savedTree && paneNarrow === false && treeOpen && px && px >= 180 && Math.round(px) !== savedTree.px) {
      savedTree.px = Math.round(px);
      writeTreeLayout({ px: savedTree.px });
    }
  }, [savedTree, paneNarrow, treeOpen, treePanelRef]);

  // A drag all the way shut is a close; keep the state honest so the corner
  // button reopens it instead of doing nothing.
  const onTreeResize = useCallback((size: PanelSize) => {
    if (size.asPercentage === 0 && treeAppliedRef.current && !treeExpandingRef.current) {
      treeAppliedRef.current = false;
      setTreeOpen(false);
    }
  }, []);

  return { treePanelRef, rootRef, paneNarrow, treeOpen, setTreeOpen, rememberTreeWidth, onTreeResize };
}
