import { useMemo, useState } from "react";
import { captureException } from "@sentry/react";
import { isVaultAssetPath, isVaultMarkdownPath, type VaultFileEntry, type VaultLocateResponse } from "@codecast/shared/contracts";
import { useWatchEffect } from "./useWatchEffect";
import { localEndpointOf, useVaultStore } from "../store/vaultStore";
import { listVaults, locateVault, VaultRequestError } from "../lib/vault/client";
import { hostEndpoint } from "../lib/vault/hosts/routes";
import { hostLabel, vaultsOn } from "../lib/vault/hosts/hostVaults";
import { filesHref, resolveVaultTarget, sameNamedCheckoutPaths } from "../lib/vault/vaultHref";
import { ancestorDirs } from "../lib/vault/explorerModel";
import { inferHomeDir, resolveCustomPath } from "../lib/utils";

export function useVaultLocalPath(
  localPath: string | null,
  /** The link's `l`: a line or a cursor spelling (`12:4`, `12-20`), carried as is. */
  targetLine: number | string | undefined,
  router: { replace: (href: string) => void },
  /** The machine the path was written on (`d`, a session's runner). A cloud
   *  host this machine forwards to opens the host's own file, the agent's
   *  truth; when the forward cannot be opened, a mirror of the host's notes
   *  (read-only), else this machine's same-named checkout. */
  device?: string | null,
): void {
  const connection = useVaultStore((s) => s.connection);
  const localEndpoint = useVaultStore(localEndpointOf);
  const allVaults = useVaultStore((s) => s.vaults);
  const activeVaultId = useVaultStore((s) => s.activeVaultId);
  const scannedAt = useVaultStore((s) => s.scannedAt);
  const hostState = useVaultStore((s) => (device ? s.hostStates[device] : undefined));
  // Which machine this link resolves on. Until this machine's daemon is known
  // a host link cannot tell whether it names this machine, so it waits.
  const settled = connection !== "idle" && connection !== "discovering";
  const onHost = !!localPath && !!device && device !== localEndpoint?.deviceId;
  const side: "local" | "host" | "pending" = !onHost
    ? "local"
    : !settled || !hostState || hostState === "connecting"
      ? "pending"
      : hostState === "connected" ? "host" : "local";
  const fallback = onHost && side === "local";
  const scopeDevice = side === "host" ? device! : null;
  const vaults = useMemo(() => vaultsOn(allVaults, scopeDevice), [allVaults, scopeDevice]);
  const endpoint = side === "pending" ? null : side === "host" ? hostEndpoint(device!) : localEndpoint;
  const activeRoot = vaults.find((v) => v.id === activeVaultId)?.root;
  // Nothing resolves until the link knows its machine: a host path must not
  // open in a local vault that happens to hold the same folder.
  const target = useMemo(
    () => localPath && side !== "pending" ? resolveVaultTarget(localPath, vaults, activeRoot) : null,
    [localPath, vaults, activeRoot, side],
  );
  const abs = localPath ? resolveCustomPath(localPath, inferHomeDir(vaults.map((v) => v.root)), activeRoot) : null;
  const needsLocate = !!localPath && side !== "pending" && !target;
  const adopt = (vault: VaultLocateResponse["vault"]) =>
    side === "host" ? useVaultStore.getState().adoptHostVault(vault, device!) : useVaultStore.getState().adoptVault(vault);

  useWatchEffect(() => {
    if (onHost && settled && !hostState) void useVaultStore.getState().connectHost(device!);
  }, [onHost, settled, hostState, device]);

  // The host is out of reach. Its notes may be mirrored (read-only, through
  // Convex): that is the host's copy, so it wins over a local checkout. Code
  // never is mirrored, so a source file goes on to this machine's checkout.
  const mirror = useVaultStore((s) =>
    fallback && abs && (isVaultMarkdownPath(abs) || isVaultAssetPath(abs))
      ? s.remoteVaults.find((v) => v.device_id === device && (abs === v.root || abs.startsWith(`${v.root.replace(/\/+$/, "")}/`)))
      : undefined,
  );
  useWatchEffect(() => {
    if (!mirror || !abs) return;
    const rel = abs.slice(mirror.root.replace(/\/+$/, "").length).replace(/^\/+/, "");
    void useVaultStore.getState().openRemoteVault(mirror.id).then(() => {
      if (useVaultStore.getState().activeVaultId === mirror.id) router.replace(filesHref(rel ? { path: rel, line: targetLine } : {}));
    });
  }, [mirror?.id, abs]);
  // A path a registered vault holds is still asked about once: the daemon
  // names a deeper vault when the path sits in a checkout inside a folder
  // that is not one (a repo under a /tmp vault of 20k files), registering it.
  // Adopting that vault makes it the deepest root, and the target follows.
  // The answer also stands in for the row lookup below (ensureEntry), so a
  // link still costs the daemon one request. `located` undefined: it failed.
  const [checked, setChecked] = useState<{ abs: string; located: VaultLocateResponse | null | undefined } | null>(null);
  const deep = !!target && !!target.rel;
  const awaitingCheck = deep && !mirror && !!endpoint && !!abs && checked?.abs !== abs;

  useWatchEffect(() => {
    if (!awaitingCheck || !abs || !endpoint || !target) return;
    let cancelled = false;
    void locateVault(endpoint, abs).then(
      (located) => {
        if (cancelled) return;
        if (located && located.vault.id !== target.vaultId) adopt(located.vault);
        setChecked({ abs, located });
      },
      () => !cancelled && setChecked({ abs, located: undefined }),
    );
    return () => { cancelled = true; };
  }, [awaitingCheck, abs, endpoint, target?.vaultId]);

  useWatchEffect(() => {
    if (!needsLocate || !abs || !endpoint || mirror) return;
    let cancelled = false;
    useVaultStore.getState().clearOpError();
    void (async () => {
      const located = await locateVault(endpoint, abs);
      if (cancelled) return;
      if (located) {
        // The daemon has answered for this path: no second ask once the
        // adopted vault becomes the target.
        setChecked({ abs, located });
        return adopt(located.vault);
      }
      // A path from another machine (a teammate's, or a host's when its
      // forward is down, or this machine's path opened on a host): open the
      // same file in that machine's checkout of that folder. When no copy
      // sits at the same place, the checkout's own scan still finds a file a
      // relative mention put under the wrong folder. The link keeps its
      // machine, so a fallback stays one.
      const roots = side === "host"
        ? (await listVaults(endpoint)).map((v) => v.root)
        : vaultsOn(useVaultStore.getState().vaults, null).map((v) => v.root);
      if (cancelled) return;
      const candidates = sameNamedCheckoutPaths(abs, roots);
      const hrefFor = (candidate: string) => filesHref({ localPath: candidate, line: targetLine, device });
      for (const candidate of candidates) {
        const found = await locateVault(endpoint, candidate);
        if (cancelled) return;
        if (found) return router.replace(hrefFor(candidate));
      }
      if (candidates.length && side !== "host") return router.replace(hrefFor(candidates[0]));
      useVaultStore.setState({ opError: `${abs} does not exist on ${side === "host" ? hostLabel(device!) : "this machine"}.` });
    })().catch((error: unknown) => {
      if (cancelled) return;
      captureException(error);
      const detail = error instanceof VaultRequestError && error.status === 404
        ? "Update Codecast on this machine to open files outside known folders."
        : `${error instanceof Error ? error.message : String(error)}. Reload to retry.`;
      useVaultStore.setState({ opError: `Could not open ${abs}: ${detail}` });
    });
    return () => { cancelled = true; };
  }, [needsLocate, abs, endpoint, mirror]);

  useWatchEffect(() => {
    if (!target || awaitingCheck || mirror || (connection !== "connected" && connection !== "cached")) return;
    const store = useVaultStore.getState();
    // The header offers the host again from the checkout that stood in for it.
    const nextFallback = fallback ? { deviceId: device!, localVaultId: target.vaultId } : null;
    const held = store.hostFallback;
    if (held?.deviceId !== nextFallback?.deviceId || held?.localVaultId !== nextFallback?.localVaultId) store.setHostFallback(nextFallback);
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
      useVaultStore.setState({ opError: `${target.abs} isn't in this vault.` });
      useVaultStore.getState().openQuickSwitch(rel.slice(rel.lastIndexOf("/") + 1));
      router.replace(filesHref());
    };
    // The file list is a scan (rule-filtered, capped, maybe a stale cached
    // copy), so a missing row is not a missing file: ask the daemon. Only its
    // "no such file" is a verdict; when it cannot be asked, open the path
    // anyway and let the reader fetch it.
    const settle = (row: VaultFileEntry | null | undefined) => {
      if (row === null) return notInVault();
      if (row?.dir) {
        useVaultStore.getState().setDirsExpanded([...ancestorDirs(row.path), row.path], true);
        router.replace(filesHref());
        return;
      }
      openFile(row?.path ?? rel);
    };
    // The daemon already answered for this path (the check above): its row,
    // or its word that this vault has none, as ensureEntry would read it.
    if (checked && checked.abs === target.abs) {
      const l = checked.located;
      const row = l === undefined ? undefined : l?.vault.id === target.vaultId ? (l.entry ?? null) : null;
      if (row && !row.dir) store.adoptLinkedFile(row);
      return settle(row);
    }
    let cancelled = false;
    void store.ensureEntry(rel).then((row) => {
      if (!cancelled) settle(row);
    });
    return () => { cancelled = true; };
  }, [target, awaitingCheck, mirror, connection, activeVaultId, scannedAt, router, targetLine, fallback, device]);
}
