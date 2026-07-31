// Global mount for the vault quick switcher (Cmd+O). TerminalDock pattern:
// nothing downloads until the first open, then the component stays mounted.
// The shortcut handler declines (returns false) when no vault is known, so
// Cmd+O stays inert in vault-less workspaces.

import { lazy, Suspense, useRef } from "react";
import { useShortcutAction } from "../../shortcuts";
import { useVaultStore } from "../../store/vaultStore";

const VaultQuickSwitcher = lazy(() =>
  import("./VaultQuickSwitcher").then((m) => ({ default: m.VaultQuickSwitcher })),
);

export function VaultQuickSwitcherDock() {
  const open = useVaultStore((s) => s.quickSwitchOpen);
  const everOpened = useRef(false);
  if (open) everOpened.current = true;

  useShortcutAction("vault.quickSwitch", () => {
    const s = useVaultStore.getState();
    const hasVault = s.vaults.length > 0 || s.activeVaultId !== null;
    if (!hasVault) return false;
    s.setQuickSwitchOpen(!s.quickSwitchOpen);
    return true;
  });

  if (!everOpened.current) return null;
  return (
    <Suspense fallback={null}>
      <VaultQuickSwitcher />
    </Suspense>
  );
}
