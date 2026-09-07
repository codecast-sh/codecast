import { describe, expect, test } from "bun:test";

import {
  assertRequiredAssets,
  fetchDraftAwareRelease,
  findAssetShortfall,
  getRequiredReleaseAssetNames,
  verifyRequiredReleaseAssets,
  type ReleaseSummary,
} from "./verify-release-required-assets.ts";

const REQUIRED = getRequiredReleaseAssetNames();

const release = (assets: ReleaseSummary["assets"], extra: Partial<ReleaseSummary> = {}) =>
  ({ tag_name: "v1.2.4", draft: true, prerelease: false, assets, ...extra }) as ReleaseSummary;

const complete = () => REQUIRED.map((name) => ({ name, state: "uploaded", size: 42_000_000 }));

const jsonResponse = (body: unknown, init: { status?: number } = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });

describe("required asset names", () => {
  test("are the five artifacts one build produces, windows carrying .exe", () => {
    expect(REQUIRED).toEqual([
      "codecast-darwin-arm64",
      "codecast-darwin-x64",
      "codecast-linux-arm64",
      "codecast-linux-x64",
      "codecast-windows-x64.exe",
    ]);
  });
});

describe("findAssetShortfall", () => {
  test("finds nothing wrong with a complete release", () => {
    expect(findAssetShortfall(release(complete()))).toEqual({
      missing: [],
      notUploaded: [],
      empty: [],
    });
    expect(() => assertRequiredAssets("v1.2.4", release(complete()))).not.toThrow();
  });

  test("names a platform that never uploaded", () => {
    const assets = complete().filter((a) => a.name !== "codecast-linux-arm64");
    expect(findAssetShortfall(release(assets)).missing).toEqual(["codecast-linux-arm64"]);
    expect(() => assertRequiredAssets("v1.2.4", release(assets))).toThrow(
      /Missing: codecast-linux-arm64/,
    );
  });

  test("names an asset still uploading", () => {
    const assets = complete().map((a) =>
      a.name === "codecast-windows-x64.exe" ? { ...a, state: "starter" } : a,
    );
    expect(findAssetShortfall(release(assets)).notUploaded).toEqual([
      "codecast-windows-x64.exe:starter",
    ]);
  });

  test("names a zero byte asset", () => {
    const assets = complete().map((a) =>
      a.name === "codecast-darwin-x64" ? { ...a, size: 0 } : a,
    );
    expect(findAssetShortfall(release(assets)).empty).toEqual(["codecast-darwin-x64"]);
  });

  test("reports every kind of shortfall in one message", () => {
    const assets = complete()
      .filter((a) => a.name !== "codecast-linux-x64")
      .map((a) => (a.name === "codecast-darwin-x64" ? { ...a, size: 0 } : a))
      .map((a) => (a.name === "codecast-windows-x64.exe" ? { ...a, state: "starter" } : a));
    expect(() => assertRequiredAssets("v1.2.4", release(assets))).toThrow(
      /Missing: codecast-linux-x64\nNot uploaded: codecast-windows-x64.exe:starter\nEmpty: codecast-darwin-x64/,
    );
  });

  test("ignores assets nobody asked for", () => {
    const assets = [...complete(), { name: "main.js.map", state: "uploaded", size: 10 }];
    expect(findAssetShortfall(release(assets)).missing).toEqual([]);
  });
});

describe("fetchDraftAwareRelease", () => {
  const token = "t";
  const repo = "codecast-sh/codecast";

  test("reads the list endpoint, which is the only one that sees drafts", async () => {
    let requested = "";
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requested = String(url);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer t");
      return jsonResponse([release(complete(), { tag_name: "v1.2.4" })]);
    }) as unknown as typeof fetch;

    const found = await fetchDraftAwareRelease({ repo, tag: "v1.2.4", token, fetchImpl });
    expect(requested).toBe(`https://api.github.com/repos/${repo}/releases?per_page=100`);
    expect(found.draft).toBe(true);
  });

  test("refuses a tag that is absent or duplicated", async () => {
    const withReleases = (body: unknown) =>
      (async () => jsonResponse(body)) as unknown as typeof fetch;

    await expect(
      fetchDraftAwareRelease({ repo, tag: "v1.2.4", token, fetchImpl: withReleases([]) }),
    ).rejects.toThrow(/appears 0 times/);

    await expect(
      fetchDraftAwareRelease({
        repo,
        tag: "v1.2.4",
        token,
        fetchImpl: withReleases([release([]), release([])]),
      }),
    ).rejects.toThrow(/appears 2 times/);
  });

  test("surfaces an API failure instead of passing", async () => {
    const fetchImpl = (async () =>
      new Response("bad credentials", { status: 401 })) as unknown as typeof fetch;
    await expect(
      fetchDraftAwareRelease({ repo, tag: "v1.2.4", token, fetchImpl }),
    ).rejects.toThrow(/failed 401/);
  });
});

describe("verifyRequiredReleaseAssets", () => {
  test("reports the draft state of a complete release", async () => {
    const fetchImpl = (async () =>
      jsonResponse([release(complete())])) as unknown as typeof fetch;
    const result = await verifyRequiredReleaseAssets({
      repo: "codecast-sh/codecast",
      tag: "v1.2.4",
      token: "t",
      fetchImpl,
    });
    expect(result).toEqual({ tag: "v1.2.4", checked: REQUIRED, draft: true });
  });

  test("throws on an incomplete release", async () => {
    const fetchImpl = (async () =>
      jsonResponse([release(complete().slice(1))])) as unknown as typeof fetch;
    await expect(
      verifyRequiredReleaseAssets({
        repo: "codecast-sh/codecast",
        tag: "v1.2.4",
        token: "t",
        fetchImpl,
      }),
    ).rejects.toThrow(/is not ready to publish/);
  });
});
