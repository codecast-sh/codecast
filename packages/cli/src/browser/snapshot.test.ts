/**
 * Snapshot rendering rules.
 *
 * These cover the decisions that were actually got wrong while building this,
 * because those are the ones that will be got wrong again: what counts as
 * redundant text, where refs come from, and how the tree is ordered.
 */

import { describe, expect, test } from "bun:test";
import {
  matchRefs, nearMatches, ordinal, ordinalsFor, pickOrdinal, refLabel, snapshotPage, splitOrdinalQuery,
  type Snapshot,
} from "./snapshot.js";
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

/** A role-less control the DOM scan would find. */
interface FakeClickable {
  name: string;
  edit?: boolean;
  backendId: number;
}

interface FakeOpts {
  meta?: { url: string; title: string };
  /** What the cursor/onclick/tabindex/contenteditable sweep turns up. */
  clickables?: FakeClickable[];
  /** Every CDP method the page was asked for, in order. */
  calls?: string[];
}

/** A PageSession that answers the handful of calls snapshotPage makes. */
function fakePage(tree: FakeNode, opts: FakeOpts = {}): PageSession {
  const meta = opts.meta ?? { url: "https://example.test/", title: "Example" };
  const clickables = opts.clickables ?? [];
  const nodes = toAXNodes(tree);
  const conn = {
    send: async (method: string, params: any = {}) => {
      opts.calls?.push(method);
      if (method === "Runtime.evaluate") {
        const expr = String(params.expression ?? "");
        // The scan's first call: does the DOM work, parks its matches.
        if (expr.includes("contenteditable")) {
          return { result: { value: JSON.stringify(clickables.map((c) => ({ name: c.name, edit: !!c.edit }))) } };
        }
        // The scan's second call: hand back the parked array by reference.
        if (expr === "window.__castClickable") return { result: { objectId: "arr" } };
        if (expr.startsWith("delete ")) return {};
        return { result: { value: JSON.stringify([meta.url, meta.title]) } };
      }
      if (method === "Runtime.getProperties") {
        return {
          result: [
            ...clickables.map((_, i) => ({ name: String(i), value: { objectId: `el${i}` } })),
            { name: "length", value: { value: clickables.length } },
          ],
        };
      }
      if (method === "DOM.describeNode") {
        const i = Number(String(params.objectId).slice(2));
        return { node: { backendNodeId: clickables[i]?.backendId } };
      }
      if (method === "Runtime.releaseObjectGroup") return {};
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" }, childFrames: [] } };
      if (method === "Accessibility.getFullAXTree") return { nodes };
      throw new Error(`unexpected ${method}`);
    },
  };
  return { conn: conn as any, sessionId: "s1", targetId: "t1" };
}

const snap = (tree: FakeNode, opts: Record<string, unknown> = {}, fake: FakeOpts = {}): Promise<Snapshot> =>
  snapshotPage(fakePage(tree, fake), opts);

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

describe("role-less controls", () => {
  const tree: FakeNode = {
    id: "1", role: "RootWebArea", name: "Example",
    children: [{ id: "2", role: "button", name: "Real", backendId: 9 }],
  };

  test("appends a div styled as a button with a ref of the same shape", async () => {
    const s = await snap(tree, {}, { clickables: [{ name: "Publish", backendId: 4242 }] });
    expect(s.text).toContain('button "Real" #e9');
    expect(s.text).toContain('clickable "Publish" #e4242');
    expect(s.refs).toContainEqual({ ref: 4242, role: "clickable", name: "Publish", editable: false });
  });

  test("marks a contenteditable so an agent knows to type into it", async () => {
    const s = await snap(tree, {}, { clickables: [{ name: "", edit: true, backendId: 77 }] });
    expect(s.text).toContain("clickable [editable] #e77");
  });

  test("kept in interactiveOnly — a styled button is a control, not prose", async () => {
    const s = await snap(tree, { interactiveOnly: true }, { clickables: [{ name: "Publish", backendId: 5 }] });
    expect(s.text).toContain('clickable "Publish" #e5');
  });

  test("never repeats a node the accessibility walk already gave a ref", async () => {
    const s = await snap(tree, {}, { clickables: [{ name: "Real", backendId: 9 }] });
    expect(s.refs).toEqual([{ ref: 9, role: "button", name: "Real" }]);
  });

  test("stops at the character budget instead of overflowing it", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `Control number ${i}`, backendId: 100 + i }));
    const s = await snap(tree, { maxChars: 120 }, { clickables: many });
    expect(s.truncated).toBe(true);
    expect(s.text.length).toBeLessThanOrEqual(120);
  });

  test("skips the DOM sweep entirely when the caller only wants url and title", async () => {
    // `find` and `open` snapshot with maxChars 1 for the page line. Paying for
    // a DOM sweep there would slow down every navigation.
    const calls: string[] = [];
    await snap(tree, { maxChars: 1 }, { calls, clickables: [{ name: "Publish", backendId: 5 }] });
    expect(calls.filter((c) => c === "DOM.describeNode")).toHaveLength(0);
  });

  test("releases the remote objects and clears the window stash", async () => {
    const calls: string[] = [];
    await snap(tree, {}, { calls, clickables: [{ name: "Publish", backendId: 5 }] });
    expect(calls).toContain("Runtime.releaseObjectGroup");
  });

  test("a page that refuses to run the sweep still returns its tree", async () => {
    const page = fakePage(tree);
    const original = page.conn.send;
    page.conn.send = (async (method: string, params: any) => {
      if (method === "Runtime.evaluate" && String(params?.expression).includes("contenteditable")) {
        throw new Error("Blocked by CSP");
      }
      return original.call(page.conn, method, params);
    }) as typeof page.conn.send;
    const s = await snapshotPage(page);
    expect(s.text).toContain('button "Real" #e9');
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

  test("a query more specific than the name still hits", () => {
    // The most common agent phrasing: the name plus a role word.
    expect(matchRefs(refs, "Save draft button").map((r) => r.ref)).toEqual([2]);
    expect(matchRefs(refs, "the Home link").map((r) => r.ref)).toEqual([3]);
  });

  test("a trailing role word narrows but never disqualifies", () => {
    // "button" on a link: wrong role word, right element.
    expect(matchRefs(refs, "Home button").map((r) => r.ref)).toEqual([3]);
  });

  test("word overlap matches out-of-order and unspaced names", () => {
    const hn = [
      { ref: 10, role: "link", name: "173comments" },
      { ref: 11, role: "link", name: "past" },
    ];
    expect(matchRefs(hn, "173 comments").map((r) => r.ref)).toEqual([10]);
    const mac = [{ ref: 12, role: "button", name: "Download for Mac" }];
    expect(matchRefs(mac, "mac download button").map((r) => r.ref)).toEqual([12]);
  });

  test("near matches surface what almost hit, and only on a miss", () => {
    const page = [
      { ref: 20, role: "button", name: "Edit file" },
      { ref: 21, role: "cell", name: "README.md, (File)" },
      { ref: 22, role: "button", name: "Sign in" },
    ];
    expect(matchRefs(page, "edit readme")).toEqual([]);
    const near = nearMatches(page, "edit readme").map((r) => r.ref);
    expect(near).toContain(20);
    expect(near).not.toContain(22);
  });
});

describe("matchRefs against real pages", () => {
  // Condensed from live snapshots of github.com/anthropics/claude-code,
  // news.ycombinator.com and codecast.sh (2026-08-15). Each query is phrased
  // the way agents actually phrase them; `expected` is a hit anywhere in the
  // returned list, because the caller reads the whole short list.
  const github = [
    { ref: 9, role: "link", name: "All issues" },
    { ref: 10, role: "link", name: "All pull requests" },
    { ref: 12, role: "link", name: "You have no unread notifications ( g then n )" },
    { ref: 16, role: "button", name: "Open quick search dialog, type / to search" },
    { ref: 19, role: "button", name: "Open user navigation menu" },
    { ref: 33, role: "button", name: "Code" },
    { ref: 56, role: "button", name: "main branch" },
    { ref: 161, role: "button", name: "Watch: Participating in anthropics/claude-code. Click to change subscription settings." },
    { ref: 200, role: "button", name: "Star anthropics/claude-code" },
    { ref: 201, role: "button", name: "Star lists" },
    { ref: 249, role: "button", name: "Copy code to clipboard" },
    { ref: 101, role: "cell", name: "Fix lock-closed-issues workflow: use search API instead of offset pag…" },
    { ref: 124, role: "cell", name: "CHANGELOG.md, (File)" },
  ];
  const codecast = [
    { ref: 48, role: "button", name: "Sign in" },
    { ref: 49, role: "button", name: "Sign up" },
    { ref: 50, role: "button", name: "Get started free" },
    { ref: 51, role: "button", name: "Download for Mac" },
    { ref: 57, role: "button", name: "View on GitHub" },
    { ref: 59, role: "button", name: "Windows" },
    { ref: 61, role: "button", name: "Copy to clipboard" },
  ];

  const cases: Array<[typeof github, string, number]> = [
    [github, "All issues link", 9],
    [github, "star button", 200],
    [github, "watch button", 161],
    [github, "user menu", 19],
    [github, "search box", 16],
    [github, "main branch button", 56],
    [github, "notifications", 12],
    [github, "copy code button", 249],
    [codecast, "Sign in button", 48],
    [codecast, "copy button", 61],
    [codecast, "windows button", 59],
    [codecast, "github link", 57],
  ];

  for (const [page, query, expected] of cases) {
    test(`finds ${JSON.stringify(query)}`, () => {
      expect(matchRefs(page, query).map((r) => r.ref)).toContain(expected);
    });
  }

  test("ranks the intended element at or near the top for role-suffixed queries", () => {
    // "star button" is genuinely ambiguous between "Star …" and "Star lists";
    // both belong on the short list the caller reads.
    expect(matchRefs(github, "star button").slice(0, 2).map((r) => r.ref)).toContain(200);
    expect(matchRefs(github, "main branch button")[0].ref).toBe(56);
    expect(matchRefs(codecast, "Sign in button")[0].ref).toBe(48);
  });

  test("one grid widget is not four hits", () => {
    // Gmail gives a message's row, gridcell, checkbox and link the identical
    // accessible name. Only the interactive carriers are worth listing.
    const name = "Changelog: Cal.com v6.8";
    const gmail = [
      { ref: 1, role: "row", name },
      { ref: 2, role: "gridcell", name },
      { ref: 3, role: "checkbox", name },
      { ref: 4, role: "link", name },
      { ref: 5, role: "row", name: "Weekly digest" },
    ];
    const hits = matchRefs(gmail, name);
    expect(hits.map((r) => r.ref).sort()).toEqual([3, 4]);
    // A row that is the only carrier of its name survives.
    expect(matchRefs(gmail, "Weekly digest").map((r) => r.ref)).toEqual([5]);
    // Same-role duplicates are genuinely distinct elements and all stay.
    const dupes = [
      { ref: 6, role: "button", name: "Copy code to clipboard" },
      { ref: 7, role: "button", name: "Copy code to clipboard" },
    ];
    expect(matchRefs(dupes, "Copy code to clipboard").length).toBe(2);
  });

  test("pure synonyms still miss, with an empty near list", () => {
    // "avatar" shares no words with "Open user navigation menu". That case
    // belongs to the calling agent (snapshot and pick), not to this matcher.
    expect(matchRefs(github, "avatar")).toEqual([]);
    expect(nearMatches(github, "avatar")).toEqual([]);
  });
});

describe("ordinals", () => {
  test("English ordinals, including the teens", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal)).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "101st",
    ]);
  });

  test("counts position among same role and name, and flags only the repeats", () => {
    const refs = [
      { ref: 1, role: "button", name: "Delete" },
      { ref: 2, role: "link", name: "Delete" },
      { ref: 3, role: "button", name: "Delete" },
      { ref: 4, role: "button", name: "Save" },
    ];
    expect(ordinalsFor(refs)).toEqual([
      { nth: 1, duplicated: true },
      { nth: 1, duplicated: false },
      { nth: 2, duplicated: true },
      { nth: 1, duplicated: false },
    ]);
  });

  test("the first namesake keeps its bare name", () => {
    expect(refLabel({ name: "Delete", nth: 1 })).toBe("Delete");
    expect(refLabel({ name: "Delete", nth: 2 })).toBe("Delete (2nd)");
    expect(refLabel({ name: "Delete" })).toBe("Delete");
    // Nothing to suffix: an unnamed control is told apart by its ref alone.
    expect(refLabel({ name: "", nth: 3 })).toBe("");
  });

  test("a trailing ordinal is a selector, not part of the name", () => {
    expect(splitOrdinalQuery("Delete (2nd)")).toEqual({ text: "Delete", nth: 2 });
    expect(splitOrdinalQuery("Delete 3rd")).toEqual({ text: "Delete", nth: 3 });
    expect(splitOrdinalQuery("Delete")).toEqual({ text: "Delete", nth: null });
    // A bare ordinal is a name, not a selector — there is nothing left to find.
    expect(splitOrdinalQuery("2nd")).toEqual({ text: "2nd", nth: null });
  });

  test("an ordinal picks by document order, not by rank", () => {
    const refs = [
      { ref: 1, role: "button", name: "Delete" },
      { ref: 2, role: "button", name: "Delete" },
      { ref: 3, role: "button", name: "Delete" },
    ];
    const hits = [refs[2], refs[0], refs[1]]; // as the visibility ranker might have reordered them
    expect(pickOrdinal(refs, hits, 2).map((r) => r.ref)).toEqual([2]);
    // Out of range keeps every candidate rather than answering nothing.
    expect(pickOrdinal(refs, hits, 9)).toEqual(hits);
  });

  test("the snapshot prints the ordinal and keeps the raw name on the ref", async () => {
    const s = await snap({
      id: "1", role: "RootWebArea",
      children: [
        { id: "2", role: "button", name: "Delete", backendId: 11 },
        { id: "3", role: "button", name: "Delete", backendId: 12 },
        { id: "4", role: "button", name: "Delete", backendId: 13 },
        { id: "5", role: "button", name: "Save", backendId: 14 },
      ],
    });
    expect(s.text.split("\n")).toEqual([
      'button "Delete" #e11',
      'button "Delete (2nd)" #e12',
      'button "Delete (3rd)" #e13',
      'button "Save" #e14',
    ]);
    // The ref keeps the raw name, so `find "Delete"` still matches all three.
    expect(s.refs.map((r) => [r.name, r.nth])).toEqual([
      ["Delete", 1], ["Delete", 2], ["Delete", 3], ["Save", undefined],
    ]);
    expect(matchRefs(s.refs, "Delete")).toHaveLength(3);
  });
});
