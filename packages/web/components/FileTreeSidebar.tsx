"use client";

import { useDiffViewerStore } from "../store/diffViewerStore";
import { ChevronRight, ChevronDown } from "lucide-react";
import { useState } from "react";

interface TreeNode {
  name: string;
  fullPath: string;
  isFile: boolean;
  children: Map<string, TreeNode>;
  changeCount: number;
}

function getCommonPrefix(paths: string[]): string {
  if (paths.length === 0) return "";
  if (paths.length === 1) {
    const parts = paths[0].split("/");
    return parts.slice(0, -1).join("/");
  }

  const splitPaths = paths.map(p => p.split("/"));
  const minLen = Math.min(...splitPaths.map(p => p.length - 1));

  let commonParts: string[] = [];
  for (let i = 0; i < minLen; i++) {
    const part = splitPaths[0][i];
    if (splitPaths.every(p => p[i] === part)) {
      commonParts.push(part);
    } else {
      break;
    }
  }

  return commonParts.join("/");
}

function buildFileTree(filePaths: string[], changeCounts: Map<string, number>): TreeNode {
  const root: TreeNode = {
    name: "",
    fullPath: "",
    isFile: false,
    children: new Map(),
    changeCount: 0,
  };

  const prefix = getCommonPrefix(filePaths);
  const prefixLen = prefix ? prefix.length + 1 : 0;

  for (const path of filePaths) {
    const relativePath = path.slice(prefixLen);
    const parts = relativePath.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;

      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          fullPath: path,
          isFile,
          children: new Map(),
          changeCount: isFile ? (changeCounts.get(path) || 0) : 0,
        });
      }

      current = current.children.get(part)!;
    }
  }

  return root;
}

function FileTreeNode({
  node,
  depth = 0,
  selectedFile,
  onFileClick,
  getFileColor,
}: {
  node: TreeNode;
  depth?: number;
  selectedFile: string | null;
  onFileClick: (filePath: string) => void;
  getFileColor: (filePath: string) => string;
}) {
  const [isExpanded, setIsExpanded] = useState(true);

  if (node.isFile) {
    const isSelected = selectedFile === node.fullPath;
    const color = getFileColor(node.fullPath);

    return (
      <button
        onClick={() => onFileClick(node.fullPath)}
        className={`
          w-full text-left px-2 py-1 text-sm font-mono flex items-center gap-2
          hover:bg-accent rounded transition-colors
          ${isSelected ? "bg-accent" : ""}
        `}
        style={{ paddingLeft: `${depth * 8 + 4}px` }}
      >
        <div
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: color }}
        />
        <span className="flex-1 truncate">{node.name}</span>
        {node.changeCount > 0 && (
          <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded-full">
            {node.changeCount}
          </span>
        )}
      </button>
    );
  }

  const hasChildren = node.children.size > 0;

  return (
    <div>
      {node.name && (
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full text-left px-2 py-1 text-sm font-mono flex items-center gap-1 hover:bg-accent/50 rounded transition-colors"
          style={{ paddingLeft: `${depth * 8 + 4}px` }}
        >
          {hasChildren ? (
            isExpanded ? (
              <ChevronDown className="w-3 h-3 shrink-0" />
            ) : (
              <ChevronRight className="w-3 h-3 shrink-0" />
            )
          ) : (
            <span className="w-3" />
          )}
          <span className="text-muted-foreground">{node.name}/</span>
        </button>
      )}
      {isExpanded && (
        <div>
          {Array.from(node.children.values())
            .sort((a, b) => {
              if (a.isFile === b.isFile) return a.name.localeCompare(b.name);
              return a.isFile ? 1 : -1;
            })
            .map((child) => (
              <FileTreeNode
                key={child.fullPath}
                node={child}
                depth={depth + 1}
                selectedFile={selectedFile}
                onFileClick={onFileClick}
                getFileColor={getFileColor}
              />
            ))}
        </div>
      )}
    </div>
  );
}

export function FileTreeSidebar({ getFileColor }: { getFileColor: (filePath: string) => string }) {
  const { getFilesList, getSelectedChanges, selectedFile, selectFile } = useDiffViewerStore();

  const files = getFilesList();
  const selectedChanges = getSelectedChanges();

  const changeCounts = new Map<string, number>();
  for (const change of selectedChanges) {
    changeCounts.set(change.filePath, (changeCounts.get(change.filePath) || 0) + 1);
  }

  const tree = buildFileTree(files, changeCounts);

  const handleFileClick = (filePath: string) => {
    if (selectedFile === filePath) {
      selectFile(null);
    } else {
      selectFile(filePath);
    }
  };

  return (
    <div className="h-full w-64 border-r border-border bg-background overflow-y-auto">
      <div className="p-2 border-b border-border">
        <h3 className="text-sm font-semibold text-muted-foreground">FILES</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          {files.length} {files.length === 1 ? "file" : "files"}
        </p>
      </div>
      <div className="py-1">
        {Array.from(tree.children.values()).map((child) => (
          <FileTreeNode
            key={child.fullPath}
            node={child}
            depth={0}
            selectedFile={selectedFile}
            onFileClick={handleFileClick}
            getFileColor={getFileColor}
          />
        ))}
      </div>
    </div>
  );
}
