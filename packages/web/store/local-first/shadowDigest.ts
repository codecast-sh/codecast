export type ShadowDigestRow = {
  key: string;
  value: unknown;
};

export type ShadowDigest = {
  contractId: string;
  viewKey: string;
  rowCount: number;
  digest: string;
};

export type ShadowComparison = {
  contractId: string;
  viewKey: string;
  equal: boolean;
  authoritativeRowCount: number;
  materializedRowCount: number;
  authoritativeDigest: string;
  materializedDigest: string;
};

function stableJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Shadow digests require finite numbers");
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Shadow digests cannot encode cyclic arrays");
    seen.add(value);
    const encoded = `[${value.map((item) => stableJson(item, seen)).join(",")}]`;
    seen.delete(value);
    return encoded;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (seen.has(record)) throw new TypeError("Shadow digests cannot encode cyclic objects");
    seen.add(record);
    const encoded = `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key], seen)}`)
      .join(",")}}`;
    seen.delete(record);
    return encoded;
  }
  throw new TypeError(`Shadow digests cannot encode ${typeof value}`);
}

async function sha256(value: string): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("SHA-256 is unavailable for local-first shadow validation");
  }
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Produces only a count and one-way digest. Callers may emit this result as
 * telemetry; protected rows and field-level differences never leave the local
 * comparison boundary.
 */
export async function digestShadowRows(input: {
  contractId: string;
  viewKey: string;
  rows: readonly ShadowDigestRow[];
}): Promise<ShadowDigest> {
  const sorted = [...input.rows].sort((left, right) => left.key.localeCompare(right.key));
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index - 1].key === sorted[index].key) {
      throw new Error(`Duplicate shadow row key: ${sorted[index].key}`);
    }
  }
  const canonical = stableJson({
    contractId: input.contractId,
    viewKey: input.viewKey,
    rows: sorted,
  });
  return {
    contractId: input.contractId,
    viewKey: input.viewKey,
    rowCount: sorted.length,
    digest: `sha256:${await sha256(canonical)}`,
  };
}

export async function compareShadowRows(input: {
  contractId: string;
  viewKey: string;
  authoritative: readonly ShadowDigestRow[];
  materialized: readonly ShadowDigestRow[];
}): Promise<ShadowComparison> {
  const [authoritative, materialized] = await Promise.all([
    digestShadowRows({
      contractId: input.contractId,
      viewKey: input.viewKey,
      rows: input.authoritative,
    }),
    digestShadowRows({
      contractId: input.contractId,
      viewKey: input.viewKey,
      rows: input.materialized,
    }),
  ]);
  return {
    contractId: input.contractId,
    viewKey: input.viewKey,
    equal: authoritative.digest === materialized.digest,
    authoritativeRowCount: authoritative.rowCount,
    materializedRowCount: materialized.rowCount,
    authoritativeDigest: authoritative.digest,
    materializedDigest: materialized.digest,
  };
}
