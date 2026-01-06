"use client";

import { useState, useEffect, useMemo } from "react";
import { Panel, Group, Separator } from "react-resizable-panels";
import { ChevronRight, ChevronDown, FileText, Keyboard, MessageSquare } from "lucide-react";
import { Button } from "./ui/button";
import { KeyboardShortcutsHelp } from "./KeyboardShortcutsHelp";
import { DiffView } from "./DiffView";
import { parsePatch, getFileStatus } from "../lib/patchParser";
import { cn } from "../lib/utils";

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
  title: string;
  subtitle?: React.ReactNode;
  headerExtra?: React.ReactNode;
  sidebarHeader?: React.ReactNode;
  onFileComment?: (filename: string, lineNumber?: number) => void;
  renderFileExtra?: (file: DiffFile) => React.ReactNode;
}

const STORAGE_KEY = "file-diff-layout";

const getInitialLayout = (): number[] => {
  if (typeof window === "undefined") return [25, 75];
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length === 2) {
        return parsed;
      }
    } catch {}
  }
  return [25, 75];
};

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

interface FileTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children: FileTreeNode[];
  file?: DiffFile;
}

function buildFileTree(files: DiffFile[]): FileTreeNode[] {
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
}: {
  node: FileTreeNode;
  selectedFile: string | null;
  onSelect: (filename: string) => void;
  depth?: number;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
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
            />
          ))}
      </div>
    );
  }

  return (
    <button
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
}: {
  files: DiffFile[];
  selectedFile: string | null;
  onSelectFile: (filename: string) => void;
  header?: React.ReactNode;
}) {
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => {
    const dirs = new Set<string>();
    for (const file of files) {
      const parts = file.filename.split("/");
      for (let i = 1; i < parts.length; i++) {
        dirs.add(parts.slice(0, i).join("/"));
      }
    }
    return dirs;
  });

  const fileTree = useMemo(() => buildFileTree(files), [files]);

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

  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

  return (
    <div className="h-full flex flex-col bg-sol-bg border-r border-sol-border">
      {header}
      <div className="px-3 py-2 border-b border-sol-border/50 bg-sol-bg-alt/30">
        <div className="text-xs text-sol-text-muted">
          {files.length} {files.length === 1 ? "file" : "files"} changed
        </div>
        <div className="text-xs mt-0.5">
          <span className="text-sol-green font-medium">+{totalAdditions}</span>
          <span className="text-sol-text-dim mx-1">/</span>
          <span className="text-sol-red font-medium">-{totalDeletions}</span>
        </div>
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
          />
        ))}
      </div>
    </div>
  );
}

function FileDiffContent({
  file,
  onComment,
  renderExtra,
}: {
  file: DiffFile | null;
  onComment?: (filename: string, lineNumber?: number) => void;
  renderExtra?: (file: DiffFile) => React.ReactNode;
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

  if (!file.patch) {
    return (
      <div className="h-full overflow-auto">
        <div className="sticky top-0 z-10 bg-sol-bg border-b border-sol-border px-4 py-3">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "w-5 h-5 rounded text-[11px] font-bold flex items-center justify-center",
                status.bgColor,
                status.color
              )}
            >
              {status.label}
            </span>
            <h3 className="font-mono text-sm font-medium text-sol-text truncate">
              {file.filename}
            </h3>
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

  const { oldContent, newContent } = parsePatch(file.patch);

  return (
    <div className="h-full overflow-auto">
      <div className="sticky top-0 z-10 bg-sol-bg border-b border-sol-border px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
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
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {onComment && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => onComment(file.filename)}
              >
                <MessageSquare className="w-3 h-3 mr-1" />
                Comment
              </Button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 mt-1 text-xs text-sol-text-muted">
          <span>
            <span className="text-sol-green">+{file.additions}</span>
            <span className="mx-1">/</span>
            <span className="text-sol-red">-{file.deletions}</span>
          </span>
          {language && <span className="text-sol-text-dim">{language}</span>}
        </div>
      </div>
      <div className="p-4">
        <div className="rounded overflow-hidden border border-sol-border/30 bg-sol-bg-alt">
          <DiffView
            oldStr={oldContent}
            newStr={newContent}
            language={language}
            contextLines={3}
            maxLines={100}
          />
        </div>
      </div>
      {renderExtra && renderExtra(file)}
    </div>
  );
}

export function FileDiffLayout({
  files,
  title,
  subtitle,
  headerExtra,
  sidebarHeader,
  onFileComment,
  renderFileExtra,
}: FileDiffLayoutProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(
    files.length > 0 ? files[0].filename : null
  );
  const [showHelp, setShowHelp] = useState(false);
  const [layout, setLayout] = useState(getInitialLayout);
  const [currentFileIndex, setCurrentFileIndex] = useState(0);

  useEffect(() => {
    if (files.length > 0 && !selectedFile) {
      setSelectedFile(files[0].filename);
      setCurrentFileIndex(0);
    }
  }, [files, selectedFile]);

  useEffect(() => {
    const index = files.findIndex((f) => f.filename === selectedFile);
    if (index >= 0) {
      setCurrentFileIndex(index);
    }
  }, [selectedFile, files]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
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
          if (currentFileIndex < files.length - 1) {
            const nextFile = files[currentFileIndex + 1];
            setSelectedFile(nextFile.filename);
            setCurrentFileIndex(currentFileIndex + 1);
          }
          break;
        case "k":
        case "[":
          e.preventDefault();
          if (currentFileIndex > 0) {
            const prevFile = files[currentFileIndex - 1];
            setSelectedFile(prevFile.filename);
            setCurrentFileIndex(currentFileIndex - 1);
          }
          break;
        case "?":
          e.preventDefault();
          setShowHelp((prev) => !prev);
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentFileIndex, files]);

  const handleLayoutChange = (sizes: number[]) => {
    setLayout(sizes);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes));
  };

  const selectedFileData = files.find((f) => f.filename === selectedFile) || null;

  if (files.length === 0) {
    return (
      <div className="h-full flex flex-col">
        <div className="border-b border-sol-border px-4 py-3 bg-sol-bg">
          <h1 className="text-lg font-semibold text-sol-text">{title}</h1>
          {subtitle && <div className="mt-1">{subtitle}</div>}
        </div>
        <div className="flex-1 flex items-center justify-center text-sol-text-muted">
          <div className="text-center">
            <FileText className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>No files changed</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="border-b border-sol-border px-4 py-3 bg-sol-bg flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-lg font-semibold text-sol-text">{title}</h1>
          {subtitle && <div className="mt-1">{subtitle}</div>}
        </div>
        <div className="flex items-center gap-2">
          {headerExtra}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 opacity-50 hover:opacity-100"
            onClick={() => setShowHelp(true)}
            title="Keyboard shortcuts (?)"
          >
            <Keyboard className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        <Group
          orientation="horizontal"
          onLayoutChange={handleLayoutChange}
          defaultLayout={layout}
          className="h-full"
        >
          <Panel id="file-tree" minSize={15} maxSize={40}>
            <FileSidebar
              files={files}
              selectedFile={selectedFile}
              onSelectFile={setSelectedFile}
              header={sidebarHeader}
            />
          </Panel>

          <Separator className="w-1 bg-sol-border hover:bg-sol-cyan data-[resize-handle-active]:bg-sol-cyan cursor-col-resize transition-colors" />

          <Panel id="diff-content" minSize={40}>
            <FileDiffContent
              file={selectedFileData}
              onComment={onFileComment}
              renderExtra={renderFileExtra}
            />
          </Panel>
        </Group>
      </div>

      <KeyboardShortcutsHelp isOpen={showHelp} onClose={() => setShowHelp(false)} />
    </div>
  );
}
