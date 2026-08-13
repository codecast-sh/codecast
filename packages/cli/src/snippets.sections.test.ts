import { describe, expect, test } from "bun:test";
import {
  applySnippet,
  cutOwnedSections,
  findOwnedSections,
  hasOwnedSection,
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
    expect(hasOwnedSection(text, WORK)).toBe(false);
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

// A refresh cuts each block out and re-appends it at the end. If the cut left
// the blank line that separated it from the next section, every `cast update`
// would grow the file — the shipped CLI added one blank line per snippet per
// run. Two consecutive updates must be byte-identical.
describe("regression: repeated updates do not grow the file", () => {
  test("a second update is byte-identical to the first", () => {
    const start = `# Mine\n\n## Tasks & Plans\nold\n${END}\n\n## Later\nkeep\n`;
    const once = applySnippet(start, WORK, FRESH, true).text;
    const twice = applySnippet(once, WORK, FRESH, true).text;
    const thrice = applySnippet(twice, WORK, FRESH, true).text;
    expect(twice).toBe(once);
    expect(thrice).toBe(once);
  });

  test("blank-line structure around neighbours is preserved", () => {
    const start = `# Mine\n\n## Tasks & Plans\nold\n${END}\n\n## Later\nkeep\n`;
    const out = applySnippet(start, WORK, FRESH, true).text;
    expect(out).toContain("# Mine\n\n## Later\nkeep\n");
    expect(out).not.toMatch(/\n{3,}/);
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

  test("re-enabling after a disable restores exactly one copy", () => {
    const installed = applySnippet("# Mine\n", MESSAGING, MSG_BODY, false).text;
    const disabled = cutOwnedSections(installed, MESSAGING);
    const again = applySnippet(disabled, MESSAGING, MSG_BODY, false).text;
    expect(again.match(/## Messaging/g)).toHaveLength(1);
  });

  test("disabling something that was never installed changes nothing", () => {
    const theirs = "# Mine\n\n## My Notes\nKEEP THIS\n";
    expect(cutOwnedSections(theirs, MESSAGING)).toBe(theirs);
  });
});
