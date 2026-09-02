import { describe, expect, it } from "bun:test";
import { formatCheckLine, formatDoctorJson, formatDoctorReport, runDoctor, type DoctorCheck } from "./index";

const pass: DoctorCheck = { name: "auth", run: () => ({ ok: true, detail: "authenticated" }) };
const fail: DoctorCheck = { name: "daemon", run: () => ({ ok: false, detail: "not running", fix: "run `acme start`" }) };
const warn: DoctorCheck = { name: "disk", run: () => ({ ok: false, warn: true, detail: "90% full" }) };
const skip: DoctorCheck = { name: "cursor", run: () => ({ ok: true, skip: true, detail: "not installed" }) };

describe("runDoctor", () => {
  it("records one line per check with the right status", async () => {
    const report = await runDoctor([pass, fail, warn, skip], { product: "Acme", version: "1.0.0" });
    expect(report.checks.map((c) => c.status)).toEqual(["pass", "fail", "warn", "skip"]);
    expect(report.ok).toBe(false);
    expect(report.checks[1].fix).toBe("run `acme start`");
  });

  it("is healthy with warnings and skips only", async () => {
    const report = await runDoctor([pass, warn, skip], { product: "Acme", version: "1.0.0" });
    expect(report.ok).toBe(true);
  });

  it("turns a thrown error into a failure", async () => {
    const boom: DoctorCheck = { name: "boom", run: () => { throw new Error("kaput"); } };
    const report = await runDoctor([boom], { product: "Acme", version: "1" });
    expect(report.checks[0]).toMatchObject({ status: "fail", detail: "kaput" });
  });

  it("skips checks whose dependency failed and streams records", async () => {
    const e2e: DoctorCheck = { name: "end-to-end", dependsOn: ["daemon"], run: () => ({ ok: true, detail: "should not run" }) };
    const seen: string[] = [];
    const report = await runDoctor([fail, e2e], { product: "Acme", version: "1", onCheck: (r) => seen.push(r.name) });
    expect(report.checks[1]).toMatchObject({ status: "skip", detail: "skipped: daemon failed" });
    expect(seen).toEqual(["daemon", "end-to-end"]);
  });

  it("times out a slow check", async () => {
    const slow: DoctorCheck = { name: "slow", timeoutMs: 20, run: () => new Promise((r) => setTimeout(() => r({ ok: true, detail: "late" }), 200)) };
    const report = await runDoctor([slow], { product: "Acme", version: "1" });
    expect(report.checks[0].status).toBe("fail");
    expect(report.checks[0].detail).toContain("timed out");
  });

  it("measures elapsed time with the injected clock", async () => {
    let t = 0;
    const tick: DoctorCheck = { name: "tick", run: () => { t += 1500; return { ok: true, detail: "ok" }; } };
    const report = await runDoctor([tick], { product: "Acme", version: "1", now: () => t });
    expect(report.checks[0].elapsedMs).toBe(1500);
  });
});

describe("formatters", () => {
  it("prints glyph, padded name, detail, fix and timing", () => {
    const line = formatCheckLine({ name: "daemon", status: "fail", detail: "not running", fix: "run it", elapsedMs: 2300 });
    expect(line).toBe(`  ✗ ${"daemon".padEnd(22)} not running — run it  2.3s`);
    const fast = formatCheckLine({ name: "auth", status: "pass", detail: "ok", elapsedMs: 5 });
    expect(fast).toBe(`  ✓ ${"auth".padEnd(22)} ok`);
  });

  it("applies color hooks", () => {
    const line = formatCheckLine({ name: "a", status: "warn", detail: "d", elapsedMs: 0 }, { color: { warning: (s) => `[${s}]` } });
    expect(line.startsWith("  [!]")).toBe(true);
  });

  it("renders the report with a verdict", async () => {
    const ok = await runDoctor([pass], { product: "Acme", version: "2.0.0" });
    const text = formatDoctorReport(ok);
    expect(text).toContain("Acme Doctor  (v2.0.0)");
    expect(text).toContain("✓ acme is healthy");
    const bad = await runDoctor([fail], { product: "Acme", version: "2.0.0" });
    expect(formatDoctorReport(bad)).toContain("✗ problems found");
    expect(JSON.parse(formatDoctorJson(bad)).ok).toBe(false);
  });
});
