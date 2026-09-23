import { describe, expect, test } from "bun:test";
import { orgChangeError, orgAsksErrors } from "@codecast/shared/contracts/orgProposal";
import { buildHireSpec, grantsToAsk, hireErrors, resolvedConfig, slugOf, type HireDraft } from "./orgTemplateSpec";

// The hire form's one output (org-hire.md H3): a proposal spec with the role,
// its authority and the hire in one ask, every change valid by the contract.

const manifest: any = {
  schemaVersion: 2, id: "growth", version: "2.0.0", name: "CMO", description: "One project CMO",
  role: { name: "CMO", handle: "{{instance}}-cmo", charter: "org/charter.md", caps: { hands_per_day: 4, wakes_per_day: 12, tokens_per_day: 200000 }, avatar: "fox", tenure: { kind: "standing" } },
  inputs: [
    { key: "product.domain", label: "Apex domain", kind: "string", required: true },
    { key: "budget.monthly_envelope_usd", label: "Monthly envelope", kind: "money", required: true },
    { key: "accounts.ads", label: "Ads credentials", kind: "secret" },
    { key: "accounts.customer_id", label: "Ads customer id", kind: "string" },
    { key: "voice", label: "Voice", kind: "choice", choices: ["plain", "playful"], default: "plain" },
  ],
  authority: [
    { id: "ads-spend", kind: "spend", label: "Paid search for {{project.name}}", limit: { usd_per_month: "{{input.budget.monthly_envelope_usd}}" }, requires: ["accounts.ads", "accounts.customer_id"], expires: "90d" },
    { id: "site-write", kind: "write", label: "Ship pages" },
  ],
  setup: [{ id: "search-console", title: "Verify {{input.product.domain}}", who: "human" }, { id: "measurement", title: "See one event", who: "role" }],
  routines: [{ id: "weekly", title: "CMO weekly", every: "7d", prompt: "org/w.md" }, { id: "ads", title: "Ads daily", every: "1d", prompt: "org/a.md", mode: "apply", requires: { authority: ["ads-spend"] } }],
};
const template = { template_id: "growth", name: "CMO", description: "One project CMO", latest: { version: "2.0.0", digest: "a".repeat(64) }, manifest };
const project = { _id: "projects_p", short_id: "pr-7", title: "Acme Growth" };
const draft = (over: Partial<HireDraft> = {}): HireDraft => ({ template, project, instance: "acme-growth-growth", config: { "product.domain": "acme.io", "budget.monthly_envelope_usd": "300" }, reportsTo: "me", seatHandle: null, updatePolicy: "stable", ...over });

describe("hire spec", () => {
  test("slugs and errors", () => {
    expect(slugOf("Acme Growth!")).toBe("acme-growth");
    expect(slugOf("42 things")).toBe("things");
    expect(hireErrors(draft({ template: null }))).toEqual(["Choose a template"]);
    expect(hireErrors(draft({ config: { "product.domain": "acme.io" } }))).toEqual(["Monthly envelope is required"]);
    expect(hireErrors(draft({ config: { "product.domain": "acme.io", "budget.monthly_envelope_usd": "lots" } }))).toEqual(["Monthly envelope is a number"]);
    expect(hireErrors(draft({ instance: "Bad Name" }))).toEqual(["The instance name is a lowercase slug (a letter, then letters, digits or dashes)"]);
    expect(hireErrors(draft({ reportsTo: "growth" }))).toEqual(["Reports to is me or a role's @handle"]);
    expect(hireErrors(draft())).toEqual([]);
  });
  test("defaults fill; a grant waits only on unanswered non secret inputs; limits resolve from answers", () => {
    expect(resolvedConfig(manifest, { "product.domain": "acme.io" })).toEqual({ "product.domain": "acme.io", voice: "plain" });
    expect(grantsToAsk(manifest, resolvedConfig(manifest, draft().config)).map((g) => g.id)).toEqual(["site-write"]);
    const withId = grantsToAsk(manifest, { ...draft().config, "accounts.customer_id": "695" });
    expect(withId.map((g) => g.id)).toEqual(["ads-spend", "site-write"]);
    expect(withId[0]).toMatchObject({ kind: "spend", limit: { usd_per_month: 300 }, expires: "90d" });
  });
  test("a new role: role, authority and hire in one ask, every change valid, tokens substituted", () => {
    const spec = buildHireSpec(draft({ config: { ...draft().config, "accounts.customer_id": "695" } }));
    expect(spec.mode).toBe("request");
    expect(spec.changes.map((c) => c.kind)).toEqual(["role", "authority", "hire"]);
    for (const c of spec.changes) expect(orgChangeError(c), c.kind).toBeNull();
    expect(orgAsksErrors(spec.asks, spec.changes.map((change) => ({ change })))).toEqual([]);
    const role = spec.changes[0] as any;
    expect(role).toMatchObject({ handle: "acme-growth-growth-cmo", name: "CMO", scope: { projects: ["pr-7"], plans: [] }, reports_to: "me", avatar: "fox", tenure: { kind: "standing" } });
    expect((spec.changes[1] as any).authority[0].label).toBe("Paid search for Acme Growth");
    expect(spec.changes[2]).toMatchObject({ kind: "hire", handle: "acme-growth-growth-cmo", template: "growth", version: "2.0.0", instance: "acme-growth-growth", project: "pr-7", config: { "product.domain": "acme.io", "budget.monthly_envelope_usd": "300", "accounts.customer_id": "695", voice: "plain" }, update_policy: "stable" });
    expect((spec.changes[2] as any).config["accounts.ads"]).toBeUndefined();
    expect(spec.summary_md).toContain("created paused for you to activate");
    expect(spec.summary_md).toContain("1 setup step only you can do");
    expect(spec.summary_md).toContain("cast org template bind acme-growth-growth");
  });
  test("hiring under the lead, or naming the lead as the seat", () => {
    const under = buildHireSpec(draft({ reportsTo: "@growth" }));
    expect((under.changes[0] as any).reports_to).toBe("@growth");
    const seat = buildHireSpec(draft({ seatHandle: "growth" }));
    expect(seat.changes.map((c) => c.kind)).toEqual(["authority", "hire"]);
    expect(seat.changes.every((c: any) => c.handle === "growth")).toBe(true);
    expect(seat.summary_md).toContain("@growth is the seat: no new role.");
    for (const c of seat.changes) expect(orgChangeError(c), c.kind).toBeNull();
  });
});
