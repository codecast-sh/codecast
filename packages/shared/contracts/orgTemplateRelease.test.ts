import { describe, expect, test } from "bun:test";
import type { OrgTemplate } from "./orgTemplateManifest";
import { bumpRefusal, changelogBetween, changelogSections, classifyRelease, jumpBetween, mergeClassifications, releaseNote, updateOffer, versionBump, withClasses, type ReleaseLike } from "./orgTemplateRelease";

const base = (version = "1.0.0"): OrgTemplate => ({
  schemaVersion: 2, id: "growth", version, name: "CMO", description: "One project CMO",
  role: { name: "CMO", handle: "{{instance}}-cmo", charter: "org/charter.md", caps: { hands_per_day: 4, wakes_per_day: 12, tokens_per_day: 200000 } },
  inputs: [{ key: "product.domain", label: "Domain", kind: "string", required: true }],
  authority: [{ id: "ads-spend", kind: "spend", label: "Paid search" }],
  setup: [{ id: "search-console", title: "Verify the domain", who: "human" }],
  routines: [{ id: "seo", title: "SEO weekly", every: "7d", prompt: "org/seo.md" }, { id: "ads", title: "Ads", every: "1d", prompt: "org/ads.md", mode: "propose" }],
});
const edit = (version: string, fn: (m: OrgTemplate) => void): OrgTemplate => { const m = structuredClone(base(version)); fn(m); return m; };
const NONE = { routines_added: [], routines_removed: [], routines_recadenced: [], inputs_added: [], inputs_removed: [], setup_added: [], setup_removed: [], evidence_changed: [], ledgers_changed: [], scoreboard_changed: [], authority_changed: [] };

describe("classifyRelease", () => {
  test("the first release is structure, with everything it declares added", () => {
    expect(classifyRelease(null, base())).toEqual({ class: "structure", changes: { ...NONE, routines_added: ["seo", "ads"], inputs_added: ["product.domain"], setup_added: ["search-console"] } });
  });
  test("a manifest the same but for its version is content, whatever the key order", () => {
    const next = base("1.0.1");
    const reordered = { ...next, role: { caps: next.role.caps, charter: next.role.charter, handle: next.role.handle, name: next.role.name } } as OrgTemplate;
    expect(classifyRelease(base(), reordered)).toEqual({ class: "content", changes: NONE });
  });
  test("routines added, removed and re-cadenced, inputs, setup and ledgers: structure, each named", () => {
    const next = edit("1.1.0", (m) => {
      m.routines = [{ ...m.routines[0]!, every: "3d" }, { id: "social", title: "Social post", every: "1d", prompt: "org/social.md" }];
      m.inputs!.push({ key: "accounts.publora", label: "Publora key", kind: "secret" });
      m.setup!.push({ id: "measurement", title: "See one event", who: "role" });
      m.ledgers = [{ id: "cmo", title: "CMO ledger" }];
    });
    expect(classifyRelease(base(), next)).toEqual({ class: "structure", changes: { ...NONE, routines_added: ["social"], routines_removed: ["ads"], routines_recadenced: [{ id: "seo", from: "7d", to: "3d" }], inputs_added: ["accounts.publora"], setup_added: ["measurement"], ledgers_changed: ["cmo"] } });
  });
  test("caps, authority, a routine's mode, the line and the role's name or handle are authority, in human words", () => {
    expect(classifyRelease(base(), edit("2.0.0", (m) => { m.role.caps.tokens_per_day = 400000; })).changes.authority_changed).toEqual(["caps.tokens_per_day 200000 -> 400000"]);
    expect(classifyRelease(base(), edit("2.0.0", (m) => { m.authority!.push({ id: "site-write", kind: "write", label: "Site" }); })).changes.authority_changed).toEqual(["authority site-write added"]);
    expect(classifyRelease(base(), edit("2.0.0", (m) => { m.routines[1]!.mode = "apply"; })).changes.authority_changed).toEqual(["routine ads mode propose -> apply"]);
    expect(classifyRelease(base(), edit("2.0.0", (m) => { m.role.line = "feature"; })).changes.authority_changed).toEqual(["role.line none -> feature"]);
    expect(classifyRelease(base(), edit("2.0.0", (m) => { m.role.handle = "{{instance}}-growth"; })).class).toBe("authority");
    const both = classifyRelease(base(), edit("2.0.0", (m) => { m.role.name = "Growth"; m.routines.pop(); }));
    expect(both).toMatchObject({ class: "authority", changes: { routines_removed: ["ads"], authority_changed: ["role.name CMO -> Growth"] } });
  });
  test("a description, avatar or routine title change is structure, never content", () => {
    expect(classifyRelease(base(), edit("1.1.0", (m) => { m.description = "Another"; })).class).toBe("structure");
    expect(classifyRelease(base(), edit("1.1.0", (m) => { m.role.avatar = "fox"; })).class).toBe("structure");
    expect(classifyRelease(base(), edit("1.1.0", (m) => { m.routines[0]!.title = "SEO"; })).class).toBe("structure");
  });
});

describe("the bump a class needs", () => {
  test("versionBump names the part raised", () => {
    expect([versionBump("1.2.3", "1.2.4"), versionBump("1.2.3", "1.3.0"), versionBump("1.2.3", "2.0.0"), versionBump("1.2.3", "1.2.3"), versionBump("1.2.3", "1.2.0")]).toEqual(["patch", "minor", "major", "none", "none"]);
  });
  test("a patch that adds a routine is refused, naming the routine and the version to use", () => {
    const next = edit("1.0.1", (m) => { m.routines.push({ id: "social", title: "Social", every: "1d", prompt: "org/s.md" }); });
    expect(bumpRefusal(base(), next)).toBe("growth@1.0.1 is a structure release (routine social added), so it needs a minor version bump over 1.0.0; 1.0.1 is a patch bump. Publish it as 1.1.0 or later.");
    expect(bumpRefusal(base(), { ...next, version: "1.1.0" })).toBeNull();
  });
  test("authority needs a major; content takes any newer version; the first release takes any", () => {
    expect(bumpRefusal(base(), edit("1.1.0", (m) => { m.role.caps.wakes_per_day = 1; }))).toMatch(/authority release \(caps\.wakes_per_day 12 -> 1\), so it needs a major version bump over 1\.0\.0; 1\.1\.0 is a minor bump\. Publish it as 2\.0\.0/);
    expect(bumpRefusal(base(), base("1.0.1"))).toBeNull();
    expect(bumpRefusal(null, base("0.0.1"))).toBeNull();
  });
});

const rel = (version: string, over: Partial<ReleaseLike> = {}, manifest = base(version)): ReleaseLike => ({ version, digest: version.replace(/\./g, "").padEnd(64, "a"), status: "stable", manifest, ...over });

describe("changelogs", () => {
  test("sections by version heading, or the whole text under its own release", () => {
    expect([...changelogSections("# Changelog\n\n## 1.1.0\n\n- b\n\n## 1.0.1 (patch)\n\n- a\n")]).toEqual([["1.1.0", "- b"], ["1.0.1", "- a"]]);
    expect([...changelogSections("Fixed a typo.", "1.0.1")]).toEqual([["1.0.1", "Fixed a typo."]]);
    expect(changelogSections("", "1.0.1").size).toBe(0);
  });
  test("between two versions, newest first, each from the newest changelog that has its section; a rollback lists what it undoes", () => {
    const releases = [rel("1.0.0", { changelog: "## 1.0.0\n- a" }), rel("1.1.0", { changelog: "## 1.1.0\n- old b" }), rel("1.2.0", { changelog: "## 1.2.0\n- c\n\n## 1.1.0\n- b\n", yanked: { reason: "broke ads", at: 1 } })];
    expect(changelogBetween(releases, "1.0.0", "1.2.0")).toEqual([{ version: "1.2.0", text: "- c" }, { version: "1.1.0", text: "- b" }]);
    expect(changelogBetween(releases, "1.2.0", "1.0.0").map((s) => s.version)).toEqual(["1.2.0", "1.1.0"]);
  });
  test("a release without a stored class gets one computed against the one before it", () => {
    const releases = [rel("1.0.0"), rel("1.1.0", {}, edit("1.1.0", (m) => { m.routines.pop(); })), rel("1.1.1", { class: "content", changes: NONE })];
    expect(withClasses(releases).map((r) => [r.version, r.class])).toEqual([["1.0.0", "structure"], ["1.1.0", "structure"], ["1.1.1", "content"]]);
  });
});

describe("a jump across several releases", () => {
  test("merges forward: the widest class and every change, a re-cadence from its first to its last value", () => {
    const releases = [
      rel("1.0.0"),
      rel("1.0.1"),
      rel("1.1.0", {}, edit("1.1.0", (m) => { m.routines[0]!.every = "3d"; })),
      rel("1.2.0", {}, edit("1.2.0", (m) => { m.routines[0]!.every = "1d"; m.setup!.push({ id: "x", title: "X", who: "human" }); })),
    ];
    expect(jumpBetween(releases, releases[0]!, releases[3]!)).toEqual({ class: "structure", changes: { ...NONE, routines_recadenced: [{ id: "seo", from: "7d", to: "1d" }], setup_added: ["x"] } });
    expect(jumpBetween(releases, releases[0]!, releases[1]!)?.class).toBe("content");
    expect(mergeClassifications([])).toBeNull();
  });
  test("a rollback is the direct diff of the two manifests", () => {
    const releases = [rel("1.0.0"), rel("1.1.0", {}, edit("1.1.0", (m) => { m.routines.push({ id: "social", title: "S", every: "1d", prompt: "org/s.md" }); }))];
    expect(jumpBetween(releases, releases[1]!, releases[0]!)).toEqual({ class: "structure", changes: { ...NONE, routines_removed: ["social"] } });
  });
});

describe("updateOffer", () => {
  const releases = [rel("1.0.0"), rel("1.1.0", { status: "canary" }), rel("1.2.0", { status: "draft" }), rel("1.0.1")];
  test("a stable instance is offered the newest stable release above its own; behind counts newer non-draft, non-yanked releases", () => {
    expect(updateOffer(releases, { version: "1.0.0", digest: rel("1.0.0").digest }, "stable")).toMatchObject({ to: { version: "1.0.1" }, rollback: null, behind: 2 });
    expect(updateOffer(releases, { version: "1.0.1", digest: rel("1.0.1").digest }, "stable")).toMatchObject({ to: null, behind: 1 });
  });
  test("canary and manual instances are offered nothing, until their release is yanked", () => {
    expect(updateOffer(releases, { version: "1.1.0", digest: rel("1.1.0").digest }, "canary").to).toBeNull();
    const yanked = releases.map((r) => (r.version === "1.1.0" ? { ...r, yanked: { reason: "posts twice", at: 1 } } : r));
    expect(updateOffer(yanked, { version: "1.1.0", digest: rel("1.1.0").digest }, "canary")).toMatchObject({ to: { version: "1.0.1" }, rollback: { reason: "posts twice" }, behind: 0 });
    expect(updateOffer(yanked, { version: "1.1.0", digest: rel("1.1.0").digest }, "manual")).toMatchObject({ to: { version: "1.0.1" }, rollback: { reason: "posts twice" } });
  });
  test("a yanked release is never offered", () => {
    const rs = [rel("1.0.0"), rel("1.1.0", { yanked: { reason: "bad", at: 1 } })];
    expect(updateOffer(rs, { version: "1.0.0", digest: rel("1.0.0").digest }, "stable")).toMatchObject({ to: null, behind: 0 });
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
    const note = releaseNote({ instance: "acme-growth", template: "CMO", from: "1.0.0", next, classification: classifyRelease(base(), next), changelogs: [{ version: "1.1.0", text: "- Adds the social post." }] });
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
    expect(releaseNote({ instance: "acme-growth", template: "CMO", from: "1.0.0", next: base("1.0.1"), classification: classifyRelease(base(), base("1.0.1")), changelogs: [] }))
      .toBe("acme-growth now runs CMO 1.0.1, up from 1.0.0. This is a content change: the charter, prompts or guides changed, the manifest did not. Read your charter and routine instructions again before acting on what you remember of 1.0.0.\nNobody needs to do anything for this change.");
    const back = releaseNote({ instance: "acme-growth", template: "CMO", from: "1.0.1", next: base(), yanked: "posts twice", classification: classifyRelease(base("1.0.1"), base()), changelogs: [{ version: "1.0.1", text: "- typo" }] });
    expect(back).toContain("back from 1.0.1 (1.0.1 was withdrawn: posts twice)");
    expect(back).toContain("What is undone:\n### 1.0.1\n- typo");
  });
});
