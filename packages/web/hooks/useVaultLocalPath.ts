import { useMemo, useState } from "react";
import { useConvex } from "convex/react";
import { captureException } from "@sentry/react";
import { isVaultAssetPath, isVaultMarkdownPath } from "@codecast/shared/contracts";
import { useWatchEffect } from "./useWatchEffect";
import { useVaultStore } from "../store/vaultStore";
import { locateVault, VaultRequestError } from "../lib/vault/client";
import { filesHref, resolveVaultTarget, sameNamedCheckoutPaths } from "../lib/vault/vaultHref";
import { ancestorDirs } from "../lib/vault/explorerModel";
import { inferHomeDir, resolveCustomPath } from "../lib/utils";
import { readRemoteFile, type RemoteFileState } from "../lib/vault/remoteFile";

/**
 * Opens a `?path=` link. When this machine lacks the file and the link names
 * the conversation it came from (`conversationId`), the file is read from that
 * conversation's machine instead, and returned for the page to show.
 */
export function useVaultLocalPath(
  localPath: string | null,
  targetLine: number | undefined,
  router: { replace: (href: string) => void },
  conversationId?: string | null,
): RemoteFileState | null {
  const convex = useConvex();
  const [remoteAbs, setRemoteAbs] = useState<string | null>(null);
  const [remote, setRemote] = useState<RemoteFileState | null>(null);
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
  const noLocalDaemon = !endpoint && (connection === "no-daemon" || connection === "cached");

  useWatchEffect(() => {
    setRemoteAbs(null);
    setRemote(null);
  }, [localPath, conversationId]);

  useWatchEffect(() => {
    if (!remoteAbs || !conversationId) return;
    let cancelled = false;
    useVaultStore.getState().clearOpError();
    setRemote({ status: "loading", abs: remoteAbs, machine: null });
    void readRemoteFile(convex, conversationId, remoteAbs, () => cancelled)
      .then((state) => { if (!cancelled) setRemote(state); })
      .catch((error: unknown) => {
        if (cancelled) return;
        captureException(error);
        setRemote({ status: "failed", abs: remoteAbs, machine: null, message: `Could not read ${remoteAbs}: ${error instanceof Error ? error.message : String(error)}` });
      });
    return () => { cancelled = true; };
  }, [remoteAbs, conversationId, convex]);

  useWatchEffect(() => {
    if (needsLocate && abs && noLocalDaemon && conversationId) setRemoteAbs(abs);
  }, [needsLocate, abs, noLocalDaemon, conversationId]);

  useWatchEffect(() => {
    if (!needsLocate || !abs || !endpoint) return;
    let cancelled = false;
    useVaultStore.getState().clearOpError();
    void (async () => {
      const located = await locateVault(endpoint, abs);
      if (cancelled) return;
      if (located) return useVaultStore.getState().adoptVault(located.vault);
      // A path from another machine (a teammate's or a cloud host's session):
      // open the same file in this machine's checkout of that folder.
      // When no copy sits at the same place, the checkout's own scan still
      // finds a file a relative mention put under the wrong folder.
      const roots = useVaultStore.getState().vaults.map((v) => v.root);
      const candidates = sameNamedCheckoutPaths(abs, roots);
      for (const candidate of candidates) {
        const found = await locateVault(endpoint, candidate);
        if (cancelled) return;
        if (found) return router.replace(filesHref({ localPath: candidate, line: targetLine }));
      }
      if (candidates.length) return router.replace(filesHref({ localPath: candidates[0], line: targetLine }));
      if (conversationId) return setRemoteAbs(abs);
      useVaultStore.setState({ opError: `${abs} does not exist on this machine.` });
    })().catch((error: unknown) => {
      if (cancelled) return;
      captureException(error);
      const detail = error instanceof VaultRequestError && error.status === 404
        ? "Update Codecast on this machine to open files outside known folders."
        : `${error instanceof Error ? error.message : String(error)}. Reload to retry.`;
      useVaultStore.setState({ opError: `Could not open ${abs}: ${detail}` });
    });
    return () => { cancelled = true; };
  }, [needsLocate, abs, endpoint, conversationId]);

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
    const openFile = (path: string) => {
      const st = useVaultStore.getState();
      if (!st.showAllFiles && !isVaultMarkdownPath(path) && !isVaultAssetPath(path)) st.setShowAllFiles(true);
      st.noteOpened(path);
      st.requestReveal(path);
      router.replace(filesHref({ path, line: targetLine }));
    };
    if (entry && !entry.dir) {
      openFile(rel);
      return;
    }
    if (isDir) {
      if (rel) store.setDirsExpanded([...ancestorDirs(rel), rel], true);
      router.replace(filesHref());
      return;
    }
    const existing = ancestorDirs(rel).filter((d) => files[d]?.dir || Object.keys(files).some((p) => p.startsWith(`${d}/`)));
    if (existing.length) store.setDirsExpanded(existing, true);
    const notInVault = () => {
      if (conversationId) {
        setRemoteAbs(target.abs);
        return;
      }
      useVaultStore.setState({ opError: `${target.abs} isn't in this vault.` });
      useVaultStore.getState().openQuickSwitch(rel.slice(rel.lastIndexOf("/") + 1));
      router.replace(filesHref());
    };
    // The file list is a scan (rule-filtered, capped, maybe a stale cached
    // copy), so a missing row is not a missing file: ask the daemon. Only its
    // "no such file" is a verdict; when it cannot be asked, open the path
    // anyway and let the reader fetch it.
    let cancelled = false;
    void store.ensureEntry(rel).then((row) => {
      if (cancelled) return;
      if (row === null) return notInVault();
      if (row?.dir) {
        useVaultStore.getState().setDirsExpanded([...ancestorDirs(row.path), row.path], true);
        router.replace(filesHref());
        return;
      }
      openFile(row?.path ?? rel);
    });
    return () => { cancelled = true; };
  }, [target, connection, activeVaultId, scannedAt, router, targetLine, conversationId]);

  return remote;
}
