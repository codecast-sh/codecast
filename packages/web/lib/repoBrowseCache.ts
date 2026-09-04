export type RepoBrowseRow = {
  _id: string;
  scope: string;
  repository: string;
  kind: string;
  value: unknown;
  updated_at: number;
};

export function repoViewerScope(token: string | null | undefined, viewerId: string | undefined): string | null {
  if (!token || !viewerId) return null;
  const part = token.split(".")[1];
  if (!part || !/^[\w-]+$/.test(part)) return null;
  let subject: unknown;
  try {
    subject = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))).sub;
  } catch {
    return null;
  }
  if (typeof subject !== "string" || subject.split("|")[0] !== viewerId) return null;
  return subject;
}

export function repoBrowseKey(scope: string | null, kind: string, args: Record<string, unknown> | null): string | null {
  if (!scope || !args) return null;
  return JSON.stringify([scope, kind, Object.entries(args).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))]);
}

export function retainRepoBrowseRows(current: Record<string, RepoBrowseRow>, incoming: RepoBrowseRow): RepoBrowseRow[] {
  const rows = [incoming, ...Object.values(current)
    .filter((row) => row._id !== incoming._id && row.scope === incoming.scope)
    .sort((a, b) => b.updated_at - a.updated_at)];
  let bytes = 0;
  return rows.filter((row, index) => {
    bytes += JSON.stringify(row).length * 2;
    return index < 96 && (index === 0 || bytes <= 16 * 1024 * 1024);
  });
}
