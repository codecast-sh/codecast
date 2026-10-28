import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MESSAGING_SNIPPET } from "../snippets.js";
import type { ModelCallSpec } from "@codecast/shared/contracts/modelCall";
import { insertUnderSection, runPromote, validMoves, type PromoteDeps } from "./kitPromote.js";
import { renderOwnedSection } from "./driver.js";

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

// Line numbers below are 1-based positions in PERSONAL.
const PERSONAL = [
  "# How I work", //                                         1
  "", //                                                      2
  "- Write plainly, no emdashes.", //                         3
  "- Run `bun test <file>` here, never the whole suite.", //  4
  "- Rebase, never merge.", //                                5
  "- Deploy convex before pushing web.", //                   6
].join("\n");

function setup(personalExtra = "") {
  const home = tmp("cc-promote-home-");
  const repo = tmp("cc-promote-repo-");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const personal = path.join(home, ".claude", "CLAUDE.md");
  fs.writeFileSync(personal, PERSONAL + "\n" + personalExtra);
  fs.writeFileSync(path.join(repo, "CLAUDE.md"), "# Repo\n\n## Testing\n\n- Tests use a tmp HOME.\n\n## Git\n\n- Keep history flat.\n");
  return { home, repo, personal };
}

function deps(over: Partial<PromoteDeps> & { home: string; repoRoot: string | null; reply: unknown; answers: string[] }): PromoteDeps & { seen: ModelCallSpec[]; out: string[]; published: Array<{ file: string; heading: string; text: string }> } {
  const seen: ModelCallSpec[] = [];
  const out: string[] = [];
  const published: Array<{ file: string; heading: string; text: string }> = [];
  const answers = [...over.answers];
  return {
    seen,
    out,
    published,
    model: async (spec) => {
      seen.push(spec);
      return { ok: true, text: JSON.stringify(over.reply), json: over.reply, usage: { input_tokens: 1, output_tokens: 1 }, cost_usd: 0, model: spec.model };
    },
    ask: async () => answers.shift() ?? "n",
    publishInstructions: async (file, heading) => {
      published.push({ file, heading, text: fs.readFileSync(file, "utf-8") });
      return true;
    },
    print: (l) => out.push(l),
    ...over,
  };
}

describe("cast cap promote", () => {
  test("accepted lines land at their destination, declined and already-present ones stay put", async () => {
    const { home, repo, personal } = setup();
    const d = deps({
      home,
      repoRoot: repo,
      reply: {
        moves: [
          { lines: [4], destination: "repo", section: "Testing" },
          { lines: [5], destination: "repo", section: "Git", already_present: "CLAUDE.md § Git: Keep history flat" },
          { lines: [6], destination: "team", item: "Deploys" },
          { lines: [3], destination: "team", item: "Voice" },
        ],
      },
      // L3 declined, L4 accepted, L6 accepted, then keep the personal file as is.
      answers: ["n", "y", "y", "n"],
    });
    const r = await runPromote(d);

    // The model saw the personal lines, the repo file and both destinations.
    expect(d.seen[0]!.prompt).toContain("L4: - Run `bun test <file>` here");
    expect(d.seen[0]!.prompt).toContain("Keep history flat.");
    expect(d.seen[0]!.output).toBe("json");

    expect(r.skipped.map((m) => m.lines)).toEqual([[5]]);
    expect(d.out.some((l) => l.startsWith("skip  L5") && l.includes("already there"))).toBe(true);
    expect(r.declined.map((m) => m.lines)).toEqual([[3]]);
    expect(r.accepted.map((m) => m.lines)).toEqual([[4], [6]]);

    const repoText = fs.readFileSync(path.join(repo, "CLAUDE.md"), "utf-8");
    expect(repoText).toBe("# Repo\n\n## Testing\n\n- Tests use a tmp HOME.\n- Run `bun test <file>` here, never the whole suite.\n\n## Git\n\n- Keep history flat.\n");
    expect(d.published).toHaveLength(1);
    expect(d.published[0]!.heading).toBe("Deploys");
    expect(d.published[0]!.text).toBe("## Deploys\n\n- Deploy convex before pushing web.\n");
    // Declined removal: the personal file is untouched.
    expect(fs.readFileSync(personal, "utf-8")).toBe(PERSONAL + "\n");
  });

  test("removal takes out only the moved lines; codecast sections are never proposed", async () => {
    const kit = renderOwnedSection("Acme: Deploys", "- Ship from main.", "authored/t1/instructions/deploys");
    const { home, repo, personal } = setup(MESSAGING_SNIPPET + kit);
    const owned = fs.readFileSync(personal, "utf-8").split("\n").findIndex((l) => l.startsWith("## Messaging")) + 1;
    const d = deps({
      home,
      repoRoot: repo,
      reply: { moves: [{ lines: [6], destination: "team", item: "Deploys" }, { lines: [owned], destination: "repo" }] },
      answers: ["y", "y"],
    });
    const r = await runPromote(d);
    expect(d.seen[0]!.prompt).not.toContain(`L${owned}: ## Messaging`);
    expect(r.proposed.map((m) => m.lines)).toEqual([[6]]);
    // The installed team item is extended, not replaced.
    expect(d.published[0]!.text).toBe("## Deploys\n\n- Ship from main.\n\n- Deploy convex before pushing web.\n");
    const after = fs.readFileSync(personal, "utf-8");
    expect(after).not.toContain("Deploy convex before pushing web.");
    expect(after).toContain("- Rebase, never merge.");
    expect(after).toContain("## Messaging");
    expect(r.removedFromPersonal).toBe(1);
  });

  test("scan lists and writes nothing; no repo means no repo moves", async () => {
    const { home, repo, personal } = setup();
    const d = deps({ home, repoRoot: null, scan: true, reply: { moves: [{ lines: [4], destination: "repo" }, { lines: [6], destination: "team", item: "Deploys" }] }, answers: [] });
    const r = await runPromote(d);
    expect(r.proposed.map((m) => m.destination)).toEqual(["team"]);
    expect(d.out.some((l) => l.startsWith("move  L6"))).toBe(true);
    expect(d.published).toEqual([]);
    expect(fs.readFileSync(personal, "utf-8")).toBe(PERSONAL + "\n");
    expect(fs.readFileSync(path.join(repo, "CLAUDE.md"), "utf-8")).toContain("- Tests use a tmp HOME.\n\n## Git");
  });

  test("a line that contradicts its destination is shown and never offered", async () => {
    const { home, repo } = setup();
    const d = deps({ home, repoRoot: repo, reply: { moves: [{ lines: [5], destination: "repo", section: "Git", conflicts: "Git says keep history flat" }] }, answers: [] });
    const r = await runPromote(d);
    expect(r.skipped.map((m) => m.lines)).toEqual([[5]]);
    expect(r.accepted).toEqual([]);
    expect(d.out.some((l) => l.startsWith("skip  L5") && l.includes("contradicts"))).toBe(true);
  });

  test("a failed publish keeps the lines in the personal file", async () => {
    const { home, personal } = setup();
    const d = deps({ home, repoRoot: null, reply: { moves: [{ lines: [6], destination: "team", item: "Deploys" }] }, answers: ["y", "y"] });
    d.publishInstructions = async () => false;
    const r = await runPromote(d);
    expect(r.wrote).toEqual([]);
    expect(fs.readFileSync(personal, "utf-8")).toBe(PERSONAL + "\n");
  });
});

describe("helpers", () => {
  test("validMoves drops unknown lines, duplicates and impossible destinations", () => {
    const moves = validMoves(
      { moves: [{ lines: [3, 99], destination: "team" }, { lines: [3], destination: "repo" }, { lines: [4], destination: "elsewhere" }] },
      new Set([3, 4]),
      true,
    );
    expect(moves).toEqual([{ lines: [3], destination: "team" }]);
  });

  test("insertUnderSection appends a new section when none matches", () => {
    expect(insertUnderSection("# Repo\n", "Deploys", ["- a"])).toBe("# Repo\n\n## Deploys\n\n- a\n");
  });
});
