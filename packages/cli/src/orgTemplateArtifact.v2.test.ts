import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalDirectory, inputTokens, manifestFiles, readArtifact, substitute, validateTemplate, validateTokens, type OrgTemplate } from "./orgTemplateArtifact";

// Manifest v2 (docs/architecture/org-hire.md H2): what a hire can ask a person
// for, checked at inspect time so a bad template never reaches a proposal.

const dirs: string[] = [];
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "org-template-v2-")); dirs.push(dir); return canonicalDirectory(dir); };
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const v2 = (): OrgTemplate => ({
  schemaVersion: 2, id: "growth", version: "2.0.0", name: "CMO", description: "One project CMO",
  role: { name: "CMO", handle: "{{instance}}-cmo", charter: "org/charter.md", caps: { hands_per_day: 4, wakes_per_day: 12, tokens_per_day: 200000 }, avatar: "fox", tenure: { kind: "standing" } },
  inputs: [
    { key: "product.domain", label: "Apex domain", kind: "string", required: true, help: "codecast.sh" },
    { key: "budget.monthly_envelope_usd", label: "Monthly growth envelope", kind: "money", required: true },
    { key: "accounts.google_ads", label: "Google Ads credentials", kind: "secret", unlocks: ["ads-daily", "ads-spend"] },
    { key: "voice", label: "Voice", kind: "choice", choices: ["plain", "playful"], default: "plain" },
  ],
  authority: [
    { id: "ads-spend", kind: "spend", label: "Paid search inside the envelope for {{project.name}}", limit: { usd_per_month: "{{input.budget.monthly_envelope_usd}}" }, requires: ["accounts.google_ads"], expires: "90d" },
    { id: "social-publish", kind: "publish", label: "Post to selected accounts", limit: { per_day: 3 } },
  ],
  setup: [{ id: "search-console", title: "Verify {{input.product.domain}} in Search Console", who: "human", unlocks: ["seo-weekly"], how: "org/setup/search-console.md", price: "unlocks SEO weekly" }],
  evidence: [{ id: "ads_billing", title: "Ads delivery eligible", max_age: "24h", required_for: ["ads-daily"] }],
  ledgers: [{ id: "cmo", title: "CMO ledger for {{project.name}}" }],
  scoreboard: [{ key: "primary_events", label: "Primary events, last 7 days" }],
  learn: { review: "codecast" },
  instance_file: ".codecast/packs/growth.toml",
  routines: [
    { id: "seo-weekly", title: "SEO weekly", every: "7d", prompt: "org/seo.md" },
    { id: "ads-daily", title: "Ads daily", every: "1d", prompt: "org/ads.md", mode: "apply", requires: { authority: ["ads-spend"], evidence: ["ads_billing"] } },
  ],
});
const withoutKey = (m: OrgTemplate, mutate: (row: any) => void): unknown => { const row = structuredClone(m) as any; mutate(row); return row; };

describe("manifest v2 validation", () => {
  test("a full v2 manifest validates and v1 stays unchanged", () => {
    expect(validateTemplate(v2()).schemaVersion).toBe(2);
    const v1 = withoutKey(v2(), (r) => { r.schemaVersion = 1; for (const k of ["inputs", "authority", "setup", "evidence", "ledgers", "scoreboard", "learn", "instance_file"]) delete r[k]; delete r.role.avatar; delete r.role.tenure; for (const x of r.routines) { delete x.mode; delete x.requires; } });
    expect(validateTemplate(v1).schemaVersion).toBe(1);
  });
  test("v1 refuses every v2 field; v2 refuses unknown keys everywhere", () => {
    for (const key of ["inputs", "authority", "setup", "evidence", "ledgers", "scoreboard", "learn", "instance_file"]) {
      expect(() => validateTemplate(withoutKey(v2(), (r) => { r.schemaVersion = 1; const keep = r[key]; for (const k of ["inputs", "authority", "setup", "evidence", "ledgers", "scoreboard", "learn", "instance_file"]) delete r[k]; r[key] = keep; delete r.role.avatar; delete r.role.tenure; for (const x of r.routines) { delete x.mode; delete x.requires; } }))).toThrow(/missing or unknown/);
    }
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.inputs[0].secret_value = "x"; }))).toThrow(/missing or unknown/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.authority[0].budget = 1; }))).toThrow(/missing or unknown/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.routines[1].requires.grants = []; }))).toThrow(/missing or unknown/);
  });
  test("inputs: keys, kinds, defaults and choices", () => {
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.inputs[0].key = "Product.Domain"; }))).toThrow(/input key/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.inputs[1].key = "product.domain"; }))).toThrow(/duplicate input key/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.inputs[0].kind = "password"; }))).toThrow(/Unknown input kind/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.inputs[2].default = "~/.config/x"; }))).toThrow(/secret input cannot carry a default/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.inputs[3].default = "shouty"; }))).toThrow(/one of its choices/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.inputs[0].choices = ["a"]; }))).toThrow(/Only a choice input/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.inputs[2].unlocks = ["nope"]; }))).toThrow(/unknown id: nope/);
  });
  test("tokens: input tokens only for declared inputs, in every string and file", () => {
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.routines[0].title = "SEO for {{input.product.tld}}"; }))).toThrow(/Unknown template token: input.product.tld/);
    expect(() => validateTokens("{{input.product.domain}}")).toThrow(/Unknown template token/);
    validateTokens("{{input.product.domain}}", inputTokens(v2()));
    expect(substitute("Own {{instance}} at {{input.product.domain}}", { instance: "acme", "input.product.domain": "acme.io" }, inputTokens(v2()))).toBe("Own acme at acme.io");
    expect(() => substitute("{{input.product.domain}}", {}, inputTokens(v2()))).toThrow(/Missing template value/);
  });
  test("authority: kinds, limits as numbers or one input token, requires and expiry", () => {
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.authority[0].kind = "delete"; }))).toThrow(/Unknown authority kind/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.authority[0].limit = {}; }))).toThrow(/at least one bound/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.authority[0].limit = { usd_per_month: -1 }; }))).toThrow(/nonnegative/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.authority[0].limit = { usd_per_month: "300 {{input.budget.monthly_envelope_usd}}" }; }))).toThrow(/one input token/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.authority[0].limit = { usd_per_month: "{{input.nope}}" }; }))).toThrow(/one input token/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.authority[0].requires = ["accounts.nope"]; }))).toThrow(/unknown id: accounts.nope/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.authority[0].expires = "never"; }))).toThrow(/Invalid cadence/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.authority.push({ ...r.authority[0] }); }))).toThrow(/duplicate authority id/);
  });
  test("setup, evidence, ledgers, scoreboard, learn and routine requirements cross-check", () => {
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.setup[0].who = "agent"; }))).toThrow(/human or role/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.setup[0].unlocks = ["ads_billing"]; }))).toThrow(/unknown id: ads_billing/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.setup[0].how = "../outside.md"; }))).toThrow(/Unsafe artifact path/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.evidence[0].max_age = "2y"; }))).toThrow(/Invalid cadence/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.evidence[0].required_for = ["ads-spend"]; }))).toThrow(/unknown id: ads-spend/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.routines[1].requires.authority = ["seo-weekly"]; }))).toThrow(/unknown id: seo-weekly/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.routines[1].requires.evidence = ["search-console"]; }))).toThrow(/unknown id: search-console/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.routines[1].mode = "run"; }))).toThrow(/propose or apply/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.ledgers.push({ id: "cmo", title: "again" }); }))).toThrow(/duplicate ledger id/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.scoreboard[0].key = "Primary Events"; }))).toThrow(/scoreboard key/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.learn.review = "nobody"; }))).toThrow(/codecast or publisher/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.instance_file = "/etc/growth.toml"; }))).toThrow(/Unsafe instance file/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.role.tenure = { kind: "program" }; }))).toThrow(/then: retire or review/);
    expect(() => validateTemplate(withoutKey(v2(), (r) => { r.role.avatar = "Fox!"; }))).toThrow(/avatar key/);
  });
  test("readArtifact requires setup how-to files and checks input tokens inside files", () => {
    const m = v2();
    const root = tmp();
    fs.mkdirSync(path.join(root, "org/setup"), { recursive: true });
    fs.writeFileSync(path.join(root, "org-template.json"), JSON.stringify(m));
    fs.writeFileSync(path.join(root, "org/charter.md"), "Own {{project.name}} at {{input.product.domain}} within {{input.budget.monthly_envelope_usd}} a month.");
    for (const r of m.routines) fs.writeFileSync(path.join(root, r.prompt), `Run ${r.id} for {{instance}}.`);
    expect(() => readArtifact(root)).toThrow(/Missing template instruction file: org\/setup\/search-console.md/);
    fs.writeFileSync(path.join(root, "org/setup/search-console.md"), "Open Search Console and add {{input.product.domain}}.");
    const artifact = readArtifact(root);
    expect(manifestFiles(artifact.manifest)).toEqual(["org/charter.md", "org/seo.md", "org/ads.md", "org/setup/search-console.md"]);
    fs.writeFileSync(path.join(root, "org/seo.md"), "Use {{input.product.tld}}.");
    expect(() => readArtifact(root)).toThrow(/Unknown template token: input.product.tld/);
  });
});

describe("hire-time input answers", () => {
  test("parseInputs validates against the manifest and fills defaults", async () => {
    const { parseInputs } = await import("./orgTemplateRun");
    const m = v2();
    expect(parseInputs(m, ["product.domain=acme.io", "budget.monthly_envelope_usd=300"])).toEqual({ "product.domain": "acme.io", "budget.monthly_envelope_usd": "300", voice: "plain" });
    expect(() => parseInputs(m, ["product.domain=acme.io"])).toThrow(/Required input not answered: budget.monthly_envelope_usd/);
    expect(() => parseInputs(m, ["product.domain=acme.io", "budget.monthly_envelope_usd=lots"])).toThrow(/must be a number/);
    expect(() => parseInputs(m, ["product.domain=acme.io", "budget.monthly_envelope_usd=-5"])).toThrow(/must be a number/);
    expect(() => parseInputs(m, ["product.domain=acme.io", "budget.monthly_envelope_usd=300", "voice=shouty"])).toThrow(/one of: plain, playful/);
    expect(() => parseInputs(m, ["product.domain=acme.io", "budget.monthly_envelope_usd=300", "accounts.google_ads=~/x.json"])).toThrow(/bound on the host/);
    expect(() => parseInputs(m, ["product.domain=acme.io", "budget.monthly_envelope_usd=300", "tld=io"])).toThrow(/Unknown input: tld/);
    expect(() => parseInputs(m, ["product.domain=a", "product.domain=b", "budget.monthly_envelope_usd=300"])).toThrow(/answered twice/);
    expect(() => parseInputs(m, ["product.domain={{instance}}", "budget.monthly_envelope_usd=300"])).toThrow(/Invalid value/);
    expect(() => parseInputs(m, ["nonsense"])).toThrow(/key=value/);
    expect(parseInputs({ ...m, inputs: undefined }, [])).toEqual({});
  });
});
