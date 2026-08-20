"use client";
import { lazy, memo, Suspense, useCallback, useMemo } from "react";
import { FolderTree } from "lucide-react";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { filesPaneHref } from "../store/workspace";
import { TabParamsCtx } from "../lib/tabParams";
import { tabNavigate } from "../src/compat/tabRouting";
import { SlotPanel } from "./workspace/Slot";
import { ErrorBoundary } from "./ErrorBoundary";

const VaultPage = lazy(() => import("../app/vault/page"));

// The Files surface beside a conversation: the whole /files page hosted in the
// secondary slot. The page is URL-driven, and here its "URL" is the pane's
// ref — TabParamsCtx.navigate rewrites the ref instead of moving the tab, so
// the page needs no knowledge of where it is mounted.
//
//   ⤢  promote: the tab navigates to the same URL, the pane closes
//   ✕  close — the conversation reclaims the stage
export const StageFilesPane = memo(function StageFilesPane() {
  const s = useTrackedStore([(st) => filesPaneHref(st.workspace)]);
  const ref = filesPaneHref(s.workspace) ?? "/files";

  const ctx = useMemo(() => {
    const [pathAndHash, query] = ref.split("?");
    return {
      tabId: "files-pane",
      pathname: pathAndHash.split("#")[0],
      params: {},
      searchParams: new URLSearchParams(query ?? ""),
      isActive: true,
      navigate: (path: string) => {
        useInboxStore.getState().wsShow("secondary", { kind: "files", ref: path }, { presentation: "split" });
      },
    };
  }, [ref]);

  const handleClose = useCallback(() => {
    useInboxStore.getState().wsHide("secondary", { remember: true });
  }, []);
  const handlePromote = useCallback(() => {
    useInboxStore.getState().wsHide("secondary", { remember: false });
    tabNavigate(ref, "push");
  }, [ref]);

  return (
    <SlotPanel
      slot="secondary"
      title="Files"
      icon={<FolderTree className="w-3.5 h-3.5" />}
      canPromote
      onPromote={handlePromote}
      onClose={handleClose}
      className="h-full border-l border-sol-border/30 bg-sol-bg"
    >
      <ErrorBoundary name="StageFilesPane" level="panel">
        <TabParamsCtx.Provider value={ctx}>
          <Suspense fallback={null}>
            <VaultPage />
          </Suspense>
        </TabParamsCtx.Provider>
      </ErrorBoundary>
    </SlotPanel>
  );
});
