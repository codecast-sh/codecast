type ProjectBackedDoc = {
  project_path?: string | null;
  source_file?: string | null;
};

function normalizePath(path: string): string {
  return path.replace(/\/+$/, "");
}

function normalizeToRoot(path: string): string {
  const parts = normalizePath(path).split("/");
  const srcIndex = parts.findIndex((p) => p === "src" || p === "projects" || p === "repos" || p === "code");
  if (srcIndex >= 0 && srcIndex < parts.length - 1) {
    return parts.slice(0, srcIndex + 2).join("/");
  }
  return normalizePath(path);
}

function projectName(path: string): string {
  return normalizeToRoot(path).split("/").filter(Boolean).pop() || path;
}

function pathMatchesProject(candidate: string | null | undefined, projectFilter: string): boolean {
  if (!candidate) return false;
  const path = normalizePath(candidate);
  const filter = normalizePath(projectFilter);
  return (
    path === filter ||
    path.startsWith(`${filter}/`) ||
    filter.startsWith(`${path}/`) ||
    projectName(path) === projectName(filter)
  );
}

export function docMatchesProjectFilter(doc: ProjectBackedDoc, projectFilter: string): boolean {
  if (!projectFilter) return true;
  return pathMatchesProject(doc.project_path, projectFilter) || pathMatchesProject(doc.source_file, projectFilter);
}
