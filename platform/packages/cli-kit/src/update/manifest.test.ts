import { describe, expect, it } from "bun:test";
import { checkBinaryEntry, isReleaseManifest, releaseOrigin } from "./manifest";

const BASE = "https://dl.example.com";
const SHA = "ab".repeat(32);
const opts = { releaseBaseUrl: BASE, maxBytes: 1024 };

describe("checkBinaryEntry", () => {
  it("accepts a same-origin https asset with a well formed digest", () => {
    const r = checkBinaryEntry({ url: `${BASE}/cli/releases/v1.2.3/abc/acme-darwin-arm64`, sha256: SHA }, opts);
    expect(r.ok).toBe(true);
  });

  it("accepts today's manifests, which carry no size", () => {
    expect(checkBinaryEntry({ url: `${BASE}/acme-darwin-arm64`, sha256: SHA.toUpperCase() }, opts).ok).toBe(true);
  });

  it("refuses http, another origin, credentials, a query and a fragment", () => {
    for (const url of [
      `http://dl.example.com/acme`,
      `https://evil.example.com/acme`,
      `https://dl.example.com.evil.net/acme`,
      `https://dl.example.com:8443/acme`,
      `https://u:p@dl.example.com/acme`,
      `${BASE}/acme?x=1`,
      `${BASE}/acme#f`,
      `ftp://dl.example.com/acme`,
      `not a url`,
    ]) {
      const r = checkBinaryEntry({ url, sha256: SHA }, opts);
      expect(r.ok, url).toBe(false);
    }
  });

  it("treats shell metacharacters in the path as data and refuses them", () => {
    for (const path of [`/acme"; touch /tmp/pwn; "`, "/acme$(id)", "/acme`id`", "/acme;id", "/acme|id", "/acme&id", "/acme id", "/acme%2e%2e/x", "/a\nb"]) {
      const r = checkBinaryEntry({ url: `${BASE}${path}`, sha256: SHA }, opts);
      expect(r.ok, path).toBe(false);
      if (!r.ok) expect(r.error).toBe("url_unsafe_path");
    }
  });

  it("refuses a malformed digest", () => {
    for (const sha256 of ["", "abc", SHA.slice(1), SHA + "a", "zz".repeat(32), `sha256:${SHA}`, ` ${SHA}`]) {
      const r = checkBinaryEntry({ url: `${BASE}/acme`, sha256 }, opts);
      expect(r.ok, sha256).toBe(false);
      if (!r.ok) expect(r.error).toBe("digest_malformed");
    }
  });

  it("refuses a declared size outside the bounds", () => {
    expect(checkBinaryEntry({ url: `${BASE}/acme`, sha256: SHA, size: 1024 }, opts).ok).toBe(true);
    for (const size of [1025, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = checkBinaryEntry({ url: `${BASE}/acme`, sha256: SHA, size }, opts);
      expect(r.ok, String(size)).toBe(false);
      if (!r.ok) expect(r.error).toBe("size_out_of_bounds");
    }
  });

  it("derives the release origin from the base url", () => {
    expect(releaseOrigin("https://dl.example.com/")).toBe("https://dl.example.com");
    expect(releaseOrigin("https://dl.example.com/releases")).toBe("https://dl.example.com");
  });
});

describe("isReleaseManifest", () => {
  it("still accepts a manifest with no signature block", () => {
    expect(isReleaseManifest({ version: "1.0.0", released: "", binaries: { "darwin-arm64": { url: "u", sha256: "s" } } })).toBe(true);
  });
  it("rejects an entry whose size is not a number", () => {
    expect(isReleaseManifest({ version: "1.0.0", released: "", binaries: { k: { url: "u", sha256: "s", size: "1" } } })).toBe(false);
  });
});
