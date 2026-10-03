// `cast sources` (external-data.md X1, X10): the add body, the key printed
// once, and what each verb posts.
import { describe, expect, test } from "bun:test";
import { SCOPE, SITE, useCliHarness } from "./externalDataCli.testHarness.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatSourceDetail, formatSourceList, recordInCodecastJson, sourceAddBody, testBatch, type SourceRow } from "./sourcesCommand.js";
import { codecastJsonPath, committedIngestKey, writeCodecastJson } from "./codecastJson.js";

describe("sourceAddBody", () => {
  test("the provider is checked and the name defaults to it", () => {
    expect(() => sourceAddBody("datadog", undefined, {})).toThrow("Providers: sentry, posthog, sdk, http, app");
    expect(sourceAddBody(" SDK ", undefined, {})).toEqual({ provider: "sdk", name: "sdk" });
  });

  test("github is codecast's own source and is never added by hand", () => {
    expect(() => sourceAddBody("github", undefined, {})).toThrow("--source github-ci");
  });

  test("settings land in config, lists split on commas, blanks drop", () => {
    expect(sourceAddBody("sentry", "web", { org: "acme", projects: "web, api,", environments: "production", project: "Ops", fingerprintPrefix: " union ", promote: "new,spike", host: " " })).toEqual({
      provider: "sentry",
      name: "web",
      config: { org: "acme", projects: ["web", "api"], environments: ["production"] },
      project: "Ops",
      fingerprint_prefix: "union",
      promote: ["new", "spike"],
    });
  });

  test("a setting for another provider is refused; where a vendor source reads is its connection's, so there is no --host", () => {
    expect(() => sourceAddBody("posthog", "web", { org: "acme" })).toThrow("--org does not apply to a posthog source");
    expect(() => sourceAddBody("sdk", "web", { projectId: "7" })).toThrow("--project-id does not apply to a sdk source");
    expect(sourceAddBody("posthog", "web", { projectId: " 7 ", host: "https://other" })).toEqual({ provider: "posthog", name: "web", config: { project_id: "7" } });
  });

  test("--base-url makes an app source's signed connection in the same step, and belongs to app alone", () => {
    expect(sourceAddBody("app", "union", { baseUrl: " https://api.union.example/api " })).toEqual({ provider: "app", name: "union", base_url: "https://api.union.example/api" });
    expect(() => sourceAddBody("posthog", "web", { baseUrl: "https://other" })).toThrow("--base-url belongs to an app source");
  });
});

describe("codecast.json", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cc-json-"));

  test("add writes the nearest codecast.json up to the checkout root, else the root's, and merges", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, ".git"));
    const app = path.join(root, "outreach", "backend");
    fs.mkdirSync(app, { recursive: true });
    expect(codecastJsonPath(app, undefined)).toBe(path.join(root, "codecast.json"));
    fs.writeFileSync(path.join(app, "codecast.json"), "{}");
    expect(codecastJsonPath(app, undefined)).toBe(path.join(app, "codecast.json"));
    const out = recordInCodecastJson({ name: "union-errors", short_id: "src-5", workspace: "team:k57" }, { cwd: app, write: undefined, ingestKey: "cc_ing_abc", endpoint: "https://convex.codecast.sh/cli/ingest" });
    expect(out).toContain("wrote");
    recordInCodecastJson({ name: "union", short_id: "src-6", workspace: "team:k57" }, { cwd: app, write: undefined, endpoint: "https://convex.codecast.sh/cli/ingest" });
    expect(JSON.parse(fs.readFileSync(path.join(app, "codecast.json"), "utf8"))).toEqual({
      ingestKey: "cc_ing_abc",
      sources: { union: { id: "src-6", workspace: "team:k57" }, "union-errors": { id: "src-5", workspace: "team:k57" } },
    });
    expect(committedIngestKey(app)).toBe("cc_ing_abc");
  });

  test("--write names the file or directory, --no-write and outside a checkout write nothing, and a bad file is left alone", () => {
    const dir = tmp();
    expect(codecastJsonPath(dir, undefined)).toBeNull();
    expect(recordInCodecastJson({ name: "x", short_id: "src-1", workspace: "user:u1" }, { cwd: dir, write: undefined, endpoint: "e" })).toContain("--write");
    expect(codecastJsonPath(dir, false)).toBeNull();
    expect(codecastJsonPath(dir, dir)).toBe(path.join(dir, "codecast.json"));
    fs.writeFileSync(path.join(dir, "codecast.json"), JSON.stringify({ token: "sk_live" }));
    const out = writeCodecastJson(path.join(dir, "codecast.json"), { name: "x", source: { id: "src-1", workspace: "user:u1" } });
    expect(out).toMatchObject({ error: expect.stringContaining("unknown key") });
    expect(JSON.parse(fs.readFileSync(path.join(dir, "codecast.json"), "utf8"))).toEqual({ token: "sk_live" });
  });
});

describe("formatSourceList", () => {
  const row: SourceRow = { _id: "1", short_id: "src-1", name: "web", provider: "sdk", status: "active", groups_open: 2, events_today: 40, last_event_at: 1_000 };
  test("one line per source with its counts", () => {
    expect(formatSourceList([row], 121_000)).toContain("2 open · 40 today · last event 2m ago");
    expect(formatSourceList([])).toContain("cast sources add");
  });

  test("a source stopped on a lost connection says so in the list, under its line", () => {
    const lost = { ...row, short_id: "src-2", name: "sentry", provider: "sentry", status: "error", last_error: "Sentry refused the token (401); reconnect Sentry" };
    const lines = formatSourceList([row, lost], 121_000).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("error");
    expect(lines[2]).toContain("refused the token (401)");
  });

  test("show lists counted analytics events, busiest over the last day first", () => {
    const H = 3600_000;
    const now = 100 * H + 60_000;
    const text = formatSourceDetail({ ...row, event_names: [{ name: "view", buckets: [{ hour: 100 * H, count: 3 }] }, { name: "signup", buckets: [{ hour: 99 * H, count: 5 }, { hour: 40 * H, count: 9 }] }] }, now);
    const lines = text.split("\n").filter((l) => /view|signup/.test(l));
    expect(lines[0]).toMatch(/signup\s+5/);
    expect(lines[1]).toMatch(/view\s+3/);
    expect(text).toContain("events, last 24h");
  });
});

describe("cast sources on the wire", () => {
  const h = useCliHarness("sources", async () => (await import("./sourcesCommand.js")).registerSourcesCommand);
  const source: SourceRow = { _id: "1", short_id: "src-3", name: "web", provider: "sdk", status: "active", keyed: true, key_prefix: "cc_ing_ab" };

  test("add posts the body with the scope and prints the key once", async () => {
    h.answer = () => ({ source, ingest_key: "cc_ing_abcdef" });
    await h.run("add", "sdk", "web", "--allowed-origins", "https://app.test");
    expect(h.calls).toEqual([{ path: "/cli/sources/create", body: { provider: "sdk", name: "web", config: { allowed_origins: ["https://app.test"] }, ...SCOPE } }]);
    expect(h.out()).toContain("cc_ing_abcdef");
    expect(h.out()).toContain(`${SITE}/cli/ingest/<key>`);
  });

  test("a token source points at the connection instead of a key", async () => {
    h.answer = () => ({ source: { ...source, provider: "sentry", keyed: false } });
    await h.run("add", "sentry", "--org", "acme");
    expect(h.calls[0].body).toMatchObject({ provider: "sentry", name: "sentry", config: { org: "acme" } });
    expect(h.out()).toContain("cast integrations connect sentry");
  });

  test("ls, pause, key rotate and rm post their routes; --json prints the answer whole", async () => {
    h.answer = (path) => (path === "/cli/sources/list" ? [source] : path === "/cli/sources/rotate-key" ? { source, ingest_key: "cc_ing_new" } : path === "/cli/sources/remove" ? { removed: "src-3" } : { source });
    await h.run("ls", "--json");
    await h.run("pause", "web");
    await h.run("key", "rotate", "web");
    await h.run("rm", "src-3");
    expect(h.calls.map((c) => c.path)).toEqual(["/cli/sources/list", "/cli/sources/update", "/cli/sources/rotate-key", "/cli/sources/remove"]);
    expect(h.calls[1].body).toEqual({ source: "web", status: "paused", ...SCOPE });
    expect(JSON.parse(h.logs[0])).toEqual([source]);
    expect(h.out()).toContain("cc_ing_new");
  });

  test("test posts one harmless batch to the door with the key, and refuses a key that is not the source's", async () => {
    h.answer = (path) => (path === "/cli/sources/get" ? source : { accepted: 1, dropped: 0 });
    await h.run("test", "web", "--key", "cc_ing_abXYZ");
    const door = h.calls.find((c) => c.path.startsWith("/cli/ingest/"))!;
    expect(door.path).toBe("/cli/ingest/cc_ing_abXYZ");
    expect(door.body.items).toEqual([expect.objectContaining({ type: "event", name: "codecast.test" })]);
    expect(h.out()).toContain("1 accepted");

    h.calls.length = 0;
    await expect(h.run("test", "web", "--key", "cc_ing_zz")).rejects.toThrow(/exit 1/);
    expect(h.calls.some((c) => c.path.startsWith("/cli/ingest/"))).toBe(false);
  });

  test("the test batch is a counted event, which the door never stores or announces", () => {
    expect(testBatch(5).items).toEqual([{ type: "event", name: "codecast.test", at: 5 }]);
  });
});

// The group help and the snippet are written by hand, so they are checked
// against the flags `cast sources add` really registers.
describe("help names only real flags", () => {
  test("every --flag the sources help advertises is one of add's options, and none sets a connection's host or url", async () => {
    const { Command } = await import("commander");
    const { commandGroup } = await import("./commandGroups.js");
    const { registerSourcesCommand } = await import("./sourcesCommand.js");
    const program = new Command();
    registerSourcesCommand(program, {} as any);
    const add = program.commands.find((c) => c.name() === "sources")!.commands.find((c) => c.name() === "add")!;
    const real = new Set(add.options.map((o) => o.long));
    const advertised = commandGroup("sources").description.match(/--[a-z][a-z-]*/g) ?? [];
    expect(advertised.length).toBeGreaterThan(0);
    for (const flag of advertised) expect(real.has(flag)).toBe(true);
    // --base-url is the app source's one connection setting: it makes a signed connection, which holds no secret.
    expect(real.has("--host")).toBe(false);
    expect(real.has("--base-url")).toBe(true);
    expect(add.description()).toContain("cast integrations connect");
    expect(add.description()).not.toContain("github");
  });

  test("the External data snippet speaks the CLI's words: connector, --team personal, grants made on the web", async () => {
    const { TASK_SNIPPET } = await import("@codecast/shared/contracts");
    const section = TASK_SNIPPET.slice(TASK_SNIPPET.indexOf("### External data"));
    expect(section).toContain("cast connector");
    expect(section).not.toMatch(/cast app\b/);
    expect(section).toContain("--team <name|personal>");
    expect(section).not.toContain("--personal");
    expect(section).toContain("cast integrations connect");
    expect(section).toMatch(/resolving or ignoring a group mirrored from Sentry\) runs only on a grant a person makes on the web/);
    for (const flag of ["--host", "--base-url", "--org"]) expect(section).not.toContain(flag);
  });
});
