import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import type { PRDetailsRead } from "../../hooks/usePRDetails";

export function PRDetailsFrame({ read, hasRows, label, children }: {
  read?: PRDetailsRead; hasRows: boolean; label: string; children: ReactNode;
}) {
  return (
    <div className="h-full flex flex-col min-h-0">
      {(read?.loading || read?.error) && (
        <div className={`${hasRows ? "px-5 py-3" : "flex-1 justify-center px-8"} flex flex-col items-center gap-2 text-center text-[13px] text-sol-text-muted`} role={read.error ? "alert" : "status"}>
          {read.error ? <>
            <p>Could not load {label.toLowerCase()}.</p>
            <p className="max-w-lg text-[12px] text-sol-text-dim break-words">{read.error}</p>
            <button type="button" onClick={read.retry} className="text-sol-cyan hover:underline">Try again</button>
          </> : <>
            <Loader2 className="w-4 h-4 animate-spin" />
            <p>Loading {label.toLowerCase()}…</p>
          </>}
        </div>
      )}
      {(hasRows || (!read?.loading && !read?.error)) && <div className="flex-1 min-h-0">{children}</div>}
    </div>
  );
}
