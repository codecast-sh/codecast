// `cast expectations`: what a person or a routine reads after each verb.
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatProposeResult, formatShow, readProposalSource } from "./expectationsCommand";

describe("cast expectations output", () => {
  test("propose says what happened and who acts next", () => {
    expect(formatProposeResult({ short_id: "xp-3", status: "applied", version: 2, auto: true })).toBe("xp-3 applied as version 2: it only adds lines with quoted, dated sources.");
    expect(formatProposeResult({ short_id: "xp-4", status: "open", version: 2, card: "sd-9" })).toContain("card sd-9");
    expect(formatProposeResult({ short_id: "xp-5", status: "open", version: 2 })).toContain("cast expectations apply xp-5");
    expect(formatProposeResult({ short_id: "xp-6", status: "open", version: 2, card_error: "--to x: no person" })).toContain("No card was posted: --to x: no person");
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
    expect(out).toContain("card sd-4\n  could not apply: changed in version 2");
    expect(out).toContain("Context read up to 2026-10-05T17:00:00.000Z.");
  });

  test("a proposal is a file path, or the text itself", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "xp-")), "p.md");
    fs.writeFileSync(file, "# from a file");
    expect(readProposalSource(file)).toBe("# from a file");
    expect(readProposalSource("# inline\n## add")).toBe("# inline\n## add");
  });
});
