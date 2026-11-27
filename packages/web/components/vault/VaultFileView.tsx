// The view for everything that isn't markdown: text files open in the code
// editor (components/code, loaded lazily), images, media and PDFs draw
// themselves, and anything else gets an honest dead end.

import { memo, Suspense, useMemo, useState } from "react";
import { lazyNamed } from "../../lib/lazyNamed";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { FileQuestion, FileWarning } from "lucide-react";
import { FileUnavailable } from "./FileUnavailable";
import { VAULT_MAX_PREVIEW_BYTES, vaultFileKind } from "@codecast/shared/contracts";
import { CODE_EDITOR_MAX_BYTES } from "../../lib/code/limits";
import { readFailureLabel, vaultAssetUrl } from "../../lib/vault/client";
import { useVaultStore } from "../../store/vaultStore";
import { bufferKey, useCodeStore } from "../../store/codeStore";
import { VaultFileHeader } from "./VaultFileHeader";
import { CodeFileBar } from "../code/CodeFileBar";
import { useVaultEntryState } from "./useVaultEntry";

/** Bytes, in the unit a person would say out loud. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

// The editor is its own chunk: nobody who only browses images pays for
// CodeMirror. Files prewarms it once the browser is idle, so the first source
// file opens without waiting on the download.
const loadCodeFileView = () => import("../code/CodeFileView");
const CodeFileView = lazyNamed(loadCodeFileView, "CodeFileView");
if (typeof window !== "undefined") {
  const prewarm = () => void loadCodeFileView().catch(() => {});
  if (typeof requestIdleCallback === "function") requestIdleCallback(prewarm, { timeout: 5000 });
  else setTimeout(prewarm, 2000);
}

export const VaultFileView = memo(function VaultFileView({ path, line }: { path: string; line?: string | null }) {
  const entry = useVaultStore((s) => s.files[path]);
  const entryState = useVaultEntryState(path);
  const body = useVaultStore((s) => s.bodies[path]);
  const endpoint = useVaultStore((s) => s.endpoint);
  const vaultId = useVaultStore((s) => s.activeVaultId);
  const isRemote = useVaultStore((s) => s.isRemote);
  const connection = useVaultStore((s) => s.connection);
  // Unsaved edits keep the editor on screen whatever disk does, so the file can
  // be written back (or merged with what returns) rather than stranded.
  const unsaved = useCodeStore((s) => !!vaultId && !!s.dirty[bufferKey(vaultId, path)]);

  // The name only rules a file out; a body that turns out to hold a NUL (the
  // check git and grep use) is binary whatever its extension says.
  const binaryBody = useMemo(() => !!body?.content.includes("\0"), [body]);
  const kind = binaryBody ? "binary" : vaultFileKind(path);
  const size = entry?.size ?? 0;
  const tooLarge = size > (kind === "text" ? CODE_EDITOR_MAX_BYTES : VAULT_MAX_PREVIEW_BYTES);
  const title = path.slice(path.lastIndexOf("/") + 1);

  // Text arrives on demand, unlike notes, which are all held from the scan:
  // from the local daemon, or from the mirror for a vault on another machine.
  // `endpoint` is a dep on purpose: a cached boot paints this view before the
  // daemon handshake lands, and the ask has to repeat once there is one.
  // A read that came back with nothing is remembered for that version of the
  // entry, so the editor stays mounted until a read has actually failed, "not
  // asked yet" never flashes as "couldn't read", and a file that returns (an
  // add or change event) is read again.
  const readKey = `${path}@${entry?.mtime ?? ""}`;
  // The last failed read: which version of the entry, and why (a status a
  // person can act on). Retry clears it and asks again.
  const [failedRead, setFailedRead] = useState<{ key: string; reason: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useWatchEffect(() => {
    if (kind !== "text" || body) return;
    const store = useVaultStore.getState();
    const read = isRemote
      ? store.loadRemoteBody(path)
      : endpoint
        ? store.loadTextBody(path, { maxBytes: CODE_EDITOR_MAX_BYTES })
        : null;
    void read?.then(
      (reason) => {
        const s = useVaultStore.getState();
        if (!s.bodies[path] && !s.loadingPaths[path]) setFailedRead({ key: readKey, reason: reason ?? "Unreadable" });
      },
      (e) => setFailedRead({ key: readKey, reason: readFailureLabel(e) }),
    );
  }, [kind, readKey, !!body, endpoint, isRemote, attempt]);
  // No daemon and none coming: no read will run, so say so rather than load
  // forever. A cached boot is not that: the daemon is still being reached, and
  // the read runs once the endpoint lands (CodeFileView marks a long wait).
  const unreachable = !isRemote && !endpoint && connection === "no-daemon";
  const failReason = failedRead?.key === readKey ? failedRead.reason : unreachable ? "No daemon" : null;
  const readFailedRaw = !body && !unsaved && failReason !== null;
  const retryRead = () => {
    setFailedRead(null);
    if (unreachable) void useVaultStore.getState().reconnect();
    else setAttempt((n) => n + 1);
  };
  const missing = entryState === "missing";
  // A text path with nothing on disk, in a vault this machine writes: the
  // editor stays (CodeFileView opens an empty buffer under that name, created
  // by the first save, or keeps a buffer the file was deleted under).
  const newFile = missing && kind === "text" && !isRemote && !!endpoint && !!vaultId;
  const readFailed = !newFile && readFailedRaw;

  if (missing && !newFile && !(kind === "text" && unsaved)) {
    return <FileUnavailable path={path} icon={<FileQuestion className="w-8 h-8 text-sol-text-dim opacity-40" />} title="Not on disk" />;
  }

  const assetSrc =
    endpoint && vaultId && kind === "asset" ? vaultAssetUrl(endpoint, vaultId, path) : null;

  const renderBody = () => {
    if (tooLarge) {
      return (
        <FileUnavailable
          path={path}
          icon={<FileWarning className="w-8 h-8 text-sol-text-dim opacity-40" />}
          title="Too large"
          detail={`${formatSize(size)} · limit ${formatSize(kind === "text" ? CODE_EDITOR_MAX_BYTES : VAULT_MAX_PREVIEW_BYTES)}`}
        />
      );
    }
    // Attachments the browser can play or draw by itself, given the URL the
    // loopback route serves them from.
    if (assetSrc) {
      if (/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(path)) {
        return <img src={assetSrc} alt={title} className="max-w-full rounded border border-sol-border/30" />;
      }
      if (/\.(mp4|webm|mov)$/i.test(path)) {
        return <video src={assetSrc} controls className="max-w-full rounded border border-sol-border/30" />;
      }
      if (/\.(mp3|wav|m4a)$/i.test(path)) return <audio src={assetSrc} controls className="w-full" />;
      if (/\.pdf$/i.test(path)) {
        return <iframe src={assetSrc} title={title} className="w-full h-[70vh] rounded border border-sol-border/30" />;
      }
    }
    if (kind === "text") {
      if (!readFailed) {
        return (
          <Suspense fallback={null}>
            <CodeFileView path={path} line={line} missing={missing} newFile={newFile} />
          </Suspense>
        );
      }
      // Only the scan's own size can tell "empty" from "we don't have it":
      // calling a failed read "empty" would be a quiet lie about the file.
      return size === 0 ? (
        <FileUnavailable path={path} icon={<FileQuestion className="w-8 h-8 text-sol-text-dim opacity-40" />} title="Empty file" />
      ) : (
        <FileUnavailable
          path={path}
          icon={<FileWarning className="w-8 h-8 text-sol-yellow opacity-70" />}
          title="Couldn't read"
          detail={failReason ?? undefined}
          onRetry={retryRead}
        />
      );
    }
    return (
      <FileUnavailable
        path={path}
        icon={<FileQuestion className="w-8 h-8 text-sol-text-dim opacity-40" />}
        title="No preview"
        detail={formatSize(size)}
      />
    );
  };

  // A text file fills the pane and scrolls inside the editor, which renders
  // only what is on screen; everything else scrolls as a page. One compact row
  // names the file; the editor owns the rest of the height. A text file keeps
  // this layout while its body loads, and when it cannot be shown, so the
  // breadcrumbs, reveal and bookmark stay put.
  if (kind === "text") {
    return (
      <div className="h-full flex flex-col min-h-0 overflow-hidden">
        <CodeFileBar path={path} />
        <div className="flex-1 min-h-0">{renderBody()}</div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto" data-vault-note-scroll>
      <div className="max-w-4xl mx-auto px-8 py-6">
        <VaultFileHeader path={path} title={title} />
        {renderBody()}
      </div>
    </div>
  );
});
