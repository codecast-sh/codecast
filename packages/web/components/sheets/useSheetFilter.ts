// A tab's filter, shared or personal. The shared filter lives on the tab, so
// everyone (agents included) sees the same rows, like a basic filter in
// Google Sheets. A personal filter is this person's own view of the tab,
// kept in their synced UI state (clientState.ui.sheet_filters): it hides rows
// only for them, and while it exists it is the filter they see and edit.
import { useCallback } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { tabPatchOps, type SheetModel, type TabFilter } from "./sheetCore";
import type { ArtifactOp } from "@codecast/shared/artifacts";

export type FilterScope = "shared" | "mine";
export type SetFilter = (f: TabFilter | null, scope?: FilterScope) => void;

export function useSheetFilter(docId: string, tabId: string, shared: TabFilter | undefined, model: () => SheetModel, apply: (ops: ArtifactOp[]) => void) {
  const key = `${docId}:${tabId}`;
  const mine = useInboxStore((s) => (s.clientState.ui?.sheet_filters as Record<string, TabFilter | null> | undefined)?.[key] ?? null);
  const setFilter = useCallback<SetFilter>(
    (f, scope) => {
      const all = (useInboxStore.getState().clientState.ui?.sheet_filters ?? {}) as Record<string, TabFilter | null>;
      const target = scope ?? (all[key] ? "mine" : "shared");
      const { [key]: _old, ...rest } = all;
      if (target === "mine") {
        useInboxStore.getState().updateClientUI({ sheet_filters: f ? { ...rest, [key]: f } : rest });
        return;
      }
      // Sharing a personal view moves it onto the tab; the personal copy goes.
      if (all[key]) useInboxStore.getState().updateClientUI({ sheet_filters: rest });
      apply(tabPatchOps(model(), tabId, { filter: f as never }));
    },
    [key, tabId, model, apply],
  );
  return { filter: mine ?? shared, personal: !!mine, setFilter };
}
