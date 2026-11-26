// The installed-apps e2e harness (packages/electron/installedApps/e2e) plays
// a.codecast.sh with a stand-in. This holds the stand-in to the real serve
// route: the same example bundles are published through the real publish
// route, and every request a host makes (page, redirect, host user agent,
// gate refusals, ?app=1, icons, assets, _data) goes to both, which must
// answer with the same status, headers and body. A host that passes the
// harness then meets the same answers on prod, short of the edge worker
// (infra/artifact-edge, with its own tests).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { convexTest } from "convex-test";
import { presentToken } from "@platform/auth/convex";
import { pageHostUserAgentSuffix } from "@codecast/shared/contracts";
import schema from "./schema";
import { allModules } from "./testModules.testkit";
import { hashToken } from "./apiTokens";
import { kTokenFor } from "./lib/artifactGates";
import { monogramPng } from "./lib/appIcon";
// @ts-expect-error a plain ES module without types
import { startStandin, EXAMPLES } from "../../electron/installedApps/e2e/standin.mjs";

setDefaultTimeout(180_000);

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36";
const hostUa = (slug: string) => `Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko)${pageHostUserAgentSuffix("1.1.253", slug)}`;
const HEADERS = [
  "content-type", "content-security-policy", "cache-control", "vary", "x-cast-version", "access-control-expose-headers",
  "x-content-type-options", "referrer-policy", "x-robots-tag", "location",
];

function bundleFiles(example: string) {
  const dir = join(EXAMPLES, example);
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  return walk(dir)
    .filter((f) => !f.endsWith("cast-data.json"))
    .map((f) => ({ path: relative(dir, f), content_b64: readFileSync(f).toString("base64") }));
}
const titleOf = (example: string) => /<title>([^<]*)<\/title>/i.exec(readFileSync(join(EXAMPLES, example, "index.html"), "utf8"))![1].trim();

let t: any;
let standin: any;
const slugs: Record<string, string> = {};
let k = "";

beforeAll(async () => {
  t = convexTest(schema, allModules);
  const owner = await t.run(async (ctx: any) => ctx.db.insert("users", { name: "Ada", email: "ada@acme.dev" }));
  const secret = `tok_${owner}`;
  await t.run(async (ctx: any) => {
    await ctx.db.insert("api_tokens", { user_id: owner, token_hash: await hashToken(secret), name: "mac", created_at: 1, last_used_at: 1, device_id: "dev1" });
    await ctx.db.insert("devices", { user_id: owner, device_id: "dev1", label: "mac", platform: "darwin", last_seen: 1 });
  });
  const api_token = presentToken(secret, "dev1");
  const publish = async (example: string, extra: Record<string, unknown>, app: (a: any) => any = (a) => a) => {
    const decl = JSON.parse(readFileSync(join(EXAMPLES, example, "cast-data.json"), "utf8"));
    const res = await t.fetch("/cli/artifacts/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_token, title: titleOf(example), kind: "bundle", files: bundleFiles(example), data: { ...decl, app: app(decl.app) }, ...extra }),
    });
    const body = await res.json();
    if (res.status !== 200) throw new Error(`publish ${example}: ${JSON.stringify(body)}`);
    return body.slug as string;
  };
  slugs.gated = await publish("needs-you", { access: { password: "pw" } });
  slugs.open = await publish("standup-board", { source_path: "/w/standup" });
  slugs.noicon = await publish("standup-board", { source_path: "/w/noicon" }, ({ icon: _icon, ...rest }) => rest);
  const row = await t.run((ctx: any) => ctx.db.query("artifacts").withIndex("by_slug", (q: any) => q.eq("slug", slugs.gated)).first());
  k = await kTokenFor(row.password_hash, slugs.gated);
  // No request here proves a viewer, so the real route answers for an anonymous one.
  standin = await startStandin({
    owner: "Ada",
    apps: [
      { slug: slugs.gated, example: "needs-you", gate: { k }, relation: "anonymous" },
      { slug: slugs.open, example: "standup-board", relation: "anonymous" },
      { slug: slugs.noicon, example: "standup-board", icon: false, relation: "anonymous" },
    ],
  });
});
afterAll(async () => {
  await standin?.close();
});

type Answer = { status: number; headers: Record<string, string | null>; body: Uint8Array };
async function both(path: string, ua = BROWSER_UA): Promise<{ real: Answer; standin: Answer }> {
  const read = async (res: Response): Promise<Answer> => {
    const headers: Record<string, string | null> = {};
    for (const h of HEADERS) headers[h] = res.headers.get(h);
    if (headers.location) headers.location = headers.location.replace(/^\/cli\/a\//, "/");
    return { status: res.status, headers, body: new Uint8Array(await res.arrayBuffer()) };
  };
  const real = await read(await t.fetch(`/cli/a${path}`, { headers: { "User-Agent": ua }, redirect: "manual" }));
  const local = await read(await fetch(`${standin.origin}${path}`, { headers: { "User-Agent": ua }, redirect: "manual" }));
  return { real, standin: local };
}
const text = (a: Answer) => new TextDecoder().decode(a.body);
/** Status and headers equal; returns both for body checks. */
async function same(path: string, ua?: string) {
  const r = await both(path, ua);
  expect({ path, status: r.standin.status, headers: r.standin.headers }).toEqual({ path, status: r.real.status, headers: r.real.headers });
  return r;
}

describe("the e2e stand-in answers like the real serve route", () => {
  test("a bundle's bare slug redirects to its folder, keeping the query", async () => {
    const r = await same(`/${slugs.open}?host=app&surface=window`);
    expect(r.real.status).toBe(301);
  });

  test("the page document: X-Cast-Version, the bar and the page's cache policy for a browser", async () => {
    for (const path of [`/${slugs.open}/?host=app`, `/${slugs.gated}/?host=app&k=${k}`]) {
      const r = await same(path);
      expect(r.real.status).toBe(200);
      expect(text(r.real)).toContain("__cc_bar");
      expect(text(r.standin)).toContain("__cc_bar");
    }
  });

  test("the host user agent: no bar, allow-same-origin, private, no-store, Vary", async () => {
    for (const [slug, q] of [[slugs.open, ""], [slugs.gated, `&k=${k}`]]) {
      const r = await same(`/${slug}/?host=app&surface=window${q}`, hostUa(slug));
      expect(r.real.headers["content-security-policy"]).toContain("allow-same-origin");
      expect(text(r.real)).not.toContain("__cc_bar");
      expect(text(r.standin)).not.toContain("__cc_bar");
    }
    // Another page's host is a browser.
    await same(`/${slugs.open}/?host=app`, hostUa(slugs.gated));
  });

  test("without its key a gated page refuses each request the way the real gate does", async () => {
    for (const path of [`/${slugs.gated}?host=app`, `/${slugs.gated}/?host=app`, `/${slugs.gated}/tray.png`, `/${slugs.gated}/_data/waiting`]) {
      const r = await same(path, hostUa(slugs.gated));
      expect(r.real.status).toBe(200);
      expect(text(r.real)).toContain("codecast:gate");
      expect(text(r.standin)).toContain("codecast:gate");
    }
    const facts = await same(`/${slugs.gated}?app=1`);
    expect(facts.real.status).toBe(403);
    expect(JSON.parse(text(facts.standin))).toEqual(JSON.parse(text(facts.real)));
    const icon = await same(`/${slugs.gated}?icon=512`);
    expect(icon.real.status).toBe(404);
  });

  test("?app=1 is the same AppInfo", async () => {
    for (const [slug, q] of [[slugs.gated, `&k=${k}`], [slugs.open, ""], [slugs.noicon, ""]]) {
      const r = await same(`/${slug}?app=1${q}`);
      expect(r.real.status).toBe(200);
      const strip = (info: any) => ({
        ...info,
        updated_at: typeof info.updated_at,
        icons: Object.fromEntries(Object.entries(info.icons).map(([size, u]) => [size, String(u).replace(/^https?:\/\/[^/]+/, "")])),
      });
      expect(strip(JSON.parse(text(r.standin)))).toEqual(strip(JSON.parse(text(r.real))));
    }
  });

  test("icons: the declared PNG, else the generated monogram, byte for byte", async () => {
    for (const [slug, q] of [[slugs.gated, `&k=${k}`], [slugs.open, ""], [slugs.noicon, ""]]) {
      for (const size of ["512", "1024"]) {
        const r = await same(`/${slug}?icon=${size}${q}`);
        expect(r.real.status).toBe(200);
        expect(Buffer.from(r.standin.body).equals(Buffer.from(r.real.body))).toBe(true);
      }
    }
    const generated = await both(`/${slugs.noicon}?icon=1024`);
    expect(Buffer.from(generated.real.body).equals(Buffer.from(monogramPng(titleOf("standup-board"), slugs.noicon, 1024)))).toBe(true);
  });

  test("a bundle asset carries the sandbox, and the host sandbox for the host", async () => {
    await same(`/${slugs.gated}/tray.png?k=${k}`);
    await same(`/${slugs.gated}/tray.png?k=${k}`, hostUa(slugs.gated));
    await same(`/${slugs.open}/fonts/InstrumentSans-Regular.ttf`, hostUa(slugs.open));
    await same(`/${slugs.open}/nope.png`);
  });

  test("an unknown page is not found", async () => {
    await same(`/zzzzzzzzzzzz`);
  });
});
