// Ported from codecast packages/cli/src/snippets.sections.test.ts. The pure
// engine suites carry over unchanged; the file suites run on the injected
// in-memory filesystem, with write counts standing in for "the mtime did not
// move". The catalog matrix (every real codecast spec replayed through the
// regressions) stays in codecast with the catalog itself.

import { describe, expect, test } from "bun:test";
import {
  applySnippet,
  cutOwnedSections,
  findOwnedSections,
  sectionBody,
} from "./sections";
import type { SectionSpec } from "./types";
import { installSectionToFile, installSectionToTargets } from "./install";
import { memoryFs } from "./fs";

const END = "<!-- /platform-work -->";
const WORK: SectionSpec = {
  headings: [
    "## Tasks & Plans",
    "## Tasks, Plans & Workflows",
    "## Issue Tracking with cast task",
  ],
  endMarker: END,
};
const FRESH = `\n## Tasks & Plans\n\nfresh body\n${END}\n`;

describe("findOwnedSections", () => {
  test("finds a well-formed block, taking its trailing separator", () => {
    const text = `# Top\n\n## Tasks & Plans\nbody\n${END}\n\n## After\nkeep me\n`;
    const [block] = findOwnedSections(text, WORK);
    expect(text.slice(block.start, block.end)).toBe(`## Tasks & Plans\nbody\n${END}\n\n`);
    // What remains still separates the heading above from the section below.
    expect(cutOwnedSections(text, WORK)).toBe("# Top\n\n## After\nkeep me\n");
  });

  test("ignores a heading that appears mid-line", () => {
    const text = `see the ## Tasks & Plans section for details\n`;
    expect(findOwnedSections(text, WORK)).toEqual([]);
  });

  test("ignores a section that shares our heading but carries no marker", () => {
    const text = `## Tasks & Plans\nmy own notes, not the installer's\n\n## Other\n`;
    expect(findOwnedSections(text, WORK)).toEqual([]);
  });

  // A heading match is a PREFIX match (`indexOf`), so a user's longer heading
  // matches ours too. Only the marker then decides: without one their section
  // is safe, with one inside its block we claim it. Recorded behavior.
  test("a longer user heading is ours once our marker sits inside its block", () => {
    const theirs = `## Tasks & Plans for Q3\njust mine\n\n## Other\n`;
    expect(findOwnedSections(theirs, WORK)).toEqual([]);
    const withMarker = `## Tasks & Plans for Q3\njust mine\n${END}\n\n## Other\nkeep\n`;
    expect(cutOwnedSections(withMarker, WORK)).toBe("## Other\nkeep\n");
  });

  test("removes a marker-less block only when a content probe matches", () => {
    const spec: SectionSpec = { ...WORK, contentProbes: ["cast task"] };
    const text = `## Tasks & Plans\nrun cast task ls to see work\n\n## Other\nkeep\n`;
    const [block] = findOwnedSections(text, spec);
    expect(text.slice(block.start, block.end)).toBe(
      "## Tasks & Plans\nrun cast task ls to see work\n\n",
    );
    expect(cutOwnedSections(text, spec)).toBe("## Other\nkeep\n");
  });
});

// The bug this whole module exists to kill. Reproduced against the donor's
// shipped binary before the fix: installing printed "updated" and deleted
// every section below the heading.
describe("regression: the end marker sits ABOVE the heading", () => {
  const text = [
    "# My CLAUDE.md",
    "",
    "## Issue Tracking with cast task",
    "old block body",
    END,
    "",
    "## Tasks & Plans",
    "newer block, never terminated",
    "",
    "## My Personal Notes",
    "DO NOT LOSE THIS",
    "",
    "## Visual Canvas",
    "another installed snippet",
    "<!-- /platform-visual -->",
    "",
  ].join("\n");

  test("does not delete to end of file", () => {
    const out = applySnippet(text, WORK, FRESH, true).text;
    expect(out).toContain("## My Personal Notes");
    expect(out).toContain("DO NOT LOSE THIS");
    expect(out).toContain("## Visual Canvas");
    expect(out).toContain("<!-- /platform-visual -->");
  });

  test("replaces the block it can prove it owns", () => {
    const out = applySnippet(text, WORK, FRESH, true).text;
    expect(out).not.toContain("old block body");
    expect(out).toContain("fresh body");
  });

  // The unterminated block carries no end marker and matches no content probe,
  // so nothing distinguishes it from a section the user wrote under a heading
  // we happen to share. We keep it. A visible duplicate heading is a far
  // cheaper mistake than silently deleting someone's notes.
  test("keeps an ambiguous unterminated block rather than guessing", () => {
    const out = applySnippet(text, WORK, FRESH, true).text;
    expect(out).toContain("newer block, never terminated");
  });
});

// The likelier trigger: a user writes their own section under a heading we
// also use, and the real installed block sits further down under a legacy
// heading.
describe("regression: a user section shares our heading", () => {
  const text = [
    "# My CLAUDE.md",
    "",
    "## Tasks & Plans",
    "MY OWN notes. Ticket prefix is ACME-.",
    "Escalation: sam@example.com",
    "",
    "## Architecture",
    "The billing service owns invoices.",
    "",
    "## Issue Tracking with cast task",
    "the real installed block",
    END,
    "",
    "## My Deploy Runbook",
    "step 1: ssh bastion",
    "",
  ].join("\n");

  test("keeps the user's content and replaces the real block", () => {
    const out = applySnippet(text, WORK, FRESH, true).text;
    expect(out).toContain("ACME-");
    expect(out).toContain("sam@example.com");
    expect(out).toContain("billing service");
    expect(out).toContain("ssh bastion");
    expect(out).not.toContain("the real installed block");
    expect(out).toContain("fresh body");
  });
});

describe("applySnippet", () => {
  test("appends when the section is absent", () => {
    const r = applySnippet("# Mine\n", WORK, FRESH, false);
    expect(r).toMatchObject({ installed: true, updated: false });
    expect(r.text).toBe("# Mine\n" + FRESH);
  });

  test("is a no-op when present and not updating", () => {
    const text = `## Tasks & Plans\nbody\n${END}\n`;
    const r = applySnippet(text, WORK, FRESH, false);
    expect(r).toMatchObject({ installed: false, updated: false });
    expect(r.text).toBe(text);
  });

  test("running an update twice is idempotent", () => {
    const once = applySnippet("# Mine\n", WORK, FRESH, true).text;
    const twice = applySnippet(once, WORK, FRESH, true).text;
    const thrice = applySnippet(twice, WORK, FRESH, true).text;
    expect(twice).toBe(thrice);
    expect(twice.match(/## Tasks & Plans/g)).toHaveLength(1);
  });

  test("collapses duplicate blocks left by an older buggy update", () => {
    const dup = `# Top\n\n## Tasks & Plans\nfirst\n${END}\n\n## Tasks & Plans\nsecond\n${END}\n`;
    const out = applySnippet(dup, WORK, FRESH, true).text;
    expect(out.match(/## Tasks & Plans/g)).toHaveLength(1);
    expect(out).not.toContain("first");
    expect(out).not.toContain("second");
  });

  test("preserves content that follows the block", () => {
    const text = `## Tasks & Plans\nold\n${END}\n\n## Later\nkeep me\n`;
    const out = applySnippet(text, WORK, FRESH, true).text;
    expect(out).toContain("## Later");
    expect(out).toContain("keep me");
  });

  test("a legacy heading is replaced, not duplicated", () => {
    const text = `## Tasks, Plans & Workflows\nold body\n${END}\n`;
    const out = applySnippet(text, WORK, FRESH, true).text;
    expect(out).not.toContain("## Tasks, Plans & Workflows");
    expect(out.match(/## Tasks & Plans/g)).toHaveLength(1);
  });

  test("sectionBody trims the padding into a standalone block", () => {
    expect(sectionBody(FRESH)).toBe(`## Tasks & Plans\n\nfresh body\n${END}\n`);
  });
});

// A refresh replaces each block where it stands. The block's end deliberately
// swallows the blank line that separated it from the next section, and the
// refresh writes exactly one back, so the separator neither vanishes nor
// doubles. The donor's shipped CLI added one blank line per snippet per run.
describe("regression: repeated updates do not grow the file", () => {
  test("a second update is byte-identical to the first", () => {
    const start = `# Mine\n\n## Tasks & Plans\nold\n${END}\n\n## Later\nkeep\n`;
    const once = applySnippet(start, WORK, FRESH, true).text;
    const twice = applySnippet(once, WORK, FRESH, true).text;
    const thrice = applySnippet(twice, WORK, FRESH, true).text;
    expect(twice).toBe(once);
    expect(thrice).toBe(once);
  });

  test("blank lines are preserved and the block does not move", () => {
    const start = `# Mine\n\n## Tasks & Plans\nold\n${END}\n\n## Later\nkeep\n`;
    const out = applySnippet(start, WORK, FRESH, true).text;
    expect(out).toBe(`# Mine\n\n## Tasks & Plans\n\nfresh body\n${END}\n\n## Later\nkeep\n`);
    expect(out).not.toMatch(/\n{3,}/);
  });
});

// The block is refreshed where it stands. Re-appending it at the end walked
// installed sections downward past the user's own content on every update.
describe("regression: an update does not reorder the user's file", () => {
  const start = [
    "# My CLAUDE.md",
    "",
    "## Above",
    "written before the installer existed",
    "",
    "## Tasks & Plans",
    "old body",
    END,
    "",
    "## Below",
    "still mine",
    "",
  ].join("\n");

  test("the section keeps its place between the sections around it", () => {
    const out = applySnippet(start, WORK, FRESH, true).text;
    expect(out).toBe(
      [
        "# My CLAUDE.md",
        "",
        "## Above",
        "written before the installer existed",
        "",
        "## Tasks & Plans",
        "",
        "fresh body",
        END,
        "",
        "## Below",
        "still mine",
        "",
      ].join("\n"),
    );
  });

  test("its neighbours keep their order across ten updates", () => {
    let out = start;
    for (let i = 0; i < 10; i++) out = applySnippet(out, WORK, FRESH, true).text;
    expect(out.indexOf("## Above")).toBeLessThan(out.indexOf("## Tasks & Plans"));
    expect(out.indexOf("## Tasks & Plans")).toBeLessThan(out.indexOf("## Below"));
    expect(out).toBe(applySnippet(out, WORK, FRESH, true).text);
  });

  test("duplicates collapse into the FIRST block's position, not the end", () => {
    const dup = [
      "# Top",
      "",
      "## Tasks & Plans",
      "first",
      END,
      "",
      "## Mine",
      "keep me here",
      "",
      "## Tasks & Plans",
      "second",
      END,
      "",
    ].join("\n");
    const out = applySnippet(dup, WORK, FRESH, true).text;
    expect(out.match(/## Tasks & Plans/g)).toHaveLength(1);
    expect(out.indexOf("## Tasks & Plans")).toBeLessThan(out.indexOf("## Mine"));
    expect(out).toContain("keep me here");
  });

  // A block's window covers the blank lines below it, never the one above. The
  // duplicate here ends the file, so removing it used to strand that blank
  // line and leave the file ending "keep me here\n\n".
  test("collapsing a duplicate that ends the file leaves no orphan blank line", () => {
    const dup = `# Top\n\n## Tasks & Plans\nfirst\n${END}\n\n## Mine\nkeep me here\n\n## Tasks & Plans\nsecond\n${END}\n`;
    const out = applySnippet(dup, WORK, FRESH, true).text;
    expect(out).toBe(`# Top\n\n## Tasks & Plans\n\nfresh body\n${END}\n\n## Mine\nkeep me here\n`);
  });

  // Two specs, one file. Refreshing A used to move A below B and refreshing B
  // moved it back, so alternating passes never produced the same bytes twice.
  test("two owned blocks in one file keep their order across alternating updates", () => {
    const OTHER_END = "<!-- /platform-state -->";
    const OTHER: SectionSpec = { headings: ["## Thread state"], endMarker: OTHER_END };
    const OTHER_BODY = `\n## Thread state\n\nstate body\n${OTHER_END}\n`;
    const start = [
      "# My CLAUDE.md",
      "",
      "## Tasks & Plans",
      "old work",
      END,
      "",
      "## House rules",
      "mine, between the two",
      "",
      "## Thread state",
      "old state",
      OTHER_END,
      "",
    ].join("\n");

    const pass1 = applySnippet(start, WORK, FRESH, true).text;
    const pass2 = applySnippet(pass1, OTHER, OTHER_BODY, true).text;
    const pass3 = applySnippet(pass2, WORK, FRESH, true).text;
    expect(pass3).toBe(pass2);
    expect(pass3.indexOf("## Tasks & Plans")).toBeLessThan(pass3.indexOf("## House rules"));
    expect(pass3.indexOf("## House rules")).toBeLessThan(pass3.indexOf("## Thread state"));
    expect(pass3).not.toMatch(/\n{3,}/);
  });
});

describe("a run that changes nothing reports unchanged", () => {
  test("re-applying the current section is a no-op", () => {
    const once = applySnippet("# Mine\n", WORK, FRESH, true);
    expect(once.unchanged).toBe(false);
    const twice = applySnippet(once.text, WORK, FRESH, true);
    expect(twice).toMatchObject({ installed: true, updated: true, unchanged: true });
    expect(twice.text).toBe(once.text);
  });

  test("a changed body is not unchanged", () => {
    const once = applySnippet("# Mine\n", WORK, FRESH, true).text;
    const next = applySnippet(once, WORK, `\n## Tasks & Plans\n\nNEW body\n${END}\n`, true);
    expect(next.unchanged).toBe(false);
    expect(next.text).toContain("NEW body");
  });

  test("present and not updating is unchanged", () => {
    const text = `## Tasks & Plans\nbody\n${END}\n`;
    expect(applySnippet(text, WORK, FRESH, false)).toMatchObject({
      installed: false,
      updated: false,
      unchanged: true,
    });
  });
});

// Recorded behavior, carried from the donor: a `## ` at the start of a line
// inside a fenced code block reads as the next section, so the end marker
// falls outside the block and nothing is ever recognized as ours. The file
// grows by a full copy on every refresh. Bodies must never contain a line
// starting with `## ` below their own heading; the doctrine test enforces
// that for the sections this package ships.
test("a `## ` inside a fenced code block breaks recognition, and stacks copies", () => {
  const spec: SectionSpec = { headings: ["## Tasks & Plans"], endMarker: END };
  const body = `\n## Tasks & Plans\n\n\`\`\`md\n## Goal\nwhat we are doing\n\`\`\`\n${END}\n`;
  const once = applySnippet("# Mine\n", spec, body, true).text;
  expect(findOwnedSections(once, spec)).toEqual([]);
  const twice = applySnippet(once, spec, body, true).text;
  expect(twice.match(/## Tasks & Plans/g)).toHaveLength(2);
});

// Uninstall removes every section we own from one file. The donor's
// hand-rolled copies each fell back to end-of-file when a marker was missing,
// so uninstalling could take the rest of the user's CLAUDE.md with it.
describe("uninstall: removing every owned section at once", () => {
  const MEM = "<!-- /platform-memory -->";
  const MSG = "<!-- /platform-messaging -->";
  const MEMORY: SectionSpec = { headings: ["## Memory"], endMarker: MEM, contentProbes: ["cast search"] };
  const MESSAGING: SectionSpec = { headings: ["## Messaging"], endMarker: MSG };

  const file = [
    "# My CLAUDE.md",
    "",
    "## My Personal Notes",
    "DO NOT LOSE THIS",
    "",
    "## Memory",
    "cast search stuff",
    MEM,
    "",
    "## Architecture",
    "The billing service owns invoices.",
    "",
    "## Messaging",
    "cast send things",
    MSG,
    "",
    "## My Deploy Runbook",
    "step 1: ssh bastion",
    "",
  ].join("\n");

  const cutAll = (text: string) =>
    [MEMORY, MESSAGING].reduce((acc, spec) => cutOwnedSections(acc, spec), text);

  test("removes our sections and keeps everything between them", () => {
    const out = cutAll(file);
    expect(out).not.toContain("cast search stuff");
    expect(out).not.toContain("cast send things");
    expect(out).toContain("## My Personal Notes");
    expect(out).toContain("DO NOT LOSE THIS");
    expect(out).toContain("The billing service owns invoices.");
    expect(out).toContain("## My Deploy Runbook");
    expect(out).toContain("ssh bastion");
  });

  test("an end marker stranded above its heading does not eat the rest of the file", () => {
    const stranded = [
      "# My CLAUDE.md",
      "",
      "## Notes",
      "I pasted a fragment here once:",
      MSG,
      "",
      "## Messaging",
      "cast send things",
      "",
      "## My Deploy Runbook",
      "step 1: ssh bastion — IRREPLACEABLE",
      "",
    ].join("\n");
    const out = cutAll(stranded);
    expect(out).toContain("ssh bastion — IRREPLACEABLE");
    expect(out).toContain("## My Deploy Runbook");
    // Ownership is genuinely ambiguous here — the marker is not inside the
    // block — so the section stays. A leftover heading is recoverable; a
    // deleted runbook is not.
    expect(out).toContain("## Messaging");
  });

  test("removing from a file with none of our sections changes nothing", () => {
    const theirs = "# Mine\n\n## Notes\njust me\n";
    expect(cutAll(theirs)).toBe(theirs);
  });

  // Our section is the LAST thing in the file — the common shape, since
  // install appends. Removing it must not leave the blank line that separated
  // it from the user's text above.
  test("removing the last section in the file leaves one trailing newline", () => {
    const file = `# Mine\n\n## Notes\njust me\n\n## Messaging\ncast send things\n${MSG}\n`;
    expect(cutOwnedSections(file, MESSAGING)).toBe("# Mine\n\n## Notes\njust me\n");
  });
});

// Disable removes the section from disk: flipping a config flag while leaving
// the text in place means the agent keeps reading a capability the user
// believes they switched off.
describe("disable removes the section from disk", () => {
  const MSG = "<!-- /platform-messaging -->";
  const MESSAGING: SectionSpec = { headings: ["## Messaging"], endMarker: MSG };
  const MSG_BODY = `\n## Messaging\ncast send things\n${MSG}\n`;

  test("removes only the disabled section", () => {
    const withBoth = applySnippet(
      applySnippet("# Mine\n\n## My Notes\nKEEP THIS\n", MESSAGING, MSG_BODY, false).text,
      WORK,
      FRESH,
      false,
    ).text;
    const after = cutOwnedSections(withBoth, MESSAGING);
    expect(after).not.toContain("## Messaging");
    expect(after).toContain("## Tasks & Plans"); // the other snippet survives
    expect(after).toContain("KEEP THIS"); // and so does the user
  });

  test("disabling twice is harmless", () => {
    const once = cutOwnedSections(applySnippet("# Mine\n", MESSAGING, MSG_BODY, false).text, MESSAGING);
    expect(cutOwnedSections(once, MESSAGING)).toBe(once);
  });

  // Disable then re-enable is a round trip: the file must come back byte for
  // byte, not one blank line taller each cycle.
  test("re-enabling after a disable restores the file exactly", () => {
    const installed = applySnippet("# Mine\n", MESSAGING, MSG_BODY, false).text;
    let text = installed;
    for (let i = 0; i < 3; i++) {
      text = applySnippet(cutOwnedSections(text, MESSAGING), MESSAGING, MSG_BODY, false).text;
    }
    expect(text).toBe(installed);
    expect(text.match(/## Messaging/g)).toHaveLength(1);
    expect(text).not.toMatch(/\n{3,}/);
  });

  test("disabling something that was never installed changes nothing", () => {
    const theirs = "# Mine\n\n## My Notes\nKEEP THIS\n";
    expect(cutOwnedSections(theirs, MESSAGING)).toBe(theirs);
  });
});

// The write itself is skipped when nothing changed. In the donor the
// observable was the file's mtime — what every watcher wakes on. Here the
// injected filesystem counts writes, which is the same claim one level up.
describe("installSectionToFile: no write when nothing changed", () => {
  const FILE = "/home/.claude/CLAUDE.md";
  const seeded = () => {
    const fsi = memoryFs();
    installSectionToFile(fsi, { filePath: FILE }, WORK, FRESH, true);
    return fsi;
  };

  test("creating the file writes it", () => {
    const fsi = memoryFs();
    const r = installSectionToFile(fsi, { filePath: FILE }, WORK, FRESH, true);
    expect(r).toMatchObject({ installed: true, unchanged: false });
    expect(fsi.files.get(FILE)).toContain("fresh body");
    expect(fsi.dirs.has("/home/.claude")).toBe(true);
  });

  test("an absent file is still created when the text works out identical", () => {
    // Installing an empty-bodied change into a missing file must land a file
    // on disk, so "the section is installed" is true on disk, not only in the
    // returned value.
    const fsi = memoryFs();
    installSectionToFile(fsi, { filePath: FILE }, WORK, FRESH, true);
    expect(fsi.exists(FILE)).toBe(true);
  });

  test("re-installing the same section does not write again", () => {
    const fsi = seeded();
    const r = installSectionToFile(fsi, { filePath: FILE }, WORK, FRESH, true);
    expect(r).toMatchObject({ installed: true, updated: true, unchanged: true });
    expect(fsi.writes.get(FILE)).toBe(1);
  });

  test("ten reconcile passes still write only once", () => {
    const fsi = seeded();
    for (let i = 0; i < 10; i++) installSectionToFile(fsi, { filePath: FILE }, WORK, FRESH, true);
    expect(fsi.writes.get(FILE)).toBe(1);
  });

  test("a genuinely new body does write", () => {
    const fsi = seeded();
    const r = installSectionToFile(fsi, { filePath: FILE }, WORK, `\n## Tasks & Plans\n\nNEW body\n${END}\n`, true);
    expect(r.unchanged).toBe(false);
    expect(fsi.writes.get(FILE)).toBe(2);
    expect(fsi.files.get(FILE)).toContain("NEW body");
  });

  test("present and not updating never touches the file", () => {
    const fsi = seeded();
    const r = installSectionToFile(fsi, { filePath: FILE }, WORK, FRESH, false);
    expect(r).toMatchObject({ installed: false, unchanged: true });
    expect(fsi.writes.get(FILE)).toBe(1);
  });

  test("the user's surrounding content survives a real write", () => {
    const fsi = memoryFs({
      [FILE]: `# Mine\n\n## Above\nkeep\n\n## Tasks & Plans\nold\n${END}\n\n## Below\nkeep too\n`,
    });
    installSectionToFile(fsi, { filePath: FILE }, WORK, FRESH, true);
    expect(fsi.files.get(FILE)).toBe(
      `# Mine\n\n## Above\nkeep\n\n## Tasks & Plans\n\nfresh body\n${END}\n\n## Below\nkeep too\n`,
    );
  });
});

// The fold across several files: one stale file out of three is still a
// change to this machine, so `unchanged` may only be true when NOTHING was
// written anywhere. The donor drove this through subprocesses with a scratch
// HOME; the injected filesystem makes it a plain unit test.
describe("installSectionToTargets: the fold across several files", () => {
  const CLAUDE = "/home/.claude/CLAUDE.md";
  const CODEX = "/home/.codex/AGENTS.md";
  const TARGETS = [{ filePath: CLAUDE }, { filePath: CODEX }];

  test("a first install writes every target", () => {
    const fsi = memoryFs();
    const r = installSectionToTargets(fsi, TARGETS, WORK, FRESH, true);
    expect(r).toMatchObject({ installed: true, unchanged: false });
    expect(fsi.files.get(CLAUDE)).toContain("fresh body");
    expect(fsi.files.get(CODEX)).toContain("fresh body");
  });

  test("re-running when every target is current reports unchanged", () => {
    const fsi = memoryFs();
    installSectionToTargets(fsi, TARGETS, WORK, FRESH, true);
    const second = installSectionToTargets(fsi, TARGETS, WORK, FRESH, true);
    expect(second).toMatchObject({ installed: true, updated: true, unchanged: true });
  });

  test("one stale target out of two is still a change", () => {
    const fsi = memoryFs();
    installSectionToTargets(fsi, TARGETS, WORK, FRESH, true);
    // Only the codex file drifts — the claude one is already byte-perfect.
    fsi.files.set(CODEX, `## Tasks & Plans\nSTALE body\n${END}\n`);
    const r = installSectionToTargets(fsi, TARGETS, WORK, FRESH, true);
    expect(r.unchanged).toBe(false);
    expect(fsi.files.get(CODEX)).toContain("fresh body");
    // …and the file that was already current was NOT rewritten to say so.
    expect(fsi.writes.get(CLAUDE)).toBe(1);
  });
});
