// codecast's declared finders (.codecast/line.toml, line-profile.md LP3) hold
// to their declarations: every finder the profile lists has a producer here,
// and what that producer files carries the declared source, a declared kind,
// and a fingerprint of the declared shape. A finder declared without a
// producer, or a producer that drifts from its declaration, fails here.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseLineProfileText } from "../packages/cli/src/lineProfile";
import { evalSignals, signalArgv } from "../packages/evals/src/signals";
import { insightBlockerSignals } from "../packages/convex/convex/signals";
import { LESSON_SIGNAL, lessonFingerprint } from "../packages/convex/convex/lineLearn";

const root = path.join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const profile = parseLineProfileText(read(".codecast/line.toml"), ".codecast/line.toml").values;

type Filed = { source: string; kind: string; fingerprint: string };

/** What each declared finder files, from its real code path. */
const producers: Record<string, () => Filed[]> = {
  "eval-drift": () => {
    const out = evalSignals({ surface: "title", regression: true, gatesFailed: ["lengths"], failingFreezes: ["e22b47f0aa"], summary: [] });
    return out.map((s) => {
      const argv = signalArgv(s);
      return { source: argv[argv.indexOf("--source") + 1], kind: argv[argv.indexOf("--kind") + 1], fingerprint: argv[argv.indexOf("--fingerprint") + 1] };
    });
  },
  "insight-blockers": () => insightBlockerSignals("jx7c6zk", ["Deploy fails on schema"], undefined, undefined),
  lessons: () => {
    // The card's Revise or Drop note (lineLearn), and the weekly harvest the
    // cast-lessons skill files by hand: its command block is what an agent runs.
    const skill = read("packages/cli/skills/cast-lessons/SKILL.md");
    const source = skill.match(/--source (\S+)/)?.[1] ?? "";
    const kind = skill.match(/--kind (\S+)/)?.[1] ?? "";
    expect(skill).toMatch(/--fingerprint lesson:<rule-slug>/);
    expect(skill).toMatch(/--project /);
    return [
      { ...LESSON_SIGNAL, fingerprint: lessonFingerprint("ct-7", "add a test") },
      { source, kind, fingerprint: "lesson:PR-code-4" },
    ];
  },
};

/**
 * The declared fingerprint as a pattern: each alternative (comma separated
 * outside the placeholders, a parenthesized note dropped) is literal text
 * with every <placeholder> standing for one non-blank run.
 */
function fingerprintPattern(declared: string): RegExp {
  const alternatives: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of declared.replace(/\([^)]*\)/g, "")) {
    if (ch === "<") depth++;
    if (ch === ">") depth--;
    if (ch === "," && depth === 0) {
      alternatives.push(current.trim());
      current = "";
    } else current += ch;
  }
  alternatives.push(current.trim());
  const one = (alt: string) => alt.split(/<[^>]*>/).map((lit) => lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\S+");
  return new RegExp(`^(?:${alternatives.filter(Boolean).map(one).join("|")})$`);
}

describe("codecast's declared finders", () => {
  test("every declared finder has a producer, and every producer is declared", () => {
    expect((profile.finders ?? []).map((f) => f.id).sort()).toEqual(Object.keys(producers).sort());
  });

  for (const finder of profile.finders ?? []) {
    test(`${finder.id} files what it declares`, () => {
      const filed = producers[finder.id]();
      expect(filed.length).toBeGreaterThan(0);
      const pattern = fingerprintPattern(finder.fingerprint);
      for (const s of filed) {
        expect(s.source).toBe(finder.source);
        if (finder.kind !== "any") expect(finder.kind).toContain(s.kind);
        expect(s.fingerprint).toMatch(pattern);
      }
    });
  }

  test("the declared shape is read the way it is written", () => {
    const p = fingerprintPattern("evals:<surface>:<gate, freeze or separated-worse>");
    expect("evals:title:lengths").toMatch(p);
    expect("evals:title").not.toMatch(p);
    const lessons = fingerprintPattern("lesson:<task>:<note hash> (a card's note), lesson:<rule slug> (cast-lessons)");
    expect("lesson:ct-7:0a1b2c3d").toMatch(lessons);
    expect("lesson:PR-code-4").toMatch(lessons);
    expect("insight:jx7:abc").not.toMatch(lessons);
  });
});
