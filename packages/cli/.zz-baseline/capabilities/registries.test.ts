// Fixture driven: the pages here are two real consecutive responses from
// `registry.modelcontextprotocol.io`, recorded 2026-08-13, plus one detail
// record and one older page that happens to contain a deprecated server. No test
// in this file touches the network — the fetch seam is injected.

import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import {
  browsableServers,
  buildServerDetailUrl,
  buildServersUrl,
  describeServerSurface,
  fetchRegistryPage,
  fetchRegistryServer,
  listRegistryServers,
  OFFICIAL_META_KEY,
  parseRegistryDetail,
  parseRegistryPage,
  parseRegistryServer,
  UNINTEGRATED_MCP_DIRECTORIES,
} from "./registries.js";

const FIXTURES = path.join(import.meta.dir, "__fixtures__");
const fixture = (name: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf-8"));

const PAGE_1 = fixture("mcp-registry-page-1.json");
const PAGE_2 = fixture("mcp-registry-page-2.json");
const MIXED = fixture("mcp-registry-page.json");
const DETAIL = fixture("mcp-registry-detail.json");

/** A fetch that serves recorded bodies by URL substring, and records the calls. */
function fakeFetch(routes: Array<{ match: string; body?: unknown; status?: number; throws?: string }>) {
  const calls: string[] = [];
  const impl = async (url: string): Promise<Response> => {
    calls.push(url);
    const route = routes.find((r) => url.includes(r.match)) ?? routes[routes.length - 1];
    if (route.throws) throw new Error(route.throws);
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
  };
  return { impl, calls };
}

/* ------------------------------------------------------------------ parsing */

describe("parseRegistryPage", () => {
  test("reads a recorded page", () => {
    const page = parseRegistryPage(PAGE_1);
    expect(page.servers.map((s) => s.name)).toEqual([
      "ac.inference.sh/mcp",
      "ac.tandem/docs-mcp",
      "ag.hood/name-service",
    ]);
    expect(page.nextCursor).toBe("ag.hood/name-service:0.1.0");
  });

  test("the namespaced name is the identity; the title is only a label", () => {
    const server = parseRegistryPage(PAGE_1).servers[0];
    expect(server.name).toBe("ac.inference.sh/mcp");
    expect(server.title).toBe("inference.sh");
    expect(server.version).toBe("2.0.1");
    expect(server.isLatest).toBe(true);
    expect(server.status).toBe("active");
  });

  test("remotes carry their url and whether the caller must supply a secret", () => {
    const tandem = parseRegistryPage(PAGE_1).servers.find((s) => s.name === "ac.tandem/docs-mcp");
    expect(tandem?.remotes).toEqual([
      { type: "streamable-http", url: "https://tandem.ac/mcp", headers: [], requiresAuth: false },
    ]);
    expect(tandem?.repositoryUrl).toBe("https://github.com/frumu-ai/tandem");

    const gated = parseRegistryPage(MIXED).servers.find((s) => s.name === "ai.agentplaybooks/agentplaybooks");
    expect(gated?.remotes[0].requiresAuth).toBe(true);
    expect(gated?.remotes[0].headers).toEqual([
      { name: "Authorization", isRequired: true, isSecret: true },
    ]);
  });

  test("a header that is required but not secret is configuration, not a credential", () => {
    const [server] = parseRegistryPage({
      servers: [
        {
          server: {
            name: "x/y",
            remotes: [
              {
                type: "streamable-http",
                url: "https://x.example/mcp",
                headers: [{ name: "X-Tenant-Id", isRequired: true }],
              },
            ],
          },
        },
      ],
    }).servers;
    expect(server.remotes[0].headers).toEqual([
      { name: "X-Tenant-Id", isRequired: true, isSecret: false },
    ]);
    expect(server.remotes[0].requiresAuth).toBe(false);
    expect(describeServerSurface(server).requiresSecrets).toBe(false);
  });

  test("packages carry the transport and every variable, with both flags kept apart", () => {
    const trust = parseRegistryPage(MIXED).servers.find((s) => s.name === "ai.agenttrust/mcp-server");
    expect(trust?.packages).toEqual([
      {
        registryType: "npm",
        identifier: "@agenttrust/mcp-server",
        version: "1.1.1",
        transport: "stdio",
        runtimeArguments: [],
        packageArguments: [],
        env: [{ name: "AGENTTRUST_API_KEY", isRequired: true, isSecret: true }],
      },
    ]);
  });

  test("an optional, non-secret variable does not make a server look credentialed", () => {
    const [server] = parseRegistryPage({
      servers: [
        {
          server: {
            name: "x/y",
            packages: [
              {
                registryType: "npm",
                identifier: "chatty",
                transport: { type: "stdio" },
                environmentVariables: [{ name: "LOG_LEVEL", isRequired: false, isSecret: false }],
              },
            ],
          },
        },
      ],
    }).servers;
    expect(server.packages[0].env).toEqual([
      { name: "LOG_LEVEL", isRequired: false, isSecret: false },
    ]);
    expect(describeServerSurface(server)).toEqual({
      remote: false,
      stdioCommand: true,
      requiresSecrets: false,
      secretNames: [],
    });
  });

  test("the command a package would run survives: runtime hint, arguments, digest", () => {
    const armory = parseRegistryPage(MIXED).servers.find((s) => s.name === "com.mcparmory/github");
    expect(armory?.packages.map((p) => p.runtimeHint)).toEqual(["uvx", "docker"]);

    const [server] = parseRegistryPage({
      servers: [
        {
          server: {
            name: "x/y",
            packages: [
              {
                registryType: "oci",
                identifier: "ghcr.io/x/y:1",
                runtimeHint: "docker",
                fileSha256: "abc123",
                transport: { type: "stdio" },
                runtimeArguments: [
                  { type: "named", name: "--mount", value: "type=bind,src={dir}" },
                  { type: "positional", valueHint: "image" },
                  { type: "named", isRequired: true },
                ],
                packageArguments: [{ type: "positional", value: "serve", isRequired: true }],
              },
            ],
          },
        },
      ],
    }).servers;
    const pkg = server.packages[0];
    expect(pkg.runtimeHint).toBe("docker");
    expect(pkg.fileSha256).toBe("abc123");
    expect(pkg.runtimeArguments).toEqual([
      { kind: "named", name: "--mount", value: "type=bind,src={dir}", isRequired: false },
      { kind: "positional", value: "image", isRequired: false },
    ]);
    expect(pkg.packageArguments).toEqual([{ kind: "positional", value: "serve", isRequired: true }]);
  });

  test("a deprecated server keeps its status and the publisher's reason", () => {
    const deprecated = parseRegistryPage(MIXED).servers.find(
      (s) => s.name === "ai.agentplaybooks/agentplaybooks",
    );
    expect(deprecated?.status).toBe("deprecated");
    expect(deprecated?.statusMessage).toContain("Published accidentally");
  });

  test("a server with neither remotes nor packages parses with both empty", () => {
    const page = parseRegistryPage({ servers: [{ server: { name: "bare/thing" } }] });
    expect(page.servers[0]).toMatchObject({ name: "bare/thing", remotes: [], packages: [], isLatest: false });
    expect(page.servers[0].status).toBe("unknown");
  });

  test("malformed payloads yield an empty page, never a throw", () => {
    for (const input of [null, undefined, {}, [], "text", 7, { servers: "nope" }]) {
      expect(parseRegistryPage(input).servers).toEqual([]);
    }
  });

  test("one broken row drops without taking the page with it", () => {
    const page = parseRegistryPage({
      servers: [
        null,
        { server: { description: "no name" } },
        { notServer: {} },
        { server: { name: "good/one" } },
      ],
      metadata: { nextCursor: "" },
    });
    expect(page.servers.map((s) => s.name)).toEqual(["good/one"]);
    expect(page.nextCursor).toBeUndefined();
  });

  test("the provenance block is read by its literal reverse-DNS key", () => {
    const wrongKey = parseRegistryServer({
      server: { name: "x/y" },
      _meta: { [OFFICIAL_META_KEY.replace("/official", "")]: { status: "active", isLatest: true } },
    });
    // A near miss must not be adopted as official metadata.
    expect(wrongKey?.status).toBe("unknown");
    expect(wrongKey?.isLatest).toBe(false);
  });
});

test("parseRegistryDetail reads the single-object detail response", () => {
  const server = parseRegistryDetail(DETAIL);
  expect(server?.name).toBe("ac.tandem/docs-mcp");
  expect(server?.status).toBe("active");
  expect(server?.updatedAt).toBe("2026-04-22T21:06:34.500049Z");
  expect(parseRegistryDetail({ nothing: true })).toBeNull();
});

describe("browsableServers", () => {
  test("hides deprecated entries from a default listing", () => {
    const all = parseRegistryPage(MIXED).servers;
    expect(all.length).toBe(6);
    const browsable = browsableServers(all);
    expect(browsable.map((s) => s.name)).not.toContain("ai.agentplaybooks/agentplaybooks");
    expect(browsable.length).toBe(5);
  });

  test("a source that publishes no status block still browses", () => {
    // This is the seam other directories arrive through: their rows carry no
    // `io.modelcontextprotocol.registry/official` block, so every status is
    // `unknown`. Demanding an `active` stamp would browse them to nothing.
    const foreign = parseRegistryPage({
      servers: [{ server: { name: "a/b" } }, { server: { name: "c/d" } }],
    }).servers;
    expect(foreign.map((s) => s.status)).toEqual(["unknown", "unknown"]);
    expect(browsableServers(foreign).length).toBe(2);
  });

  test("a deleted entry is hidden too", () => {
    const rows = parseRegistryPage({
      servers: [
        { server: { name: "gone/x" }, _meta: { [OFFICIAL_META_KEY]: { status: "deleted" } } },
        { server: { name: "here/y" }, _meta: { [OFFICIAL_META_KEY]: { status: "active" } } },
      ],
    }).servers;
    expect(browsableServers(rows).map((s) => s.name)).toEqual(["here/y"]);
  });
});

test("describeServerSurface reports how a server would run, structurally", () => {
  const servers = parseRegistryPage(MIXED).servers;
  const remote = servers.find((s) => s.name === "ac.inference.sh/mcp")!;
  const local = servers.find((s) => s.name === "ai.agenttrust/mcp-server")!;
  expect(describeServerSurface(remote)).toEqual({
    remote: true,
    stdioCommand: false,
    requiresSecrets: false,
    secretNames: [],
  });
  expect(describeServerSurface(local)).toEqual({
    remote: false,
    stdioCommand: true,
    requiresSecrets: true,
    secretNames: ["AGENTTRUST_API_KEY"],
  });
});

test("a secret named by both a remote and a package is listed once", () => {
  const [server] = parseRegistryPage({
    servers: [
      {
        server: {
          name: "x/y",
          remotes: [
            {
              url: "https://x.example/mcp",
              headers: [{ name: "API_KEY", isSecret: true }],
            },
          ],
          packages: [
            {
              identifier: "x",
              transport: { type: "stdio" },
              environmentVariables: [
                { name: "API_KEY", isSecret: true },
                { name: "OTHER_KEY", isSecret: true },
              ],
            },
          ],
        },
      },
    ],
  }).servers;
  expect(describeServerSurface(server).secretNames).toEqual(["API_KEY", "OTHER_KEY"]);
});

/* --------------------------------------------------------------------- urls */

describe("buildServersUrl", () => {
  test("always sends version=latest, without which the registry returns every version", () => {
    expect(buildServersUrl()).toBe("https://registry.modelcontextprotocol.io/v0/servers?version=latest");
  });

  test("carries the incremental sync, search and cursor parameters", () => {
    const url = new URL(buildServersUrl({
      updatedSince: "2026-08-01T00:00:00Z",
      search: "github mcp",
      cursor: "a/b:1.0.0",
      limit: 50,
    }));
    expect(url.searchParams.get("version")).toBe("latest");
    expect(url.searchParams.get("updated_since")).toBe("2026-08-01T00:00:00Z");
    expect(url.searchParams.get("search")).toBe("github mcp");
    expect(url.searchParams.get("cursor")).toBe("a/b:1.0.0");
    expect(url.searchParams.get("limit")).toBe("50");
  });

  test("clamps the page size to what the registry accepts", () => {
    expect(new URL(buildServersUrl({ limit: 5000 })).searchParams.get("limit")).toBe("100");
    expect(new URL(buildServersUrl({ limit: 0 })).searchParams.get("limit")).toBe("1");
    expect(new URL(buildServersUrl({ limit: Number.NaN })).searchParams.has("limit")).toBe(false);
  });

  test("a custom base url with a trailing slash does not double up", () => {
    expect(buildServersUrl({ baseUrl: "http://localhost:9000/" })).toStartWith("http://localhost:9000/v0/servers?");
  });

  test("a namespaced name is encoded into the detail path", () => {
    expect(buildServerDetailUrl("ac.tandem/docs-mcp")).toBe(
      "https://registry.modelcontextprotocol.io/v0/servers/ac.tandem%2Fdocs-mcp/versions/latest",
    );
  });
});

/* ----------------------------------------------------------------- fetching */

describe("fetchRegistryPage", () => {
  test("returns the parsed page", async () => {
    const { impl } = fakeFetch([{ match: "/v0/servers", body: PAGE_1 }]);
    const result = await fetchRegistryPage({ fetchImpl: impl });
    expect(result.error).toBeUndefined();
    expect(result.page.servers.length).toBe(3);
  });

  test("an HTTP error is a phrase, not an exception", async () => {
    const { impl } = fakeFetch([{ match: "/v0/servers", status: 503 }]);
    const result = await fetchRegistryPage({ fetchImpl: impl });
    expect(result.page.servers).toEqual([]);
    expect(result.error).toBe("registry returned HTTP 503");
  });

  test("a timeout is a phrase, not an exception", async () => {
    const { impl } = fakeFetch([{ match: "/v0/servers", throws: "Request timed out after 45000ms" }]);
    const result = await fetchRegistryPage({ fetchImpl: impl });
    expect(result.page.servers).toEqual([]);
    expect(result.error).toContain("timed out");
  });

  test("a body that is not JSON at all is a phrase, not an exception", async () => {
    const impl = async () => new Response("<html>502 Bad Gateway</html>", { status: 200 });
    const result = await fetchRegistryPage({ fetchImpl: impl });
    expect(result.page.servers).toEqual([]);
    expect(result.error).toBeDefined();
  });
});

test("fetchRegistryServer reads one server and tolerates a failure", async () => {
  const ok = fakeFetch([{ match: "/versions/latest", body: DETAIL }]);
  expect((await fetchRegistryServer("ac.tandem/docs-mcp", { fetchImpl: ok.impl })).server?.name).toBe(
    "ac.tandem/docs-mcp",
  );
  expect(ok.calls[0]).toContain("ac.tandem%2Fdocs-mcp");

  const bad = fakeFetch([{ match: "/versions", status: 404 }]);
  const result = await fetchRegistryServer("nope/nope", { fetchImpl: bad.impl });
  expect(result.server).toBeNull();
  expect(result.error).toBe("registry returned HTTP 404");
});

/* ------------------------------------------------------------- the cursor walk */

describe("listRegistryServers", () => {
  test("follows the cursor to the end and reports the newest timestamp seen", async () => {
    const { impl, calls } = fakeFetch([
      { match: "cursor=", body: { ...(PAGE_2 as object), metadata: {} } },
      { match: "/v0/servers", body: PAGE_1 },
    ]);
    const result = await listRegistryServers({ fetchImpl: impl, limit: 3 });
    expect(result.pagesFetched).toBe(2);
    expect(result.servers.length).toBe(6);
    expect(result.truncated).toBe(false);
    expect(result.stopReason).toBe("complete");
    expect(result.error).toBeUndefined();
    expect(calls[1]).toContain("cursor=ag.hood%2Fname-service%3A0.1.0");
    expect(result.newestUpdatedAt).toBeDefined();
  });

  test("every returned server is distinct, whatever the pages contain", async () => {
    // The registry silently ignores unknown parameters, so a future rename of
    // `version=latest` would resurface duplicate versions rather than error.
    const dupes = {
      servers: [...(PAGE_1 as { servers: unknown[] }).servers, ...(PAGE_1 as { servers: unknown[] }).servers],
      metadata: {},
    };
    const { impl } = fakeFetch([{ match: "/v0/servers", body: dupes }]);
    const result = await listRegistryServers({ fetchImpl: impl });
    expect(result.servers.map((s) => s.name)).toEqual([
      "ac.inference.sh/mcp",
      "ac.tandem/docs-mcp",
      "ag.hood/name-service",
    ]);
  });

  test("a server that hands back the same cursor forever does not loop", async () => {
    const stuck = { servers: (PAGE_1 as { servers: unknown[] }).servers, metadata: { nextCursor: "same" } };
    const { impl } = fakeFetch([{ match: "/v0/servers", body: stuck }]);
    const result = await listRegistryServers({ fetchImpl: impl, maxPages: 50 });
    // First page yields the cursor, second page repeats it, and the walk stops —
    // reported as a prefix, because it is one.
    expect(result.pagesFetched).toBe(2);
    expect(result.stopReason).toBe("repeated_cursor");
    expect(result.truncated).toBe(true);
    expect(result.nextCursor).toBe("same");
  });

  test("the page cap stops a walk and says where to resume", async () => {
    let n = 0;
    const impl = async () => {
      n += 1;
      return new Response(
        JSON.stringify({
          servers: [{ server: { name: `s${n}/x` } }],
          metadata: { nextCursor: `cursor-${n}` },
        }),
        { status: 200 },
      );
    };
    const result = await listRegistryServers({ fetchImpl: impl, maxPages: 3 });
    expect(result.pagesFetched).toBe(3);
    expect(result.stopReason).toBe("page_cap");
    expect(result.truncated).toBe(true);
    expect(result.nextCursor).toBe("cursor-3");
    expect(result.servers.map((s) => s.name)).toEqual(["s1/x", "s2/x", "s3/x"]);
  });

  test("a failure part way through keeps what was already collected", async () => {
    let n = 0;
    const impl = async (url: string) => {
      n += 1;
      if (n === 1) return new Response(JSON.stringify(PAGE_1), { status: 200 });
      throw new Error("connection reset");
    };
    const result = await listRegistryServers({ fetchImpl: impl });
    expect(result.servers.length).toBe(3);
    expect(result.pagesFetched).toBe(2);
    expect(result.stopReason).toBe("error");
    expect(result.truncated).toBe(true);
    expect(result.error).toContain("connection reset");
  });

  test("a registry that is entirely down yields nothing and says why", async () => {
    const { impl } = fakeFetch([{ match: "", status: 500 }]);
    const result = await listRegistryServers({ fetchImpl: impl });
    expect(result.servers).toEqual([]);
    expect(result.error).toBe("registry returned HTTP 500");
  });
});

test("the directories we deliberately do not read are written down with reasons", () => {
  const names = UNINTEGRATED_MCP_DIRECTORIES.map((d) => d.name);
  expect(names).toContain("Smithery");
  expect(names).toContain("PulseMCP");
  expect(UNINTEGRATED_MCP_DIRECTORIES.every((d) => d.reason.length > 0)).toBe(true);
});
