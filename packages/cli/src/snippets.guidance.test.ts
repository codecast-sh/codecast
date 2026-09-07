/**
 * The version stamp, the stub form, and the staleness read `cast doctor` makes
 * from them (ct-49544).
 *
 * What these pin: a section says which cast wrote it, stamping is idempotent so
 * an update still settles on its second run, a stub says what the capability is
 * and where the flags live, and doctor calls a section stale only for real
 * content drift — never for a version bump alone, which nothing would rewrite.
 */

import { describe, expect, test } from "bun:test";
import {
  SNIPPET_CATALOG,
  readSnippetStamp,
  renderSectionBody,
  snippetBySlug,
  snippetStamp,
  stampSectionBody,
  stripSnippetStamp,
  stubSectionBody,
} from "@codecast/shared/contracts";
import { guidanceSectionStatus } from "./snippets.js";

const calls = snippetBySlug("calls")!;
const END = calls.section!.spec.endMarker;

/** What one instruction file looks like once `body` is installed in it. */
function fileWith(body: string): string {
  return `# My own notes\n\nkeep me\n\n${body.replace(/^\n+/, "")}\n`;
}

describe("section version stamp", () => {
  test("sits on its own line immediately above the end marker", () => {
    const stamped = stampSectionBody(calls.section!.body, END, "9.9.9");
    expect(stamped).toContain(`${snippetStamp("9.9.9")}\n${END}`);
    expect(readSnippetStamp(stamped)).toBe("9.9.9");
  });

  test("re-stamping replaces rather than stacks, so an update settles", () => {
    const once = stampSectionBody(calls.section!.body, END, "1.0.0");
    const twice = stampSectionBody(once, END, "1.0.0");
    expect(twice).toBe(once);
    const bumped = stampSectionBody(once, END, "2.0.0");
    expect(readSnippetStamp(bumped)).toBe("2.0.0");
    expect(bumped.match(/<!-- cast /g)).toHaveLength(1);
    // Only the stamp moved: the guidance itself is byte-identical.
    expect(stripSnippetStamp(bumped)).toBe(stripSnippetStamp(once));
  });

  test("an unstamped section reads as null, not as an error", () => {
    expect(readSnippetStamp(calls.section!.body)).toBeNull();
  });

  test("every catalog section can be stamped and read back", () => {
    for (const descriptor of SNIPPET_CATALOG) {
      if (!descriptor.section) continue;
      const stamped = renderSectionBody(descriptor, "full", "3.2.1");
      expect(`${descriptor.slug}: ${readSnippetStamp(stamped)}`).toBe(`${descriptor.slug}: 3.2.1`);
      expect(stamped).toContain(descriptor.section.spec.endMarker);
    }
  });
});

describe("stub sections", () => {
  test("carry the heading, the capability, and where the flags live", () => {
    const stub = stubSectionBody(calls);
    expect(stub).toContain(calls.section!.spec.headings[0]);
    expect(stub).toContain(calls.detail);
    expect(stub).toContain("cast guide calls");
    expect(stub).toContain(END);
  });

  test("stub mode only replaces a section it makes substantially smaller", () => {
    for (const descriptor of SNIPPET_CATALOG) {
      if (!descriptor.section) continue;
      const rendered = renderSectionBody(descriptor, "stub", "1.0.0");
      const stubbed = rendered.includes(`cast guide ${descriptor.slug}`);
      const worthIt = stubSectionBody(descriptor).length * 3 < descriptor.section.body.length * 2;
      expect(`${descriptor.slug} stubbed: ${stubbed}`).toBe(`${descriptor.slug} stubbed: ${worthIt}`);
      expect(`${descriptor.slug} smaller: ${rendered.length <= renderSectionBody(descriptor, "full", "1.0.0").length}`)
        .toBe(`${descriptor.slug} smaller: true`);
    }
  });

  test("the short sections keep their guidance", () => {
    // `calls` and `limits` are under a kilobyte: their stub would save 30 and
    // 220 bytes, which does not pay for a `cast guide` run.
    for (const slug of ["calls", "limits"]) {
      const rendered = renderSectionBody(snippetBySlug(slug)!, "stub", "1.0.0");
      expect(`${slug}: ${rendered.includes("cast guide")}`).toBe(`${slug}: false`);
    }
  });

  test("the whole catalog in stub mode costs a fraction of the full sections", () => {
    let full = 0;
    let stub = 0;
    for (const descriptor of SNIPPET_CATALOG) {
      if (!descriptor.section) continue;
      full += renderSectionBody(descriptor, "full", "1.0.0").length;
      stub += renderSectionBody(descriptor, "stub", "1.0.0").length;
    }
    // Measured at ~14.5k vs ~2.4k tokens when the mode shipped (ct-49544). The
    // bar is loose on purpose: it fails if stubbing ever stops being the large
    // saving the mode exists for, not on ordinary edits to a body.
    expect(`stub/full under half: ${stub * 2 < full}`).toBe("stub/full under half: true");
  });

  test("stay recognizable to the installer: heading first, end marker last", () => {
    for (const descriptor of SNIPPET_CATALOG) {
      if (!descriptor.section) continue;
      const spec = descriptor.section.spec;
      const stub = stubSectionBody(descriptor);
      expect(stub.indexOf(spec.headings[0])).toBeLessThan(stub.indexOf(spec.endMarker));
      expect(stub.trimEnd().endsWith(spec.endMarker)).toBe(true);
    }
  });
});

describe("guidanceSectionStatus — what cast doctor reads", () => {
  const config = { calls_enabled: true };
  const current = renderSectionBody(calls, "full", "1.0.0");

  test("a section this binary would write reads as current", () => {
    const rows = guidanceSectionStatus({
      files: [{ label: "CLAUDE.md", text: fileWith(current) }],
      config,
      version: "1.0.0",
      mode: "full",
    });
    expect(rows).toEqual([{ slug: "calls", file: "CLAUDE.md", state: "current", stamp: "1.0.0" }]);
  });

  test("a version bump with no body change is NOT drift", () => {
    // The refresh gate is keyed on content, so nothing would rewrite this file.
    // Reporting it stale would be a warning the user cannot act on.
    const rows = guidanceSectionStatus({
      files: [{ label: "CLAUDE.md", text: fileWith(current) }],
      config,
      version: "2.0.0",
      mode: "full",
    });
    expect(rows[0]).toMatchObject({ state: "current", stamp: "1.0.0" });
  });

  test("a body written by an older cast reads as stale, and names it", () => {
    const older = current.replace("The team's huddles", "Huddles");
    const rows = guidanceSectionStatus({
      files: [{ label: "CLAUDE.md", text: fileWith(older) }],
      config,
      version: "1.0.0",
      mode: "full",
    });
    expect(rows[0]).toMatchObject({ state: "stale", stamp: "1.0.0" });
  });

  test("a pre-stamp section whose text still matches is current, unstamped", () => {
    // Stamps arrive with the next body change, because the refresh gate is
    // keyed on content: nagging about a file nothing would rewrite would be a
    // permanent warning with no action behind it.
    const rows = guidanceSectionStatus({
      files: [{ label: "CLAUDE.md", text: fileWith(calls.section!.body) }],
      config,
      version: "1.0.0",
      mode: "full",
    });
    expect(rows[0]).toMatchObject({ state: "current", stamp: null });
  });

  test("drift in a pre-stamp section is stale with no version to name", () => {
    const drifted = calls.section!.body.replace("The team's huddles", "Huddles");
    const rows = guidanceSectionStatus({
      files: [{ label: "CLAUDE.md", text: fileWith(drifted) }],
      config,
      version: "1.0.0",
      mode: "full",
    });
    expect(rows[0]).toMatchObject({ state: "stale", stamp: null });
  });

  test("stub mode grades against the stub, not the full body", () => {
    // `browser` rather than `calls`: it is long enough to actually be stubbed.
    const browser = snippetBySlug("browser")!;
    const stub = renderSectionBody(browser, "stub", "1.0.0");
    const asStub = {
      files: [{ label: "CLAUDE.md", text: fileWith(stub) }],
      config: { browser_enabled: true },
      version: "1.0.0",
    };
    expect(guidanceSectionStatus({ ...asStub, mode: "stub" })[0]).toMatchObject({ state: "current" });
    expect(guidanceSectionStatus({ ...asStub, mode: "full" })[0]).toMatchObject({ state: "stale" });
  });

  test("an enabled snippet with no section on disk reads as missing", () => {
    const rows = guidanceSectionStatus({
      files: [{ label: "CLAUDE.md", text: "# only my own notes\n" }],
      config,
      version: "1.0.0",
      mode: "full",
    });
    expect(rows[0]).toMatchObject({ state: "missing", stamp: null });
  });

  test("a snippet that is off is not graded at all", () => {
    expect(guidanceSectionStatus({
      files: [{ label: "CLAUDE.md", text: fileWith(current) }],
      config: { calls_enabled: false },
      version: "1.0.0",
      mode: "full",
    })).toEqual([]);
  });

  test("one row per file, so a stale AGENTS.md is not hidden by a fresh CLAUDE.md", () => {
    const rows = guidanceSectionStatus({
      files: [
        { label: "CLAUDE.md", text: fileWith(current) },
        { label: "AGENTS.md", text: fileWith(current.replace("The team's huddles", "Huddles")) },
      ],
      config,
      version: "1.0.0",
      mode: "full",
    });
    expect(rows.map((r) => `${r.file}:${r.state}`)).toEqual(["CLAUDE.md:current", "AGENTS.md:stale"]);
  });
});
