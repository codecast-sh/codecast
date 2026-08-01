// The graph is driven by a REAL VaultIndex built from synthetic notes rather
// than a hand-written stub: the interesting failures live in resolution (a
// link that points somewhere unexpected draws the wrong edge), and a stub
// would assert the graph against my own idea of resolution instead of the
// index's.

import { test, expect, describe } from "bun:test";
import { VaultIndex } from "../vaultIndex";
import { buildVaultGraph, localSubgraph, topFolder, unresolvedNodeId } from "../graphBuilder";

const build = (files: Record<string, string>) => VaultIndex.build(Object.entries(files));

/** Edges as sorted "a|b" strings — order is an implementation detail here. */
const edgeSet = (g: { edges: { source: string; target: string }[] }) =>
  g.edges.map((e) => `${e.source}|${e.target}`).sort();

const degreeOf = (g: { nodes: { id: string; degree: number }[] }, id: string) =>
  g.nodes.find((n) => n.id === id)?.degree;

describe("buildVaultGraph", () => {
  test("resolved wiki links become undirected edges between notes", () => {
    const graph = buildVaultGraph(
      build({
        "A.md": "links to [[B]]",
        "B.md": "links to [[C]]",
        "C.md": "a leaf",
      }),
    );

    expect(graph.nodes.map((n) => n.id)).toEqual(["A.md", "B.md", "C.md"]);
    expect(edgeSet(graph)).toEqual(["A.md|B.md", "B.md|C.md"]);
  });

  test("a mutual link pair is one edge, and counts once toward degree", () => {
    const graph = buildVaultGraph(
      build({
        "A.md": "[[B]]",
        "B.md": "[[A]]",
      }),
    );

    expect(graph.edges).toHaveLength(1);
    expect(degreeOf(graph, "A.md")).toBe(1);
    expect(degreeOf(graph, "B.md")).toBe(1);
  });

  test("repeated links to the same note don't inflate degree", () => {
    const graph = buildVaultGraph(
      build({
        "A.md": "[[B]] and again [[B]] and once more [[B]]",
        "B.md": "",
      }),
    );

    expect(graph.edges).toHaveLength(1);
    expect(degreeOf(graph, "A.md")).toBe(1);
  });

  test("degree counts distinct neighbors, in and out", () => {
    const graph = buildVaultGraph(
      build({
        "hub.md": "[[a]] [[b]]",
        "a.md": "",
        "b.md": "",
        "c.md": "[[hub]]",
      }),
    );

    expect(degreeOf(graph, "hub.md")).toBe(3);
    expect(degreeOf(graph, "a.md")).toBe(1);
  });

  test("self-links draw no edge", () => {
    const graph = buildVaultGraph(build({ "A.md": "[[A]] and [[#a heading]]" }));

    expect(graph.edges).toEqual([]);
    expect(degreeOf(graph, "A.md")).toBe(0);
  });

  test("an isolated note is still a node", () => {
    const graph = buildVaultGraph(build({ "lonely.md": "no links here" }));

    expect(graph.nodes.map((n) => n.id)).toEqual(["lonely.md"]);
    expect(degreeOf(graph, "lonely.md")).toBe(0);
  });

  test("attachments are neither nodes nor edge endpoints", () => {
    const graph = buildVaultGraph(
      build({
        "A.md": "![[diagram.png]] and [[B]]",
        "B.md": "",
        "diagram.png": "",
      }),
    );

    expect(graph.nodes.map((n) => n.id)).toEqual(["A.md", "B.md"]);
    expect(degreeOf(graph, "A.md")).toBe(1);
  });

  test("label is the note's title, falling back to the filename", () => {
    const graph = buildVaultGraph(
      build({
        "notes/deep.md": "# Real Title\n",
        "notes/plain.md": "no heading",
        "fm.md": "---\ntitle: From Frontmatter\n---\n# Ignored H1\n",
      }),
    );

    const label = (id: string) => graph.nodes.find((n) => n.id === id)?.label;
    expect(label("notes/deep.md")).toBe("Real Title");
    expect(label("notes/plain.md")).toBe("plain");
    expect(label("fm.md")).toBe("From Frontmatter");
  });

  test("folder is the top-level segment; root notes get an empty folder", () => {
    const graph = buildVaultGraph(
      build({
        "root.md": "",
        "projects/x.md": "",
        "projects/deep/y.md": "",
      }),
    );

    const folder = (id: string) => graph.nodes.find((n) => n.id === id)?.folder;
    expect(folder("root.md")).toBe("");
    expect(folder("projects/x.md")).toBe("projects");
    expect(folder("projects/deep/y.md")).toBe("projects");
  });

  describe("unresolved targets", () => {
    const files = {
      "A.md": "[[B]] and [[Nowhere]]",
      "B.md": "[[Nowhere]]",
    };

    test("are excluded by default", () => {
      const graph = buildVaultGraph(build(files));

      expect(graph.nodes.map((n) => n.id)).toEqual(["A.md", "B.md"]);
      expect(graph.edges).toHaveLength(1);
    });

    test("become shared ghost nodes when enabled", () => {
      const graph = buildVaultGraph(build(files), { includeUnresolved: true });
      const ghost = unresolvedNodeId("Nowhere");

      // One ghost, linked from BOTH mentioning notes — not one ghost each.
      expect(graph.nodes.filter((n) => n.isUnresolved).map((n) => n.id)).toEqual([ghost]);
      expect(graph.nodes.find((n) => n.id === ghost)?.label).toBe("Nowhere");
      expect(edgeSet(graph)).toEqual([`${ghost}|A.md`, `${ghost}|B.md`, "A.md|B.md"]);
      expect(degreeOf(graph, ghost)).toBe(2);
      // Ghosts raise the degree of the notes that mention them.
      expect(degreeOf(graph, "A.md")).toBe(2);
    });

    test("different spellings of one missing note are a single ghost", () => {
      const graph = buildVaultGraph(
        build({
          "A.md": "[[Project Ideas]]",
          "B.md": "[[project ideas]]",
          "C.md": "[[./Project Ideas]]",
        }),
        { includeUnresolved: true },
      );

      const ghosts = graph.nodes.filter((n) => n.isUnresolved);
      expect(ghosts).toHaveLength(1);
      // Grouped case-insensitively, but displayed as the first source wrote it.
      expect(ghosts[0].label).toBe("Project Ideas");
      expect(ghosts[0].degree).toBe(3);
    });

    test("missing attachments are not drawn as notes", () => {
      const graph = buildVaultGraph(build({ "A.md": "![[missing.png]] [[Real Gap]]" }), {
        includeUnresolved: true,
      });

      expect(graph.nodes.filter((n) => n.isUnresolved).map((n) => n.label)).toEqual(["Real Gap"]);
    });

    test("a ghost id can never collide with a real note path", () => {
      // Vault paths are relative, so nothing real starts with a slash.
      expect(unresolvedNodeId("Nowhere").startsWith("/")).toBe(true);
    });
  });

  test("output is sorted and reproducible across rebuilds", () => {
    const files = {
      "z.md": "[[a]]",
      "a.md": "[[m]]",
      "m.md": "[[z]]",
    };
    const first = buildVaultGraph(build(files));
    // Same files, inserted in the opposite order.
    const second = buildVaultGraph(VaultIndex.build(Object.entries(files).reverse()));

    expect(first.nodes.map((n) => n.id)).toEqual(["a.md", "m.md", "z.md"]);
    expect(first).toEqual(second);
  });
});

describe("localSubgraph", () => {
  //  A - B - C - D  (a chain), plus an unconnected island
  const chain = () =>
    buildVaultGraph(
      build({
        "A.md": "[[B]]",
        "B.md": "[[C]]",
        "C.md": "[[D]]",
        "D.md": "",
        "island.md": "",
      }),
    );

  test("one hop keeps the root and its direct neighbors", () => {
    const local = localSubgraph(chain(), "B.md", 1);

    expect(local.nodes.map((n) => n.id)).toEqual(["A.md", "B.md", "C.md"]);
    expect(edgeSet(local)).toEqual(["A.md|B.md", "B.md|C.md"]);
  });

  test("two hops reach further, in both link directions", () => {
    const local = localSubgraph(chain(), "A.md", 2);

    // A → B is outgoing, B → C is a link A doesn't own: traversal is undirected.
    expect(local.nodes.map((n) => n.id)).toEqual(["A.md", "B.md", "C.md"]);
  });

  test("degree is recomputed against the subgraph, not the whole vault", () => {
    const local = localSubgraph(chain(), "A.md", 1);

    // B has two neighbors in the vault (A and C) but only one on screen.
    expect(degreeOf(local, "B.md")).toBe(1);
  });

  test("an isolated root yields just itself", () => {
    const local = localSubgraph(chain(), "island.md", 2);

    expect(local.nodes.map((n) => n.id)).toEqual(["island.md"]);
    expect(local.edges).toEqual([]);
  });

  test("an unknown root yields an empty graph rather than throwing", () => {
    expect(localSubgraph(chain(), "gone.md", 2)).toEqual({ nodes: [], edges: [] });
  });

  test("hops beyond the graph's diameter are harmless", () => {
    const local = localSubgraph(chain(), "A.md", 99);

    expect(local.nodes.map((n) => n.id)).toEqual(["A.md", "B.md", "C.md", "D.md"]);
  });
});

describe("topFolder", () => {
  test("splits on the first slash only", () => {
    expect(topFolder("a/b/c.md")).toBe("a");
    expect(topFolder("c.md")).toBe("");
  });
});
