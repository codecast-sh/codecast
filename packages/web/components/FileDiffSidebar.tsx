import { useState, useMemo } from "react";
import { ChevronRight, ChevronDown, Check, Search, X, ChevronsUpDown, ChevronsDownUp } from "lucide-react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { getFileStatus } from "../lib/patchParser";
import { cn } from "../lib/utils";
import { buildFileTreeFromStripped, shortenPrefix, stripCommonPrefix, type FileTreeNode } from "../lib/diffFileTree";
import type { DiffFile, FileDiffLayoutProps } from "./FileDiffLayout";

function FileTreeItem({
  node,
  selectedFile,
  onSelect,
  depth = 0,
  expandedDirs,
  onToggleDir,
  selectedFileRef,
  fileMarks,
}: {
  node: FileTreeNode;
  selectedFile: string | null;
  onSelect: (filename: string) => void;
  depth?: number;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  selectedFileRef?: React.RefObject<HTMLButtonElement | null>;
  fileMarks?: FileDiffLayoutProps["fileMarks"];
}) {
  const isExpanded = expandedDirs.has(node.path);
  const isSelected = selectedFile === node.path;
  const status = node.file ? getFileStatus(node.file.status) : null;
  const marks = node.file ? fileMarks?.(node.file.originalFilename ?? node.file.filename) : undefined;

  if (node.isDirectory) {
    return (
      <div>
        <button
          onClick={() => onToggleDir(node.path)}
          className="w-full flex items-center gap-1 py-1 px-2 hover:bg-sol-bg-alt/50 text-sm text-sol-text-muted"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          {isExpanded ? (
            <ChevronDown className="w-3 h-3 shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 shrink-0" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
        {isExpanded &&
          node.children.map((child) => (
            <FileTreeItem
              key={child.path}
              node={child}
              selectedFile={selectedFile}
              onSelect={onSelect}
              depth={depth + 1}
              expandedDirs={expandedDirs}
              onToggleDir={onToggleDir}
              selectedFileRef={selectedFileRef}
              fileMarks={fileMarks}
            />
          ))}
      </div>
    );
  }

  return (
    <button
      ref={isSelected && selectedFileRef ? selectedFileRef as React.RefObject<HTMLButtonElement> : undefined}
      onClick={() => onSelect(node.path)}
      data-diff-file={node.file ? node.file.originalFilename ?? node.file.filename : undefined}
      className={cn(
        "w-full flex items-center gap-2 py-1.5 px-2 text-sm transition-colors",
        isSelected
          ? "bg-sol-violet/20 text-sol-text border-l-2 border-sol-violet"
          : "hover:bg-sol-bg-alt/50 text-sol-text-muted",
        marks?.viewed && !isSelected && "opacity-50",
      )}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
    >
      {status && (
        <span
          className={cn(
            "w-4 h-4 rounded text-[10px] font-bold flex items-center justify-center shrink-0",
            status.bgColor,
            status.color
          )}
        >
          {status.label}
        </span>
      )}
      <span className={cn("truncate", marks?.viewed && "line-through decoration-sol-text-dim/60")}>{node.name}</span>
      {node.file && (
        <span className="ml-auto flex items-center gap-1.5 text-[10px] text-sol-text-dim shrink-0">
          {!!marks?.pending && (
            <span className="rounded-full border border-dashed border-sol-yellow/60 px-1 text-sol-yellow" title={`${marks.pending} in your review`}>
              {marks.pending}
            </span>
          )}
          {!!marks?.open && (
            <span className="rounded-full bg-sol-cyan/15 px-1 text-sol-cyan" title={`${marks.open} open ${marks.open === 1 ? "thread" : "threads"}`}>
              {marks.open}
            </span>
          )}
          {marks?.viewed && <Check className="w-3 h-3 text-sol-green" />}
          <span>
            <span className="text-sol-green">+{node.file.additions}</span>
            <span className="mx-0.5">/</span>
            <span className="text-sol-red">-{node.file.deletions}</span>
          </span>
        </span>
      )}
    </button>
  );
}

export function FileSidebar({
  files,
  selectedFile,
  onSelectFile,
  header,
  selectedFileRef,
  commonPrefix,
  fileMarks,
  flow = false,
}: {
  files: DiffFile[];
  selectedFile: string | null;
  onSelectFile: (filename: string) => void;
  header?: React.ReactNode;
  selectedFileRef?: React.RefObject<HTMLButtonElement | null>;
  commonPrefix?: string;
  fileMarks?: FileDiffLayoutProps["fileMarks"];
  /** In the page's flow: sized by its content, never a scroller of its own. */
  flow?: boolean;
}) {
  const [searchQuery, setSearchQuery] = useState("");

  const strippedFiles = useMemo(() => stripCommonPrefix(files), [files]);

  const allDirPaths = useMemo(() => {
    const dirs = new Set<string>();
    for (const file of strippedFiles) {
      const parts = file.filename.split("/");
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts.slice(0, i).join("/"));
      }
    }
    return dirs;
  }, [strippedFiles]);

  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  useWatchEffect(() => {
    setExpandedDirs(allDirPaths);
  }, [allDirPaths]);

  const filteredFiles = useMemo(() => {
    if (!searchQuery.trim()) return strippedFiles;
    const query = searchQuery.toLowerCase();
    return strippedFiles.filter((f) => f.filename.toLowerCase().includes(query));
  }, [strippedFiles, searchQuery]);

  const fileTree = useMemo(() => buildFileTreeFromStripped(filteredFiles), [filteredFiles]);

  const toggleDir = (path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const expandAll = () => setExpandedDirs(new Set(allDirPaths));
  const collapseAll = () => setExpandedDirs(new Set());

  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);
  const viewedCount = fileMarks
    ? files.filter((f) => fileMarks(f.originalFilename ?? f.filename)?.viewed).length
    : 0;

  return (
    <div className={flow ? "flex flex-col bg-sol-bg rounded-lg border border-sol-border/70 overflow-clip" : "h-full flex flex-col bg-sol-bg border-r border-sol-border"}>
      {header}
      <div className={cn("px-3 py-2 border-b border-sol-border/50 bg-sol-bg-alt/30", flow && files.length <= 5 && "hidden")}>
        <div className={cn("flex items-center justify-between", flow && "hidden")}>
          <div>
            <div className="text-xs text-sol-text-muted">
              {filteredFiles.length === files.length
                ? `${files.length} ${files.length === 1 ? "file" : "files"} changed`
                : `${filteredFiles.length} of ${files.length} files`}
              {viewedCount > 0 && (
                <span className="ml-1.5 text-sol-green">{viewedCount} viewed</span>
              )}
            </div>
            <div className="text-xs mt-0.5">
              <span className="text-sol-green font-medium">+{totalAdditions}</span>
              <span className="text-sol-text-dim mx-1">/</span>
              <span className="text-sol-red font-medium">-{totalDeletions}</span>
            </div>
            {commonPrefix && (
              <div className="text-xs mt-1 font-mono text-sol-text-dim truncate" title={commonPrefix}>
                {shortenPrefix(commonPrefix)}/
              </div>
            )}
          </div>
          <div className="flex items-center gap-0.5">
            <button
              onClick={expandAll}
              className="p-1 rounded hover:bg-sol-bg-alt/50 text-sol-text-dim hover:text-sol-text-muted transition-colors"
              title="Expand all"
            >
              <ChevronsUpDown className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={collapseAll}
              className="p-1 rounded hover:bg-sol-bg-alt/50 text-sol-text-dim hover:text-sol-text-muted transition-colors"
              title="Collapse all"
            >
              <ChevronsDownUp className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
        {files.length > 5 && (
          <div className={cn("relative", !flow && "mt-2")}>
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-sol-text-dim" />
            <input
              type="text"
              placeholder="Filter files..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-7 pl-7 pr-7 text-xs bg-sol-bg border border-sol-border/50 rounded focus:outline-none focus:ring-1 focus:ring-sol-violet/50"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-sol-text-dim hover:text-sol-text-muted"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        )}
      </div>
      <div className={flow ? "py-1" : "flex-1 overflow-y-auto py-1"}>
        {fileTree.map((node) => (
          <FileTreeItem
            fileMarks={fileMarks}
            key={node.path}
            node={node}
            selectedFile={selectedFile}
            onSelect={onSelectFile}
            expandedDirs={expandedDirs}
            onToggleDir={toggleDir}
            selectedFileRef={selectedFileRef}
          />
        ))}
        {filteredFiles.length === 0 && searchQuery && (
          <div className="px-3 py-4 text-xs text-sol-text-dim text-center">
            No files match "{searchQuery}"
          </div>
        )}
      </div>
    </div>
  );
}
