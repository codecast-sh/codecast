import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Every prose-taking option or positional in the CLI must be described with
 * stdinText(), so '-' reads the heredoc through the one preAction hook
 * (sendBody.ts). A plain string description on such a flag is how
 * `cast task create -d -` once stored a literal "-" as a task body.
 *
 * Prose is recognised by its placeholder. Search filters (-q, --query) are the
 * one exception: a query is never a heredoc.
 */
const PROSE_PLACEHOLDER = /<(text|title|prompt|why|criteria|content|entry|description|body|message)>/;
const DECL = /\.(?:option|requiredOption|argument)\("([^"]*)", (?:stdinText\()?"/g;
const FILES = ["index.ts", "decideCommand.ts", "stateCommand.ts", "publish.ts"];

describe("stdin dash guard", () => {
  test("every prose flag is described with stdinText()", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const src = fs.readFileSync(path.join(import.meta.dir, file), "utf-8");
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        for (const m of line.matchAll(DECL)) {
          const flags = m[1];
          if (!PROSE_PLACEHOLDER.test(flags)) continue;
          if (/(^|, )-q, --query /.test(flags) || flags.startsWith("--query ")) continue;
          if (!m[0].includes("stdinText(")) offenders.push(`${file}:${i + 1}  ${flags}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
