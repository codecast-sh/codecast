import { describe, expect, test } from "bun:test";
import type { ReleaseChanges } from "@codecast/shared/contracts/orgTemplateRelease";
import { releasesBehindLabel, updateCard } from "./templateUpdate";
import { buildUpgradeSpec } from "./orgTemplateSpec";

// The Update card's words (sd-424): the class leads in plain words, a
// structure change names each routine, input and setup step by its title, an
// authority change offers no update, a withdrawn release offers a rollback.

const none: ReleaseChanges = { routines_added: [], routines_removed: [], routines_recadenced: [], inputs_added: [], inputs_removed: [], setup_added: [], setup_removed: [], evidence_changed: [], ledgers_changed: [], scoreboard_changed: [], authority_changed: [] };
const base = {
  instance: "acme-growth", template_id: "growth", version: "2.0.0", update_available: "2.2.0", update_digest: "f".repeat(64),
  template: { name: "CMO", changelog: "## 2.2.0\nLatest." },
  routines: [{ id: "cmo-weekly", title: "CMO weekly" }, { id: "ads-daily", title: "Ads daily" }],
  setup: [{ id: "bing", title: "Verify in Bing" }],
  update_changelogs: [{ version: "2.2.0", text: "Adds the SEO weekly." }, { version: "2.1.0", text: "Names the owning account." }],
};

describe("updateCard", () => {
  test("nothing offered: no card", () => {
    expect(updateCard({ ...base, update_available: null })).toBeNull();
  });

  test("content: wording only, the changelogs, one click", () => {
    const card = updateCard({ ...base, update_class: "content", update_changes: none })!;
    expect(card.heading).toBe("Wording only");
    expect(card.changes).toEqual([]);
    expect(card.action).toBe("Update");
    expect(card.changelogs.map((c) => c.version)).toEqual(["2.2.0", "2.1.0"]);
  });

  test("structure: each change by its title, new routines arrive paused", () => {
    const changes: ReleaseChanges = { ...none, routines_added: ["seo-weekly"], routines_removed: ["ads-daily"], routines_recadenced: [{ id: "cmo-weekly", from: "7d", to: "1d" }], inputs_added: ["product.domain"], setup_added: ["search-console"], setup_removed: ["bing"], evidence_changed: ["technical"] };
    const card = updateCard({ ...base, update_class: "structure", update_changes: changes, update_names: { routines: { "seo-weekly": { title: "SEO weekly", every: "7d" } }, setup: { "search-console": "Verify the domain" }, inputs: { "product.domain": "Apex domain" } } })!;
    expect(card.heading).toBe("Changes what the role does");
    expect(card.changes).toEqual([
      "New routine: SEO weekly (every 7d)",
      "Retired routine: Ads daily",
      "CMO weekly runs every 1d instead of every 7d",
      "New input: Apex domain",
      "New setup step: Verify the domain",
      "Setup step removed: Verify in Bing",
      "Evidence checks changed: technical",
    ]);
    expect(card.note).toMatch(/arrives paused and needs Activate/);
    expect(card.action).toBe("Update");
  });

  test("structure without the offered release's names falls back to ids", () => {
    const card = updateCard({ ...base, update_class: "structure", update_changes: { ...none, routines_added: ["a", "b"] } })!;
    expect(card.changes).toEqual(["New routine: a", "New routine: b"]);
    expect(card.note).toMatch(/New routines arrive paused/);
  });

  test("authority: never an Update; a permission request follows", () => {
    const card = updateCard({ ...base, update_class: "authority", update_changes: { ...none, authority_changed: ["caps.tokens_per_day 200000 -> 400000"] } })!;
    expect(card.heading).toBe("Changes what the role may do");
    expect(card.action).toBeNull();
    expect(card.changes).toEqual(["caps.tokens_per_day 200000 -> 400000"]);
    expect(card.note).toMatch(/separate permission request follows/);
  });

  test("rollback: the withdrawal reason leads and the button rolls back", () => {
    const card = updateCard({ ...base, update_available: "1.9.0", update_class: "structure", update_changes: none, update_rollback: { reason: "posted twice a day" }, update_changelogs: [] })!;
    expect(card.kind).toBe("rollback");
    expect(card.heading).toBe("This release was withdrawn: posted twice a day");
    expect(card.action).toBe("Roll back");
    expect(card.changelogs).toEqual([], "the latest changelog is not what a rollback undoes");
  });

  test("an older server with no class keeps the plain card and the latest changelog", () => {
    const card = updateCard({ ...base, update_changelogs: undefined })!;
    expect(card.heading).toBeNull();
    expect(card.action).toBe("Update");
    expect(card.changelogs).toEqual([{ version: "2.2.0", text: "## 2.2.0\nLatest." }]);
  });
});

test("releasesBehindLabel", () => {
  expect(releasesBehindLabel(0)).toBeNull();
  expect(releasesBehindLabel(undefined)).toBeNull();
  expect(releasesBehindLabel(1)).toBe("1 release behind");
  expect(releasesBehindLabel(3)).toBe("3 releases behind");
});

describe("buildUpgradeSpec", () => {
  test("carries the class, the changes and every changelog in between", () => {
    const spec = buildUpgradeSpec({ ...base, update_class: "structure", update_changes: { ...none, routines_added: ["seo-weekly"] }, update_names: { routines: { "seo-weekly": { title: "SEO weekly", every: "7d" } } } });
    expect(spec.title).toBe("Update acme-growth to CMO 2.2.0");
    expect(spec.summary_md).toMatch(/Changes what the role does/);
    expect(spec.summary_md).toMatch(/- New routine: SEO weekly \(every 7d\)/);
    expect(spec.summary_md).toMatch(/### 2\.2\.0\nAdds the SEO weekly\.\n\n### 2\.1\.0\nNames the owning account\./);
    expect(spec.changes).toEqual([{ kind: "upgrade", instance: "acme-growth", template: "growth", to: "2.2.0", digest: "f".repeat(64) }]);
  });

  test("a rollback is the same change to the older release, titled as one", () => {
    const spec = buildUpgradeSpec({ ...base, update_available: "1.9.0", update_rollback: { reason: "posted twice a day" }, update_changelogs: [{ version: "2.0.0", text: "Doubled posting." }] });
    expect(spec.title).toBe("Roll back acme-growth to CMO 1.9.0");
    expect(spec.summary_md).toMatch(/This release was withdrawn: posted twice a day/);
    expect(spec.summary_md).toMatch(/What it undoes:/);
    expect(spec.asks[0]!.why).toBe("CMO 2.0.0 was withdrawn: posted twice a day.");
    expect(spec.changes[0]).toMatchObject({ kind: "upgrade", to: "1.9.0" });
  });
});
