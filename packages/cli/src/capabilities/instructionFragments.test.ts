import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { applyInstructionFragments, sectionsLedgerPath, type InstructionFragment } from "./instructionFragments.js";

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function machine(): string {
  const h = tmp("cc-frag-");
  fs.mkdirSync(path.join(h, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(h, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(h, ".claude", "CLAUDE.md"), "# Mine\n");
  return h;
}

const review: InstructionFragment = {
  slug: "authored/t1/instructions/review",
  teamName: "Acme",
  name: "Review",
  body: "## Review\n\nTwo readers per change.\n",
  hash: "h1",
};
const deploy: InstructionFragment = {
  slug: "authored/t1/instructions/deploy",
  teamName: "Acme",
  name: "Deploy",
  body: "Deploy from main only.",
  hash: "h2",
};

describe("applyInstructionFragments", () => {
  test("each fragment lands once in Claude's CLAUDE.md and Codex's AGENTS.md, and a disabled one is cut from both", () => {
    const h = machine();
    const files = [path.join(h, ".claude", "CLAUDE.md"), path.join(h, ".codex", "AGENTS.md")];

    const on = applyInstructionFragments({ home: h, fragments: [review, deploy] });
    expect(on.conflicts).toEqual([]);
    expect(on.wrote.sort()).toEqual([...files, ...files].sort());
    for (const f of files) {
      const text = fs.readFileSync(f, "utf-8");
      expect(text.split("## Acme: Review\n").length).toBe(2);
      expect(text.split("## Acme: Deploy\n").length).toBe(2);
      // The published heading is replaced by the team-and-item heading.
      expect(text).not.toContain("## Review\n");
    }
    expect(fs.readFileSync(files[0]!, "utf-8").startsWith("# Mine\n")).toBe(true);
    expect(fs.existsSync(sectionsLedgerPath(h))).toBe(true);

    const again = applyInstructionFragments({ home: h, fragments: [review, deploy] });
    expect(again.ops).toEqual([]);

    const off = applyInstructionFragments({ home: h, fragments: [deploy] });
    expect(off.removed.sort()).toEqual([...files].sort());
    for (const f of files) {
      const text = fs.readFileSync(f, "utf-8");
      expect(text).not.toContain("Acme: Review");
      expect(text).toContain("## Acme: Deploy");
    }
  });

  test("a dry run plans without writing anything, ledger included", () => {
    const h = machine();
    const r = applyInstructionFragments({ home: h, fragments: [review], dryRun: true });
    expect(r.ops.filter((o) => o.op === "markdown_section")).toHaveLength(2);
    expect(r.wrote).toEqual([]);
    expect(fs.readFileSync(path.join(h, ".claude", "CLAUDE.md"), "utf-8")).toBe("# Mine\n");
    expect(fs.existsSync(path.join(h, ".codex", "AGENTS.md"))).toBe(false);
    expect(fs.existsSync(sectionsLedgerPath(h))).toBe(false);
  });

  test("Codex gets no AGENTS.md on a machine without ~/.codex", () => {
    const h = machine();
    fs.rmSync(path.join(h, ".codex"), { recursive: true });
    applyInstructionFragments({ home: h, fragments: [review] });
    expect(fs.existsSync(path.join(h, ".codex"))).toBe(false);
  });

  test("a project fragment never lands in a tracked CLAUDE.md, and lands in an ignored one", () => {
    const h = machine();
    fs.rmSync(path.join(h, ".codex"), { recursive: true });
    const repo = tmp("cc-frag-repo-");
    const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    git("init", "-q");
    fs.writeFileSync(path.join(repo, "CLAUDE.md"), "# Repo rules\n");
    git("add", "CLAUDE.md");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");

    const tracked = applyInstructionFragments({ home: h, fragments: [{ ...review, projectRoot: repo }] });
    expect(tracked.conflicts).toMatchObject([{ reason: "project_write_refused" }]);
    expect(tracked.conflicts[0]!.detail).toContain("CLAUDE.md is tracked");
    expect(fs.readFileSync(path.join(repo, "CLAUDE.md"), "utf-8")).toBe("# Repo rules\n");

    git("rm", "-q", "--cached", "CLAUDE.md");
    fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "CLAUDE.md\n");
    const ignored = applyInstructionFragments({ home: h, fragments: [{ ...review, projectRoot: repo }] });
    expect(ignored.conflicts).toEqual([]);
    expect(fs.readFileSync(path.join(repo, "CLAUDE.md"), "utf-8")).toContain("## Acme: Review");
  });
});
