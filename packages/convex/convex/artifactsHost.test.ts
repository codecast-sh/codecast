// Serving pages to installed hosts (docs/architecture/installed-apps.md): an
// installed app's host gets the page itself, a browser gets the bar, every
// page document names its version, and a declared app icon must be a square
// PNG of at least 512 px. Runs the real publish and serve routes.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import { presentToken } from "@platform/auth/convex";
import schema from "./schema";
import { api } from "./_generated/api";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";
import { monogramPng } from "./lib/appIcon";
import { pngDimensions } from "./artifactsHttp";
import { isPageHost, pageHostUserAgentSuffix } from "@codecast/shared/contracts";

setDefaultTimeout(120_000);

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36";
const hostUa = (slug: string) => `Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko)${pageHostUserAgentSuffix("1.1.253", slug)}`;

async function setup() {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Ada", email: "ada@acme.dev" } as any);
    const team = await ctx.db.insert("teams", { name: "Acme", invite_code: "ACME1234", created_at: 1 } as any);
    await ctx.db.insert("team_memberships", { user_id: owner, team_id: team, role: "admin", joined_at: 1, visibility: "full" } as any);
    return { owner, team };
  });
  const secret = `tok_${ids.owner}`;
  await t.run(async (ctx) => {
    await ctx.db.insert("api_tokens", { user_id: ids.owner, token_hash: await hashToken(secret), name: "mac", created_at: 1, last_used_at: 1, device_id: "dev1" } as any);
    await ctx.db.insert("devices", { user_id: ids.owner, device_id: "dev1", label: "mac", platform: "darwin", last_seen: 1 } as any);
  });
  return { t, ...ids, api_token: presentToken(secret, "dev1"), as: (u: any) => t.withIdentity({ subject: `${u}|session` }) };
}

async function publish(t: any, body: Record<string, unknown>) {
  const res = await t.fetch("/cli/artifacts/publish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const html = (s: string) => b64(new TextEncoder().encode(s));
const fetchAs = (t: any, path: string, ua: string) => t.fetch(path, { headers: { "User-Agent": ua } });
const PAGE = "<!doctype html><html><head><title>V</title></head><body><h1>vitals</h1></body></html>";

describe("the host user agent", () => {
  test("names this page at the very end, or it is a browser", () => {
    expect(isPageHost(hostUa("abc123"), "abc123")).toBe(true);
    expect(isPageHost(hostUa("abc123"), "zzz999")).toBe(false);
    expect(isPageHost(`${hostUa("abc123")} Extra/1`, "abc123")).toBe(false);
    expect(isPageHost(BROWSER_UA, "abc123")).toBe(false);
    expect(isPageHost(null, "abc123")).toBe(false);
  });
});

describe("serving a page to an installed host", () => {
  test("the host gets the page alone with allow-same-origin and no cache; a browser gets the bar and the opaque sandbox", async () => {
    const { t, api_token } = await setup();
    const { body } = await publish(t, { api_token, title: "Vitals", content: PAGE });
    const slug = body.slug as string;

    const host = await fetchAs(t, `/cli/a/${slug}?host=app&surface=window`, hostUa(slug));
    const hostHtml = await host.text();
    expect(host.status).toBe(200);
    expect(host.headers.get("Content-Security-Policy")).toContain("allow-same-origin");
    expect(host.headers.get("Content-Security-Policy")).toContain("sandbox allow-scripts");
    expect(host.headers.get("Cache-Control")).toBe("private, no-store");
    expect(host.headers.get("Vary")).toBe("User-Agent");
    expect(host.headers.get("X-Cast-Version")).toBe("1");
    expect(hostHtml).toContain("<h1>vitals</h1>");
    // No publish bar, so no version picker, Discuss, or new-version banner.
    expect(hostHtml).not.toContain("__cc_bar");
    expect(hostHtml).not.toContain("__cc_new");

    const browser = await fetchAs(t, `/cli/a/${slug}?host=app&surface=window`, BROWSER_UA);
    const browserHtml = await browser.text();
    expect(browser.headers.get("Content-Security-Policy")).not.toContain("allow-same-origin");
    expect(browser.headers.get("Cache-Control")).toContain("public");
    expect(browserHtml).toContain("__cc_bar");
    expect(browser.headers.get("X-Cast-Version")).toBe("1");
  });

  test("a host user agent naming another page is treated as a browser", async () => {
    const { t, api_token } = await setup();
    const { body } = await publish(t, { api_token, title: "Vitals", content: PAGE });
    const res = await fetchAs(t, `/cli/a/${body.slug}`, hostUa("someotherpage"));
    expect(res.headers.get("Content-Security-Policy")).not.toContain("allow-same-origin");
    expect(await res.text()).toContain("__cc_bar");
  });

  test("a bundle's assets carry the host sandbox for the host only", async () => {
    const { t, api_token } = await setup();
    const files = [{ path: "index.html", content_b64: html(PAGE) }, { path: "about.html", content_b64: html("<p>about</p>") }];
    const { body } = await publish(t, { api_token, title: "B", kind: "bundle", files });
    const slug = body.slug as string;
    expect((await fetchAs(t, `/cli/a/${slug}/about.html`, hostUa(slug))).headers.get("Content-Security-Policy")).toContain("allow-same-origin");
    expect((await fetchAs(t, `/cli/a/${slug}/about.html`, BROWSER_UA)).headers.get("Content-Security-Policy")).not.toContain("allow-same-origin");
  });

  test("X-Cast-Version names the version delivered: ?v=N carries N", async () => {
    const { t, api_token } = await setup();
    const first = await publish(t, { api_token, title: "V", content: PAGE, source_path: "/w/v.html" });
    await publish(t, { api_token, title: "V", content: PAGE.replace("vitals", "vitals 2"), source_path: "/w/v.html" });
    const slug = first.body.slug as string;
    expect((await t.fetch(`/cli/a/${slug}`)).headers.get("X-Cast-Version")).toBe("2");
    expect((await t.fetch(`/cli/a/${slug}?v=1`)).headers.get("X-Cast-Version")).toBe("1");
    expect((await fetchAs(t, `/cli/a/${slug}?v=1`, hostUa(slug))).headers.get("X-Cast-Version")).toBe("1");
    expect((await t.fetch(`/cli/a/${slug}?preview=1`)).headers.get("X-Cast-Version")).toBe("2");
  });
});

describe("Install as app on the bar", () => {
  test("is offered unless the page's team turned installs off", async () => {
    const { t, api_token, owner, team, as } = await setup();
    const conv = await t.run((ctx: any) => ctx.db.insert("conversations", {
      user_id: owner, agent_type: "claude_code", session_id: crypto.randomUUID(), started_at: 1, updated_at: 1,
      message_count: 0, is_private: false, status: "active", team_id: team, team_visibility: "full",
    }));
    const { body } = await publish(t, { api_token, title: "Vitals", content: PAGE, session_ref: String(conv) });
    const page = async () => await (await t.fetch(`/cli/a/${body.slug}`)).text();
    expect(await page()).toContain(`"installable":true`);
    expect(await page()).toContain("codecast://install/");
    await as(owner).mutation(api.teams.setAppsPolicy, { team_id: team, install: false });
    expect(await page()).toContain(`"installable":false`);
  });
});

describe("the app icon check at publish", () => {
  const bundle = (icon: Uint8Array) => [{ path: "index.html", content_b64: html(PAGE) }, { path: "icon.png", content_b64: b64(icon) }];

  test("reads the PNG's dimensions from its header", () => {
    expect(pngDimensions(monogramPng("A", "a", 256))).toEqual({ width: 256, height: 256 });
    expect(pngDimensions(new Uint8Array(24))).toBeNull();
  });

  test("accepts a square PNG of at least 512 px", async () => {
    const { t, api_token } = await setup();
    const res = await publish(t, { api_token, title: "I", kind: "bundle", files: bundle(monogramPng("I", "i", 1024)), data: { app: { icon: "icon.png" } } });
    expect(res.status).toBe(200);
  });

  test("refuses a small icon, a non-square icon, and bytes that are not a PNG, with the reason", async () => {
    const { t, api_token } = await setup();
    const small = await publish(t, { api_token, title: "I", kind: "bundle", files: bundle(monogramPng("I", "i", 256)), data: { app: { icon: "icon.png" } } });
    expect(small.status).toBe(400);
    expect(small.body.error).toBe(`cast-data.json: "app.icon" must be at least 512x512; icon.png is 256x256`);

    const wide = monogramPng("I", "i", 512);
    new DataView(wide.buffer, wide.byteOffset).setUint32(16, 640);
    const notSquare = await publish(t, { api_token, title: "I", kind: "bundle", files: bundle(wide), data: { app: { icon: "icon.png" } } });
    expect(notSquare.body.error).toBe(`cast-data.json: "app.icon" must be square; icon.png is 640x512`);

    const junk = await publish(t, { api_token, title: "I", kind: "bundle", files: bundle(new TextEncoder().encode("not a png at all, really not")), data: { app: { icon: "icon.png" } } });
    expect(junk.body.error).toBe(`cast-data.json: "app.icon" names icon.png, which is not a valid PNG`);
    expect(await t.run((ctx: any) => ctx.db.query("artifacts").collect())).toHaveLength(0);
  });

  test("checks an uploaded icon from storage too", async () => {
    const { t, api_token, owner } = await setup();
    const small = monogramPng("U", "u", 128);
    const storage_id = await t.run(async (ctx: any) => {
      const id = await ctx.storage.store(new Blob([small], { type: "image/png" }));
      return id;
    });
    // Register it as this user's upload the way the upload route does.
    await t.run(async (ctx: any) => {
      await ctx.db.insert("artifact_uploads", { user_id: owner, storage_id, created_at: Date.now() });
    });
    const res = await publish(t, { api_token, title: "U", kind: "bundle", files: [{ path: "index.html", content_b64: html(PAGE) }, { path: "icon.png", upload_id: storage_id }], data: { app: { icon: "icon.png" } } });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("must be at least 512x512; icon.png is 128x128");
  });
});
