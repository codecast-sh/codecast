import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  applySnippet,
  BROWSER_SECTION,
  BROWSER_SNIPPET,
  cutOwnedSections,
  findOwnedSections,
  installSectionToFile,
  MESSAGING_SECTION,
  MESSAGING_SNIPPET,
  PUBLISH_SECTION,
  PUBLISH_SNIPPET,
  REFERENCES_SECTION,
  REFERENCES_SNIPPET,
  snippetStale,
  stampSnippet,
  type SectionSpec,
} from "./snippets.js";

const END = "<!-- /codecast-work -->";
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
    const text = `## Tasks & Plans\nmy own notes, not codecast's\n\n## Other\n`;
    expect(findOwnedSections(text, WORK)).toEqual([]);
  });

  // A heading match is a PREFIX match (`indexOf`), so a user's longer heading
  // matches ours too. Only the marker then decides: without one their section is
  // safe, with one inside its block we claim it. Today's behavior, recorded
  // rather than endorsed — install.golden.test.ts:292 pins the same edge through
  // the real CLI.
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

// The bug this whole module exists to kill. Reproduced against the shipped
// binary before the fix: `cast install tasks` printed "updated" and deleted
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
    "another codecast snippet",
    "<!-- /codecast-visual -->",
    "",
  ].join("\n");

  test("does not delete to end of file", () => {
    const out = applySnippet(text, WORK, FRESH, true).text;
    expect(out).toContain("## My Personal Notes");
    expect(out).toContain("DO NOT LOSE THIS");
    expect(out).toContain("## Visual Canvas");
    expect(out).toContain("<!-- /codecast-visual -->");
  });

  test("replaces the block it can prove it owns", () => {
    const out = applySnippet(text, WORK, FRESH, true).text;
    expect(out).not.toContain("old block body");
    expect(out).toContain("fresh body");
  });

  // The unterminated block carries no end marker and matches no content probe,
  // so nothing distinguishes it from a section the user wrote under a heading we
  // happen to share. We keep it. A visible duplicate heading is a far cheaper
  // mistake than silently deleting someone's notes — which is the bug this
  // module exists to kill. A content probe is how a snippet opts into removing
  // its own pre-marker-era bodies.
  test("keeps an ambiguous unterminated block rather than guessing", () => {
    const out = applySnippet(text, WORK, FRESH, true).text;
    expect(out).toContain("newer block, never terminated");
  });
});

// The likelier trigger: a user writes their own section under a heading we also
// use, and the real codecast block sits further down under a legacy heading.
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
    "the real codecast block",
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
    expect(out).not.toContain("the real codecast block");
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
});

// A refresh replaces each block where it stands. The block's end deliberately
// swallows the blank line that separated it from the next section, and the
// refresh writes exactly one back — so the separator neither vanishes nor
// doubles. The shipped CLI added one blank line per snippet per run.
// Two consecutive updates must be byte-identical.
describe("regression: repeated updates do not grow the file", () => {
  test("a second update is byte-identical to the first", () => {
    const start = `# Mine\n\n## Tasks & Plans\nold\n${END}\n\n## Later\nkeep\n`;
    const once = applySnippet(start, WORK, FRESH, true).text;
    const twice = applySnippet(once, WORK, FRESH, true).text;
    const thrice = applySnippet(twice, WORK, FRESH, true).text;
    expect(twice).toBe(once);
    expect(thrice).toBe(once);
  });

  // This test used to assert `# Mine\n\n## Later\nkeep\n` — the signature of the
  // old writer, which cut our block out of the middle and re-appended it at the
  // bottom, leaving the user's `## Later` pulled up under their title. The file
  // did not grow, which is all this describe block claims, but the user's
  // section order silently changed on every update. The claim about blank lines
  // is unweakened; what changed is where the refreshed block belongs.
  test("blank lines are preserved and the block does not move", () => {
    const start = `# Mine\n\n## Tasks & Plans\nold\n${END}\n\n## Later\nkeep\n`;
    const out = applySnippet(start, WORK, FRESH, true).text;
    expect(out).toBe(`# Mine\n\n## Tasks & Plans\n\nfresh body\n${END}\n\n## Later\nkeep\n`);
    expect(out).not.toMatch(/\n{3,}/);
  });
});

// The block is refreshed where it stands. Re-appending it at the end walked
// codecast's sections downward past the user's own content on every update.
describe("regression: an update does not reorder the user's file", () => {
  const start = [
    "# My CLAUDE.md",
    "",
    "## Above",
    "written before codecast existed",
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
        "written before codecast existed",
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
  // duplicate here ends the file, so removing it used to strand that blank line
  // and leave the file ending "keep me here\n\n".
  test("collapsing a duplicate that ends the file leaves no orphan blank line", () => {
    const dup = `# Top\n\n## Tasks & Plans\nfirst\n${END}\n\n## Mine\nkeep me here\n\n## Tasks & Plans\nsecond\n${END}\n`;
    const out = applySnippet(dup, WORK, FRESH, true).text;
    expect(out).toBe(`# Top\n\n## Tasks & Plans\n\nfresh body\n${END}\n\n## Mine\nkeep me here\n`);
  });

  // Two specs, one file. Refreshing A used to move A below B and refreshing B
  // moved it back, so alternating passes never produced the same bytes twice and
  // a caller comparing against the previous run always saw a change.
  test("two owned blocks in one file keep their order across alternating updates", () => {
    const OTHER_END = "<!-- /codecast-state -->";
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
    // …and the user's section is still sandwiched between ours, as they wrote it.
    expect(pass3.indexOf("## Tasks & Plans")).toBeLessThan(pass3.indexOf("## House rules"));
    expect(pass3.indexOf("## House rules")).toBeLessThan(pass3.indexOf("## Thread state"));
    expect(pass3).not.toMatch(/\n{3,}/);
  });
});

// There is no reconcile loop — `refreshEnabledSnippets` runs on `cast update`
// (index.ts:10923), on `cast restart` when it self-updates (index.ts:4869), and
// on daemon boot when the version changed since the last boot (daemon.ts:17231).
// It reinstalls EVERY enabled section at once, so one of those beats rewrites up
// to ten sections across up to three files. A write with the same bytes still
// moves each file's mtime, which wakes every watcher on it — editors, and the
// agents that are reading CLAUDE.md right now — for nothing.
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

// Everything above runs on hand-written fixtures. These run on the bodies this
// module actually ships, because the fixtures can only prove the algorithm is
// right about text shaped the way the test author imagined.
describe("the shipped snippet bodies are recognized as our own", () => {
  const shipped: Array<[string, SectionSpec, string]> = [
    ["messaging", MESSAGING_SECTION, MESSAGING_SNIPPET],
    ["publish", PUBLISH_SECTION, PUBLISH_SNIPPET],
    ["browser", BROWSER_SECTION, BROWSER_SNIPPET],
    ["references", REFERENCES_SECTION, REFERENCES_SNIPPET],
  ];

  // Guards the invariant `NEXT_SECTION` is built on (snippets.ts:58-61): a
  // snippet body never contains a `## ` at the start of a line. Break it and the
  // body's own heading ends the block before the end marker, so the block is
  // never recognized again and every refresh appends another copy — see the next
  // test for what that looks like.
  for (const [name, spec, body] of shipped) {
    test(`${name}: written into a real file, then found again and refreshed in place`, () => {
      const user = "# Mine\n\n## Their Own Section\nkeep\n";
      const once = applySnippet(user, spec, body, true).text;
      expect(findOwnedSections(once, spec)).toHaveLength(1);
      const twice = applySnippet(once, spec, body, true);
      expect(twice.unchanged).toBe(true);
      expect(twice.text).toBe(once);
      expect(once).toContain("## Their Own Section");
      expect(once).not.toMatch(/\n{3,}/);
    });
  }

  // TODAY's behavior, recorded rather than endorsed. A `## ` at the start of a
  // line inside a fenced code block reads as the next section, so the end marker
  // falls outside the block and nothing is ever recognized as ours. The file
  // grows by a full copy on every refresh. No shipped body does this — the loop
  // above is what keeps it that way — and the fix would be to make the boundary
  // scan fence-aware.
  test("a `## ` inside a fenced code block breaks recognition, and stacks copies", () => {
    const spec: SectionSpec = { headings: ["## Tasks & Plans"], endMarker: END };
    const body = `\n## Tasks & Plans\n\n\`\`\`md\n## Goal\nwhat we are doing\n\`\`\`\n${END}\n`;
    const once = applySnippet("# Mine\n", spec, body, true).text;
    expect(findOwnedSections(once, spec)).toEqual([]);
    const twice = applySnippet(once, spec, body, true).text;
    expect(twice.match(/## Tasks & Plans/g)).toHaveLength(2);
  });
});

// `cast uninstall` removes every section we own from one file. It used to be
// seven hand-rolled copies, each falling back to end-of-file when a marker was
// missing — so uninstalling could take the rest of the user's CLAUDE.md with
// it, at the one moment they have stopped watching.
describe("uninstall: removing every owned section at once", () => {
  const MEM = "<!-- /codecast-memory -->";
  const MSG = "<!-- /codecast-messaging -->";
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

  // Our section is the LAST thing in the file — the common shape, since install
  // appends. Removing it must not leave the blank line that separated it from
  // the user's text above.
  test("removing the last section in the file leaves one trailing newline", () => {
    const file = `# Mine\n\n## Notes\njust me\n\n## Messaging\ncast send things\n${MSG}\n`;
    expect(cutOwnedSections(file, MESSAGING)).toBe("# Mine\n\n## Notes\njust me\n");
  });
});

// `cast install <slug> --disable` used to write `<key>_enabled: false` and
// print "disabled" while leaving the section in CLAUDE.md — so the agent kept
// reading a capability the user believed they had switched off. Removal is the
// other half of that promise.
describe("disable removes the section from disk", () => {
  const MSG = "<!-- /codecast-messaging -->";
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
  // byte, not one blank line taller each cycle. It used to gain one, because the
  // removal left the separator above the block behind for the re-install to
  // append onto.
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

// The claim above, proved against a real file: the write itself is skipped, so
// the mtime does not move. mtime is the observable that matters — it is what
// every file watcher on the machine wakes on.
describe("installSectionToFile: no write when nothing changed", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cast-snippets-"));
  afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  let n = 0;
  /** A fresh dir per test, with the section already installed and its mtime
   *  parked in the past so a rewrite is unmistakable. */
  const seeded = () => {
    const dir = path.join(tmpRoot, `case-${n++}`);
    const file = path.join(dir, "CLAUDE.md");
    installSectionToFile(file, dir, WORK, FRESH, true);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(file, past, past);
    return { dir, file, mtime: fs.statSync(file).mtimeMs };
  };

  test("creating the file writes it", () => {
    const dir = path.join(tmpRoot, "create");
    const file = path.join(dir, "CLAUDE.md");
    const r = installSectionToFile(file, dir, WORK, FRESH, true);
    expect(r).toMatchObject({ installed: true, unchanged: false });
    expect(fs.readFileSync(file, "utf-8")).toContain("fresh body");
  });

  test("re-installing the same section leaves the mtime alone", () => {
    const { dir, file, mtime } = seeded();
    const r = installSectionToFile(file, dir, WORK, FRESH, true);
    expect(r).toMatchObject({ installed: true, updated: true, unchanged: true });
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  });

  test("ten reconcile passes still leave the mtime alone", () => {
    const { dir, file, mtime } = seeded();
    for (let i = 0; i < 10; i++) installSectionToFile(file, dir, WORK, FRESH, true);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  });

  test("a genuinely new body does write", () => {
    const { dir, file, mtime } = seeded();
    const r = installSectionToFile(file, dir, WORK, `\n## Tasks & Plans\n\nNEW body\n${END}\n`, true);
    expect(r.unchanged).toBe(false);
    expect(fs.statSync(file).mtimeMs).toBeGreaterThan(mtime);
    expect(fs.readFileSync(file, "utf-8")).toContain("NEW body");
  });

  test("present and not updating never touches the file", () => {
    const { dir, file, mtime } = seeded();
    const r = installSectionToFile(file, dir, WORK, FRESH, false);
    expect(r).toMatchObject({ installed: false, unchanged: true });
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  });

  test("the user's surrounding content survives a real write", () => {
    const dir = path.join(tmpRoot, "surround");
    const file = path.join(dir, "CLAUDE.md");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `# Mine\n\n## Above\nkeep\n\n## Tasks & Plans\nold\n${END}\n\n## Below\nkeep too\n`);
    installSectionToFile(file, dir, WORK, FRESH, true);
    const out = fs.readFileSync(file, "utf-8");
    expect(out).toBe(`# Mine\n\n## Above\nkeep\n\n## Tasks & Plans\n\nfresh body\n${END}\n\n## Below\nkeep too\n`);
  });

  test("the file is written owner-only", () => {
    const dir = path.join(tmpRoot, "mode");
    const file = path.join(dir, "CLAUDE.md");
    installSectionToFile(file, dir, WORK, FRESH, true);
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe("600");
  });
});

// `installSectionToTargets` fans one section out to every agent instruction file
// on the machine and folds the results into one. The fold has a rule of its own:
// one stale file out of three is still a change to this machine, so `unchanged`
// may only be true when NOTHING was written anywhere.
//
// It reads `os.homedir()`, which bun resolves once at process start and caches —
// setting process.env.HOME mid-test moves nothing. So each case runs in its own
// bun process against a scratch HOME, the same way install.golden.test.ts drives
// the CLI, and reports back as JSON.
describe("installSectionToTargets: the fold across several files", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cast-snippets-home-"));
  afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  const snippetsModule = path.join(import.meta.dir, "snippets.ts");

  let n = 0;
  /**
   * Run `body` in a fresh bun process whose HOME is a scratch dir carrying both
   * a ~/.claude and a ~/.codex target. `body` gets `install(update)` and the two
   * file paths, and returns whatever it wants read back.
   */
  function inScratchHome<T>(body: string): { home: string; claude: string; codex: string; value: T } {
    const home = path.join(tmpRoot, `home-${n++}`);
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });

    const script = `
      import * as fs from "fs";
      import * as path from "path";
      import * as os from "os";
      import { installSectionToTargets } from ${JSON.stringify(snippetsModule)};
      const END = ${JSON.stringify(END)};
      const WORK = ${JSON.stringify(WORK)};
      const FRESH = ${JSON.stringify(FRESH)};
      const claude = path.join(os.homedir(), ".claude", "CLAUDE.md");
      const codex = path.join(os.homedir(), ".codex", "AGENTS.md");
      const install = (update) => installSectionToTargets(WORK, FRESH, update);
      const read = (f) => fs.readFileSync(f, "utf-8");
      const mtime = (f) => fs.statSync(f).mtimeMs;
      console.log("@@" + JSON.stringify((() => { ${body} })()));
    `;
    const proc = spawnSync(process.execPath, ["-e", script], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
      timeout: 60_000,
    });
    if (proc.status !== 0) throw new Error(`scratch-HOME run failed (${proc.status}): ${proc.stderr}`);
    const line = proc.stdout.split("\n").find((l) => l.startsWith("@@"));
    if (!line) throw new Error(`scratch-HOME run printed no result: ${proc.stdout}${proc.stderr}`);
    return {
      home,
      claude: path.join(home, ".claude", "CLAUDE.md"),
      codex: path.join(home, ".codex", "AGENTS.md"),
      value: JSON.parse(line.slice(2)) as T,
    };
  }

  test("a first install writes every target", () => {
    const { claude, codex, value } = inScratchHome<{ r: Record<string, boolean> }>(
      `return { r: install(true) };`,
    );
    expect(value.r).toMatchObject({ installed: true, unchanged: false });
    expect(fs.readFileSync(claude, "utf-8")).toContain("fresh body");
    expect(fs.readFileSync(codex, "utf-8")).toContain("fresh body");
  });

  test("re-running when every target is current reports unchanged", () => {
    const { value } = inScratchHome<{ second: Record<string, boolean> }>(
      `install(true); return { second: install(true) };`,
    );
    expect(value.second).toMatchObject({ installed: true, updated: true, unchanged: true });
  });

  test("one stale target out of two is still a change", () => {
    const { codex, value } = inScratchHome<{ r: Record<string, boolean>; moved: boolean }>(`
      install(true);
      // Only the codex file drifts — the claude one is already byte-perfect.
      fs.writeFileSync(codex, "## Tasks & Plans\\nSTALE body\\n" + END + "\\n");
      const before = mtime(claude);
      const r = install(true);
      return { r, moved: mtime(claude) !== before };
    `);
    expect(value.r.unchanged).toBe(false);
    expect(fs.readFileSync(codex, "utf-8")).toContain("fresh body");
    // …and the file that was already current was NOT rewritten to say so.
    expect(value.moved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ct-42805: the regression matrix over EVERY real spec. Everything above the
// "shipped snippet bodies" block runs on hand-written fixtures; this block
// replays the three historical regressions — a marker stranded above the
// heading, a user section sharing our heading, a double update — against the
// actual spec+body of every snippet in the shared table, plus the shared
// references section. A synthetic spec can only prove the algorithm right
// about text shaped the way the test author imagined.
import { SNIPPET_CATALOG } from "@codecast/shared/contracts";

const REAL_SECTIONS: Array<[string, SectionSpec, string]> = [
  ...SNIPPET_CATALOG.filter((s) => s.section).map(
    (s) => [s.slug, s.section!.spec, s.section!.body] as [string, SectionSpec, string],
  ),
  ["references", REFERENCES_SECTION, REFERENCES_SNIPPET],
];

describe("the shared table itself", () => {
  test("every slug except orchestration carries its spec and body together", () => {
    for (const s of SNIPPET_CATALOG) {
      if (s.slug === "orchestration") {
        // Not markdown: it installs skills, agents and hooks.
        expect(s.section).toBeUndefined();
        continue;
      }
      expect(s.section).toBeDefined();
      expect(s.section!.body).toContain(s.section!.spec.headings[0]);
      expect(s.section!.body).toContain(s.section!.spec.endMarker);
    }
  });

  // Two specs sharing a heading would each claim the other's block; two
  // sharing an end marker would cut each other's window. Either is a data bug
  // no algorithm test would catch.
  test("headings[0] is unique across the table", () => {
    const heads = REAL_SECTIONS.map(([, spec]) => spec.headings[0]);
    expect(new Set(heads).size).toBe(heads.length);
  });

  test("endMarker is unique across the table", () => {
    const ends = REAL_SECTIONS.map(([, spec]) => spec.endMarker);
    expect(new Set(ends).size).toBe(ends.length);
  });

  // snippetHashKey (./snippets.ts) derives each snippet's hash key by replacing
  // this suffix. A versionKey without it would collide the hash and the version
  // into one config key, so snippetStale would read true on every run and
  // rewrite that snippet forever.
  test("every versionKey ends in _version, so the hash key derives cleanly", () => {
    for (const s of SNIPPET_CATALOG) {
      expect(s.versionKey).toEndWith("_version");
    }
  });

  test("a typo'd slug throws instead of silently never refreshing", () => {
    // snippetStale returning false for an unknown slug would mean a misspelled
    // gate never refreshes its snippet again; a misspelled stamp would never
    // record what was installed, so its gate reinstalls on every pass.
    expect(() => snippetStale({}, "memroy")).toThrow(/unknown snippet slug "memroy"/);
    expect(() => stampSnippet({}, "memroy", "1")).toThrow(/unknown snippet slug "memroy"/);
    // Not-stale is reserved for a real entry that installs no markdown.
    expect(snippetStale({}, "orchestration")).toBe(false);
  });
});

// The matrix above exercises each spec alone; `cast uninstall` cuts ALL of
// them from one file (index.ts sweeps the catalog plus references — the hand
// list it replaced forgot browser and chat). This drives that exact shape:
// every real body adjacent in one document, then removed in sequence, with the
// user's own content the only survivor.
describe("every real section in one document", () => {
  const userDoc = [
    "# My CLAUDE.md",
    "",
    "## My Personal Notes",
    "DO NOT LOSE THIS",
    "",
  ].join("\n");

  test("install all, then cut all — the user's file comes back byte-identical", () => {
    let doc = userDoc;
    for (const [, spec, body] of REAL_SECTIONS) doc = applySnippet(doc, spec, body, true).text;
    for (const [slug, spec] of REAL_SECTIONS) {
      expect(findOwnedSections(doc, spec), `${slug} not found after install-all`).toHaveLength(1);
    }
    for (const [, spec] of REAL_SECTIONS) doc = cutOwnedSections(doc, spec);
    expect(doc).toBe(userDoc);
  });
});

// ---------------------------------------------------------------------------
// The refresh gates in index.ts. The pure-function suites above stay green no
// matter what index.ts does with the helpers, so this pins the wiring itself:
// reverting a gate to `config.<x>_version !== get<X>Version()` would regress
// the fleet to version-keyed rewrites — the exact bug the content-hash key
// (ct-42806) exists to kill — with every other test in this file passing.
// Asserted against the source text because index.ts runs `program.parse()` at
// module scope and cannot be imported (same technique as snippets.wiring.test.ts).
describe("the refresh gates in index.ts", () => {
  const indexSource = fs.readFileSync(path.join(import.meta.dir, "index.ts"), "utf-8");

  // Snippets kept current WITHOUT a per-snippet staleness gate in index.ts:
  //   - forks relies on the blanket refreshEnabledSnippets() pass alone and
  //     never writes its version key (recorded in snippets.wiring.test.ts);
  //   - messaging's gate lives in ensureMessagingForMemory (./snippets.ts),
  //     which compares messaging_hash itself;
  //   - orchestration installs no markdown at all.
  // A new catalog entry lands in the gated list below by default, so its
  // author either wires a gate or moves it here with a reason.
  const UNGATED = new Set(["forks", "messaging", "orchestration"]);

  // Boolean assertions with a message, not toContain(indexSource): a failing
  // toContain prints the whole 700KB "received" source, burying the finding.
  const gateIn = (slug: string) => indexSource.includes(`snippetStale(config, "${slug}")`);

  test.each(
    SNIPPET_CATALOG.filter((s) => !UNGATED.has(s.slug)).map((s) => [s.slug] as const),
  )("%s decides its rewrite with snippetStale and stamps what it wrote", (slug) => {
    expect(
      gateIn(slug),
      `index.ts has no snippetStale(config, "${slug}") gate — wire one (or list the slug as UNGATED here with a reason)`,
    ).toBe(true);
    expect(
      indexSource.includes(`stampSnippet(config, "${slug}"`),
      `index.ts never stamps "${slug}" after installing it, so its gate would reinstall on every pass`,
    ).toBe(true);
  });

  test("the ungated list stays honest", () => {
    // A gate added for one of these belongs in the gated set above — delete
    // the exception rather than leaving the list describing a machine that
    // no longer exists.
    for (const slug of UNGATED) {
      expect(gateIn(slug), `"${slug}" now has a gate in index.ts — remove it from UNGATED`).toBe(false);
    }
  });

  test("cast uninstall sweeps the catalog, not a hand list", () => {
    // The hand list this replaced had already forgotten browser and chat, so
    // uninstall left their sections in CLAUDE.md. The catalog loop cannot
    // forget a snippet; references rides along because catalog snippets are
    // what install it.
    expect(
      indexSource.includes("for (const snippet of SNIPPET_CATALOG)"),
      "the uninstall sweep in index.ts no longer iterates SNIPPET_CATALOG — a hand-listed sweep drifts from the catalog and strands sections in CLAUDE.md",
    ).toBe(true);
  });
});

describe.each(REAL_SECTIONS)("regression matrix over real specs: %s", (_slug, spec, body) => {
  const userDoc = [
    "# My CLAUDE.md",
    "",
    "## My Personal Notes",
    "DO NOT LOSE THIS",
    "",
    "## My Deploy Runbook",
    "step 1: ssh bastion",
    "",
  ].join("\n");

  test("installed into a real file, found again, and byte-identical under repeated updates", () => {
    const once = applySnippet(userDoc, spec, body, true).text;
    expect(findOwnedSections(once, spec)).toHaveLength(1);
    expect(once).toContain("DO NOT LOSE THIS");
    expect(once).toContain("ssh bastion");
    expect(once).not.toMatch(/\n{3,}/);
    const twice = applySnippet(once, spec, body, true);
    expect(twice.unchanged).toBe(true);
    expect(twice.text).toBe(once);
    const thrice = applySnippet(twice.text, spec, body, true).text;
    expect(thrice).toBe(once);
  });

  test("an end marker stranded ABOVE the heading does not eat the rest of the file", () => {
    // The original data-loss shape: detection saw the marker anywhere in the
    // file, the cut searched only below the heading, found nothing, and ran to
    // end of file — deleting every later section, user content included.
    const stranded = [
      "# My CLAUDE.md",
      "",
      "## Notes",
      "I pasted a fragment here once:",
      spec.endMarker,
      "",
      spec.headings[0],
      "never terminated",
      "",
      "## My Personal Notes",
      "DO NOT LOSE THIS",
      "",
    ].join("\n");
    const out = applySnippet(stranded, spec, body, true).text;
    expect(out).toContain("## My Personal Notes");
    expect(out).toContain("DO NOT LOSE THIS");
    // The ambiguous unterminated block survives too — no probe matches it.
    expect(out).toContain("never terminated");
  });

  test("a user section sharing our heading survives an update", () => {
    const doc = [
      "# My CLAUDE.md",
      "",
      spec.headings[0],
      "MY OWN notes under a heading codecast also uses.",
      "",
      "## Architecture",
      "The billing service owns invoices.",
      "",
    ].join("\n");
    // The real block lands below the user's; the update then refreshes ours
    // and only ours, and a second pass reproduces the bytes exactly.
    const withReal = applySnippet(doc, spec, body, true).text;
    const updated = applySnippet(withReal, spec, body, true);
    expect(updated.text).toBe(withReal);
    expect(updated.text).toContain("MY OWN notes under a heading codecast also uses.");
    expect(updated.text).toContain("The billing service owns invoices.");
    expect(findOwnedSections(updated.text, spec)).toHaveLength(1);
  });
});
