/**
 * Audit trail: append, dedup, bounding, and the after-the-fact landing check.
 *
 * The trail is shared by every agent on the machine, so a row carries the
 * session that drove the tab; dedup is per TAB so a settle-check re-reporting
 * the page a tab is already on does not multiply rows.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { auditLanding, auditPath, readAudit, recordVisit, type AuditRecord } from "./audit.js";
import type { SitePolicy } from "./policy.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-audit-"));
  process.env.CODECAST_DIR = dir;
});
afterEach(() => {
  delete process.env.CODECAST_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const rec = (over: Partial<AuditRecord> = {}): AuditRecord => ({
  t: 1_000,
  origin: "https://example.com",
  session: "session:abc",
  tab: "TAB1",
  via: "open",
  ...over,
});

describe("recordVisit", () => {
  test("appends and reads back", () => {
    expect(recordVisit(rec())).toBe(true);
    const rows = readAudit();
    expect(rows).toHaveLength(1);
    expect(rows[0].origin).toBe("https://example.com");
  });

  test("skips a repeat of the tab's latest origin, but records a return visit", () => {
    recordVisit(rec());
    expect(recordVisit(rec({ t: 2_000 }))).toBe(false); // still there
    expect(recordVisit(rec({ t: 3_000, origin: "https://other.io" }))).toBe(true);
    expect(recordVisit(rec({ t: 4_000 }))).toBe(true); // came BACK — a real move
    expect(readAudit()).toHaveLength(3);
  });

  test("dedup is per tab — two tabs on one origin are two visits", () => {
    recordVisit(rec({ tab: "TAB1" }));
    expect(recordVisit(rec({ tab: "TAB2" }))).toBe(true);
  });

  test("a blocked attempt is never folded into an allowed visit", () => {
    recordVisit(rec());
    expect(recordVisit(rec({ blocked: true }))).toBe(true);
  });

  test("the file is bounded: crossing the cap drops the oldest half", () => {
    // Seed the file at the cap directly — looping recordVisit 4000 times would
    // re-read the whole file per call and turn this into a minute-long test.
    fs.mkdirSync(path.dirname(auditPath()), { recursive: true });
    const seeded = Array.from({ length: 4000 }, (_, i) => JSON.stringify(rec({ t: i, origin: `https://site${i}.com` })));
    fs.writeFileSync(auditPath(), seeded.join("\n") + "\n");
    recordVisit(rec({ t: 5_000, origin: "https://fresh.io" }));
    const rows = readAudit();
    expect(rows).toHaveLength(2000);
    expect(rows[rows.length - 1].origin).toBe("https://fresh.io");
    expect(rows[0].origin).toBe("https://site2001.com"); // oldest half gone
  });

  test("a torn line is dropped, not fatal", () => {
    recordVisit(rec());
    fs.appendFileSync(auditPath(), "{half a rec");
    recordVisit(rec({ origin: "https://other.io" }));
    expect(readAudit()).toHaveLength(2);
  });
});

describe("auditLanding", () => {
  const lockdown: SitePolicy = {
    sources: [{ file: "/proj/workspace.toml", key: "[browser] allow", patterns: ["github.com"] }],
    errors: [],
  };

  test("in-policy landing records silently", () => {
    const warn = auditLanding({ url: "https://github.com/x", tab: "T", session: "s", via: "open", policy: lockdown });
    expect(warn).toBeNull();
    const row = readAudit()[0];
    expect(row.origin).toBe("https://github.com");
    expect(row.blocked).toBeUndefined();
  });

  test("off-policy landing records as blocked and warns loudly", () => {
    const warn = auditLanding({ url: "https://evil.example/p", tab: "T", session: "s", via: "action", policy: lockdown });
    expect(warn).toContain("OUTSIDE the site allowlist");
    expect(warn).toContain("cast browser audit");
    expect(readAudit()[0].blocked).toBe(true);
  });

  test("no policy: the landing is still recorded — the trail is always on", () => {
    const warn = auditLanding({ url: "https://anywhere.io", tab: "T", session: "s", via: "batch", policy: null });
    expect(warn).toBeNull();
    expect(readAudit()).toHaveLength(1);
  });

  test("browser furniture is not a visit", () => {
    auditLanding({ url: "about:blank", tab: "T", session: "s", via: "open", policy: null });
    expect(readAudit()).toHaveLength(0);
  });
});
