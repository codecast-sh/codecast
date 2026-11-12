import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain .mjs build script
import { assetRefs, carryAssets } from "./carry-assets.mjs";

const live: Record<string, string> = {
  "/": `<script type="module" src="/assets/index-AAAAAAAA.js"></script><link rel="stylesheet" href="/assets/index-CCCCCCCC.css">`,
  "/assets/index-AAAAAAAA.js": `const m=["assets/MarketingLayout-iJ9FaHPZ.js","assets/shared-BBBBBBBB.js"];import("./MarketingLayout-iJ9FaHPZ.js");import("./codecast.js")`,
  "/assets/MarketingLayout-iJ9FaHPZ.js": `import{a}from"./shared-BBBBBBBB.js";`,
  "/assets/shared-BBBBBBBB.js": `export const a=1`,
  "/assets/index-CCCCCCCC.css": `@font-face{src:url(/assets/mono-DDDDDDDD.woff2)}`,
  "/assets/mono-DDDDDDDD.woff2": `font`,
};
const fetchImpl = async (url: string) => {
  const body = live[new URL(url).pathname];
  return body === undefined ? new Response("Not found", { status: 404 }) : new Response(body);
};

describe("carry-assets (ct-92522)", () => {
  const dir = mkdtempSync(join(tmpdir(), "carry-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("reads hashed refs in every form vite writes, not plain names", () => {
    expect(assetRefs(live["/assets/index-AAAAAAAA.js"]).sort()).toEqual(["MarketingLayout-iJ9FaHPZ.js", "shared-BBBBBBBB.js"]);
  });

  test("copies the live build's chunk graph into the new build, keeping the new build's own files", async () => {
    writeFileSync(join(dir, "shared-BBBBBBBB.js"), "new build");
    const r = await carryAssets({ origin: "https://codecast.sh", assetsDir: dir, fetchImpl });
    expect(readdirSync(dir).sort()).toEqual([
      "MarketingLayout-iJ9FaHPZ.js",
      "index-AAAAAAAA.js",
      "index-CCCCCCCC.css",
      "mono-DDDDDDDD.woff2",
      "shared-BBBBBBBB.js",
    ]);
    expect(readFileSync(join(dir, "shared-BBBBBBBB.js"), "utf8")).toBe("new build");
    expect(r.carried.sort()).toEqual(["MarketingLayout-iJ9FaHPZ.js", "index-AAAAAAAA.js", "index-CCCCCCCC.css", "mono-DDDDDDDD.woff2"]);
    expect(r.missing).toEqual([]);
    expect(r.complete).toBe(true);
  });

  test("an unreachable origin carries nothing and does not throw", async () => {
    const r = await carryAssets({ origin: "https://down.invalid", assetsDir: dir, fetchImpl: async () => new Response("", { status: 502 }) });
    expect(r.carried).toEqual([]);
  });
});
