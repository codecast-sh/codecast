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

/** Find refs whose accessible name matches, for `cast browser find`. */
export function matchRefs(refs: SnapshotRef[], query: string): SnapshotRef[] {
  const q = query.toLowerCase();
  const exact = refs.filter((r) => r.name.toLowerCase() === q);
  if (exact.length) return exact;
  return refs.filter((r) => r.name.toLowerCase().includes(q) || r.role.toLowerCase() === q);
}
