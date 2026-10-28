import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MESSAGING_SNIPPET, PUBLISH_SNIPPET } from "../snippets.js";
import { apply, planSections, sectionMarker, type DesiredSection, type DriverLedger } from "./driver.js";

// The markdown_section arm: one owned region per prose capability in each
// agent instruction file, on the same engine `cast install` writes builtin
// sections with. Every test passes `home` explicitly; nothing here reads the
// real home directory.

const dirs: string[] = [];
function home(): string {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "cc-mdarm-"));
  dirs.push(h);
  fs.mkdirSync(path.join(h, ".claude"), { recursive: true });
  return h;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const claudeMd = (h: string) => path.join(h, ".claude", "CLAUDE.md");
const fragment: DesiredSection = {
  slug: "authored/team1/instructions/review-rules",
  heading: "Acme: Review rules",
  body: "Every change gets a second reader.\n\n## Exceptions\n\nTypos.",
};

function run(desired: DesiredSection[], ledger: DriverLedger, h: string) {
  const ops = planSections(desired, ledger, { home: h });
  return { ops, ...apply(ops, ledger) };
}

describe("markdown_section arm", () => {
  test("a prose capability writes exactly one owned region, after the user's content", () => {
    const h = home();
    fs.writeFileSync(claudeMd(h), "# My notes\n\nkeep me\n");
    const r = run([fragment], { files: {} }, h);
    expect(r.ops.map((o) => o.op)).toEqual(["markdown_section"]);
    expect(r.wrote).toEqual([claudeMd(h)]);
    const text = fs.readFileSync(claudeMd(h), "utf-8");
    expect(text.startsWith("# My notes\n\nkeep me\n")).toBe(true);
    expect(text.split("## Acme: Review rules").length).toBe(2);
    expect(text.split(sectionMarker(fragment.slug)).length).toBe(2);
    // A level-2 heading in the body would end the region early; it is demoted.
    expect(text).toContain("### Exceptions");
    expect(r.ledger.sections?.[fragment.slug]?.[claudeMd(h)]?.wroteHash).toBeTruthy();
    // The region is not a file the driver owns: nothing lands in files.
    expect(r.ledger.files).toEqual({});
  });

  test("a second apply is zero ops and leaves the mtime alone", () => {
    const h = home();
    const first = run([fragment], { files: {} }, h);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(claudeMd(h), past, past);
    const before = fs.statSync(claudeMd(h)).mtimeMs;

    const second = run([fragment], first.ledger, h);
    expect(second.ops).toEqual([]);
    expect(fs.statSync(claudeMd(h)).mtimeMs).toBe(before);

    // Trailing whitespace is not a change either.
    fs.writeFileSync(claudeMd(h), fs.readFileSync(claudeMd(h), "utf-8").replace("second reader.", "second reader.   ") + "\n\n");
    expect(planSections([fragment], first.ledger, { home: h })).toEqual([]);
  });

  test("a body change rewrites the region in place", () => {
    const h = home();
    const first = run([fragment], { files: {} }, h);
    fs.appendFileSync(claudeMd(h), "\n## Mine\n\nafter\n");
    const next = run([{ ...fragment, body: "Two readers now." }], first.ledger, h);
    expect(next.wrote).toEqual([claudeMd(h)]);
    const text = fs.readFileSync(claudeMd(h), "utf-8");
    expect(text).toContain("Two readers now.");
    expect(text).not.toContain("second reader");
    expect(text.indexOf("## Acme: Review rules")).toBeLessThan(text.indexOf("## Mine"));
  });

  test("a hand edit yields locally_modified and no write, also when the source changes", () => {
    const h = home();
    const first = run([fragment], { files: {} }, h);
    const edited = fs.readFileSync(claudeMd(h), "utf-8").replace("second reader", "third reader");
    fs.writeFileSync(claudeMd(h), edited);

    for (const want of [fragment, { ...fragment, body: "New upstream text." }]) {
      const r = run([want], first.ledger, h);
      expect(r.ops).toEqual([{ op: "conflict", slug: fragment.slug, reason: "locally_modified", detail: claudeMd(h) }]);
      expect(r.wrote).toEqual([]);
      expect(fs.readFileSync(claudeMd(h), "utf-8")).toBe(edited);
    }
    // Removal respects the edit too: theirs now.
    const off = run([], first.ledger, h);
    expect(off.ops[0]).toMatchObject({ op: "conflict", reason: "locally_modified" });
    expect(fs.readFileSync(claudeMd(h), "utf-8")).toBe(edited);
  });

  test("a deleted region comes back once, then is left alone", () => {
    const h = home();
    const first = run([fragment], { files: {} }, h);
    fs.writeFileSync(claudeMd(h), "# My notes\n");
    const again = run([fragment], first.ledger, h);
    expect(again.wrote).toEqual([claudeMd(h)]);
    fs.writeFileSync(claudeMd(h), "# My notes\n");
    const third = run([fragment], again.ledger, h);
    expect(third.ops).toEqual([{ op: "conflict", slug: fragment.slug, reason: "locally_removed", detail: claudeMd(h) }]);
    expect(fs.readFileSync(claudeMd(h), "utf-8")).toBe("# My notes\n");
  });

  test("removal cuts exactly the region and keeps neighbouring codecast sections in place and order", () => {
    const h = home();
    fs.writeFileSync(claudeMd(h), "# My notes\n\nkeep me\n" + MESSAGING_SNIPPET);
    const on = run([fragment], { files: {} }, h);
    fs.appendFileSync(claudeMd(h), PUBLISH_SNIPPET + "\n## Mine\n\nlast\n");
    const withKit = fs.readFileSync(claudeMd(h), "utf-8");
    const iMsg = withKit.indexOf("## Messaging");
    const iKit = withKit.indexOf("## Acme: Review rules");
    const iPub = withKit.indexOf("## Publishing pages");
    expect(iMsg).toBeGreaterThan(-1);
    expect(iPub).toBeGreaterThan(-1);
    expect(iMsg < iKit && iKit < iPub).toBe(true);

    const off = run([], on.ledger, h);
    expect(off.removed).toEqual([claudeMd(h)]);
    expect(off.ledger.sections).toEqual({});
    const after = fs.readFileSync(claudeMd(h), "utf-8");
    expect(after).toBe("# My notes\n\nkeep me\n" + MESSAGING_SNIPPET + PUBLISH_SNIPPET + "\n## Mine\n\nlast\n");
  });

  test("a renamed heading replaces the old region instead of stacking a second", () => {
    const h = home();
    const first = run([fragment], { files: {} }, h);
    run([{ ...fragment, heading: "Acme Inc: Review rules" }], first.ledger, h);
    const text = fs.readFileSync(claudeMd(h), "utf-8");
    expect(text).toContain("## Acme Inc: Review rules");
    expect(text).not.toContain("## Acme: Review rules");
    expect(text.split(sectionMarker(fragment.slug)).length).toBe(2);
  });

  test("a slug that could break out of its marker is refused", () => {
    const h = home();
    const ops = planSections([{ ...fragment, slug: "authored/x/instructions/a -->" }], { files: {} }, { home: h });
    expect(ops).toMatchObject([{ op: "conflict", reason: "invalid_slug" }]);
  });

  test("held slugs are neither written nor cut", () => {
    const h = home();
    const first = run([fragment], { files: {} }, h);
    const before = fs.readFileSync(claudeMd(h), "utf-8");
    expect(planSections([], first.ledger, { home: h, hold: [fragment.slug] })).toEqual([]);
    expect(fs.readFileSync(claudeMd(h), "utf-8")).toBe(before);
  });
});
