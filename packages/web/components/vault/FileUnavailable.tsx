// What a file's body area shows when it cannot show the file: too large, a
// type with no preview, a read that failed, a daemon still out of reach. An
// icon, a short title, one dim fact (a size, a status), and the actions that
// get past it: Retry when trying again can help, Reveal when this machine
// holds the file. Shared by the vault views and the code editor's loading
// state, so every dead end on Files has the same shape and a way out.

import { useState, type ReactNode } from "react";
import { RotateCw, WifiOff } from "lucide-react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { LoadingBar } from "../ui/LoadingBar";
import { useVaultStore } from "../../store/vaultStore";
import { fileManagerName } from "../../lib/vault/reveal";
import { RevealButton } from "./VaultFileHeader";
import { buttonVariants } from "../ui/button";

const actionClass = buttonVariants({ variant: "outline", size: "xs" });

export function FileUnavailable({
  path,
  icon,
  title,
  detail,
  onRetry,
}: {
  path: string;
  icon: ReactNode;
  title: string;
  detail?: string;
  onRetry?: () => void;
}) {
  const canReveal = useVaultStore((s) => !!s.endpoint && !s.isRemote);
  return (
    <div role="status" className="flex flex-col items-center justify-center gap-2 py-20 text-center">
      {icon}
      <div className="text-sm text-sol-text-muted">{title}</div>
      {detail && <div className="text-xs tabular-nums text-sol-text-dim">{detail}</div>}
      {(onRetry || canReveal) && (
        <div className="mt-2 flex items-center gap-2">
          {onRetry && (
            <button type="button" className={actionClass} onClick={onRetry}>
              <RotateCw /> Retry
            </button>
          )}
          {canReveal && (
            <RevealButton path={path} className={actionClass}>
              Show in {fileManagerName()}
            </RevealButton>
          )}
        </div>
      )}
    </div>
  );
}

/** How long a read waits on a reconnecting daemon before saying so. */
export const FILE_STALL_MS = 4000;

/** True once `waiting` has held for FILE_STALL_MS for the same `key`; the
 *  second value starts the wait over (a Retry). */
export function useStalled(waiting: boolean, key: string): [boolean, () => void] {
  const [stalled, setStalled] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useWatchEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => setStalled(key), FILE_STALL_MS);
    return () => clearTimeout(t);
  }, [waiting, key, attempt]);
  const retry = () => {
    setStalled(null);
    setAttempt((n) => n + 1);
  };
  return [waiting && stalled === key, retry];
}

/** The daemon is being reached and the file cannot be read yet. */
export function DaemonReconnecting({ path, onRetry }: { path: string; onRetry?: () => void }) {
  return (
    <FileUnavailable
      path={path}
      icon={<WifiOff className="h-8 w-8 text-sol-yellow opacity-70" />}
      title="Couldn't read"
      detail="Daemon reconnecting"
      onRetry={() => {
        onRetry?.();
        void useVaultStore.getState().reconnect();
      }}
    />
  );
}

/** A link to a file (`/files?path=`) while its folder is being resolved: the
 *  file it names, loading, never whatever the last vault had open. Past the
 *  stall with the daemon out of reach, the reconnecting state and its Retry. */
export function LinkedFilePending({ path }: { path: string }) {
  const offline = useVaultStore((s) => s.connection !== "connected");
  const [stalled, retry] = useStalled(offline, path);
  const name = path.split("/").filter(Boolean).pop() ?? path;
  const dir = path.slice(0, Math.max(0, path.length - name.length));
  return (
    <div className="relative flex h-full min-h-0 flex-col" data-linked-file-pending>
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-sol-border/40 px-3 text-meta" title={path}>
        <span className="min-w-0 truncate text-sol-text-dim">{dir}</span>
        <span className="shrink-0 text-sol-text">{name}</span>
      </div>
      <div className="relative min-h-0 flex-1">
        {!stalled && <LoadingBar className="absolute inset-x-0 top-0" />}
        {stalled && <DaemonReconnecting path={path} onRetry={retry} />}
      </div>
    </div>
  );
}
