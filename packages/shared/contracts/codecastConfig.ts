// codecast.json: a product's committed codecast configuration
// (docs/architecture/external-data.md X1, "Committed config"). It replaces
// every env var a product used to set for codecast:
//
//   {
//     "endpoint": "https://convex.codecast.sh/cli/ingest",   optional; prod when absent
//     "ingestKey": "cc_ing_...",                               optional; the keyed source's write-only key
//     "sources": { "<name>": { "id": "src-N", "workspace": "team:<id>" } }
//   }
//
// Nothing in it is a secret. The ingest key only writes into one source, and
// ships in browser bundles by design, like a Sentry DSN. The sources name
// which codecast sources may call the app (a verifier accepts a signed
// request only for one of them, codecastSignature.ts).
//
// `cast sources add` writes it (mergeCodecastConfig); the platform SDK, the
// verifier and Union's client read it. Pure: the readers own their file IO.

import { CODECAST_KEYS_PATH } from "./codecastSignature";

export const CODECAST_CONFIG_FILE = "codecast.json";

/** Codecast's prod ingest door, when a file names no endpoint. */
export const DEFAULT_CODECAST_ENDPOINT = "https://convex.codecast.sh/cli/ingest";

export interface CodecastConfigSource {
  id: string;
  workspace: string;
}

export interface CodecastConfig {
  endpoint?: string;
  ingestKey?: string;
  sources: Record<string, CodecastConfigSource>;
}

const SOURCE_ID = /^src-\d+$/;
const WORKSPACE = /^(team|user):[A-Za-z0-9_-]+$/;
const INGEST_KEY = /^cc_ing_[A-Za-z0-9_-]+$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A codecast.json as read, checked, or every problem with it. Unknown keys are refused: a misplaced secret must not ride in quietly. */
export function parseCodecastConfig(raw: unknown): { ok: true; config: CodecastConfig } | { ok: false; errors: string[] } {
  if (!isObject(raw)) return { ok: false, errors: ["codecast.json is not a JSON object"] };
  const errors: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!["$schema", "endpoint", "ingestKey", "sources"].includes(key)) errors.push(`unknown key "${key}"`);
  }
  const config: CodecastConfig = { sources: {} };
  if (raw.endpoint !== undefined) {
    if (typeof raw.endpoint !== "string" || !/^https?:\/\/[^\s]+$/.test(raw.endpoint)) errors.push("endpoint must be an http(s) URL");
    else config.endpoint = raw.endpoint.replace(/\/+$/, "");
  }
  if (raw.ingestKey !== undefined) {
    if (typeof raw.ingestKey !== "string" || !INGEST_KEY.test(raw.ingestKey)) errors.push("ingestKey must be a cc_ing_ key");
    else config.ingestKey = raw.ingestKey;
  }
  if (raw.sources !== undefined && !isObject(raw.sources)) errors.push("sources must be an object of name to { id, workspace }");
  for (const [name, s] of Object.entries(isObject(raw.sources) ? raw.sources : {})) {
    if (!isObject(s) || typeof s.id !== "string" || !SOURCE_ID.test(s.id) || typeof s.workspace !== "string" || !WORKSPACE.test(s.workspace)) {
      errors.push(`sources.${name} must be { "id": "src-N", "workspace": "team:<id>" or "user:<id>" }`);
      continue;
    }
    config.sources[name] = { id: s.id, workspace: s.workspace };
  }
  return errors.length ? { ok: false, errors } : { ok: true, config };
}

/**
 * The file after `cast sources add` (or `key rotate`) made a source: the
 * source recorded under its name, a keyed source's new key in `ingestKey`,
 * and the endpoint kept only when it is not prod. Returns what changed, for
 * the command to print.
 */
export function mergeCodecastConfig(
  existing: CodecastConfig | null,
  add: { name: string; source: CodecastConfigSource; ingestKey?: string; endpoint?: string },
): { config: CodecastConfig; changes: string[] } {
  const config: CodecastConfig = { ...(existing ?? {}), sources: { ...(existing?.sources ?? {}) } };
  const changes: string[] = [];
  const prior = config.sources[add.name];
  if (!prior || prior.id !== add.source.id || prior.workspace !== add.source.workspace) {
    config.sources[add.name] = add.source;
    changes.push(`sources.${add.name} = ${add.source.id} (${add.source.workspace})`);
  }
  if (add.ingestKey && config.ingestKey !== add.ingestKey) {
    changes.push(config.ingestKey ? `ingestKey replaced (was ${config.ingestKey.slice(0, 12)}...)` : "ingestKey set");
    config.ingestKey = add.ingestKey;
  }
  const endpoint = add.endpoint?.replace(/\/+$/, "");
  if (endpoint && endpoint !== (config.endpoint ?? DEFAULT_CODECAST_ENDPOINT)) {
    config.endpoint = endpoint;
    changes.push(`endpoint = ${endpoint}`);
  }
  // Stable key order: endpoint, ingestKey, sources, so diffs of the committed file stay small.
  const ordered: CodecastConfig = {
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.ingestKey ? { ingestKey: config.ingestKey } : {}),
    sources: Object.fromEntries(Object.keys(config.sources).sort().map((k) => [k, config.sources[k]])),
  };
  return { config: ordered, changes };
}

export function formatCodecastConfig(config: CodecastConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** The ingest door a config posts to. */
export function codecastEndpointOf(config: Pick<CodecastConfig, "endpoint"> | null | undefined): string {
  return (config?.endpoint || DEFAULT_CODECAST_ENDPOINT).replace(/\/+$/, "");
}

/** Where a config's codecast publishes its signing keys: the endpoint's origin. */
export function codecastKeysUrlOf(config: Pick<CodecastConfig, "endpoint"> | null | undefined): string {
  return `${new URL(codecastEndpointOf(config)).origin}${CODECAST_KEYS_PATH}`;
}
