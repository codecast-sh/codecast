/**
 * Page snapshots: the accessibility tree rendered as compact text with stable
 * element references.
 *
 * Why the accessibility tree and not pixels: DOM-driven agents beat vision-
 * driven ones on ordinary web tasks by a wide margin, and a screenshot costs
 * one to two thousand tokens to say less. Screenshots stay available (see
 * `cast browser shot`) for the cases where layout IS the question.
 *
 * ## Refs are anchored to the node, not to the snapshot
 *
 * Playwright MCP numbers elements per snapshot — e0, e1, e2 — so every ref goes
 * stale the moment anything re-renders, which is the most common complaint in
 * its tracker. We mint refs from CDP's `backendNodeId`, which identifies the
 * node itself: a ref stays valid for as long as that node lives, survives
 * unrelated re-renders, and fails loudly when the node is gone instead of
 * silently addressing whatever slid into its index. Measured on a live page,
 * 576 of 576 refs survived a re-snapshot.
 *
 * ## What gets a line
 *
 * Interactive roles always, structural roles when they carry a name, and text
 * when it adds something its printed ancestor did not already say. That last
 * rule has to compare against the nearest ANCESTOR WE PRINTED rather than the
 * direct parent: an unnamed <span> takes its own text as its accessible name,
 * so comparing with the parent silently deletes the text (this is how "458
 * points" vanished from a Hacker News snapshot during development).
 */

import type { PageSession } from "./instance.js";

/** Roles a user can act on. These always get a line and a ref. */
const INTERACTIVE = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio",
  "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider",
  "option", "listbox", "spinbutton", "textarea", "SearchBox", "treeitem",
  "scrollbar", "colorwell", "datetime", "menu", "menubar",
]);

/** Roles that shape the page but are never clicked. Printed when named. */
const STRUCTURAL = new Set([
  "heading", "main", "navigation", "banner", "contentinfo", "dialog", "alertdialog",
  "alert", "status", "form", "table", "row", "columnheader", "rowheader", "cell",
  "list", "listitem", "article", "region", "tablist", "tabpanel", "img", "image",
  "figure", "blockquote", "code", "note", "search", "complementary", "progressbar",
]);

/** Wrappers with no meaning of their own — descend through, print nothing. */
const SKIP = new Set([
  "none", "generic", "GenericContainer", "InlineTextBox", "LineBreak",
  "paragraph", "Section", "Pre", "presentation", "Iframe", "IframePresentational",
  "RootWebArea", "WebArea", "group", "Legend", "DescriptionList",
]);

/** Node state worth reporting; anything false or absent is left out. */
const FLAGS = ["disabled", "checked", "expanded", "required", "selected", "focused", "invalid", "readonly", "pressed"];

export interface SnapshotRef {
  ref: number;
  role: string;
  name: string;
}

export interface Snapshot {
  text: string;
  refs: SnapshotRef[];
  url: string;
  title: string;
  /** Raw AX node count, for cost diagnosis. */
  nodes: number;
  truncated: boolean;
  ms: number;
}

interface AXProperty {
  name: string;
  value?: { value?: unknown };
}

interface AXNode {
  nodeId: string;
  parentId?: string;
  childIds?: string[];
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  properties?: AXProperty[];
  backendDOMNodeId?: number;
}

const val = (p?: { value?: unknown }): unknown => (p ? p.value : undefined);

export interface SnapshotOptions {
  /** Hard cap on rendered characters. Default 40000 (~11k tokens). */
  maxChars?: number;
  /** Include text nodes. Off gives a pure control map, much cheaper. */
  interactiveOnly?: boolean;
  /** Descend into child frames. Default true. */
  frames?: boolean;
}

export async function snapshotPage(page: PageSession, opts: SnapshotOptions = {}): Promise<Snapshot> {
  const t0 = Date.now();
  const maxChars = opts.maxChars ?? 40_000;
  const { conn, sessionId } = page;

  const meta = await conn
    .send<any>(
      "Runtime.evaluate",
      { expression: `JSON.stringify([location.href, document.title])`, returnByValue: true },
      sessionId,
    )
    .then((r) => JSON.parse(r.result.value) as [string, string])
    .catch(() => ["", ""] as [string, string]);

  // Frame list: the main frame plus any child frames sharing this session.
  // A cross-origin frame runs out of process and needs its own target, which
  // `frames` handling below reports rather than silently omitting.
  let frameIds: (string | undefined)[] = [undefined];
  if (opts.frames !== false) {
    try {
      const tree = await conn.send<any>("Page.getFrameTree", {}, sessionId);
      const collect = (n: any): string[] => [n.frame.id, ...(n.childFrames ?? []).flatMap(collect)];
      const all = collect(tree.frameTree);
      // The main frame is covered by the undefined (default) query already.
      frameIds = [undefined, ...all.slice(1)];
    } catch {
      /* older builds: main frame only */
    }
  }

  const out: string[] = [];
  const refs: SnapshotRef[] = [];
  let chars = 0;
  let truncated = false;
  let rawNodes = 0;

  for (const frameId of frameIds) {
    if (truncated) break;
    let nodes: AXNode[];
    try {
      const res = await conn.send<{ nodes: AXNode[] }>(
        "Accessibility.getFullAXTree",
        frameId ? { frameId } : {},
        sessionId,
      );
      nodes = res.nodes;
    } catch {
      continue; // a frame that went away mid-snapshot is not an error
    }
    if (!nodes?.length) continue;
    rawNodes += nodes.length;

    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const root = nodes.find((n) => !n.parentId) ?? nodes[0];
    const baseDepth = frameId ? 1 : 0;
    if (frameId) {
      const line = `frame ${frameId.slice(0, 8)}`;
      out.push(line);
      chars += line.length + 1;
    }

    const walk = (node: AXNode | undefined, depth: number, announced: string): void => {
      if (!node || truncated) return;
      const role = val(node.role) as string | undefined;
      const name = String(val(node.name) ?? "").trim();
      const value = val(node.value);

      let printed = false;
      if (!node.ignored && role && !SKIP.has(role)) {
        const interactive = INTERACTIVE.has(role);
        const structural = STRUCTURAL.has(role);
        const isText = role === "StaticText";
        const redundant = isText && announced.length > 0 && name.length > 0 && announced.includes(name);
        const wanted = opts.interactiveOnly
          ? interactive
          : interactive || (structural && name.length > 0) || (isText && name.length > 1 && !redundant);

        if (wanted) {
          const indent = "  ".repeat(Math.min(depth, 12));
          let line: string;
          if (isText) {
            line = `${indent}${name.slice(0, 200)}`;
          } else {
            const bits: string[] = [role];
            if (name) bits.push(JSON.stringify(name.slice(0, 120)));
            const v = value === undefined || value === null ? "" : String(value);
            if (v && v !== name) bits.push(`value=${JSON.stringify(v.slice(0, 60))}`);
            const flags = (node.properties ?? [])
              .filter((p) => FLAGS.includes(p.name))
              .filter((p) => {
                const pv = p.value?.value;
                return pv !== false && pv !== "false" && pv !== "none" && pv !== undefined;
              })
              .map((p) => (p.value?.value === true ? p.name : `${p.name}=${p.value?.value}`));
            if (flags.length) bits.push(`[${flags.join(",")}]`);
            if (interactive && node.backendDOMNodeId) {
              bits.push(`#e${node.backendDOMNodeId}`);
              refs.push({ ref: node.backendDOMNodeId, role, name });
            }
            line = indent + bits.join(" ");
          }
          if (chars + line.length + 1 > maxChars) {
            truncated = true;
            return;
          }
          out.push(line);
          chars += line.length + 1;
          printed = true;
        }
      }

      for (const cid of node.childIds ?? []) {
        walk(byId.get(cid), printed ? depth + 1 : depth, printed ? name : announced);
      }
    };

    walk(root, baseDepth, "");
  }

  return {
    text: out.join("\n"),
    refs,
    url: meta[0],
    title: meta[1],
    nodes: rawNodes,
    truncated,
    ms: Date.now() - t0,
  };
}

/**
 * Matching for `cast browser find`.
 *
 * The caller is an agent, so the job is not to be right — it is to get the
 * target onto a short ranked list and let the caller pick. Three consequences:
 *
 *   - A hit needs word overlap in EITHER direction. Agents routinely query
 *     with more words than the accessible name ("All issues link" for a link
 *     named "All issues"), and one-way substring matching fails exactly the
 *     queries that were trying hardest to be precise.
 *   - A trailing role word ("… button") narrows by intent, softly. People say
 *     button for links and menu for buttons, so a role mismatch demotes a
 *     candidate but never disqualifies it.
 *   - Misses still answer. `nearMatches` returns the sub-threshold candidates
 *     so a failed find can show what was close instead of a dead end.
 */

interface Named {
  role: string;
  name: string;
}

/** What a human might mean by a trailing role word. Deliberately generous
 *  about `button`: menus, dropdowns and toggles usually render as buttons. */
const QUERY_ROLES: Record<string, string[]> = {
  button: ["button"],
  link: ["link"],
  tab: ["tab"],
  checkbox: ["checkbox"],
  radio: ["radio"],
  input: ["textbox", "searchbox", "combobox"],
  field: ["textbox", "searchbox", "combobox"],
  textbox: ["textbox"],
  box: ["textbox", "searchbox", "combobox", "checkbox"],
  dropdown: ["combobox", "listbox", "button"],
  menu: ["menu", "menubar", "menuitem", "button"],
  toggle: ["switch", "checkbox", "button"],
  switch: ["switch"],
  heading: ["heading"],
  option: ["option", "menuitem"],
  slider: ["slider"],
};

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const tokensOf = (s: string): string[] => norm(s).split(" ").filter(Boolean);

interface Scored<T> {
  item: T;
  score: number;
  hit: boolean;
  exact: boolean;
}

function scoreAll<T extends Named>(items: T[], query: string): Scored<T>[] {
  let qTokens = tokensOf(query);
  let wantRoles: Set<string> | null = null;
  const last = qTokens[qTokens.length - 1];
  if (qTokens.length > 1 && QUERY_ROLES[last]) {
    wantRoles = new Set(QUERY_ROLES[last]);
    qTokens = qTokens.slice(0, -1);
  }
  const qn = qTokens.join(" ");
  // A query that is just a role word ("link", "combobox") matches by role.
  const roleOnly = !wantRoles && qTokens.length === 1 ? new Set([qn, ...(QUERY_ROLES[qn] ?? [])]) : null;

  const out: Scored<T>[] = [];
  for (const item of items) {
    const nn = norm(item.name);
    const nTokens = nn ? nn.split(" ") : [];
    let score = 0;
    let hit = false;
    let exact = false;

    if (qn && nn === qn) {
      score = 100;
      hit = true;
      exact = true;
    } else if (qn && nn.includes(qn)) {
      score = 70 + 20 * (qn.length / nn.length);
      hit = true;
    } else if (nn && qn.includes(nn)) {
      score = 60 + 10 * (nn.length / qn.length);
      hit = true;
    } else if (qn) {
      // Word overlap: how much of the query the name accounts for. Substring
      // per token so "173 comments" finds a link named "173comments".
      const covered = qTokens.filter((t) => nTokens.some((n) => n === t || n.includes(t))).length;
      const cov = covered / qTokens.length;
      if (cov > 0) {
        score = 40 + 20 * cov - Math.min(8, nTokens.length / 4);
        hit = cov > 0.5;
      }
    }

    // A bare role word ("link") matches by role, as it always has.
    if (roleOnly?.has(item.role.toLowerCase()) && !hit) {
      score = Math.max(score, 30);
      hit = true;
    }
    if (score <= 0) continue;
    if (wantRoles) score += wantRoles.has(item.role.toLowerCase()) ? 8 : -6;
    if (INTERACTIVE.has(item.role)) score += 5;
    out.push({ item, score, hit, exact });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Refs whose name or role matches the query, best first. An exact name match
 *  collapses the list to exacts: "Save" must not be ambiguous just because
 *  "Save draft" also contains it. */
export function matchRefs<T extends Named>(items: T[], query: string): T[] {
  const scored = scoreAll(items, query).filter((s) => s.hit);
  const exact = scored.filter((s) => s.exact);
  const kept = exact.length ? exact : scored;
  // One widget, many rows: grid apps give a row, its cells and the control
  // inside them the same accessible name (a Gmail message is row + gridcell +
  // checkbox + link, all named alike). When an interactive element carries
  // the name, its non-interactive shadows add nothing an agent could act on —
  // but a row that is the ONLY carrier of its name stays.
  const interactiveNames = new Set(
    kept.filter((s) => INTERACTIVE.has(s.item.role)).map((s) => norm(s.item.name)),
  );
  return kept
    .filter((s) => INTERACTIVE.has(s.item.role) || !interactiveNames.has(norm(s.item.name)))
    .map((s) => s.item);
}

/** What almost matched — for the miss message, so the agent sees candidates
 *  instead of a dead end. Only meaningful when matchRefs returned nothing. */
export function nearMatches<T extends Named>(items: T[], query: string, limit = 5): T[] {
  return scoreAll(items, query)
    .filter((s) => !s.hit)
    .slice(0, limit)
    .map((s) => s.item);
}
