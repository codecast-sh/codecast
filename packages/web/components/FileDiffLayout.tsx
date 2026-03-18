"use client";

import { useState, useMemo, useRef } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useEventListener } from "../hooks/useEventListener";
import { Panel, Group, Separator } from "react-resizable-panels";
import {
  ChevronRight,
  ChevronDown,
  FileText,
  Keyboard,

  Copy,
  Check,
  Search,
  X,
  ChevronsUpDown,
  ChevronsDownUp,
  PanelLeftClose,
  PanelLeft,
  PanelRightClose,
  LayoutList,
  SplitSquareVertical,
} from "lucide-react";
import { Button } from "./ui/button";
import { KeyboardShortcutsHelp } from "./KeyboardShortcutsHelp";
import { DiffView } from "./DiffView";
import { parsePatch, getFileStatus } from "../lib/patchParser";
import { cn, copyToClipboard } from "../lib/utils";
import { useInboxStore } from "../store/inboxStore";

export interface DiffFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface FileDiffLayoutProps {
  files: DiffFile[];
  title?: string;
  subtitle?: React.ReactNode;
  headerExtra?: React.ReactNode;
  sidebarHeader?: React.ReactNode;
  onFileComment?: (filename: string, lineNumber?: number) => void;
  renderFileExtra?: (file: DiffFile) => React.ReactNode;
  onCloseDiffPanel?: () => void;
}

type Layout = { [key: string]: number };
const DEFAULT_FILE_DIFF_LAYOUT = { tree: 25, content: 75 };

function getFileExtension(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    cpp: "cpp",
    c: "c",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
    html: "html",
    css: "css",
    scss: "scss",
    sql: "sql",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
  };
  return ext ? langMap[ext] : undefined;
}

function getFileName(filePath: string): string {
  return filePath.split("/").pop() || filePath;
}

function getFileDirectory(filePath: string): string {
  const parts = filePath.split("/");
  if (parts.length <= 1) return "";
  return parts.slice(0, -1).join("/");
}

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await copyToClipboard(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className={cn(
        "p-1 rounded hover:bg-sol-bg-alt/50 transition-colors",
        className
      )}
      title={copied ? "Copied!" : "Copy to clipboard"}
    >
      {copied ? (
        <Check className="w-3 h-3 text-sol-green" />
      ) : (
        <Copy className="w-3 h-3 text-sol-text-dim" />
      )}
    </button>
  );
}

interface FileTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children: FileTreeNode[];
  file?: DiffFile;
}

function shortenPrefix(prefix: string): string {
  if (!prefix) return prefix;
  const parts = prefix.split("/").filter(Boolean);
  // Detect home-dir-relative paths: /Users/x/src/project/... or /home/x/...
  // Show from the first directory after common base dirs (Users/x, home/x, etc.)
  const homeIdx = parts.findIndex(p => p === "Users" || p === "home");
  if (homeIdx >= 0) {
    // Skip Users/<name> or home/<name>, then show from next meaningful dir
    const startAfterHome = homeIdx + 2;
    if (startAfterHome < parts.length) {
      return parts.slice(startAfterHome).join("/");
    }
  }
  // For other absolute paths, just drop the leading slash structure
  // and show last 3-4 meaningful segments
  if (parts.length > 4) {
    return parts.slice(-4).join("/");
  }
  return parts.join("/");
}

function findCommonPrefix(paths: string[]): string {
  if (paths.length === 0) return "";
  if (paths.length === 1) {
    const parts = paths[0].split("/");
    return parts.slice(0, -1).join("/");
  }

  const splitPaths = paths.map(p => p.split("/"));
  const minLen = Math.min(...splitPaths.map(p => p.length));

  let commonParts: string[] = [];
  for (let i = 0; i < minLen - 1; i++) {
    const part = splitPaths[0][i];
    if (splitPaths.every(p => p[i] === part)) {
      commonParts.push(part);
    } else {
      break;
    }
  }

  return commonParts.join("/");
}

function stripCommonPrefix(files: DiffFile[]): DiffFile[] {
  const prefix = findCommonPrefix(files.map(f => f.filename));
  if (!prefix) return files;

  const prefixWithSlash = prefix + "/";
  return files.map(f => ({
    ...f,
    filename: f.filename.startsWith(prefixWithSlash)
      ? f.filename.slice(prefixWithSlash.length)
      : f.filename
  }));
}

function buildFileTreeFromStripped(files: DiffFile[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (const file of files) {
    const parts = file.filename.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join("/");

      let node = current.find((n) => n.name === part);

      if (!node) {
        node = {
          name: part,
          path,
          isDirectory: !isLast,
          children: [],
          file: isLast ? file : undefined,
        };
        current.push(node);
      }

      if (!isLast) {
        current = node.children;
      }
    }
  }

  const sortNodes = (nodes: FileTreeNode[]): FileTreeNode[] => {
    return nodes.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  };

  const sortRecursive = (nodes: FileTreeNode[]): FileTreeNode[] => {
    const sorted = sortNodes(nodes);
    for (const node of sorted) {
      if (node.children.length > 0) {
        node.children = sortRecursive(node.children);
      }
    }
    return sorted;
  };

  return sortRecursive(root);
}

function FileTreeItem({
  node,
  selectedFile,
  onSelect,
  depth = 0,
  expandedDirs,
  onToggleDir,
  selectedFileRef,
}: {
  node: FileTreeNode;
  selectedFile: string | null;
  onSelect: (filename: string) => void;
  depth?: number;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  selectedFileRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const isExpanded = expandedDirs.has(node.path);
  const isSelected = selectedFile === node.path;
  const status = node.file ? getFileStatus(node.file.status) : null;

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
            />
          ))}
      </div>
    );
  }

  return (
    <button
      ref={isSelected && selectedFileRef ? selectedFileRef as React.RefObject<HTMLButtonElement> : undefined}
      onClick={() => onSelect(node.path)}
      className={cn(
        "w-full flex items-center gap-2 py-1.5 px-2 text-sm transition-colors",
        isSelected
          ? "bg-sol-violet/20 text-sol-text border-l-2 border-sol-violet"
          : "hover:bg-sol-bg-alt/50 text-sol-text-muted"
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
      <span className="truncate">{node.name}</span>
      {node.file && (
        <span className="ml-auto text-[10px] text-sol-text-dim shrink-0">
          <span className="text-sol-green">+{node.file.additions}</span>
          <span className="mx-0.5">/</span>
          <span className="text-sol-red">-{node.file.deletions}</span>
        </span>
      )}
    </button>
  );
}

function FileSidebar({
  files,
  selectedFile,
  onSelectFile,
  header,
  selectedFileRef,
  commonPrefix,
}: {
  files: DiffFile[];
  selectedFile: string | null;
  onSelectFile: (filename: string) => void;
  header?: React.ReactNode;
  selectedFileRef?: React.RefObject<HTMLButtonElement | null>;
  commonPrefix?: string;
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

  return (
    <div className="h-full flex flex-col bg-sol-bg border-r border-sol-border">
      {header}
      <div className="px-3 py-2 border-b border-sol-border/50 bg-sol-bg-alt/30">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs text-sol-text-muted">
              {filteredFiles.length === files.length
                ? `${files.length} ${files.length === 1 ? "file" : "files"} changed`
                : `${filteredFiles.length} of ${files.length} files`}
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
          <div className="mt-2 relative">
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
      <div className="flex-1 overflow-y-auto py-1">
        {fileTree.map((node) => (
          <FileTreeItem
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

function FileDiffContent({
  file,
  onComment,
  renderExtra,
  fileIndex,
  totalFiles,
  onToggleSidebar,
  sidebarOpen,
}: {
  file: DiffFile | null;
  onComment?: (filename: string, lineNumber?: number) => void;
  renderExtra?: (file: DiffFile) => React.ReactNode;
  fileIndex?: number;
  totalFiles?: number;
  onToggleSidebar?: () => void;
  sidebarOpen?: boolean;
}) {
  if (!file) {
    return (
      <div className="h-full flex items-center justify-center text-sol-text-muted">
        <div className="text-center">
          <FileText className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Select a file to view changes</p>
        </div>
      </div>
    );
  }

  const status = getFileStatus(file.status);
  const language = getFileExtension(file.filename);
  const showNav = fileIndex !== undefined && totalFiles !== undefined;

  if (!file.patch) {
    return (
      <div className="h-full overflow-auto">
        <div className="sticky top-0 z-10 bg-sol-bg border-b border-sol-border px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              {onToggleSidebar && (
                <button
                  onClick={onToggleSidebar}
                  className="p-1 -ml-1 rounded hover:bg-sol-bg-alt/50 text-sol-text-dim hover:text-sol-text-muted transition-colors shrink-0"
                  title={sidebarOpen ? "Hide file tree (b)" : "Show file tree (b)"}
                >
                  {sidebarOpen ? (
                    <PanelLeftClose className="w-4 h-4" />
                  ) : (
                    <PanelLeft className="w-4 h-4" />
                  )}
                </button>
              )}
              <span
                className={cn(
                  "w-5 h-5 rounded text-[11px] font-bold flex items-center justify-center shrink-0",
                  status.bgColor,
                  status.color
                )}
              >
                {status.label}
              </span>
              <h3 className="font-mono text-sm font-medium text-sol-text truncate">
                {file.filename}
              </h3>
              <CopyButton text={file.filename} />
            </div>
            {showNav && (
              <div className="text-xs text-sol-text-dim shrink-0 ml-2">
                {fileIndex + 1} of {totalFiles}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-sol-text-muted">
            <span>
              <span className="text-sol-green">+{file.additions}</span>
              <span className="mx-1">/</span>
              <span className="text-sol-red">-{file.deletions}</span>
            </span>
          </div>
        </div>
        <div className="p-4">
          <div className="text-sol-text-muted text-sm">
            {file.status === "added"
              ? "Binary file or new file (no diff available)"
              : file.status === "removed" || file.status === "deleted"
              ? "File deleted"
              : "No changes to display"}
          </div>
        </div>
        {renderExtra && renderExtra(file)}
      </div>
    );
  }

  const { hunks } = parsePatch(file.patch);

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="sticky top-0 z-10 bg-sol-bg/95 backdrop-blur-sm border-b border-sol-border/30 px-3 py-1 flex items-center justify-between">
        <div className="flex items-center gap-1.5 min-w-0">
          {onToggleSidebar && (
            <button
              onClick={onToggleSidebar}
              className="p-0.5 -ml-0.5 rounded hover:bg-sol-bg-alt/50 text-sol-text-dim hover:text-sol-text-muted transition-colors shrink-0"
              title={sidebarOpen ? "Hide file tree (b)" : "Show file tree (b)"}
            >
              {sidebarOpen ? (
                <PanelLeftClose className="w-3.5 h-3.5" />
              ) : (
                <PanelLeft className="w-3.5 h-3.5" />
              )}
            </button>
          )}
          <span className={cn("text-[10px] font-bold shrink-0", status.color)}>
            {status.label}
          </span>
          <span className="font-mono text-xs text-sol-text-muted truncate">
            {file.filename}
          </span>
          <CopyButton text={file.filename} />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] text-sol-text-dim">
            <span className="text-sol-green">+{file.additions}</span>
            <span className="mx-0.5 text-sol-text-dim/30">/</span>
            <span className="text-sol-red">-{file.deletions}</span>
          </span>
          {showNav && (
            <span className="text-[11px] text-sol-text-dim/50">
              {fileIndex + 1}/{totalFiles}
            </span>
          )}
        </div>
      </div>
      <DiffView
        hunks={hunks}
        language={language}
        maxLines={100}
      />
      {renderExtra && renderExtra(file)}
    </div>
  );
}

function UnifiedDiffView({
  files,
  onComment,
  renderExtra,
}: {
  files: DiffFile[];
  onComment?: (filename: string, lineNumber?: number) => void;
  renderExtra?: (file: DiffFile) => React.ReactNode;
}) {
  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      {files.map((file, index) => {
        const status = getFileStatus(file.status);
        const language = getFileExtension(file.filename);
        const patchData = file.patch ? parsePatch(file.patch) : null;

        return (
          <div key={file.filename} className="overflow-hidden" id={`file-${index}`}>
            <div className="sticky top-0 z-10 bg-sol-bg/95 backdrop-blur-sm px-3 py-1 flex items-center justify-between border-b border-sol-border/30">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className={cn("text-[10px] font-bold shrink-0", status.color)}>
                  {status.label}
                </span>
                <span className="font-mono text-xs text-sol-text-muted truncate">
                  {file.filename}
                </span>
                <CopyButton text={file.filename} />
              </div>
              <span className="text-[11px] text-sol-text-dim shrink-0">
                <span className="text-sol-green">+{file.additions}</span>
                <span className="mx-0.5 text-sol-text-dim/30">/</span>
                <span className="text-sol-red">-{file.deletions}</span>
              </span>
            </div>
            {patchData ? (
              <DiffView
                hunks={patchData.hunks}
                language={language}
                maxLines={500}
              />
            ) : (
              <div className="text-sol-text-muted text-sm py-4 text-center">
                {file.status === "added"
                  ? "Binary file or new file (no diff available)"
                  : file.status === "removed" || file.status === "deleted"
                  ? "File deleted"
                  : "No changes to display"}
              </div>
            )}
            {renderExtra && renderExtra(file)}
          </div>
        );
      })}
    </div>
  );
}

const MOBILE_BREAKPOINT = 768;

type ViewMode = "split" | "unified";

export function FileDiffLayout({
  files,
  title,
  subtitle,
  headerExtra,
  sidebarHeader,
  onFileComment,
  renderFileExtra,
  onCloseDiffPanel,
}: FileDiffLayoutProps) {
  // Strip common prefix once for consistent comparisons
  const commonPrefix = useMemo(() => findCommonPrefix(files.map(f => f.filename)), [files]);
  const strippedFiles = useMemo(() => stripCommonPrefix(files), [files]);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const layoutPref = useInboxStore(s => s.clientState.layouts?.file_diff ?? DEFAULT_FILE_DIFF_LAYOUT);
  const updateLayout = useInboxStore(s => s.updateClientLayout);
  const updateUI = useInboxStore(s => s.updateClientUI);
  const layout: Layout = { "file-tree": layoutPref.tree, "diff-content": layoutPref.content };
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  const [isMobile, setIsMobile] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const viewMode = useInboxStore(s => s.clientState.ui?.file_diff_view_mode ?? "unified");
  const selectedFileRef = useRef<HTMLButtonElement>(null);

  const toggleViewMode = () => {
    updateUI({ file_diff_view_mode: viewMode === "split" ? "unified" : "split" });
  };

  useMountEffect(() => {
    const mobile = window.innerWidth < MOBILE_BREAKPOINT;
    setIsMobile(mobile);
    if (mobile) setSidebarOpen(false);
  });

  useEventListener("resize", () => {
    const mobile = window.innerWidth < MOBILE_BREAKPOINT;
    setIsMobile(mobile);
    if (mobile) setSidebarOpen(false);
  });

  useWatchEffect(() => {
    if (strippedFiles.length > 0 && !selectedFile) {
      setSelectedFile(strippedFiles[0].filename);
      setCurrentFileIndex(0);
    }
  }, [strippedFiles, selectedFile]);

  useWatchEffect(() => {
    const index = strippedFiles.findIndex((f) => f.filename === selectedFile);
    if (index >= 0) {
      setCurrentFileIndex(index);
    }
  }, [selectedFile, strippedFiles]);

  useWatchEffect(() => {
    if (selectedFileRef.current) {
      selectedFileRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [currentFileIndex]);

  useEventListener("keydown", (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const isInput =
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable;

    if (isInput) return;

    switch (e.key) {
      case "j":
      case "]":
        e.preventDefault();
        if (currentFileIndex < strippedFiles.length - 1) {
          const nextFile = strippedFiles[currentFileIndex + 1];
          setSelectedFile(nextFile.filename);
          setCurrentFileIndex(currentFileIndex + 1);
        }
        break;
      case "k":
      case "[":
        e.preventDefault();
        if (currentFileIndex > 0) {
          const prevFile = strippedFiles[currentFileIndex - 1];
          setSelectedFile(prevFile.filename);
          setCurrentFileIndex(currentFileIndex - 1);
        }
        break;
      case "b":
        e.preventDefault();
        setSidebarOpen((prev) => !prev);
        break;
      case "v":
        e.preventDefault();
        toggleViewMode();
        break;
      case "?":
        e.preventDefault();
        setShowHelp((prev) => !prev);
        break;
    }
  });

  const handleLayoutChange = (newLayout: Layout) => {
    updateLayout("file_diff", { tree: newLayout["file-tree"] || 25, content: newLayout["diff-content"] || 75 });
  };

  const handleSelectFile = (filename: string) => {
    setSelectedFile(filename);
    if (isMobile) setSidebarOpen(false);
  };

  const selectedFileData = strippedFiles.find((f) => f.filename === selectedFile) || null;

  const showHeader = title || subtitle || headerExtra;

  if (files.length === 0) {
    return (
      <div className="h-full flex flex-col">
        {showHeader && (
          <div className="border-b border-sol-border px-4 py-3 bg-sol-bg">
            {title && <h1 className="text-lg font-semibold text-sol-text">{title}</h1>}
            {subtitle && <div className="mt-1">{subtitle}</div>}
          </div>
        )}
        <div className="flex-1 flex items-center justify-center text-sol-text-muted">
          <div className="text-center">
            <FileText className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>No files changed</p>
          </div>
        </div>
      </div>
    );
  }

  const toggleSidebar = () => setSidebarOpen((prev) => !prev);

  const diffContentProps = {
    file: selectedFileData,
    onComment: onFileComment,
    renderExtra: renderFileExtra,
    fileIndex: currentFileIndex,
    totalFiles: files.length,
    onToggleSidebar: toggleSidebar,
    sidebarOpen,
  };

  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

  const viewModeButton = (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 gap-1.5 text-xs"
      onClick={toggleViewMode}
      title={viewMode === "unified" ? "Switch to split view (v)" : "Switch to unified view (v)"}
    >
      {viewMode === "unified" ? (
        <>
          <SplitSquareVertical className="w-4 h-4" />
          <span className="hidden sm:inline">Split</span>
        </>
      ) : (
        <>
          <LayoutList className="w-4 h-4" />
          <span className="hidden sm:inline">Unified</span>
        </>
      )}
    </Button>
  );

  if (viewMode === "unified") {
    return (
      <div className="h-full flex flex-col">
        <div className="px-4 py-2 border-b border-sol-border bg-sol-bg flex items-center justify-between shrink-0 gap-2">
          <div className="flex items-center gap-3 text-sm min-w-0 truncate">
            <span className="text-sol-text-muted shrink-0">
              {files.length} {files.length === 1 ? "file" : "files"} changed
            </span>
            <span className="text-sol-green font-medium shrink-0">+{totalAdditions}</span>
            <span className="text-sol-red font-medium shrink-0">-{totalDeletions}</span>
            {commonPrefix && (
              <span className="font-mono text-sol-text-dim text-xs truncate" title={commonPrefix}>
                {shortenPrefix(commonPrefix)}/
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {viewModeButton}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 opacity-50 hover:opacity-100"
              onClick={() => setShowHelp(true)}
              title="Keyboard shortcuts (?)"
            >
              <Keyboard className="h-4 w-4" />
            </Button>
            {onCloseDiffPanel && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 opacity-50 hover:opacity-100"
                onClick={onCloseDiffPanel}
                title="Close diff panel (d)"
              >
                <PanelRightClose className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
        <div className="flex-1 min-h-0">
          <UnifiedDiffView
            files={strippedFiles}
            onComment={onFileComment}
            renderExtra={renderFileExtra}
          />
        </div>
        <KeyboardShortcutsHelp isOpen={showHelp} onClose={() => setShowHelp(false)} />
      </div>
    );
  }

  const headerContent = showHeader ? (
    <div className="border-b border-sol-border px-4 py-3 bg-sol-bg flex items-center justify-between shrink-0 gap-2">
      <div className="min-w-0 truncate">
        {title && <h1 className="text-lg font-semibold text-sol-text truncate">{title}</h1>}
        {subtitle && <div className={cn("truncate", title ? "mt-1" : "")}>{subtitle}</div>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {headerExtra}
        {viewModeButton}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 opacity-50 hover:opacity-100"
          onClick={() => setShowHelp(true)}
          title="Keyboard shortcuts (?)"
        >
          <Keyboard className="h-4 w-4" />
        </Button>
        {onCloseDiffPanel && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 opacity-50 hover:opacity-100"
            onClick={onCloseDiffPanel}
            title="Close diff panel (d)"
          >
            <PanelRightClose className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  ) : (
    <div className="px-4 py-2 border-b border-sol-border bg-sol-bg flex items-center justify-end shrink-0 gap-2">
      <div className="flex items-center gap-1 shrink-0">
        {viewModeButton}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 opacity-50 hover:opacity-100"
          onClick={() => setShowHelp(true)}
          title="Keyboard shortcuts (?)"
        >
          <Keyboard className="h-4 w-4" />
        </Button>
        {onCloseDiffPanel && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 opacity-50 hover:opacity-100"
            onClick={onCloseDiffPanel}
            title="Close diff panel (d)"
          >
            <PanelRightClose className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <div className="h-full flex flex-col">
        {headerContent}
        <div className="flex-1 min-h-0 relative">
          {sidebarOpen && (
            <div className="absolute inset-0 z-20 bg-sol-bg">
              <FileSidebar
                files={strippedFiles}
                selectedFile={selectedFile}
                onSelectFile={handleSelectFile}
                header={sidebarHeader}
                selectedFileRef={selectedFileRef}
                commonPrefix={commonPrefix}
              />
            </div>
          )}
          <FileDiffContent {...diffContentProps} />
        </div>
        <KeyboardShortcutsHelp isOpen={showHelp} onClose={() => setShowHelp(false)} />
      </div>
    );
  }

  if (!sidebarOpen) {
    return (
      <div className="h-full flex flex-col">
        {headerContent}
        <div className="flex-1 min-h-0">
          <FileDiffContent {...diffContentProps} />
        </div>
        <KeyboardShortcutsHelp isOpen={showHelp} onClose={() => setShowHelp(false)} />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {headerContent}
      <div className="flex-1 min-h-0">
        <Group
          orientation="horizontal"
          onLayoutChange={handleLayoutChange}
          defaultLayout={layout}
          className="h-full"
        >
          <Panel id="file-tree" minSize={10}>
            <FileSidebar
              files={strippedFiles}
              selectedFile={selectedFile}
              onSelectFile={handleSelectFile}
              header={sidebarHeader}
              selectedFileRef={selectedFileRef}
              commonPrefix={commonPrefix}
            />
          </Panel>

          <Separator className="w-1.5 bg-sol-border/50 hover:bg-sol-cyan data-[resize-handle-active]:bg-sol-cyan cursor-col-resize transition-colors" />

          <Panel id="diff-content" minSize={30}>
            <FileDiffContent {...diffContentProps} />
          </Panel>
        </Group>
      </div>
      <KeyboardShortcutsHelp isOpen={showHelp} onClose={() => setShowHelp(false)} />
    </div>
  );
}
