import { describe, expect, test } from "bun:test";
import { structuredResultModel, structuredTone } from "./structuredResult";

describe("structuredResultModel", () => {
  test("a reviewer's verdict, findings and notes", () => {
    const m = structuredResultModel({
      verdict: "PASS",
      findings: [
        { severity: "minor", file: "packages/web/lib/stickyPrompt.ts", issue: "Vault-ready messages reach the sticky header.", fix: "Exclude vault_ready there." },
        { severity: "critical", file: "/Users/ashot/src/codecast/packages/convex/convex/secrets.ts", line: 42, issue: "Value in a log line." },
      ],
      notes: "I re-ran **everything**.",
    });
    expect(m.status).toEqual({ label: "Verdict", text: "PASS", tone: "good" });
    expect(m.fields).toEqual([]);
    const [findings, notes] = m.sections;
    expect(findings.kind).toBe("records");
    if (findings.kind !== "records") return;
    expect(findings.items[0]).toEqual({
      badge: { text: "minor", tone: "warn" },
      location: { path: "packages/web/lib/stickyPrompt.ts", display: "packages/web/lib/stickyPrompt.ts" },
      title: "Vault-ready messages reach the sticky header.",
      fields: [],
      texts: [{ label: "Fix", text: "Exclude vault_ready there." }],
    });
    expect(findings.items[1].badge?.tone).toBe("bad");
    expect(findings.items[1].location).toEqual({ path: "/Users/ashot/src/codecast/packages/convex/convex/secrets.ts", display: "codecast/packages/convex/convex/secrets.ts:42", line: 42 });
    expect(notes).toEqual({ kind: "text", label: "Notes", text: "I re-ran **everything**." });
  });

  test("an implementer's report: summary leads, file lists are paths, empty arrays stay", () => {
    const m = structuredResultModel({
      status: "done",
      files_changed: ["/Users/ashot/src/codecast/packages/web/components/secrets/parts.tsx"],
      verification: "Ran cast check web.",
      summary: "All four fixes are in.",
      open_issues: [],
      tests_passed: 33,
    });
    expect(m.status?.tone).toBe("good");
    expect(m.fields).toEqual([{ label: "Tests passed", value: "33" }]);
    expect(m.sections.map((s) => s.label)).toEqual(["Summary", "Files changed", "Verification", "Open issues"]);
    expect(m.sections[1]).toEqual({ kind: "list", label: "Files changed", items: ["codecast/packages/web/components/secrets/parts.tsx"], paths: true });
    expect(m.sections[3]).toEqual({ kind: "list", label: "Open issues", items: [], paths: false });
  });

  test("no status key: short values become fields with tone only when the word carries one", () => {
    const m = structuredResultModel({ confirmed: true, risk: "high", owner: "web" });
    expect(m.status).toBeUndefined();
    expect(m.fields).toEqual([
      { label: "Confirmed", value: "true" },
      { label: "Risk", value: "high", tone: "bad" },
      { label: "Owner", value: "web" },
    ]);
  });
});

describe("structuredTone", () => {
  test.each([
    ["PASS", "good"], ["needs_changes", "warn"], ["NEEDS CHANGES", "warn"], ["REJECT", "bad"], ["DONE_WITH_CONCERNS", "warn"], ["blue", "neutral"],
  ])("%s → %s", (word, tone) => expect(structuredTone(word)).toBe(tone as never));
});
