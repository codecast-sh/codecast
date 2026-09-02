// The Node adapter against real files. Two things only it can prove: the mode
// stays the file owner's (ported from codecast's snippets.fileMode.test.ts),
// and a skipped write really leaves the mtime alone. Everything else runs on
// the in-memory filesystem in the other suites.
//
// Who owns the permissions on ~/.claude/CLAUDE.md? The installer owns one
// SECTION of that file; the user owns the file. The atomic writer publishes a
// fresh temp file on every write, so passing a mode would re-chmod on every
// refresh — and reconcilers refresh on every update and boot. No mode is
// passed: a new file lands owner-only, an existing file keeps whatever the
// user chose.

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { nodeFs } from "./fs";
import { installSectionToFile } from "./install";
import type { SectionSpec } from "./types";

const END = "<!-- /platform-modetest -->";
const SPEC: SectionSpec = { headings: ["## Mode Test"], endMarker: END };
const BODY = `\n## Mode Test\n\nbody\n${END}\n`;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "platform-snippets-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const modeOf = (p: string) => (fs.statSync(p).mode & 0o777).toString(8);

function scratch(name: string): { dir: string; file: string } {
  const dir = path.join(tmpRoot, name);
  return { dir, file: path.join(dir, "CLAUDE.md") };
}

describe("nodeFs: permissions belong to the file's owner", () => {
  test("a file we create is owner-only", () => {
    const { file } = scratch("create");
    installSectionToFile(nodeFs, { filePath: file }, SPEC, BODY, true);
    // Nothing else set a mode, so the safe default applies: an instruction
    // file can name internal hosts and workflows and has no reason to be
    // readable by anyone else on the machine.
    expect(modeOf(file)).toBe("600");
    expect(fs.readFileSync(file, "utf-8")).toContain("## Mode Test");
  });

  test("a file the user made group-readable stays group-readable", () => {
    const { dir, file } = scratch("preserve");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, "# My notes\n");
    fs.chmodSync(file, 0o644);
    installSectionToFile(nodeFs, { filePath: file }, SPEC, BODY, true);
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
    // Each pass rewrites the section with a different body, so every pass is
    // a real write. After three of them the file must still be the user's.
    for (const n of [1, 2, 3]) {
      installSectionToFile(nodeFs, { filePath: file }, SPEC, `\n## Mode Test\n\nbody ${n}\n${END}\n`, true);
      expect(modeOf(file)).toBe("664");
    }
    expect(fs.readFileSync(file, "utf-8")).toContain("body 3");
  });

  test("the user's own content survives a write that only replaces our section", () => {
    const { dir, file } = scratch("content");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `# Mine\n\n## Keep\nkeep me\n${BODY}\n## After\nalso keep\n`);
    installSectionToFile(nodeFs, { filePath: file }, SPEC, `\n## Mode Test\n\nnew body\n${END}\n`, true);
    const out = fs.readFileSync(file, "utf-8");
    expect(out).toContain("keep me");
    expect(out).toContain("also keep");
    expect(out).toContain("new body");
    expect(out).not.toContain("\nbody\n");
  });

  test("a skipped write leaves the mtime alone on a real file", () => {
    const { file } = scratch("mtime");
    installSectionToFile(nodeFs, { filePath: file }, SPEC, BODY, true);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(file, past, past);
    const mtime = fs.statSync(file).mtimeMs;
    for (let i = 0; i < 5; i++) {
      const r = installSectionToFile(nodeFs, { filePath: file }, SPEC, BODY, true);
      expect(r.unchanged).toBe(true);
    }
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  });
});
