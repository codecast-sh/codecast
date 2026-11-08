// `cast expectations`: what a person or a routine reads after each verb.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatLine, formatProposal, formatProposeResult, formatShow, narrowLocally, readProposalSource, showRefError } from "./expectationsCommand";

describe("cast expectations output", () => {
  test("propose says what happened and who acts next", () => {
    expect(formatProposeResult({ short_id: "xp-3", status: "applied", version: 2, auto: true })).toBe("xp-3 applied as version 2: it only adds lines a person said, in their quoted words.");
    expect(formatProposeResult({ short_id: "xp-4", status: "open", version: 2, ask: true })).toContain("cast decide --proposal xp-4");
    expect(formatProposeResult({ short_id: "xp-5", status: "open", version: 2 })).toContain("cast expectations apply xp-5");
    expect(formatProposeResult({ short_id: "xp-7", status: "empty", version: 2 })).toContain("nothing to change");
  });

  test("show before version 1 says how to start", () => {
    expect(formatShow({ project: { id: "p", title: "Infrastructure" }, current_version: 0, doc: null, versions: [], proposals: [], cursor: null })).toContain("has no expectations yet");
  });

  test("show lists open proposals with the reason one could not apply", () => {
    const out = formatShow({
      project: { id: "p", title: "Calls" },
      current_version: 2,
      doc: { project: { id: "p", title: "Calls" }, version: 2, prefix: "calls", items: [], applied_at: 0, applied_by: "Cam", how: "person", summary: "Sharpen", proposal: "xp-2" },
      versions: [],
      proposals: [{ short_id: "xp-3", status: "open", summary: "Retire one", changes: 1, card: "sd-4", refused: "changed in version 2", created_at: 0 }],
      cursor: Date.parse("2026-10-05T17:00:00Z"),
    }, 3_600_000);
    expect(out).toContain("Version 2 of 2, applied by Cam from xp-2: Sharpen");
    expect(out).toContain("Open: xp-3 (1 change, ");
    expect(out).toContain("decision sd-4\n  could not apply: changed in version 2");
    expect(out).toContain("Context read up to 2026-10-05T17:00:00.000Z.");
  });

  test("a proposal is a file path, or the text itself", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "xp-")), "p.md");
    fs.writeFileSync(file, "# from a file");
    expect(readProposalSource(file)).toBe("# from a file");
    expect(readProposalSource("# inline\n## add")).toBe("# inline\n## add");
  });
});

describe("cast expectations show <id>", () => {
  const line = { id: "ex-calls-2", part: "Calls", text: "Facts hold.", status: "active", added_in: 1, citations: [{ kind: "commit", ref: "um@abc" }] } as any;
  const base = {
    project: { id: "p", title: "Calls" },
    current_version: 3,
    doc: { project: { id: "p", title: "Calls" }, version: 3, prefix: "calls", next_n: 3, items: [line], applied_at: 1, applied_by: "Ashot", how: "person", summary: "s" } as any,
    versions: [],
    proposals: [{ short_id: "xp-9", status: "open", summary: "Sharpen", changes: 1, created_at: 0 }],
    cursor: null,
  };

  test("takes a line or proposal id and refuses anything else", () => {
    expect(showRefError("ex-agentwatch-trial-8")).toBeNull();
    expect(showRefError("xp-55")).toBeNull();
    expect(showRefError("sd-3")).toContain("not an expectation id");
    expect(showRefError("Calls")).toContain("not an expectation id");
  });

  test("prints the one line with its sources, not the document", () => {
    const out = formatLine({ ...base, line });
    expect(out).toStartWith("ex-calls-2: Facts hold.");
    expect(out).toContain("active in version 3 of Calls");
    expect(out).toContain("um@abc");
  });

  test("prints a proposal's changes against the current words, with how to settle it", () => {
    const out = formatProposal({ ...base, proposal: { ...base.proposals[0], base_version: 3, ops: [{ op: "edit", id: "ex-calls-2", text: "Facts always hold.", citations: [] }] as any } }, 60_000);
    expect(out).toContain("xp-9 (open, 1 change against version 3 of Calls");
    expect(out).toContain("Was: Facts hold.");
    expect(out).toContain("cast expectations apply xp-9");
  });

  test("an older server's whole answer narrows to the id, or says where to look", () => {
    expect((narrowLocally(base, "ex-calls-2") as any).line.id).toBe("ex-calls-2");
    expect((narrowLocally(base, "xp-9") as any).proposal.short_id).toBe("xp-9");
    expect(narrowLocally(base, "ex-calls-7")).toContain("another project");
    expect(narrowLocally(base, "xp-1")).toContain("another project");
  });
});
