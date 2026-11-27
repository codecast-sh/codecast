import { useRef, useState } from "react";
import { usePanelRef } from "react-resizable-panels";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useOnRequest } from "../../hooks/useOnRequest";
import { collapsePanelSoon } from "../../lib/vault/collapsePanelSoon";
import { useVaultStore } from "../../store/vaultStore";

export const SIDE_MIN_PX = 200;

// The side panel (backlinks / outline / tags) is closed by default and
// toggled from a button in the content pane. In a full Files tab the store
// flag is the truth and is remembered; in a split pane (a file link opened
// beside a conversation) both side panels start closed and the side panel's
// state is the pane's own, so reading a linked file never inherits the full
// tab's layout. This effect drives the resizable panel to match. Expanding
// resizes to an explicit width rather than calling expand(): the library's
// restored size can land below the collapse midpoint and clamp straight back to 0.
export function useVaultSidePanel(inSplitPane: boolean, showGraph: boolean, connection: unknown) {
  const storeRightPanelOpen = useVaultStore((s) => s.rightPanelOpen);
  const setStoreRightPanelOpen = useVaultStore((s) => s.setRightPanelOpen);
  const [paneRightPanelOpen, setPaneRightPanelOpen] = useState(false);
  const rightPanelOpen = inSplitPane ? paneRightPanelOpen : storeRightPanelOpen;
  const setRightPanelOpen = inSplitPane ? setPaneRightPanelOpen : setStoreRightPanelOpen;
  useOnRequest(useVaultStore((s) => s.tagPaneRequest), () => setRightPanelOpen(true));
  const sidePanelRef = usePanelRef();
  const sideAppliedRef = useRef<boolean | null>(null);
  useWatchEffect(() => {
    const ref = sidePanelRef.current;
    if (!ref || showGraph) return;
    if (sideAppliedRef.current === rightPanelOpen) return;
    const firstSync = sideAppliedRef.current === null;
    sideAppliedRef.current = rightPanelOpen;
    if (firstSync && ref.isCollapsed() !== rightPanelOpen) return;
    if (!rightPanelOpen) {
      collapsePanelSoon(sidePanelRef, () => sideAppliedRef.current === false);
      return;
    }
    ref.resize("22%");
    // A narrow window: 22% can fall under the panel's pixel minimum and the
    // library silently refuses. Ask for the minimum itself, and if that can't
    // fit either, put the flag back so the button never claims an open panel.
    requestAnimationFrame(() => {
      if (!ref.isCollapsed()) return;
      ref.resize(`${SIDE_MIN_PX}px`);
      requestAnimationFrame(() => {
        if (ref.isCollapsed()) {
          sideAppliedRef.current = false;
          setRightPanelOpen(false);
        }
      });
    });
    // `connection` is a dep because the panel group only mounts once the vault
    // is reachable; before that the ref is empty and the effect must retry.
  }, [rightPanelOpen, showGraph, connection]);
  return { rightPanelOpen, setRightPanelOpen, sidePanelRef, sideAppliedRef };
}
