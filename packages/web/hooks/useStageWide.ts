"use client";
// A page that takes its tab's width while `on` (store.stageWide): the session
// rail and any sibling pane fold to a thin rail, and come back when the page
// lets go (unmounts, navigates away, `on` turns false) or when the person
// clicks the rail. Once the person takes the split back, the page does not
// insist until it claims again. Ephemeral: the arrangement underneath is never
// rewritten. Outside a tab (a test, a bare route) nothing is claimed.
import { useInboxStore } from "../store/inboxStore";
import { useTabContext } from "../lib/tabParams";
import { useWatchEffect } from "./useWatchEffect";

export function useStageWide(on: boolean): void {
  const tab = useTabContext();
  const tabId = on && tab ? tab.tabId : null;
  const leafId = tab?.leafId ?? null;
  useWatchEffect(() => {
    if (!tabId) return;
    const wide = { tabId, leafId };
    useInboxStore.getState().setStageWide(wide);
    return () => {
      const st = useInboxStore.getState();
      if (st.stageWide && st.stageWide.tabId === wide.tabId && st.stageWide.leafId === wide.leafId) st.setStageWide(null);
    };
  }, [tabId, leafId]);
}
