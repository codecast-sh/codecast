// The run folder as it sits on disk: a tree of its files, each opening
// read-only beside it. Its panel (runPanels.tsx) fetches the open file
// (GET /run/:id/file); this view only draws the tree and what it was handed.

import { File, Folder } from "lucide-react";
import type { RunFileEntry, RunFileResponse } from "@codecast/shared/contracts/evalsApi";
import { CodeBlock } from "../CodeBlock";

const LANGUAGES: Record<string, string> = { json: "json", jsonl: "json", md: "markdown", ts: "typescript", log: "text", txt: "text", patch: "diff" };

export const fileLanguage = (path: string) => LANGUAGES[path.split(".").pop() ?? ""] ?? "text";

/** Files under their folders, folders in path order, a folder's own files before its subfolders. */
export function fileTree(files: readonly RunFileEntry[]): Array<{ dir: string; files: RunFileEntry[] }> {
  const groups = new Map<string, RunFileEntry[]>();
  for (const f of files) {
    if (f.kind === "dir") {
      if (!groups.has(f.path)) groups.set(f.path, []);
      continue;
    }
    const cut = f.path.lastIndexOf("/");
    const dir = cut < 0 ? "" : f.path.slice(0, cut);
    groups.set(dir, [...(groups.get(dir) ?? []), f]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([dir, list]) => ({ dir, files: list.sort((a, b) => a.path.localeCompare(b.path)) }));
}

const kb = (size: number) => (size >= 1024 ? `${(size / 1024).toFixed(size >= 10_240 ? 0 : 1)} KB` : `${size} B`);

export interface OpenFile {
  path: string;
  data: RunFileResponse | null;
  loading: boolean;
  error: string | null;
}

export function RunFiles({ files, open, onOpen }: { files: readonly RunFileEntry[]; open: OpenFile | null; onOpen: (path: string) => void }) {
  const tree = fileTree(files);
  return (
    <div className="ev-files" data-ev-files>
      <nav className="ev-card ev-tree" aria-label="Run folder">
        {tree.map(({ dir, files: list }) => (
          <div key={dir || "."} className="flex flex-col">
            {dir && (
              <div className="ev-tree-dir inline-flex items-center gap-1.5">
                <Folder className="w-3 h-3" /> {dir}/
              </div>
            )}
            {list.map((f) => (
              <button key={f.path} type="button" className="ev-tree-item" style={dir ? { paddingLeft: 22 } : undefined} aria-current={open?.path === f.path} onClick={() => onOpen(f.path)} data-ev-file={f.path}>
                <File />
                <span className="min-w-0 truncate">{dir ? f.path.slice(dir.length + 1) : f.path}</span>
                <span className="ev-tree-size">{kb(f.size)}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>
      <section className="ev-card overflow-hidden min-w-0" data-ev-file-view={open?.path ?? ""}>
        {!open ? (
          <div className="ev-empty-note">Pick a file. Everything here opens read-only.</div>
        ) : (
          <>
            <div className="ev-pane-head" style={{ cursor: "default" }}>
              <span className="ev-pane-name">{open.path}</span>
              {open.data && <span className="ev-pane-size">{kb(open.data.size)}{open.data.truncated ? ", truncated" : ""}</span>}
            </div>
            <div style={{ borderTop: "1px solid var(--ev-rule)" }}>
              {open.loading && !open.data ? (
                <div className="ev-empty-note">Reading {open.path}...</div>
              ) : open.error ? (
                <div className="ev-empty-note">{open.error}</div>
              ) : open.data?.text === null ? (
                <div className="ev-empty-note">A binary file: nothing to show as text.</div>
              ) : (
                <div className="ev-file-code text-[12px]">
                  <CodeBlock code={open.data?.text ?? ""} language={fileLanguage(open.path)} />
                </div>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
