// Convex rejects a field name outside printable ASCII, so a payload built from
// stored data drops any such key before a query returns it.

function isValidConvexFieldName(key: string): boolean {
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

export function sanitizeConvexObjectKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeConvexObjectKeys(item)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (!isValidConvexFieldName(key)) continue;
      out[key] = sanitizeConvexObjectKeys(child);
    }
    return out as T;
  }
  return value;
}
