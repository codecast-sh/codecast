/**
 * Site policy: origin matching and the enforcement decision.
 *
 * The rules under test (documented in policy.ts):
 *   - a bare host is exact — http/https, any port
 *   - `*.host` covers the apex AND every subdomain, never lookalike hosts
 *   - an explicit port is exact, with scheme defaults filled in
 *   - a scheme in the pattern restricts to that scheme
 *   - no policy configured = everything allowed; configured-but-empty = nothing
 *   - a broken policy source fails CLOSED, naming the file
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkUrl, denyNavigation, findManifestFile, isInternalUrl, loadSitePolicy, originOf, parsePattern,
  type SitePolicy,
} from "./policy.js";

const policyOf = (...patterns: string[]): SitePolicy => ({
  sources: [{ file: "/tmp/workspace.toml", key: "[browser] allow", patterns }],
  errors: [],
});

describe("origin matching", () => {
  test("bare host matches exactly, both schemes, any port", () => {
    const p = policyOf("example.com");
    expect(checkUrl(p, "https://example.com/a/b?c=1").allowed).toBe(true);
    expect(checkUrl(p, "http://example.com").allowed).toBe(true);
    expect(checkUrl(p, "https://example.com:8443/x").allowed).toBe(true);
    expect(checkUrl(p, "https://sub.example.com").allowed).toBe(false);
    expect(checkUrl(p, "https://notexample.com").allowed).toBe(false);
    expect(checkUrl(p, "https://example.com.evil.io").allowed).toBe(false);
  });

  test("*.host covers apex and every subdomain, not lookalikes", () => {
    const p = policyOf("*.example.com");
    expect(checkUrl(p, "https://example.com").allowed).toBe(true);
    expect(checkUrl(p, "https://api.example.com").allowed).toBe(true);
    expect(checkUrl(p, "https://a.b.example.com").allowed).toBe(true);
    expect(checkUrl(p, "https://badexample.com").allowed).toBe(false);
    expect(checkUrl(p, "https://example.com.evil.io").allowed).toBe(false);
  });

  test("explicit port is exact, and scheme defaults count as that port", () => {
    const p = policyOf("localhost:3200");
    expect(checkUrl(p, "http://localhost:3200/inbox").allowed).toBe(true);
    expect(checkUrl(p, "http://localhost:9999").allowed).toBe(false);
    // 443 is what https means, so the pattern matches the portless URL.
    const q = policyOf("example.com:443");
    expect(checkUrl(q, "https://example.com").allowed).toBe(true);
    expect(checkUrl(q, "http://example.com").allowed).toBe(false); // port 80
  });

  test("a scheme in the pattern restricts to that scheme", () => {
    const p = policyOf("http://localhost");
    expect(checkUrl(p, "http://localhost:3000").allowed).toBe(true);
    expect(checkUrl(p, "https://localhost").allowed).toBe(false);
  });

  test("non-http(s) schemes are refused unless the pattern names them", () => {
    const p = policyOf("example.com");
    expect(checkUrl(p, "file:///etc/passwd").allowed).toBe(false);
    expect(checkUrl(p, "data:text/html,<h1>x</h1>").allowed).toBe(false);
  });

  test("case and paths in patterns are tolerated", () => {
    const p = policyOf("HTTPS://Example.COM/some/path");
    expect(checkUrl(p, "https://example.com/other").allowed).toBe(true);
  });

  test("`*` allows everything", () => {
    const p = policyOf("*");
    expect(checkUrl(p, "https://anything.at.all").allowed).toBe(true);
  });

  test("blank and malformed patterns never match", () => {
    expect(parsePattern("")).toBeNull();
    expect(parsePattern("   ")).toBeNull();
    expect(checkUrl(policyOf("", "  "), "https://example.com").allowed).toBe(false);
  });
});

describe("enforcement decision", () => {
  test("no policy at all allows everything", () => {
    expect(checkUrl(null, "https://anywhere.io").allowed).toBe(true);
    expect(denyNavigation(null, "https://anywhere.io")).toBeNull();
  });

  test("a configured empty list refuses every site", () => {
    const p = policyOf();
    expect(checkUrl(p, "https://example.com").allowed).toBe(false);
  });

  test("browser furniture is always allowed", () => {
    expect(isInternalUrl("about:blank")).toBe(true);
    expect(isInternalUrl("chrome://settings")).toBe(true);
    expect(checkUrl(policyOf(), "about:blank").allowed).toBe(true);
  });

  test("union across sources: either file can allow", () => {
    const p: SitePolicy = {
      sources: [
        { file: "/proj/workspace.toml", key: "[browser] allow", patterns: ["github.com"] },
        { file: "/home/config.json", key: "browser_allow", patterns: ["*.google.com"] },
      ],
      errors: [],
    };
    expect(checkUrl(p, "https://github.com").allowed).toBe(true);
    expect(checkUrl(p, "https://docs.google.com").allowed).toBe(true);
    expect(checkUrl(p, "https://gitlab.com").allowed).toBe(false);
  });

  test("a broken source fails closed and names the file", () => {
    const p: SitePolicy = { sources: [], errors: [{ file: "/proj/workspace.toml", message: "invalid TOML" }] };
    const verdict = checkUrl(p, "https://example.com");
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("/proj/workspace.toml");
    const deny = denyNavigation(p, "https://example.com");
    expect(deny!.hint).toContain("fails closed");
  });

  test("refusal names the policy source and how to amend it", () => {
    const deny = denyNavigation(policyOf("github.com"), "https://evil.example");
    expect(deny).not.toBeNull();
    expect(deny!.message).toContain("evil.example");
    expect(deny!.hint).toContain("/tmp/workspace.toml");
    expect(deny!.hint).toContain('"evil.example"');
  });
});

describe("loading from disk", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-policy-"));
    process.env.CODECAST_DIR = path.join(dir, "codecast-home");
  });
  afterEach(() => {
    delete process.env.CODECAST_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const writeManifest = (root: string, body: string) => {
    fs.mkdirSync(path.join(root, ".codecast"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codecast", "workspace.toml"), body);
  };

  test("nothing configured anywhere → null policy", () => {
    expect(loadSitePolicy(dir)).toBeNull();
  });

  test("project allowlist is found by walking up from a subdirectory", () => {
    writeManifest(dir, `[browser]\nallow = ["github.com", "*.example.com"]\n`);
    const sub = path.join(dir, "packages", "web");
    fs.mkdirSync(sub, { recursive: true });
    expect(findManifestFile(sub)).toBe(path.join(dir, ".codecast", "workspace.toml"));
    const policy = loadSitePolicy(sub)!;
    expect(policy.sources).toHaveLength(1);
    expect(checkUrl(policy, "https://api.example.com").allowed).toBe(true);
    expect(checkUrl(policy, "https://gitlab.com").allowed).toBe(false);
  });

  test("a manifest without [browser].allow is no policy", () => {
    writeManifest(dir, `[setup]\ncopy = [".env"]\n`);
    expect(loadSitePolicy(dir)).toBeNull();
  });

  test("global browser_allow in config.json is a source, unioned with the project", () => {
    writeManifest(dir, `[browser]\nallow = ["github.com"]\n`);
    fs.mkdirSync(process.env.CODECAST_DIR!, { recursive: true });
    fs.writeFileSync(
      path.join(process.env.CODECAST_DIR!, "config.json"),
      JSON.stringify({ browser_allow: ["codecast.sh"] }),
    );
    const policy = loadSitePolicy(dir)!;
    expect(policy.sources).toHaveLength(2);
    expect(checkUrl(policy, "https://codecast.sh").allowed).toBe(true);
    expect(checkUrl(policy, "https://github.com").allowed).toBe(true);
  });

  test("an unparseable manifest loads as an error and blocks", () => {
    writeManifest(dir, `[browser\nallow = broken`);
    const policy = loadSitePolicy(dir)!;
    expect(policy.errors).toHaveLength(1);
    expect(checkUrl(policy, "https://example.com").allowed).toBe(false);
  });

  test("a malformed global browser_allow blocks rather than vanishing", () => {
    fs.mkdirSync(process.env.CODECAST_DIR!, { recursive: true });
    fs.writeFileSync(path.join(process.env.CODECAST_DIR!, "config.json"), JSON.stringify({ browser_allow: "github.com" }));
    const policy = loadSitePolicy(dir)!;
    expect(policy.errors).toHaveLength(1);
    expect(checkUrl(policy, "https://github.com").allowed).toBe(false);
  });
});

describe("origin labels", () => {
  test("real origins keep scheme, host and explicit port", () => {
    expect(originOf("https://example.com/a?b=1")).toBe("https://example.com");
    expect(originOf("http://localhost:3200/inbox")).toBe("http://localhost:3200");
  });
  test("originless schemes fall back to a scheme label", () => {
    expect(originOf("file:///etc/hosts")).toBe("file://");
  });
});
