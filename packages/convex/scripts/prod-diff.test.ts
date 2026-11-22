import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineSchema, defineTable, httpActionGeneric, httpRouter, internalQueryGeneric, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import {
  diffNames,
  formatSummary,
  isEntryModule,
  moduleName,
  namesFromActiveSchema,
  namesFromApiSpec,
  namesFromModule,
  namesFromSchema,
  readCredentials,
  type ApiSpecEntry,
  describeAdder,
} from "./prod-diff";

// Trimmed from prod's `_system/cli/modules:apiSpec` on 2026-11-22.
const API_SPEC: ApiSpecEntry[] = [
  { args: { type: "object", value: {} }, functionType: "Mutation", identifier: "emails/send.js:notifyPasswordChanged", returns: null, visibility: { kind: "public" } },
  { args: { type: "object", value: { task_id: { fieldType: { tableName: "agent_tasks", type: "id" }, optional: false } } }, functionType: "Query", identifier: "agentTasks.js:getTaskForSummary", returns: null, visibility: { kind: "internal" } },
  { functionType: "HttpAction", method: "GET", path: "/.well-known/jwks.json" },
  { functionType: "HttpAction", method: "POST", path: "/api/ingest/*" },
] as ApiSpecEntry[];

// Trimmed from prod's `_system/frontend/getSchemas` `active` (documentType elided).
const ACTIVE_SCHEMA = JSON.stringify({
  tables: [
    { tableName: "access_log", indexes: [{ indexDescriptor: "by_repeat_key", fields: ["repeat_key", "at", "_creationTime"] }, { indexDescriptor: "by_team_at", fields: ["team_id", "at", "_creationTime"] }], stagedDbIndexes: [], searchIndexes: [], stagedSearchIndexes: [], vectorIndexes: [], stagedVectorIndexes: [], documentType: { type: "any" }, stagedDocumentType: null },
    { tableName: "chat_messages", indexes: [{ indexDescriptor: "by_channel_created", fields: ["channel_id", "created_at", "_creationTime"] }], stagedDbIndexes: [], searchIndexes: [{ indexDescriptor: "search_content", searchField: "content", filterFields: ["channel_id", "team_id"] }], stagedSearchIndexes: [], vectorIndexes: [], stagedVectorIndexes: [], documentType: { type: "any" }, stagedDocumentType: null },
    { tableName: "signal_vectors", indexes: [{ indexDescriptor: "by_signal", fields: ["signal_id", "_creationTime"] }], stagedDbIndexes: [], searchIndexes: [], stagedSearchIndexes: [], vectorIndexes: [{ indexDescriptor: "by_embedding", vectorField: "embedding", dimensions: 1536, dimension: null, filterFields: ["scope"] }], stagedVectorIndexes: [], documentType: { type: "any" }, stagedDocumentType: null },
  ],
  schemaValidation: false,
});

describe("prod side", () => {
  test("apiSpec: functions by module and export, routes by method and path", () => {
    expect(namesFromApiSpec(API_SPEC)).toEqual([
      "fn:emails/send:notifyPasswordChanged",
      "fn:agentTasks:getTaskForSummary",
      "http:GET /.well-known/jwks.json",
      "http:POST /api/ingest/*",
    ]);
  });

  test("active schema: tables and every kind of index", () => {
    expect(namesFromActiveSchema(ACTIVE_SCHEMA)).toEqual([
      "table:access_log",
      "index:access_log.by_repeat_key",
      "index:access_log.by_team_at",
      "table:chat_messages",
      "index:chat_messages.by_channel_created",
      "index:chat_messages.search_content",
      "table:signal_vectors",
      "index:signal_vectors.by_signal",
      "index:signal_vectors.by_embedding",
    ]);
  });

  test("a deployment with no schema has no tables", () => {
    expect(namesFromActiveSchema(null)).toEqual([]);
  });
});

describe("tree side", () => {
  test("a schema's export names the same things prod's active schema does", () => {
    const schema = defineSchema({
      access_log: defineTable({ repeat_key: v.string(), team_id: v.string(), at: v.number() })
        .index("by_repeat_key", ["repeat_key", "at"])
        .index("by_team_at", ["team_id", "at"]),
      chat_messages: defineTable({ channel_id: v.string(), team_id: v.string(), created_at: v.number(), content: v.string() })
        .index("by_channel_created", ["channel_id", "created_at"])
        .searchIndex("search_content", { searchField: "content", filterFields: ["channel_id", "team_id"] }),
      signal_vectors: defineTable({ signal_id: v.string(), scope: v.string(), embedding: v.array(v.float64()) })
        .index("by_signal", ["signal_id"])
        .vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 1536, filterFields: ["scope"] }),
    });
    // `export()` is what the CLI calls on push; Convex's types mark it internal.
    const tree = namesFromSchema(JSON.parse((schema as unknown as { export: () => string }).export()));
    expect(diffNames(tree, namesFromActiveSchema(ACTIVE_SCHEMA))).toEqual({ adds: [], drops: [] });
  });

  test("a module contributes its queries, mutations and actions, nothing else", () => {
    const handler = async () => null;
    const names = namesFromModule("agentTasks", {
      getTaskForSummary: internalQueryGeneric({ args: {}, handler }),
      bump: mutationGeneric({ args: {}, handler }),
      list: queryGeneric({ args: {}, handler }),
      helper: () => 1,
      LIMIT: 5,
      nothing: null,
    });
    expect(names.sort()).toEqual(["fn:agentTasks:bump", "fn:agentTasks:getTaskForSummary", "fn:agentTasks:list"]);
  });

  test("the http router's routes are spelled as prod spells them, prefix routes with *", () => {
    const http = httpRouter();
    const handler = httpActionGeneric(async () => new Response());
    http.route({ path: "/.well-known/jwks.json", method: "GET", handler });
    http.route({ pathPrefix: "/api/ingest/", method: "POST", handler });
    const tree = namesFromModule("http", { default: http });
    expect(tree.sort()).toEqual(["http:GET /.well-known/jwks.json", "http:POST /api/ingest/*"]);
    const prodRoutes = namesFromApiSpec(API_SPEC).filter((n) => n.startsWith("http:"));
    expect(diffNames(tree, prodRoutes)).toEqual({ adds: [], drops: [] });
  });

  test("a router exported from any module but http is not routed", () => {
    expect(namesFromModule("router", { default: httpRouter() })).toEqual([]);
  });

  test("module names match prod's identifiers", () => {
    expect(moduleName("emails/send.ts")).toBe("emails/send");
    expect(moduleName("emails/send.js")).toBe("emails/send");
    expect(moduleName("http.ts")).toBe("http");
  });

  test("entry modules follow the bundler's rules", () => {
    for (const rel of ["apiTokens.ts", "emails/send.ts", "lib/x.tsx", "a.js"]) expect(isEntryModule(rel)).toBe(true);
    for (const rel of [
      "schema.ts",
      "_generated/api.ts",
      "accessLog.test.ts",
      "testModules.testkit.ts",
      "x.testing.ts",
      "types.d.ts",
      "accountSwitch.askFirst.test.ts",
      ".hidden.ts",
      "#emacs.ts",
      "has space/x.ts",
      "lib/node_modules/y.ts",
      "__golden__/ask.json",
      "README.md",
    ]) expect(isEntryModule(rel)).toBe(false);
  });
});

describe("diffNames", () => {
  test("adds are in the tree only, drops in prod only, both sorted", () => {
    expect(diffNames(["fn:b:x", "index:t.a", "fn:a:y", "table:t"], ["table:t", "index:t.z", "fn:a:y", "http:GET /a"])).toEqual({
      adds: ["fn:b:x", "index:t.a"],
      drops: ["http:GET /a", "index:t.z"],
    });
  });

  test("duplicates on either side count once", () => {
    expect(diffNames(["a", "a"], ["b", "b"])).toEqual({ adds: ["a"], drops: ["b"] });
  });
});

describe("formatSummary", () => {
  test("counts, then each drop on its own line, then the adds", () => {
    expect(formatSummary({ adds: ["fn:a:b"], drops: ["index:voiceprints.by_user", "table:voiceprints"] }, { tree_ms: 2100, prod_ms: 1340 })).toBe(
      [
        "prod-diff: 2 drops, 1 add (tree 2.1s, prod 1.3s)",
        "  This push takes these off prod:",
        "  DROP index:voiceprints.by_user",
        "  DROP table:voiceprints",
        "  ADD 1: fn:a:b",
      ].join("\n"),
    );
  });

  test("shows the first ten adds and counts the rest", () => {
    const adds = Array.from({ length: 13 }, (_, i) => `fn:m:f${String(i).padStart(2, "0")}`);
    const text = formatSummary({ adds, drops: [] });
    expect(text.split("\n")).toEqual([
      "prod-diff: 0 drops, 13 adds",
      `  ADD 13: ${adds.slice(0, 10).join(", ")}, +3 more`,
    ]);
  });

  test("nothing to change is one line", () => {
    expect(formatSummary({ adds: [], drops: [] })).toBe("prod-diff: 0 drops, 0 adds");
  });
});

describe("readCredentials", () => {
  const envFile = (body: string) => {
    const f = join(mkdtempSync(join(tmpdir(), "prod-diff-")), ".env.local");
    writeFileSync(f, body);
    return f;
  };

  test("env wins over the file", () => {
    const f = envFile("CONVEX_SELF_HOSTED_URL=https://file.example\nCONVEX_SELF_HOSTED_ADMIN_KEY=file-key\n");
    expect(readCredentials({ CONVEX_SELF_HOSTED_URL: "https://env.example/", CONVEX_SELF_HOSTED_ADMIN_KEY: "env-key" }, f)).toEqual({ url: "https://env.example", key: "env-key" });
  });

  test("falls back to the two keys in the file, quotes stripped, nothing else read", () => {
    const f = envFile('OTHER=x\nexport CONVEX_SELF_HOSTED_ADMIN_KEY="file-key"\n');
    expect(readCredentials({}, f)).toEqual({ url: "https://convex.codecast.sh", key: "file-key" });
  });

  test("no key anywhere", () => {
    expect(readCredentials({}, "/nonexistent/.env.local").key).toBeUndefined();
  });
});

describe("drops name the push that put them there", () => {
  const at = Date.UTC(2026, 10, 22, 5, 21);
  const adder = { name: "index:voiceprints.by_user", deploy: "dp-2372", by: "Ashot", machine: "MBP-182", via: "deploy.sh", at, dirty: 78 };

  test("an uncommitted push, a watcher push, a commit, and nobody", () => {
    expect(describeAdder(adder)).toStartWith("dp-2372, uncommitted push (78 files) by Ashot on MBP-182, ");
    expect(describeAdder({ ...adder, via: "dev watcher", dirty: 2 })).toStartWith("dp-2372, dev watcher by Ashot on MBP-182");
    expect(describeAdder({ ...adder, dirty: 0, machine: null })).toStartWith("dp-2372, push of a commit by Ashot, ");
    expect(describeAdder(undefined)).toBe("no recorded push added it");
  });

  test("the summary puts each adder beside its drop, and says nothing about adders it could not ask", () => {
    const diff = { adds: [], drops: ["index:voiceprints.by_user", "table:voiceprints"] };
    const withAdders = formatSummary(diff, undefined, [adder]);
    expect(withAdders).toContain("This push takes these off prod, with the push that put each there:");
    expect(withAdders).toContain("DROP index:voiceprints.by_user  ← dp-2372, uncommitted push (78 files)");
    expect(withAdders).toContain("DROP table:voiceprints  ← no recorded push added it");
    const without = formatSummary(diff);
    expect(without).toContain("  DROP table:voiceprints");
    expect(without).not.toContain("←");
  });
});
