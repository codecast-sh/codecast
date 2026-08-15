// The MCP registry's wire format — parsing only, no network.
//
// Moved here from packages/cli/src/capabilities/registries.ts as that file's
// own header promised: Convex ingests the same bytes (the catalog refresh
// action) and cannot import the CLI package. The CLI keeps the fetch loop and
// re-exports these types, so both sides parse the registry with ONE function.
//
// A client for the official MCP registry — the one public catalog worth reading.
//
// `https://registry.modelcontextprotocol.io` is open, needs no credentials, and
// supports incremental sync (`updated_since`) plus cursor pagination. We mirror
// its metadata and keep its provenance block; we never republish it as ours.
//
// The module is split in two on purpose. Everything above "Fetching" is pure
// parsing and normalising, so the shapes can be tested against recorded
// responses with no network at all (`__fixtures__/mcp-registry-page-*.json`).
// Everything below is one bounded fetch and one cursor loop, both total: a slow,
// missing or malformed registry yields an empty list and a phrase saying why.
//
// The pure half is written to move to `packages/shared/contracts/` unchanged.
// Convex parses the same bytes — the daemon submits raw observations and a
// mutation derives the execution surfaces (design §6.2) — and Convex cannot
// import this package. Keep new parsing above the line and new network work
// below it, and that move stays a file split with no logic in it.
//
// Verified live, 2026-08-13 (and recorded into the fixtures):
//
//   * `?version=latest` is MANDATORY. Without it the registry returns one row
//     per VERSION: a plain `?limit=100` gave 100 rows holding 65 distinct
//     servers, with duplicates split across page boundaries so per page dedupe
//     would not save it.
//   * Unknown query parameters are IGNORED, not rejected. `?isLatest=true`
//     returns 200 and behaves exactly like a bogus parameter, so a wrong
//     parameter name fails as duplicate rows rather than as an error. The list
//     loop therefore dedupes by name as a belt to that brace, and the tests
//     assert uniqueness.
//   * An invalid cursor is ALSO accepted silently and answers from somewhere
//     else in the catalog, so the loop stops on a repeated cursor and caps its
//     pages rather than trusting the server to end the walk.
//   * `status` is `active` or `deprecated`; the `_meta` key is the full
//     reverse-DNS string and must be looked up literally.
//   * A server may declare `remotes` (a URL), `packages` (something to run), or
//     neither. Nothing may assume a URL exists.
//   * Every declared environment variable and header carries `isRequired` and
//     `isSecret` SEPARATELY. They are different questions — an optional log level
//     is required=false secret=false, a mandatory tenant id is required=true
//     secret=false — and collapsing them tells a consent screen that a server
//     wants credentials when it wants a log level.
//
// Identity is not minted here, for the same reason as `nativeCatalog.ts`: the
// capability slug is built by the ingest layer from a source it determined
// itself (`formatCapabilitySlug`, `packages/shared/contracts/capabilities.ts`).
// This module reports the registry's own namespaced name, which is the fact.


export const MCP_REGISTRY_BASE_URL = "https://registry.modelcontextprotocol.io";

/** The `_meta` block the official registry attaches. A literal key: the leading
 *  segment is a reverse-DNS namespace, and a prefix guess would match a
 *  different registry's block one day. */
export const OFFICIAL_META_KEY = "io.modelcontextprotocol.registry/official";

/* --------------------------------------------------------------------------
 * Shapes
 * -------------------------------------------------------------------------- */

/** Publication status. `unknown` covers a value the registry adds later — a new
 *  status must not silently read as `active`. */
export type McpServerStatus = "active" | "deprecated" | "deleted" | "unknown";

/**
 * A value the publisher says the user has to supply — an environment variable or
 * a request header. The two flags answer different questions and the registry
 * keeps them apart, so we do too: `isRequired` decides whether the server starts
 * at all, `isSecret` decides whether a consent screen is asking for a credential.
 *
 * The name is kept, never a value: the registry publishes descriptions of these
 * variables, and a name is what a consent screen needs to list.
 */
export interface McpDeclaredValue {
  name: string;
  isRequired: boolean;
  isSecret: boolean;
}

/** A way to reach a running server over the network. */
export interface McpRemote {
  /** `streamable-http` or `sse`. */
  type: string;
  url: string;
  /** Headers the publisher declared. */
  headers: McpDeclaredValue[];
  /** True when one of those headers is a secret — an API key in practice. The
   *  library shows it before anyone installs, because it is the difference
   *  between "works" and "works once you have an account". */
  requiresAuth: boolean;
}

/**
 * One argument in the command a package would run.
 *
 * Kept, rather than dropped as detail, because the execution surface is derived
 * from the command itself (`mcp_stdio_command`, `EXECUTION_SURFACES` in
 * `packages/shared/contracts/capabilities.ts`) and the arguments are half of that
 * command. A `value` may hold a `{placeholder}` the user fills in.
 */
export interface McpPackageArgument {
  kind: "positional" | "named";
  /** The flag, for a named argument (`--port`). */
  name?: string;
  value?: string;
  isRequired: boolean;
}

/** Something the user's machine would install and run locally. */
export interface McpPackage {
  /** `npm`, `pypi`, `oci`, … */
  registryType: string;
  identifier: string;
  version?: string;
  /** The tool that runs it (`npx`, `uvx`, `docker`). Publisher supplied, and the
   *  first word of the command line an ingest layer reconstructs. */
  runtimeHint?: string;
  /** Digest of the published artifact, when the publisher gave one. A pin —
   *  `CapabilityPin.folderHash` is the same idea for a file tree. */
  fileSha256?: string;
  /** `stdio` or a network transport. */
  transport: string;
  /** Arguments to the runtime, before the package name (`docker run -i …`). */
  runtimeArguments: McpPackageArgument[];
  /** Arguments to the package itself, after it. */
  packageArguments: McpPackageArgument[];
  /** Every declared environment variable, in one list rather than split into
   *  required/optional/secret arrays that could disagree with each other. */
  env: McpDeclaredValue[];
}

export interface McpRegistryServer {
  /** The namespaced identity (`ai.smithery/foo`, `io.github.bar/baz`). Stable;
   *  `title` is a label and may be missing. */
  name: string;
  title?: string;
  description?: string;
  version?: string;
  status: McpServerStatus;
  /** Why a deprecated server was deprecated, when the publisher said. */
  statusMessage?: string;
  isLatest: boolean;
  publishedAt?: string;
  updatedAt?: string;
  repositoryUrl?: string;
  websiteUrl?: string;
  remotes: McpRemote[];
  packages: McpPackage[];
}

export interface McpRegistryPage {
  servers: McpRegistryServer[];
  /** Absent on the last page. A `name:version` string, not opaque. */
  nextCursor?: string;
}

/* --------------------------------------------------------------------------
 * Parsing
 * -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function statusOf(value: unknown): McpServerStatus {
  return value === "active" || value === "deprecated" || value === "deleted" ? value : "unknown";
}

/** Environment variables and headers share one shape in the registry's schema,
 *  so they share one parser here. An absent flag reads as false: the publisher
 *  did not claim it, and inventing "required" or "secret" would either block an
 *  install or cry wolf on a consent screen. */
function parseDeclaredValues(value: unknown): McpDeclaredValue[] {
  if (!Array.isArray(value)) return [];
  const out: McpDeclaredValue[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const name = text(raw.name);
    if (!name) continue;
    out.push({ name, isRequired: raw.isRequired === true, isSecret: raw.isSecret === true });
  }
  return out;
}

function parseArguments(value: unknown): McpPackageArgument[] {
  if (!Array.isArray(value)) return [];
  const out: McpPackageArgument[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const name = text(raw.name);
    const argValue = text(raw.value) ?? text(raw.valueHint);
    // An argument with neither a flag nor a value contributes nothing to the
    // command line, and a row that says nothing is worse than no row.
    if (!name && !argValue) continue;
    out.push({
      kind: raw.type === "named" ? "named" : "positional",
      ...(name ? { name } : {}),
      ...(argValue ? { value: argValue } : {}),
      isRequired: raw.isRequired === true,
    });
  }
  return out;
}

function parseRemotes(value: unknown): McpRemote[] {
  if (!Array.isArray(value)) return [];
  const out: McpRemote[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const url = text(raw.url);
    if (!url) continue;
    const headers = parseDeclaredValues(raw.headers);
    out.push({
      type: text(raw.type) ?? "streamable-http",
      url,
      headers,
      // Only a SECRET header means an account is needed. A required-but-open
      // header (a tenant id, an api version) is something the user supplies from
      // what they already know.
      requiresAuth: headers.some((h) => h.isSecret),
    });
  }
  return out;
}

function parsePackages(value: unknown): McpPackage[] {
  if (!Array.isArray(value)) return [];
  const out: McpPackage[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const identifier = text(raw.identifier);
    if (!identifier) continue;
    const transport = isRecord(raw.transport) ? text(raw.transport.type) : undefined;
    const version = text(raw.version);
    const runtimeHint = text(raw.runtimeHint);
    const fileSha256 = text(raw.fileSha256);
    out.push({
      registryType: text(raw.registryType) ?? "unknown",
      identifier,
      ...(version ? { version } : {}),
      ...(runtimeHint ? { runtimeHint } : {}),
      ...(fileSha256 ? { fileSha256 } : {}),
      transport: transport ?? "stdio",
      runtimeArguments: parseArguments(raw.runtimeArguments),
      packageArguments: parseArguments(raw.packageArguments),
      env: parseDeclaredValues(raw.environmentVariables),
    });
  }
  return out;
}

/**
 * One `{server, _meta}` entry. Returns null when it carries no usable identity,
 * so one broken row drops instead of breaking a page.
 */
export function parseRegistryServer(raw: unknown): McpRegistryServer | null {
  if (!isRecord(raw)) return null;
  const server = isRecord(raw.server) ? raw.server : undefined;
  if (!server) return null;
  const name = text(server.name);
  if (!name) return null;

  const meta = isRecord(raw._meta) && isRecord(raw._meta[OFFICIAL_META_KEY])
    ? (raw._meta[OFFICIAL_META_KEY] as Record<string, unknown>)
    : {};

  const title = text(server.title);
  const description = text(server.description);
  const version = text(server.version);
  const statusMessage = text(meta.statusMessage);
  const publishedAt = text(meta.publishedAt);
  const updatedAt = text(meta.updatedAt);
  const repositoryUrl = isRecord(server.repository) ? text(server.repository.url) : undefined;
  const websiteUrl = text(server.websiteUrl);

  return {
    name,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(version ? { version } : {}),
    status: statusOf(meta.status),
    ...(statusMessage ? { statusMessage } : {}),
    // Absent means the registry did not say, and the safe reading of "did not
    // say" is not-latest: it keeps an unlabelled row out of a list that claims
    // to hold current versions only.
    isLatest: meta.isLatest === true,
    ...(publishedAt ? { publishedAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(repositoryUrl ? { repositoryUrl } : {}),
    ...(websiteUrl ? { websiteUrl } : {}),
    remotes: parseRemotes(server.remotes),
    packages: parsePackages(server.packages),
  };
}

/** A `/v0/servers` response. Total: anything unrecognised yields an empty page
 *  rather than an exception, and rows that fail to parse are simply absent. */
export function parseRegistryPage(raw: unknown): McpRegistryPage {
  if (!isRecord(raw) || !Array.isArray(raw.servers)) return { servers: [] };
  const servers: McpRegistryServer[] = [];
  for (const entry of raw.servers) {
    const parsed = parseRegistryServer(entry);
    if (parsed) servers.push(parsed);
  }
  const cursor = isRecord(raw.metadata) ? text(raw.metadata.nextCursor) : undefined;
  return { servers, ...(cursor ? { nextCursor: cursor } : {}) };
}

/** The detail endpoint returns a single `{server, _meta}` object rather than a
 *  page, so it needs its own entry point even though the row shape is identical. */
export function parseRegistryDetail(raw: unknown): McpRegistryServer | null {
  return parseRegistryServer(raw);
}

/**
 * How a server would run, in the structural terms the shared execution-surface
 * vocabulary uses (`EXECUTION_SURFACES`, `packages/shared/contracts/capabilities.ts`).
 *
 * Reported as facts rather than as `ExecutionSurface` values: the ingest layer
 * owns that mapping (`remote` → `mcp_remote_url`, `stdioCommand` →
 * `mcp_stdio_command`) and classifying a capability there keeps one place
 * deciding what is dangerous.
 *
 * `remote` and `stdioCommand` are structural — the publisher had to populate a
 * url or a package for the server to work at all. `requiresSecrets` is not: it
 * reads the publisher's own `isSecret` flag. It is a helpful label, never a
 * safety control, and the surfaces that gate consent do not depend on it.
 */
export interface McpServerSurface {
  remote: boolean;
  stdioCommand: boolean;
  /** True only when a credential is wanted. Distinct from "needs configuring":
   *  a required but open value (a tenant id, an api version) is configuration. */
  requiresSecrets: boolean;
  /** The credentials by name, deduplicated across every remote and package, in
   *  the order first seen. A consent screen lists these; deriving the filter here
   *  keeps one definition of what counts as a secret. */
  secretNames: string[];
}

export function describeServerSurface(server: McpRegistryServer): McpServerSurface {
  const secretNames: string[] = [];
  const add = (v: McpDeclaredValue) => {
    if (v.isSecret && !secretNames.includes(v.name)) secretNames.push(v.name);
  };
  for (const remote of server.remotes) for (const h of remote.headers) add(h);
  for (const pkg of server.packages) for (const e of pkg.env) add(e);

  return {
    remote: server.remotes.length > 0,
    stdioCommand: server.packages.some((p) => p.transport === "stdio"),
    requiresSecrets: secretNames.length > 0,
    secretNames,
  };
}

/**
 * Servers a browse list should show by default.
 *
 * Deprecated and deleted entries are hidden: rendering one as a normal
 * suggestion is a product defect. Everything else is shown, INCLUDING `unknown`
 * — a status this build does not recognise, and a source that publishes no
 * status block at all, both land there. Requiring an `active` stamp instead would
 * make every non-official catalog browse to nothing, which is the opposite of
 * what the seam at the bottom of this file promises.
 */
export function browsableServers(servers: McpRegistryServer[]): McpRegistryServer[] {
  return servers.filter((s) => s.status !== "deprecated" && s.status !== "deleted");
}
