import { expect, it } from "bun:test";
import { declarationPattern, parseDeclaration } from "../declarations";

it("reads declarations across languages, name column included", () => {
  const cases: [string, string, string, number][] = [
    ["export async function rankFiles(a) {", "rank", "function", 23],
    ["export const QuickOpen = memo(", "quickopen", "constant", 14],
    ["class CodeBuffer {", "buffer", "class", 7],
    ["    def parse_line(self):", "parse", "function", 9],
    ["pub(crate) fn walk_tree() {", "walk", "function", 15],
    ["func NewServer() *Server {", "server", "function", 6],
    ["type Region = {", "region", "type", 6],
    ["export interface QuickOpenProps {", "props", "interface", 18],
  ];
  for (const [line, q, kind, column] of cases) {
    const d = parseDeclaration(line, q);
    expect(d?.kind).toBe(kind as never);
    expect(d?.column).toBe(column);
    expect(new RegExp(declarationPattern(q)!, "i").test(line)).toBe(true);
  }
});

it("skips names without the query and queries too short to search", () => {
  expect(parseDeclaration("function other() {}", "rank")).toBeNull();
  expect(parseDeclaration("  return rankFiles(x)", "rank")).toBeNull();
  expect(declarationPattern("a")).toBeNull();
});
