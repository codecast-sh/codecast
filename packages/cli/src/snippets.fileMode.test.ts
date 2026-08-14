// Who owns the permissions on ~/.claude/CLAUDE.md?
//
// codecast owns one SECTION of that file. The user owns the file. The two writes
// look identical and are not: `fs.writeFileSync(p, text, { mode })` hands `mode`
// to open(2) as a CREATION mode, which the kernel ignores once the file exists,
// while `atomicWriteFile` publishes a fresh temp file and chmods it every time.
// Swapping one for the other without dropping `mode` turns "set it once" into
// "reset it on every refresh" — and refreshEnabledSnippets runs on `cast update`,
// on `cast restart` and on daemon boot after a self-update.

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { installSectionToFile, type SectionSpec } from "./snippets.js";

const END = "<!-- /codecast-modetest -->";
const SPEC: SectionSpec = { headings: ["## Mode Test"], endMarker: END };
const BODY = `\n## Mode Test\n\nbody\n${END}\n`;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cast-snippet-mode-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const modeOf = (p: string) => (fs.statSync(p).mode & 0o777).toString(8);

function scratch(name: string): { dir: string; file: string } {
  const dir = path.join(tmpRoot, name);
  return { dir, file: path.join(dir, "CLAUDE.md") };
}

describe("installSectionToFile: permissions belong to the file's owner", () => {
  test("a file we create is owner-only", () => {
    const { dir, file } = scratch("create");

    installSectionToFile(file, dir, SPEC, BODY, true);

    // Nothing else set a mode, so the safe default applies: an instruction file
    // can name internal hosts and workflows and has no reason to be readable by
    // anyone else on the machine.
    expect(modeOf(file)).toBe("600");
    expect(fs.readFileSync(file, "utf-8")).toContain("## Mode Test");
  });

  test("a file the user made group-readable stays group-readable", () => {
    const { dir, file } = scratch("preserve");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, "# My notes\n");
    fs.chmodSync(file, 0o644);

    installSectionToFile(file, dir, SPEC, BODY, true);

    expect(modeOf(file)).toBe("644");
    // The write really happened — the mode survived a write, not a skip.
    expect(fs.readFileSync(file, "utf-8")).toContain("## Mode Test");
    expect(fs.readFileSync(file, "utf-8")).toContain("# My notes");
  });

  test("repeated refreshes never walk the mode back", () => {
    const { dir, file } = scratch("refresh");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, "# My notes\n");
    fs.chmodSync(file, 0o664);

    // Each pass rewrites the section with a different body, so every pass is a
    // real write. `cast update` on a machine that edits its snippets looks like
    // this, and after three of them the file must still be the user's.
    for (const n of [1, 2, 3]) {
      installSectionToFile(file, dir, SPEC, `\n## Mode Test\n\nbody ${n}\n${END}\n`, true);
      expect(modeOf(file)).toBe("664");
    }
    expect(fs.readFileSync(file, "utf-8")).toContain("body 3");
  });

  test("the user's own content survives a write that only replaces our section", () => {
    const { dir, file } = scratch("content");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `# Mine\n\n## Keep\nkeep me\n${BODY}\n## After\nalso keep\n`);

    installSectionToFile(file, dir, SPEC, `\n## Mode Test\n\nnew body\n${END}\n`, true);

    const out = fs.readFileSync(file, "utf-8");
    expect(out).toContain("keep me");
    expect(out).toContain("also keep");
    expect(out).toContain("new body");
    expect(out).not.toContain("\nbody\n");
  });
});
