import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalDirectory } from "./orgTemplateArtifact";
import { mergeToml, nestedConfig, writeInstanceFile } from "./orgTemplateInstance";

const dirs: string[] = [];
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "org-template-instance-")); dirs.push(dir); return canonicalDirectory(dir); };
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const inputs = [
  { key: "product.domain", label: "Domain", kind: "string" as const },
  { key: "budget.monthly_envelope_usd", label: "Envelope", kind: "money" as const },
  { key: "metric.window_days", label: "Window", kind: "number" as const },
  { key: "accounts.search_console", label: "Search Console", kind: "boolean" as const },
];

describe("instance file", () => {
  test("answers nest by dotted key with the manifest's types", () => {
    expect(nestedConfig({ inputs }, { "product.domain": "acme.io", "budget.monthly_envelope_usd": "300", "metric.window_days": "7", "accounts.search_console": "true" }))
      .toEqual({ product: { domain: "acme.io" }, budget: { monthly_envelope_usd: 300 }, metric: { window_days: 7 }, accounts: { search_console: true } });
  });
  test("TOML merge rewrites keys in place, keeps comments and untouched sections, appends what is missing", () => {
    const before = `# Growth instance for acme.\n[pack]\nversion = "1.2.0"\n\n[product]\nname = "Acme"\ndomain = "old.example"   # apex; keep\n\n[budget]\nmonthly_envelope_usd = 100\nads_daily_usd = 10\n\n[ledgers]\ncmo = "ct-1"   # reused\n`;
    const after = mergeToml(before, { product: { domain: "acme.io" }, budget: { monthly_envelope_usd: 300 }, metric: { window_days: 7 }, accounts: { search_console: true } });
    expect(after).toBe(`# Growth instance for acme.\n[pack]\nversion = "1.2.0"\n\n[product]\nname = "Acme"\ndomain = "acme.io"   # apex; keep\n\n[budget]\nmonthly_envelope_usd = 300\nads_daily_usd = 10\n\n[ledgers]\ncmo = "ct-1"   # reused\n\n[metric]\nwindow_days = 7\n\n[accounts]\nsearch_console = true\n`);
    expect(Bun.TOML.parse(after)).toMatchObject({ product: { domain: "acme.io" }, budget: { monthly_envelope_usd: 300, ads_daily_usd: 10 }, ledgers: { cmo: "ct-1" }, metric: { window_days: 7 }, accounts: { search_console: true } });
  });
  test("a hash inside a string value is not a comment; a top level answer is refused", () => {
    expect(mergeToml(`[product]\nname = "A #1 product"   # keep\n`, { product: { name: "B #2" } })).toBe(`[product]\nname = "B #2"   # keep\n`);
    expect(() => mergeToml("", { domain: "x" })).toThrow(/dotted input key/);
  });
  test("writes TOML at the manifest's path inside the project and JSON by default", () => {
    const dir = tmp();
    const toml = writeInstanceFile(dir, "acme-growth", { inputs, instance_file: ".codecast/packs/growth.toml" }, { "product.domain": "acme.io", "metric.window_days": "7" });
    expect(toml).toBe(path.join(dir, ".codecast/packs/growth.toml"));
    expect(Bun.TOML.parse(fs.readFileSync(toml, "utf8"))).toEqual({ product: { domain: "acme.io" }, metric: { window_days: 7 } });
    writeInstanceFile(dir, "acme-growth", { inputs, instance_file: ".codecast/packs/growth.toml" }, { "product.domain": "acme.dev" });
    expect(Bun.TOML.parse(fs.readFileSync(toml, "utf8"))).toEqual({ product: { domain: "acme.dev" }, metric: { window_days: 7 } });
    const json = writeInstanceFile(dir, "acme-growth", { inputs }, { "budget.monthly_envelope_usd": "300" });
    expect(json).toBe(path.join(dir, ".codecast/org-templates/acme-growth.config.json"));
    expect(JSON.parse(fs.readFileSync(json, "utf8"))).toEqual({ budget: { monthly_envelope_usd: 300 } });
    expect(() => writeInstanceFile(dir, "acme-growth", { inputs, instance_file: "../outside.toml" }, {})).toThrow(/inside the project/);
  });
});
