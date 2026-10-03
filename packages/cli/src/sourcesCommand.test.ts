// `cast sources` (external-data.md X1, X10): the add body, the key printed
// once, and what each verb posts.
import { describe, expect, test } from "bun:test";
import { SCOPE, SITE, useCliHarness } from "./externalDataCli.testHarness.js";
import { formatSourceList, sourceAddBody, testBatch, type SourceRow } from "./sourcesCommand.js";

describe("sourceAddBody", () => {
  test("the provider is checked and the name defaults to it", () => {
    expect(() => sourceAddBody("datadog", undefined, {})).toThrow("Providers: sentry, posthog, sdk, http, app");
    expect(sourceAddBody(" SDK ", undefined, {})).toEqual({ provider: "sdk", name: "sdk" });
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
});

describe("formatSourceList", () => {
  const row: SourceRow = { _id: "1", short_id: "src-1", name: "web", provider: "sdk", status: "active", groups_open: 2, events_today: 40, last_event_at: 1_000 };
  test("one line per source with its counts", () => {
    expect(formatSourceList([row], 121_000)).toContain("2 open · 40 today · last event 2m ago");
    expect(formatSourceList([])).toContain("cast sources add");
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
