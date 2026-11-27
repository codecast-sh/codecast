import { expect, it } from "bun:test";
import { EditorState } from "@codemirror/state";
import { describeLanguage, loadLanguage } from "../languages";
import { lezerSymbols } from "../lsp/symbols";
import { symbolPathAt } from "./symbolPath";

const typescript = (await loadLanguage(describeLanguage("a.tsx")))!;
const doc = [
  "export const Panel = () => {",
  "  const onClick = () => 1;",
  "  return null;",
  "};",
  "class Store {",
  "  load() {",
  "    return 1;",
  "  }",
  "  save = async () => {};",
  "}",
  "const handlers = { run: () => 0 };",
].join("\n");
const state = EditorState.create({ doc, extensions: typescript });
const at = (text: string) => doc.indexOf(text) + 1;

it("the crumbs and the outline name a symbol with one kind", () => {
  expect(symbolPathAt(state, at("return null")).map((c) => [c.name, c.kind])).toEqual([["Panel", "function"]]);
  expect(symbolPathAt(state, at("return 1;")).map((c) => [c.name, c.kind])).toEqual([["Store", "class"], ["load", "method"]]);
  const outline = new Map(lezerSymbols(state, 1000).map((s) => [s.name, s]));
  expect(outline.get("Panel")?.kind).toBe("function");
  expect(outline.get("load")?.kind).toBe("method");
  expect(outline.get("save")?.container).toBe("Store");
  expect(outline.get("run")?.kind).toBe("method");
  // A crumb is a level the outline holds, so pressing it can list its siblings.
  const panel = outline.get("Panel")!;
  expect(panel.to).toBeGreaterThan(doc.indexOf("};"));
});
