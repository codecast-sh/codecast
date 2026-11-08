import { conversationProjectRoot } from "@codecast/convex/convex/projectPaths";

type ProjectBackedDoc = {
  project_path?: string | null;
  source_file?: string | null;
};

function normalizePath(path: string): string {
  return path.replace(/\/+$/, "");
}

/** The repository folder name a path belongs to (conversationProjectRoot over
 *  the checkouts the viewer's sessions name), else the path's own folder. */
function projectName(path: string, checkouts: Iterable<string>): string {
  const root = conversationProjectRoot({ project_path: path }, checkouts) ?? normalizePath(path);
  return root.split("/").filter(Boolean).pop() || path;
}

function pathMatchesProject(candidate: string | null | undefined, projectFilter: string, checkouts: Iterable<string>): boolean {
  if (!candidate) return false;
  const path = normalizePath(candidate);
  const filter = normalizePath(projectFilter);
  return (
    path === filter ||
    path.startsWith(`${filter}/`) ||
    filter.startsWith(`${path}/`) ||
    projectName(path, checkouts) === projectName(filter, checkouts)
  );
}

export function docMatchesProjectFilter(doc: ProjectBackedDoc, projectFilter: string, checkouts: Iterable<string> = []): boolean {
  if (!projectFilter) return true;
  return pathMatchesProject(doc.project_path, projectFilter, checkouts) || pathMatchesProject(doc.source_file, projectFilter, checkouts);
}
