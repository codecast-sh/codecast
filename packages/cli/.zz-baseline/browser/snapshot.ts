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
 *
 * ## What the accessibility tree misses
 *
 * A <div> styled as a button carries no ARIA role, so it has no AX node worth
 * printing and an agent cannot see it at all — and that pattern is everywhere
 * in modern apps. After the AX walk, `scanClickables` asks the page directly
 * for elements that behave like controls (cursor:pointer, an onclick handler,
 * a focusable tabindex, contenteditable) and appends them under the invented
 * role `clickable`, with the same `#e<backendNodeId>` refs, so click, hover
 * and type work on them unchanged.
 */

import type { PageSession } from "./instance.js";

/** Roles a user can act on. These always get a line and a ref. */
const INTERACTIVE = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio",
  "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider",
  "option", "listbox", "spinbutton", "textarea", "SearchBox", "treeitem",
  "scrollbar", "colorwell", "datetime", "menu", "menubar",
  // Not an AX role: minted by scanClickables for controls the tree has no
  // role for. Listed here so find/matchRefs rank it like any other control.
  "clickable",
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
  /** Set on a role-less control that takes typed text (contenteditable). */
  editable?: boolean;
  /** Position among the elements sharing this role and name, in document
   *  order, counting from 1. Set only when the name repeats, so its presence
   *  IS the ambiguity — see the ordinals section below (ct-49555). */
  nth?: number;
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

// ---------------------------------------------------------------------------
// Role-less controls
// ---------------------------------------------------------------------------

/** How many role-less controls one snapshot will report. */
const CLICKABLE_LIMIT = 50;

/** How many elements the cursor sweep will look at before giving up, so a
 *  page with 100k nodes cannot turn a snapshot into a stall. */
const CLICKABLE_SCAN_CAP = 4000;

/** Where the scan parks its matches between the two round trips. */
const STASH = "window.__castClickable";

/** Objects the scan mints, released in one call when it is done. */
const OBJECT_GROUP = "cast-clickable";

/** An element inside one of these is already represented by its host control,
 *  so reporting it would give the same button two refs. Built from the roles
 *  the AX walk already covers plus the native tags that carry them. */
const HOSTED_SELECTOR = ["a", "button", "input", "select", "textarea", "option", "summary"]
  .concat([...INTERACTIVE].map((r) => `[role="${r.toLowerCase()}"]`))
  .join(",");

/**
 * Find the controls the accessibility tree has no role for.
 *
 * One `Runtime.evaluate` does all the DOM work and parks the matches on a
 * window property; `Runtime.getProperties` then hands back a remote reference
 * per match in a single call, and `DOM.describeNode` turns each one into the
 * backendNodeId a ref is made of. That is N+4 round trips for N controls,
 * against the 2N+2 a naive per-element evaluate would cost.
 *
 * Main frame only. Child frames each need their own execution context, and
 * the AX walk already covers what they expose with real roles.
 */
async function scanClickables(page: PageSession, taken: Set<number>): Promise<SnapshotRef[]> {
  const { conn, sessionId } = page;
  const expression = `(() => {
    const HOSTED = ${JSON.stringify(HOSTED_SELECTOR)};
    const editable = (el) => {
      const ce = el.getAttribute("contenteditable");
      return ce === "" || ce === "true" || ce === "plaintext-only";
    };
    const eligible = (el) => {
      if (el.closest(HOSTED)) return false;
      if (el.getAttribute("aria-hidden") === "true") return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const st = getComputedStyle(el);
      return st.visibility !== "hidden" && st.display !== "none";
    };
    const nameOf = (el) => (
      el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("alt") ||
      el.getAttribute("placeholder") || el.getAttribute("data-placeholder") ||
      el.innerText || el.textContent || ""
    ).replace(/\\s+/g, " ").trim().slice(0, 80);

    const hits = [];
    const seen = new Set();
    const consider = (el, edit) => {
      if (seen.has(el) || hits.length >= ${CLICKABLE_LIMIT * 4}) return;
      seen.add(el);
      if (!eligible(el)) return;
      const name = nameOf(el);
      // An empty editor still matters — it is where the agent has to type.
      if (!name && !edit) return;
      hits.push({ el, name, edit });
    };

    for (const el of document.querySelectorAll("[contenteditable]")) {
      if (editable(el)) consider(el, true);
    }
    for (const el of document.querySelectorAll('[onclick],[tabindex]:not([tabindex="-1"])')) {
      consider(el, false);
    }
    let scanned = 0;
    for (const el of document.querySelectorAll("div,span,li,td,img,svg,label,p,section")) {
      if (++scanned > ${CLICKABLE_SCAN_CAP}) break;
      try { if (getComputedStyle(el).cursor === "pointer") consider(el, false); } catch {}
    }

    // cursor:pointer inherits, so a styled div button and every span inside it
    // all match. Keeping only the outermost gives one ref per visual control.
    const all = hits.map((h) => h.el);
    const kept = hits.filter((h) => !all.some((o) => o !== h.el && o.contains(h.el)));
    kept.sort((a, b) =>
      a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    const top = kept.slice(0, ${CLICKABLE_LIMIT});
    ${STASH} = top.map((h) => h.el);
    return JSON.stringify(top.map((h) => ({ name: h.name, edit: h.edit })));
  })()`;

  let found: Array<{ name: string; edit: boolean }>;
  try {
    const res = await conn.send<any>(
      "Runtime.evaluate",
      { expression, returnByValue: true, objectGroup: OBJECT_GROUP },
      sessionId,
    );
    found = JSON.parse(res.result?.value ?? "[]");
  } catch {
    return []; // a page that refuses to run script is not a snapshot failure
  }
  if (!found.length) {
    await cleanupClickables(page);
    return [];
  }

  const refs: SnapshotRef[] = [];
  try {
    const stash = await conn.send<any>(
      "Runtime.evaluate",
      { expression: STASH, objectGroup: OBJECT_GROUP },
      sessionId,
    );
    const arrayId = stash.result?.objectId as string | undefined;
    if (!arrayId) return [];
    const props = await conn.send<any>(
      "Runtime.getProperties",
      { objectId: arrayId, ownProperties: true },
      sessionId,
    );
    const byIndex = new Map<number, string>();
    for (const p of (props.result ?? []) as Array<{ name: string; value?: { objectId?: string } }>) {
      const i = Number(p.name);
      if (Number.isInteger(i) && p.value?.objectId) byIndex.set(i, p.value.objectId);
    }

    const nodes = await Promise.all(
      found.map(async (_, i) => {
        const objectId = byIndex.get(i);
        if (!objectId) return undefined;
        return await conn
          .send<any>("DOM.describeNode", { objectId }, sessionId)
          .then((r) => r.node?.backendNodeId as number | undefined)
          .catch(() => undefined);
      }),
    );

    for (let i = 0; i < found.length; i++) {
      const ref = nodes[i];
      if (!ref || taken.has(ref)) continue;
      taken.add(ref);
      refs.push({ ref, role: "clickable", name: found[i].name, editable: found[i].edit });
    }
  } catch {
    /* the page moved under us — report whatever resolved */
  } finally {
    await cleanupClickables(page);
  }
  return refs;
}

async function cleanupClickables(page: PageSession): Promise<void> {
  const { conn, sessionId } = page;
  await conn.send("Runtime.releaseObjectGroup", { objectGroup: OBJECT_GROUP }, sessionId).catch(() => {});
  await conn
    .send("Runtime.evaluate", { expression: `delete ${STASH}`, returnByValue: true }, sessionId)
    .catch(() => {});
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

  // Role-less controls, appended after the tree. Skipped when there is no room
  // left for a line: `find` and `open` call this with maxChars 1 purely for the
  // url and title, and must not pay for a DOM sweep they will not print.
  if (!truncated && chars + 24 <= maxChars) {
    const taken = new Set(refs.map((r) => r.ref));
    for (const c of await scanClickables(page, taken)) {
      const bits = ["clickable"];
      if (c.name) bits.push(JSON.stringify(c.name));
      if (c.editable) bits.push("[editable]");
      bits.push(`#e${c.ref}`);
      const line = bits.join(" ");
      if (chars + line.length + 1 > maxChars) {
        truncated = true;
        break;
      }
      out.push(line);
      chars += line.length + 1;
      refs.push(c);
    }
  }

  // Ordinals last, because a name's total is only known once the whole tree is
  // walked. `refs` keeps the raw name — `find "Delete"` must still match every
  // Delete — and only the printed line carries the suffix (ct-49555).
  const ords = ordinalsFor(refs);
  const labelled = new Map<number, string>();
  refs.forEach((r, i) => {
    if (!ords[i].duplicated) return;
    r.nth = ords[i].nth;
    const label = refLabel(r);
    if (label !== r.name) labelled.set(r.ref, label);
  });
  if (labelled.size) {
    for (let i = 0; i < out.length; i++) {
      const ref = out[i].match(/#e(\d+)$/);
      const label = ref ? labelled.get(Number(ref[1])) : undefined;
      if (!label) continue;
      // The name is the first JSON string on the line; `value=` comes after.
      const next = out[i].replace(/"(?:[^"\\]|\\.)*"/, JSON.stringify(label));
      if (chars + (next.length - out[i].length) > maxChars) break;
      chars += next.length - out[i].length;
      out[i] = next;
    }
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

// ---------------------------------------------------------------------------
// Ordinals: telling identical names apart
// ---------------------------------------------------------------------------
//
// A list of rows gives every row the same "Delete" button, so the snapshot
// prints the same line three times and an agent cannot say which one it means,
// cannot check that the ref it picked is the row it wanted, and cannot recover
// a ref that went stale without guessing. The ordinal among same role and name
// in document order is the missing coordinate: printed as `Delete (2nd)`,
// accepted back in a `find` query, and remembered so a stale ref recovers to
// the element it originally addressed rather than the first namesake.

/** English ordinal: 1 → "1st", 2 → "2nd", 11 → "11th". */
export function ordinal(n: number): string {
  const teens = n % 100;
  const suffix = teens >= 11 && teens <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

/** Each item's position among the items sharing its role and name, counting
 *  from 1 in the order given, plus whether that name repeats at all. Pure. */
export function ordinalsFor<T extends Named>(items: T[]): Array<{ nth: number; duplicated: boolean }> {
  const key = (i: Named): string => `${i.role} ${i.name}`;
  const totals = new Map<string, number>();
  for (const i of items) totals.set(key(i), (totals.get(key(i)) ?? 0) + 1);
  const seen = new Map<string, number>();
  return items.map((i) => {
    const k = key(i);
    const nth = (seen.get(k) ?? 0) + 1;
    seen.set(k, nth);
    return { nth, duplicated: (totals.get(k) ?? 1) > 1 };
  });
}

/** How a ref prints. `nth` is set only when the name repeats, and the first of
 *  the namesakes keeps its bare name — so a page with nothing ambiguous on it
 *  reads exactly as it did before. */
export function refLabel(r: { name: string; nth?: number }): string {
  return r.nth && r.nth > 1 && r.name ? `${r.name} (${ordinal(r.nth)})` : r.name;
}

/** Split a trailing ordinal off a find query: `Delete (2nd)` and `Delete 2nd`
 *  both mean the second Delete. Without this the ordinal a snapshot prints
 *  would be decoration an agent could read but not act on. */
export function splitOrdinalQuery(query: string): { text: string; nth: number | null } {
  const m =
    query.match(/^(.+?)\s*\(\s*(\d+)(?:st|nd|rd|th)\s*\)\s*$/i) ??
    query.match(/^(.+?)\s+(\d+)(?:st|nd|rd|th)\s*$/i);
  const nth = m ? parseInt(m[2], 10) : 0;
  return nth > 0 ? { text: m![1].trim(), nth } : { text: query, nth: null };
}

/** The nth of `hits` in the order they appear in `items` (their document
 *  order), or every hit when there is no such one — an out-of-range ordinal
 *  must not turn a real list of candidates into nothing. */
export function pickOrdinal<T>(items: T[], hits: T[], nth: number): T[] {
  const wanted = new Set(hits);
  const inOrder = items.filter((i) => wanted.has(i));
  const one = inOrder[nth - 1];
  return one ? [one] : hits;
}

/** What a human might mean by a trailing role word. Deliberately generous
 *  about `button`: menus, dropdowns and toggles usually render as buttons. */
const QUERY_ROLES: Record<string, string[]> = {
  // A div styled as a button is what people mean by "button" more often than
  // not, so `clickable` must not be demoted by a trailing role word.
  button: ["button", "clickable"],
  link: ["link", "clickable"],
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

// ---------------------------------------------------------------------------
// The machine-readable shape
// ---------------------------------------------------------------------------

/**
 * `snapshot --json`: the refs an agent can act on plus the tree as text.
 *
 * One shape whichever driver produced it, so a caller that parses the engine's
 * answer parses the built-in driver's too. Refs carry the string form the
 * agent types (`e12` → `#e12`), never the internal number.
 */
export interface SnapshotJson {
  url: string;
  title?: string;
  refs: Array<{ ref: string; role: string; name: string }>;
  text: string;
  truncated: boolean;
}

/** The built-in CDP driver's snapshot, as JSON. */
export function snapshotJson(s: Snapshot): SnapshotJson {
  return {
    url: s.url,
    title: s.title,
    refs: s.refs.map((r) => ({ ref: `e${r.ref}`, role: r.role, name: r.name })),
    text: s.text,
    truncated: s.truncated,
  };
}

/** The browser engine's own `snapshot --json` payload. */
export interface EngineSnapshotPayload {
  origin?: string;
  refs?: Record<string, { role?: string; name?: string }>;
  snapshot?: string;
}

/**
 * The engine's snapshot payload in our shape.
 *
 * The engine answers `{origin, refs: {e1: {role, name}}, snapshot}` wrapped in
 * a lifecycle envelope that says how the browser was launched — true, and of
 * no use to anyone reading a page. Drop it and keep the two things asked for.
 */
export function engineSnapshotJson(data: EngineSnapshotPayload): SnapshotJson {
  return {
    url: data.origin ?? "",
    refs: Object.entries(data.refs ?? {}).map(([ref, r]) => ({
      ref,
      role: r?.role ?? "",
      name: r?.name ?? "",
    })),
    text: data.snapshot ?? "",
    truncated: false,
  };
}
