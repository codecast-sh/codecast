import { describe, expect, test } from "bun:test";
import type { OrgTemplate } from "./orgTemplateManifest";
import { bumpRefusal, changelogBetween, changelogSections, classifyRelease, releaseNote, updateOffer, versionBump, withClasses, type ReleaseLike } from "./orgTemplateRelease";

const base = (version = "1.0.0"): OrgTemplate => ({
  schemaVersion: 2, id: "growth", version, name: "CMO", description: "One project CMO",
  role: { name: "CMO", handle: "{{instance}}-cmo", charter: "org/charter.md", caps: { hands_per_day: 4, wakes_per_day: 12, tokens_per_day: 200000 } },
  inputs: [{ key: "product.domain", label: "Domain", kind: "string", required: true }],
  authority: [{ id: "ads-spend", kind: "spend", label: "Paid search" }],
  setup: [{ id: "search-console", title: "Verify the domain", who: "human" }],
  routines: [{ id: "seo", title: "SEO weekly", every: "7d", prompt: "org/seo.md" }, { id: "ads", title: "Ads", every: "1d", prompt: "org/ads.md", mode: "propose" }],
});
const edit = (version: string, fn: (m: OrgTemplate) => void): OrgTemplate => { const m = structuredClone(base(version)); fn(m); return m; };

describe("classifyRelease", () => {
  test("the first release is structure, with everything it declares added", () => {
    const c = classifyRelease(null, base());
    expect(c.class).toBe("structure");
    expect(c.changes.routines.added.map((r) => r.id)).toEqual(["seo", "ads"]);
    expect(c.why).toEqual(["the first release"]);
  });
  test("a manifest the same but for its version is content, whatever the key order", () => {
    const next = base("1.0.1");
    const reordered = { ...next, role: { caps: next.role.caps, charter: next.role.charter, handle: next.role.handle, name: next.role.name } } as OrgTemplate;
    expect(classifyRelease(base(), reordered).class).toBe("content");
  });
  test("routines added, removed and re-cadenced, inputs and setup added: structure, each named", () => {
    const next = edit("1.1.0", (m) => {
      m.routines = [{ ...m.routines[0]!, every: "3d" }, { id: "social", title: "Social post", every: "1d", prompt: "org/social.md" }];
      m.inputs!.push({ key: "accounts.publora", label: "Publora key", kind: "secret" });
      m.setup!.push({ id: "measurement", title: "See one event", who: "role" });
      m.ledgers = [{ id: "cmo", title: "CMO ledger" }];
    });
    const c = classifyRelease(base(), next);
    expect(c.class).toBe("structure");
    expect(c.changes.routines.added).toEqual([{ id: "social", title: "Social post", every: "1d" }]);
    expect(c.changes.routines.removed).toEqual([{ id: "ads", title: "Ads", every: "1d" }]);
    expect(c.changes.routines.recadenced).toEqual([{ id: "seo", title: "SEO weekly", before: "7d", after: "3d" }]);
    expect(c.changes.routines.changed).toEqual([]);
    expect(c.changes.inputs.added).toEqual([{ key: "accounts.publora", label: "Publora key", kind: "secret", required: false }]);
    expect(c.changes.setup.added).toEqual([{ id: "measurement", title: "See one event", who: "role" }]);
    expect(c.changes.ledgers.added).toEqual([{ id: "cmo", title: "CMO ledger" }]);
    expect(c.why).toContain("routine seo every 7d → 3d");
    expect(c.why).toContain("input accounts.publora added");
  });
  test("caps, authority, a routine's mode, the line and the role's name or handle are authority", () => {
    expect(classifyRelease(base(), edit("2.0.0", (m) => { m.role.caps.hands_per_day = 8; })).why).toEqual(["role caps changed"]);
    expect(classifyRelease(base(), edit("2.0.0", (m) => { m.authority!.push({ id: "site-write", kind: "write", label: "Site" }); })).why).toEqual(["authority site-write added"]);
    expect(classifyRelease(base(), edit("2.0.0", (m) => { m.routines[1]!.mode = "apply"; })).why).toEqual(["routine ads mode propose → apply"]);
    expect(classifyRelease(base(), edit("2.0.0", (m) => { m.role.line = "feature"; })).class).toBe("authority");
    expect(classifyRelease(base(), edit("2.0.0", (m) => { m.role.handle = "{{instance}}-growth"; })).class).toBe("authority");
    // Authority outranks the structure changes beside it.
    const both = classifyRelease(base(), edit("2.0.0", (m) => { m.role.name = "Growth"; m.routines.pop(); }));
    expect(both.class).toBe("authority");
    expect(both.changes.routines.removed.map((r) => r.id)).toEqual(["ads"]);
  });
  test("a description or avatar change is structure, never content", () => {
    expect(classifyRelease(base(), edit("1.1.0", (m) => { m.description = "Another"; })).why).toEqual(["description changed"]);
    expect(classifyRelease(base(), edit("1.1.0", (m) => { m.role.avatar = "fox"; })).why).toEqual(["role avatar changed"]);
  });
});

describe("the bump a class needs", () => {
  test("versionBump names the part raised", () => {
    expect([versionBump("1.2.3", "1.2.4"), versionBump("1.2.3", "1.3.0"), versionBump("1.2.3", "2.0.0"), versionBump("1.2.3", "1.2.3"), versionBump("1.2.3", "1.2.0")]).toEqual(["patch", "minor", "major", "none", "none"]);
  });
  test("a patch that adds a routine is refused, naming the routine and the version to use", () => {
    const next = edit("1.0.1", (m) => { m.routines.push({ id: "social", title: "Social", every: "1d", prompt: "org/s.md" }); });
    expect(bumpRefusal("growth", "1.0.0", next, classifyRelease(base(), next))).toBe("growth@1.0.1 is a structure release (routine social added), so it needs a minor version bump over 1.0.0; 1.0.1 is a patch bump. Publish it as 1.1.0 or later.");
    const minor = { ...next, version: "1.1.0" };
    expect(bumpRefusal("growth", "1.0.0", minor, classifyRelease(base(), minor))).toBeNull();
  });
  test("authority needs a major; content takes any newer version; the first release takes any", () => {
    const caps = edit("1.1.0", (m) => { m.role.caps.wakes_per_day = 1; });
    expect(bumpRefusal("growth", "1.0.0", caps, classifyRelease(base(), caps))).toMatch(/needs a major version bump over 1\.0\.0; 1\.1\.0 is a minor bump\. Publish it as 2\.0\.0/);
    expect(bumpRefusal("growth", "1.0.0", base("1.0.1"), classifyRelease(base(), base("1.0.1")))).toBeNull();
    expect(bumpRefusal("growth", null, base("0.0.1"), classifyRelease(null, base("0.0.1")))).toBeNull();
  });
});

const rel = (version: string, over: Partial<ReleaseLike> = {}, manifest = base(version)): ReleaseLike => ({ version, digest: version.replace(/\./g, "").padEnd(64, "a"), status: "stable", manifest, ...over });

describe("changelogs", () => {
  test("sections by version heading, or the whole text under its own release", () => {
    const s = changelogSections("# Changelog\n\n## 1.1.0\n\n- b\n\n## 1.0.1 (patch)\n\n- a\n");
    expect([...s]).toEqual([["1.1.0", "- b"], ["1.0.1", "- a"]]);
    expect([...changelogSections("Fixed a typo.", "1.0.1")]).toEqual([["1.0.1", "Fixed a typo."]]);
    expect(changelogSections("", "1.0.1").size).toBe(0);
  });
  test("between two versions: each release's section from the newest changelog that has it, oldest first; a rollback lists what it undoes", () => {
    const full = "## 1.2.0\n- c\n\n## 1.1.0\n- b\n";
    const releases = [rel("1.0.0", { changelog: "## 1.0.0\n- a" }), rel("1.1.0", { changelog: "## 1.1.0\n- old b" }), rel("1.2.0", { changelog: full, yanked: { reason: "broke ads", at: 1 } })];
    expect(changelogBetween(releases, "1.0.0", "1.2.0")).toEqual([
      { version: "1.1.0", class: "content", changelog: "- b", yanked: null },
      { version: "1.2.0", class: "content", changelog: "- c", yanked: "broke ads" },
    ]);
    expect(changelogBetween(releases, "1.2.0", "1.0.0").map((s) => s.version)).toEqual(["1.2.0", "1.1.0"]);
  });
  test("a release without a stored class gets one computed against the one before it", () => {
    const releases = [rel("1.0.0"), rel("1.1.0", {}, edit("1.1.0", (m) => { m.routines.pop(); })), rel("1.1.1", { class: "content", changes: classifyRelease(null, base()).changes, why: ["stored"] })];
    expect(withClasses(releases).map((r) => [r.version, r.class, r.why[0]])).toEqual([["1.0.0", "structure", "the first release"], ["1.1.0", "structure", "routine ads removed"], ["1.1.1", "content", "stored"]]);
  });
});

describe("updateOffer", () => {
  const releases = [rel("1.0.0"), rel("1.1.0", { status: "canary" }), rel("1.2.0", { status: "draft" }), rel("1.0.1")];
  test("a stable instance is offered the newest stable release above its own; behind counts newer non-draft, non-yanked releases", () => {
    expect(updateOffer(releases, { version: "1.0.0", digest: rel("1.0.0").digest }, "stable")).toMatchObject({ to: { version: "1.0.1" }, rollback: false, yanked: null, behind: 2 });
    expect(updateOffer(releases, { version: "1.0.1", digest: rel("1.0.1").digest }, "stable")).toMatchObject({ to: null, behind: 1 });
  });
  test("canary and manual instances are offered nothing, until their release is yanked", () => {
    expect(updateOffer(releases, { version: "1.1.0", digest: rel("1.1.0").digest }, "canary").to).toBeNull();
    const yanked = releases.map((r) => (r.version === "1.1.0" ? { ...r, yanked: { reason: "posts twice", at: 1 } } : r));
    expect(updateOffer(yanked, { version: "1.1.0", digest: rel("1.1.0").digest }, "canary")).toMatchObject({ to: { version: "1.0.1" }, rollback: true, yanked: "posts twice", behind: 0 });
    expect(updateOffer(yanked, { version: "1.1.0", digest: rel("1.1.0").digest }, "manual")).toMatchObject({ to: { version: "1.0.1" }, rollback: true });
  });
  test("a yanked release is never offered, and a yanked instance with a newer fix moves forward", () => {
    const rs = [rel("1.0.0"), rel("1.1.0", { yanked: { reason: "bad", at: 1 } })];
    expect(updateOffer(rs, { version: "1.0.0", digest: rel("1.0.0").digest }, "stable")).toMatchObject({ to: null, behind: 0 });
    const fixed = [...rs, rel("1.1.1")];
    expect(updateOffer(fixed, { version: "1.1.0", digest: rel("1.1.0").digest }, "manual")).toMatchObject({ to: { version: "1.1.1" }, rollback: false, yanked: "bad" });
  });
});

describe("releaseNote", () => {
  test("names the versions, the class, what moved, the changelog and each step a person must take", () => {
    const next = edit("1.1.0", (m) => {
      m.routines.push({ id: "social", title: "Social post", every: "1d", prompt: "org/social.md" });
      m.routines[0]!.every = "3d";
      m.setup!.push({ id: "publora", title: "Connect Publora", who: "human" });
      m.inputs!.push({ key: "accounts.publora", label: "Publora key", kind: "secret" });
    });
    const note = releaseNote({ instance: "acme-growth", template: "CMO", from: "1.0.0", to: "1.1.0", classification: classifyRelease(base(), next), sections: [{ version: "1.1.0", class: "structure", changelog: "- Adds the social post.", yanked: null }] });
    expect(note.split("\n")).toEqual([
      "acme-growth now runs CMO 1.1.0, up from 1.0.0. This is a structure change. Read your charter and routine instructions again before acting on what you remember of 1.0.0.",
      "What moved: new routines Social post (1d); new cadences for SEO weekly (7d → 3d); new setup steps \"Connect Publora\"; new inputs Publora key.",
      "Changelog:",
      "### 1.1.0",
      "- Adds the social post.",
      "A person must:",
      "- Activate Social post (1d) from the role page: it arrived paused.",
      "- Resume SEO weekly from the role page: its cadence moved from 7d to 3d, so it is paused for review.",
      "- Complete the new setup step \"Connect Publora\" from the role page.",
      "- Bind the new secret Publora key from the role page.",
    ]);
  });
  test("a wording change says nobody needs to do anything; a rollback off a yanked release says why", () => {
    const content = releaseNote({ instance: "acme-growth", template: "CMO", from: "1.0.0", to: "1.0.1", classification: classifyRelease(base(), base("1.0.1")), sections: [] });
    expect(content).toBe("acme-growth now runs CMO 1.0.1, up from 1.0.0. This is a content change: the charter, prompts or guides changed, the manifest did not. Read your charter and routine instructions again before acting on what you remember of 1.0.0.\nNobody needs to do anything for this change.");
    const back = releaseNote({ instance: "acme-growth", template: "CMO", from: "1.0.1", to: "1.0.0", yanked: "posts twice", classification: classifyRelease(base("1.0.1"), base()), sections: [{ version: "1.0.1", class: "content", changelog: "- typo", yanked: "posts twice" }] });
    expect(back).toContain("back from 1.0.1 (1.0.1 was withdrawn: posts twice)");
    expect(back).toContain("What is undone:\n### 1.0.1 (withdrawn)\n- typo");
  });
});
