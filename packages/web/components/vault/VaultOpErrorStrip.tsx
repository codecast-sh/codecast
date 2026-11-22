import { Copy, RotateCw, Search, X } from "lucide-react";
import { useVaultStore } from "../../store/vaultStore";
import { copyText } from "../../lib/copyText";

const action = "flex items-center gap-1 hover:opacity-70 shrink-0";

/** The Files pane's error strip. When the error is about a file or a failed
 *  request, the strip carries what to do about it: find the file by name,
 *  copy its path, or try again. */
export function VaultOpErrorStrip() {
  const opError = useVaultStore((s) => s.opError);
  const actions = useVaultStore((s) => s.opErrorActions);
  if (!opError) return null;
  const live = actions?.message === opError ? actions : null;
  const file = live?.file;
  const name = file ? file.slice(file.lastIndexOf("/") + 1) : null;
  const store = useVaultStore.getState;
  return (
    <div className="flex items-center gap-3 px-3 py-1 text-meta bg-sol-red/10 text-sol-red border-b border-sol-red/30">
      <span className="flex-1 truncate" title={opError}>
        {opError}
      </span>
      {live?.retry && (
        <button type="button" className={action} onClick={() => { store().clearOpError(); live.retry?.(); }}>
          <RotateCw className="w-3 h-3" />
          Retry
        </button>
      )}
      {file && name && (
        <>
          <button type="button" className={action} title={`Find ${name} by name`} onClick={() => store().openQuickSwitch(name)}>
            <Search className="w-3 h-3" />
            Find {name}
          </button>
          <button type="button" className={action} title={file} onClick={() => void copyText(file, "Path copied")}>
            <Copy className="w-3 h-3" />
            Copy path
          </button>
        </>
      )}
      <button type="button" onClick={() => store().clearOpError()} title="Dismiss" aria-label="Dismiss" className="hover:opacity-70">
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}
