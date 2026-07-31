// Pure helpers for the artifact gallery cards — kept free of React imports so
// unit tests can exercise them without the component graph.

export function relativeTime(ts?: number | null): string | null {
  if (!ts) return null;
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

// The owner edit link: ?edit=1 must be a QUERY param (cache-key-relevant,
// forwarded to origin) while the #o= owner key stays in the fragment (never
// sent to servers/logs) — so insert the param before the hash.
export function withEditParam(manageUrl: string): string {
  const hashAt = manageUrl.indexOf("#");
  if (hashAt === -1) return `${manageUrl}?edit=1`;
  return `${manageUrl.slice(0, hashAt)}?edit=1${manageUrl.slice(hashAt)}`;
}
