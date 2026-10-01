import { describe, expect, test } from "bun:test";
import { parseShortstat, runCost } from "./cardCommand.js";

describe("cast card build inputs", () => {
  test("parses git diff --shortstat in every plural form", () => {
    expect(parseShortstat(" 2 files changed, 18 insertions(+), 7 deletions(-)\n")).toEqual({ files: 2, added: 18, removed: 7 });
    expect(parseShortstat(" 1 file changed, 1 insertion(+)")).toEqual({ files: 1, added: 1, removed: 0 });
    expect(parseShortstat(" 1 file changed, 3 deletions(-)")).toEqual({ files: 1, added: 0, removed: 3 });
    expect(parseShortstat("")).toBeNull();
  });

  test("sums agent minutes and tokens over the task's runs", () => {
    expect(runCost([
      { created_at: 0, updated_at: 30 * 60_000, tokens: 1000 },
      { created_at: 60_000, updated_at: 9 * 60_000 },
      { updated_at: 5 },
    ])).toEqual({ tokens: 1000, minutes: 38 });
  });
});
