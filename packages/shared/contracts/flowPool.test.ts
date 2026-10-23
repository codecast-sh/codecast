// A session's graph saved to the library (convex flowLibrary.save): its graph
// attributes rewritten with every other byte kept, and a flow's base read the
// same way whether a save named it or the graph extends a file.
import { expect, test } from "bun:test";
import { flowBase, flowGraphAttr, publishableFlowSource, withGraphAttrs } from "./flowPool";

test("withGraphAttrs sets and drops graph attributes, quotes and the rest of the source kept", () => {
  const src = `digraph x {\n  graph [kind="line", label="A, b ] c", takes="task", draft="imported", goal="$task_title"]\n  a [label="x"]\n}\n`;
  const out = withGraphAttrs(src, { draft: null, label: `New "name"` });
  expect(flowGraphAttr(out, "draft")).toBe(null);
  expect(out).toContain(`goal="$task_title"`);
  expect(out).toContain(`label="New \\"name\\""`);
  expect(out).toContain(`a [label="x"]`);
  expect(publishableFlowSource(out)).toBe(true);
});

test("a source with no graph list gets one", () => {
  expect(publishableFlowSource(withGraphAttrs(`digraph y {\n a -> b\n}`, { kind: "line" }))).toBe(true);
});

test("flowBase reads a save's base, else the extends file", () => {
  expect(flowBase({ source: `digraph z { graph [extends="../line.cast"] }` })).toBe("line");
  expect(flowBase({ variant_of: "spine", source: null })).toBe("spine");
  expect(flowBase({ source: `digraph z { graph [kind="line"] }` })).toBe(null);
});
