// The files a replace or a results editor save did not write cleanly, one row
// each: what happened, the path, and why. An "unsaved" file is listed only
// when its save failed (the edit sits in its open tab).

import type { FileEditOutcome } from "../../../lib/code/search/writeBack";

const LABEL: Record<string, string> = {
  conflict: "Conflict",
  changed: "Changed",
  readonly: "Read-only",
  error: "Failed",
  unsaved: "Unsaved",
};

export function FileFailures({
  outcomes,
  onOpen,
  className = "",
}: {
  outcomes: ReadonlyArray<Pick<FileEditOutcome, "path" | "status" | "detail">>;
  /** Opens the file; rows are inert without it. */
  onOpen?: (path: string) => void;
  className?: string;
}) {
  if (!outcomes.length) return null;
  return (
    <div className={`text-meta ${className}`}>
      {outcomes.map((f) => {
        const body = (
          <>
            <span className="w-[5.5em] shrink-0 text-sol-orange">{LABEL[f.status] ?? f.status}</span>
            <span className="min-w-0 flex-1 truncate text-sol-text-muted">{f.path}</span>
            {f.detail && <span className="max-w-[45%] shrink truncate text-sol-text-dim">{f.detail}</span>}
          </>
        );
        const row = "flex w-full items-center gap-1.5 px-1.5 py-0.5 text-left";
        return onOpen ? (
          <button key={f.path} type="button" title={f.detail} onClick={() => onOpen(f.path)} className={`${row} hover:bg-sol-bg-alt`}>
            {body}
          </button>
        ) : (
          <div key={f.path} title={f.detail} className={row}>
            {body}
          </div>
        );
      })}
    </div>
  );
}
