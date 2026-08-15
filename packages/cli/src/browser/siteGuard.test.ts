/**
 * The two hooks every driver path shares. What matters here is that a driver
 * only has to make these two calls to get identical policy behaviour — so the
 * refusal must already have written the audit row, and the verb table must
 * classify each passthrough verb the way the built-in driver labels it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NAVIGATING_VERBS, refuseNavigation, viaFor, withScheme } from "./siteGuard.js";
import { readAudit } from "./audit.js";
import type { SitePolicy } from "./policy.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-guard-"));
  process.env.CODECAST_DIR = dir;
});
afterEach(() => {
  delete process.env.CODECAST_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const lockdown: SitePolicy = {
  sources: [{ file: "/proj/workspace.toml", key: "[browser] allow", patterns: ["example.com"] }],
  errors: [],
};

describe("refuseNavigation", () => {
  test("allowed → null, nothing recorded yet (the landing records it)", () => {
    expect(refuseNavigation("https://example.com/x", "s", "open", lockdown)).toBeNull();
    expect(readAudit()).toHaveLength(0);
  });

  test("refused → message + hint, and the attempt is already on the trail", () => {
    const deny = refuseNavigation("evil.example", "s", "open", lockdown);
    expect(deny!.message).toContain("https://evil.example");
    const rows = readAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: "https://evil.example", blocked: true, via: "open", tab: "-" });
  });

  test("no policy → never refuses", () => {
    expect(refuseNavigation("https://anything.io", "s", "batch", null)).toBeNull();
  });
});

describe("passthrough verb table", () => {
  test("verbs that can move the page are audited; read-only ones are not", () => {
    for (const v of ["open", "click", "press", "back", "reload", "do"]) expect(NAVIGATING_VERBS.has(v)).toBe(true);
    for (const v of ["snapshot", "text", "console", "shot", "eval"]) expect(NAVIGATING_VERBS.has(v)).toBe(false);
  });
  test("via labels match the built-in driver's", () => {
    expect(viaFor("open")).toBe("open");
    expect(viaFor("back")).toBe("history");
    expect(viaFor("reload")).toBe("reload");
    expect(viaFor("do")).toBe("batch");
    expect(viaFor("click")).toBe("action");
  });
  test("withScheme mirrors open's bare-host default", () => {
    expect(withScheme("example.com")).toBe("https://example.com");
    expect(withScheme("http://x")).toBe("http://x");
  });
});
