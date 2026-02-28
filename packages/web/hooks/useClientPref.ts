import { useCallback, useMemo } from "react";
import { useInboxStore } from "../store/inboxStore";
import type { ClientUI, ClientLayouts, ClientDismissed } from "../store/inboxStore";

type Namespace = "ui" | "layouts" | "dismissed";

type NamespaceType = {
  ui: ClientUI;
  layouts: ClientLayouts;
  dismissed: ClientDismissed;
};

export function useClientPref<N extends Namespace, K extends string & keyof NamespaceType[N]>(
  namespace: N,
  key: K,
  defaultValue: NonNullable<NamespaceType[N][K]>,
  localStorageKey?: string,
): [NonNullable<NamespaceType[N][K]>, (value: NonNullable<NamespaceType[N][K]>) => void] {
  const value = useInboxStore((s) => {
    const ns = (s.clientState as any)?.[namespace];
    return ns?.[key] ?? defaultValue;
  });

  const updateUI = useInboxStore((s) => s.updateClientUI);
  const updateLayout = useInboxStore((s) => s.updateClientLayout);
  const updateDismissed = useInboxStore((s) => s.updateClientDismissed);

  const setValue = useCallback(
    (newValue: NonNullable<NamespaceType[N][K]>) => {
      if (namespace === "ui") {
        updateUI({ [key]: newValue } as any);
      } else if (namespace === "layouts") {
        updateLayout(key as any, newValue);
      } else {
        updateDismissed(key as any, newValue);
      }
      if (localStorageKey) {
        try {
          localStorage.setItem(
            localStorageKey,
            typeof newValue === "object" ? JSON.stringify(newValue) : String(newValue),
          );
        } catch {}
      }
    },
    [namespace, key, localStorageKey, updateUI, updateLayout, updateDismissed],
  );

  return [value, setValue];
}
