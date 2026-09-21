import { useMemo } from "react";
import { captureException } from "@sentry/react";
import { isVaultAssetPath, isVaultMarkdownPath } from "@codecast/shared/contracts";
import { useWatchEffect } from "./useWatchEffect";
import { useVaultStore } from "../store/vaultStore";
import { locateVault, VaultRequestError } from "../lib/vault/client";
import { filesHref, resolveVaultTarget } from "../lib/vault/vaultHref";
import { ancestorDirs } from "../lib/vault/explorerModel";
import { inferHomeDir, resolveCustomPath } from "../lib/utils";

export function useVaultLocalPath(
  localPath: string | null,
  targetLine: number | undefined,
  router: { replace: (href: string) => void },
): void {
  const connection = useVaultStore((s) => s.connection);
  const endpoint = useVaultStore((s) => s.endpoint);
  const vaults = useVaultStore((s) => s.vaults);
  const activeVaultId = useVaultStore((s) => s.activeVaultId);
  const scannedAt = useVaultStore((s) => s.scannedAt);
  const activeRoot = vaults.find((v) => v.id === activeVaultId)?.root;
  const target = useMemo(
    () => localPath ? resolveVaultTarget(localPath, vaults, activeRoot) : null,
    [localPath, vaults, activeRoot],
  );
  const abs = localPath ? resolveCustomPath(localPath, inferHomeDir(vaults.map((v) => v.root)), activeRoot) : null;
  const needsLocate = !!localPath && !target;

  useWatchEffect(() => {
    if (!needsLocate || !abs || !endpoint) return;
    let cancelled = false;
    useVaultStore.getState().clearOpError();
    void locateVault(endpoint, abs).then((located) => {
      if (cancelled) return;
      if (located) useVaultStore.getState().adoptVault(located.vault);
      else useVaultStore.setState({ opError: `${abs} does not exist on this machine.` });
    }).catch((error: unknown) => {
      if (cancelled) return;
      captureException(error);
      const detail = error instanceof VaultRequestError && error.status === 404
        ? "Update Codecast on this machine to open files outside known folders."
        : `${error instanceof Error ? error.message : String(error)}. Reload to retry.`;
      useVaultStore.setState({ opError: `Could not open ${abs}: ${detail}` });
    });
    return () => { cancelled = true; };
  }, [needsLocate, abs, endpoint]);

  useWatchEffect(() => {
    if (!target || (connection !== "connected" && connection !== "cached")) return;
    const store = useVaultStore.getState();
    if (target.vaultId !== activeVaultId) {
      void store.selectVault(target.vaultId);
      return;
    }
    if (!scannedAt) return;
    if (store.opError) store.clearOpError();
    const { files } = store;
    let rel = target.rel;
    let entry = rel ? files[rel] : undefined;
    if (rel && !entry && !Object.keys(files).some((p) => p.startsWith(`${rel}/`))) {
      const suffix = `/${rel}`;
      const candidates = Object.keys(files).filter((p) => p.endsWith(suffix) && !files[p].dir);
      if (candidates.length === 1) {
        rel = candidates[0];
        entry = files[rel];
      }
    }
    const isDir = !rel || !!entry?.dir || Object.keys(files).some((p) => p.startsWith(`${rel}/`));
    store.setLeftPaneTab("files");
    if (entry && !entry.dir) {
      if (!store.showAllFiles && !isVaultMarkdownPath(rel) && !isVaultAssetPath(rel)) store.setShowAllFiles(true);
      store.noteOpened(rel);
      store.requestReveal(rel);
      router.replace(filesHref({ path: rel, line: targetLine }));
      return;
    }
    if (isDir) {
      if (rel) store.setDirsExpanded([...ancestorDirs(rel), rel], true);
      router.replace(filesHref());
      return;
    }
    const existing = ancestorDirs(rel).filter((d) => files[d]?.dir || Object.keys(files).some((p) => p.startsWith(`${d}/`)));
    if (existing.length) store.setDirsExpanded(existing, true);
    useVaultStore.setState({ opError: `${target.abs} isn't in this vault.` });
    store.openQuickSwitch(rel.slice(rel.lastIndexOf("/") + 1));
    router.replace(filesHref());
  }, [target, connection, activeVaultId, scannedAt, router, targetLine]);
}
