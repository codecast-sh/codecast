/**
 * Snapshot rendering rules.
 *
 * These cover the decisions that were actually got wrong while building this,
 * because those are the ones that will be got wrong again: what counts as
 * redundant text, where refs come from, and how the tree is ordered.
 */

import { describe, expect, test } from "bun:test";
import { matchRefs, snapshotPage, type Snapshot } from "./snapshot.js";
import type { PageSession } from "./instance.js";

interface FakeNode {
  id: string;
  role: string;
  name?: string;
  value?: string;
  children?: FakeNode[];
  ignored?: boolean;
  backendId?: number;
  props?: Array<{ name: string; value: unknown }>;
}

/** Flatten a readable tree into the shape Accessibility.getFullAXTree returns. */
function toAXNodes(root: FakeNode): unknown[] {
  const out: any[] = [];
  const walk = (n: FakeNode, parentId?: string) => {
    out.push({
      nodeId: n.id,
      parentId,
      childIds: (n.children ?? []).map((c) => c.id),
      ignored: n.ignored ?? false,
      role: { value: n.role },
      name: n.name === undefined ? undefined : { value: n.name },
      value: n.value === undefined ? undefined : { value: n.value },
      backendDOMNodeId: n.backendId,
      properties: (n.props ?? []).map((p) => ({ name: p.name, value: { value: p.value } })),
    });
    for (const c of n.children ?? []) walk(c, n.id);
  };
  walk(root);
  return out;
}

/** A PageSession that answers the handful of calls snapshotPage makes. */
function fakePage(tree: FakeNode, meta = { url: "https://example.test/", title: "Example" }): PageSession {
  const nodes = toAXNodes(tree);
  const conn = {
    send: async (method: string) => {
      if (method === "Runtime.evaluate") {
        return { result: { value: JSON.stringify([meta.url, meta.title]) } };
      }
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" }, childFrames: [] } };
      if (method === "Accessibility.getFullAXTree") return { nodes };
      throw new Error(`unexpected ${method}`);
    },
  };
  return { conn: conn as any, sessionId: "s1", targetId: "t1" };
}

const snap = (tree: FakeNode, opts = {}): Promise<Snapshot> => snapshotPage(fakePage(tree), opts);

describe("snapshot rendering", () => {
  test("gives every interactive element a ref taken from its backend node id", async () => {
    const s = await snap({
      id: "1", role: "RootWebArea", name: "Example",
      children: [
        { id: "2", role: "button", name: "Save", backendId: 4242 },
        { id: "3", role: "link", name: "Home", backendId: 77 },
      ],
    });
    expect(s.text).toContain('button "Save" #e4242');
    expect(s.text).toContain('link "Home" #e77');
    expect(s.refs).toEqual([
      { ref: 4242, role: "button", name: "Save" },
      { ref: 77, role: "link", name: "Home" },
    ]);
  });

  test("drops text that only repeats the label of the element containing it", async () => {
    // A link's accessible name comes from its own text, so printing both says
    // the same thing twice and doubles the cost of every list of links.
    const s = await snap({
      id: "1", role: "RootWebArea",
      children: [
        { id: "2", role: "link", name: "Documentation", backendId: 10,
          children: [{ id: "3", role: "StaticText", name: "Documentation" }] },
      ],
    });
    expect(s.text).toBe('link "Documentation" #e10');
  });

  test("keeps text under an unnamed wrapper", async () => {
    // The regression that removed Hacker News scores: a wrapper with no role of
    // its own still carries its text as an accessible name, so comparing
    // against the direct parent — rather than the nearest PRINTED ancestor —
    // deleted the content entirely.
    const s = await snap({
      id: "1", role: "RootWebArea",
      children: [
        { id: "2", role: "generic", name: "458 points",
          children: [{ id: "3", role: "StaticText", name: "458 points" }] },
      ],
    });
    expect(s.text).toContain("458 points");
  });

  test("nests children under the elements that were printed", async () => {
    const s = await snap({
      id: "1", role: "RootWebArea",
      children: [
        { id: "2", role: "navigation", name: "Main",
          children: [{ id: "3", role: "link", name: "Docs", backendId: 5 }] },
      ],
    });
    expect(s.text).toBe('navigation "Main"\n  link "Docs" #e5');
  });

  test("does not indent for wrappers that print nothing", async () => {
    // Otherwise a deeply wrapped page walks off the right edge saying nothing.
    const s = await snap({
      id: "1", role: "RootWebArea",
      children: [
        { id: "2", role: "generic",
          children: [{ id: "3", role: "generic",
            children: [{ id: "4", role: "button", name: "Go", backendId: 9 }] }] },
      ],
    });
    expect(s.text).toBe('button "Go" #e9');
  });

  test("reports state flags but omits the ones that are false", async () => {
    const s = await snap({
      id: "1", role: "RootWebArea",
      children: [
        { id: "2", role: "checkbox", name: "Ship it", backendId: 3,
          props: [{ name: "checked", value: true }, { name: "disabled", value: false }] },
      ],
    });
    expect(s.text).toBe('checkbox "Ship it" [checked] #e3');
  });

  test("shows an input's value alongside its label", async () => {
    const s = await snap({
      id: "1", role: "RootWebArea",
      children: [{ id: "2", role: "textbox", name: "Email", value: "a@b.c", backendId: 8 }],
    });
    expect(s.text).toBe('textbox "Email" value="a@b.c" #e8');
  });

  test("skips ignored nodes but keeps walking through them", async () => {
    // An ignored wrapper is invisible to assistive tech, not a dead end.
    const s = await snap({
      id: "1", role: "RootWebArea",
      children: [
        { id: "2", role: "generic", ignored: true,
          children: [{ id: "3", role: "button", name: "Deep", backendId: 6 }] },
      ],
    });
    expect(s.text).toBe('button "Deep" #e6');
  });

  test("interactiveOnly leaves out prose", async () => {
    const s = await snap(
      {
        id: "1", role: "RootWebArea",
        children: [
          { id: "2", role: "StaticText", name: "Some explanatory copy" },
          { id: "3", role: "button", name: "Act", backendId: 2 },
        ],
      },
      { interactiveOnly: true },
    );
    expect(s.text).toBe('button "Act" #e2');
  });

  test("truncates at the character budget and says so", async () => {
    const many: FakeNode[] = Array.from({ length: 200 }, (_, i) => ({
      id: `n${i}`, role: "link", name: `Item number ${i}`, backendId: 1000 + i,
    }));
    const s = await snap({ id: "1", role: "RootWebArea", children: many }, { maxChars: 200 });
    expect(s.truncated).toBe(true);
    expect(s.text.length).toBeLessThanOrEqual(200);
  });

  test("carries the page's url and title", async () => {
    const s = await snap({ id: "1", role: "RootWebArea" });
    expect(s.url).toBe("https://example.test/");
    expect(s.title).toBe("Example");
  });
});

describe("matchRefs", () => {
  const refs = [
    { ref: 1, role: "button", name: "Save" },
    { ref: 2, role: "button", name: "Save draft" },
    { ref: 3, role: "link", name: "Home" },
  ];

  test("prefers an exact name over anything it is a prefix of", async () => {
    // "Save" must not be ambiguous just because "Save draft" also contains it.
    expect(matchRefs(refs, "Save")).toEqual([{ ref: 1, role: "button", name: "Save" }]);
  });

  test("falls back to substring matching", () => {
    expect(matchRefs(refs, "draft").map((r) => r.ref)).toEqual([2]);
  });

  test("ignores case", () => {
    expect(matchRefs(refs, "home").map((r) => r.ref)).toEqual([3]);
  });

  test("matches on role when the name does not match", () => {
    expect(matchRefs(refs, "link").map((r) => r.ref)).toEqual([3]);
  });
});
