// Expo OTA hook, from aurora's packages/mobile/lib/ota.ts. Check, fetch and
// reload when the app comes to the foreground, before the user is doing
// anything. Never mid session: expo-updates can mark an update launched on a
// mid session reloadAsync() and then silently roll it back.
//
// Codecast's variant applies on BACKGROUND instead of on open. Both avoid a
// reload while the user is working; pick the one that fits the product.
//
// Copy into the app. Requires react, react-native and expo-updates; the
// import of expo-updates here is safe because expo-updates is always part of
// the binary that runs the OTA (it is what applied it).

import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import * as Updates from "expo-updates";

export function useOtaOnOpen(): void {
  const applying = useRef(false);

  useEffect(() => {
    const applyIfAvailable = async () => {
      if (applying.current || __DEV__ || !Updates.isEnabled) return;
      applying.current = true;
      try {
        const check = await Updates.checkForUpdateAsync();
        if (check.isAvailable) {
          await Updates.fetchUpdateAsync();
          // The user just arrived; a reload now costs nothing.
          await Updates.reloadAsync();
        }
      } catch {
        // Network flake or a bad manifest: the running version stays.
      } finally {
        applying.current = false;
      }
    };

    // Cold start counts as an open.
    void applyIfAvailable();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void applyIfAvailable();
    });
    return () => sub.remove();
  }, []);
}
