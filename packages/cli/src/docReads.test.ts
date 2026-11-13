import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

let dir: string;
let mod: typeof import("./docReads");
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-reads-"));
  process.env.CODECAST_DIR = dir;
  mod = await import("./docReads");
});
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); delete process.env.CODECAST_DIR; });

describe("doc read ledger", () => {
  test("a doc read records its revision for that session only", () => {
    mod.noteDocRevisions("sess-a", "/cli/docs/get", { id: "d1" }, { _id: "d1", revision: "3.abc.1" });
    expect(mod.docReadBase("sess-a", mod.docKey("d1"))).toBe("3.abc.1");
    expect(mod.docReadBase("sess-b", mod.docKey("d1"))).toBeUndefined();
  });

  test("a write's answer moves the base forward", () => {
    mod.noteDocRevisions("sess-a", "/cli/docs/update", { id: "d1", content: "# new" }, { success: true, revision: "4.def.2" });
    expect(mod.docReadBase("sess-a", mod.docKey("d1"))).toBe("4.def.2");
  });

  test("a plan read is found by the short id the write names, and by its doc", () => {
    mod.noteDocRevisions("sess-a", "/cli/plans/get", { short_id: "pl-9" }, { short_id: "pl-9", doc_id: "d9", doc_revision: "1.x.1" });
    expect(mod.docReadBase("sess-a", mod.planKey("pl-9"))).toBe("1.x.1");
    expect(mod.docReadBase("sess-a", mod.docKey("d9"))).toBe("1.x.1");
  });

  test("a brief read is found by the role id", () => {
    mod.noteDocRevisions(null, "/cli/brief/get", { role_id: "r1" }, { role: { _id: "r1" }, brief_doc_id: "b1", brief_revision: "2.y.1" });
    expect(mod.docReadBase(null, mod.briefKey("r1"))).toBe("2.y.1");
  });

  test("a patch or a metadata change never moves the base: the caller has not seen the text it produced", () => {
    mod.noteDocRevisions("sess-d", "/cli/docs/get", { id: "d5" }, { _id: "d5", revision: "1.a.1" });
    mod.noteDocRevisions("sess-d", "/cli/docs/patch", { id: "d5" }, { revision: "3.b.1" });
    mod.noteDocRevisions("sess-d", "/cli/docs/update", { id: "d5", doc_type: "runbook" }, { revision: "4.c.1" });
    mod.noteDocRevisions("sess-d", "/cli/plans/update", { short_id: "pl-1", title: "x" }, { short_id: "pl-1", doc_revision: "5.d.1" });
    expect(mod.docReadBase("sess-d", mod.docKey("d5"))).toBe("1.a.1");
    expect(mod.docReadBase("sess-d", mod.planKey("pl-1"))).toBeUndefined();
  });

  test("responses without a revision and unrelated routes record nothing", () => {
    mod.noteDocRevisions("sess-c", "/cli/docs/get", { id: "d2" }, null);
    mod.noteDocRevisions("sess-c", "/cli/tasks/get", { id: "d2" }, { revision: "9" });
    expect(mod.docReadBase("sess-c", mod.docKey("d2"))).toBeUndefined();
  });

  test("outside a session each shell keeps its own reads", () => {
    mod.noteDocRevisions(null, "/cli/docs/get", { id: "d7" }, { _id: "d7", revision: "1.s.1" });
    expect(fs.existsSync(path.join(dir, "doc-reads", `shell-${process.ppid}.json`))).toBe(true);
    expect(mod.docReadBase(null, mod.docKey("d7"))).toBe("1.s.1");
  });
});
