// rrweb recordings as replay events (docs/architecture/external-data.md X5,
// X7). PostHog and Sentry both record with rrweb; this turns their snapshots
// into the same semantic stream our recorder writes, so a mirrored replay
// reads, renders and reproduces the same way.
//
// What it reads:
//   type 4 Meta                       a navigation
// Privacy follows the SDK recorder's rules: URLs keep their query keys but not
// the values or the hash (cleanUrl), and no text is read from a field, a rich
// text editor, anything marked [data-private], or a container holding one.
//   type 2 FullSnapshot               the node tree, kept to name what a click or an input touched
//   type 3 Incremental, source 0      node additions, so later clicks on new nodes still resolve
//   type 3 Incremental, source 2      mouse interactions: clicks only
//   type 3 Incremental, source 3      scrolls, at most one a second
//   type 3 Incremental, source 5      inputs: the length, never the value
//   type 6 Plugin rrweb/console@1     warnings and errors
//   type 6 Plugin rrweb/network@1     failed and slow requests (rrweb's and PostHog's payload shapes)
//   type 5 Custom (Sentry)            console breadcrumbs and fetch/xhr performance spans
// Everything else (pixels, styles, mouse moves) is dropped.
import { cleanUrl, REPLAY_LIMITS, type ReplayConsoleLevel, type ReplayEvent } from "../contracts/replay";
import { isFailedRequest, isRecorderNoise, isSlowRequest, sortReplayEvents } from "./events";

/** The loose shape of an rrweb event. Vendor payloads are untrusted, so every field is read defensively. */
export interface RrwebEvent {
  type: number;
  timestamp: number;
  data?: any;
}

const EventType = { FullSnapshot: 2, IncrementalSnapshot: 3, Meta: 4, Custom: 5, Plugin: 6 } as const;
const Source = { Mutation: 0, MouseInteraction: 2, Scroll: 3, Input: 5 } as const;
const MouseClick = 2;
const NodeType = { Document: 0, Element: 2, Text: 3 } as const;

export interface SNode {
  id: number;
  type: number;
  tagName?: string;
  attributes?: Record<string, unknown>;
  childNodes?: SNode[];
  textContent?: string;
}

/** The node tree the snapshots describe, with parents, so a target can be named by its surroundings. */
class NodeIndex {
  private nodes = new Map<number, SNode>();
  private parents = new Map<number, number>();
  private labelsFor = new Map<string, number>();

  /** Children that arrived before their parent (a mutation's adds are not always parent first), by parent id. */
  private orphans = new Map<number, SNode[]>();

  /** The document the last full snapshot drew, as this index's own copy, kept current by every mutation since. */
  root: SNode | null = null;

  reset() {
    this.nodes.clear();
    this.parents.clear();
    this.labelsFor.clear();
    this.orphans.clear();
    this.root = null;
  }

  /**
   * Add a node and its subtree as the index's own copy. A mutation adds each
   * node on its own with a parentId and no children, so a node added after
   * the snapshot is joined to its parent here, or a button rendered later has
   * no text to read. The recording's own objects are never changed: the
   * player replays them after this pass.
   */
  add(node: SNode, parentId?: number, nextId?: number | null) {
    if (!node || typeof node.id !== "number") return;
    const own = this.copy(node);
    if (parentId === undefined) {
      this.root = own;
      return;
    }
    this.parents.set(own.id, parentId);
    const parent = this.nodes.get(parentId);
    if (!parent) {
      const waiting = this.orphans.get(parentId) ?? [];
      waiting.push(own);
      this.orphans.set(parentId, waiting);
      return;
    }
    this.attach(parent, own, nextId);
  }

  private copy(node: SNode): SNode {
    const own: SNode = { id: node.id, type: node.type, ...(node.tagName ? { tagName: node.tagName } : {}), ...(node.attributes ? { attributes: { ...node.attributes } } : {}), ...(typeof node.textContent === "string" ? { textContent: node.textContent } : {}), childNodes: [] };
    this.nodes.set(own.id, own);
    if (own.tagName === "label" && typeof own.attributes?.for === "string") this.labelsFor.set(own.attributes.for, own.id);
    for (const child of node.childNodes ?? []) {
      if (!child || typeof child.id !== "number") continue;
      own.childNodes!.push(this.copy(child));
      this.parents.set(child.id, own.id);
    }
    for (const waiting of this.orphans.get(own.id) ?? []) this.attach(own, waiting);
    this.orphans.delete(own.id);
    return own;
  }

  private attach(parent: SNode, child: SNode, nextId?: number | null) {
    const kids = (parent.childNodes ??= []);
    const was = kids.findIndex((k) => k.id === child.id);
    if (was >= 0) kids.splice(was, 1);
    const before = typeof nextId === "number" ? kids.findIndex((k) => k.id === nextId) : -1;
    if (before >= 0) kids.splice(before, 0, child);
    else kids.push(child);
  }

  remove(id: number, parentId?: number) {
    const p = this.nodes.get(parentId ?? this.parents.get(id) ?? -1);
    if (p?.childNodes) p.childNodes = p.childNodes.filter((k) => k.id !== id);
  }

  setText(id: number, value: unknown) {
    const n = this.nodes.get(id);
    if (n && (typeof value === "string" || value === null)) n.textContent = value ?? "";
  }

  setAttributes(id: number, attrs: unknown) {
    const n = this.nodes.get(id);
    if (!n || !attrs || typeof attrs !== "object") return;
    const next = { ...(n.attributes ?? {}) };
    for (const [k, v] of Object.entries(attrs as Record<string, unknown>)) {
      if (v === null || v === undefined) delete next[k];
      else next[k] = v;
    }
    n.attributes = next;
  }

  get(id: number) {
    return this.nodes.get(id);
  }

  parent(id: number) {
    const p = this.parents.get(id);
    return p === undefined ? undefined : this.nodes.get(p);
  }

  text(node: SNode | undefined, max: number = REPLAY_LIMITS.label_max_chars): string {
    if (!node) return "";
    let out = "";
    const walk = (n: SNode) => {
      if (out.length > max) return;
      if (n.type === NodeType.Text && n.textContent) out += ` ${n.textContent}`;
      if (n.tagName === "script" || n.tagName === "style") return;
      for (const c of n.childNodes ?? []) walk(c);
    };
    walk(node);
    return out.replace(/\s+/g, " ").trim().slice(0, max);
  }

  /**
   * A node's own text, or "" when reading it could leak what a person typed:
   * a field, anything private or editable, or a container holding one. The
   * same rule as the SDK's readableText, read off the snapshot.
   */
  readableText(node: SNode | undefined): string {
    if (!node) return "";
    if (FIELD_TAGS.has(node.tagName ?? "")) return "";
    for (let n: SNode | undefined = node, depth = 0; n && depth < 50; n = this.parent(n.id), depth++) {
      if (isPrivateNode(n) || isEditableNode(n)) return "";
    }
    const holds = (n: SNode): boolean => (n.tagName === "textarea" || isPrivateNode(n) || isEditableNode(n)) || (n.childNodes ?? []).some(holds);
    if ((node.childNodes ?? []).some(holds)) return "";
    return this.text(node);
  }

  /** An element by its id attribute (aria-labelledby targets). */
  byId(id: string): SNode | undefined {
    for (const n of this.nodes.values()) if (n.attributes?.id === id) return n;
    return undefined;
  }

  labelElement(id: string) {
    const lid = this.labelsFor.get(id);
    return lid === undefined ? undefined : this.nodes.get(lid);
  }

  /** The document's <title>, for the navigation it follows. */
  title(): string | undefined {
    for (const n of this.nodes.values()) if (n.tagName === "title") return this.text(n) || undefined;
    return undefined;
  }
}

const attr = (n: SNode, name: string): string | undefined => {
  const v = n.attributes?.[name];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

const FIELD_TAGS = new Set(["input", "textarea", "select", "form"]);
const hasAttr = (n: SNode, name: string) => n.attributes?.[name] !== undefined && n.attributes?.[name] !== null;
const isPrivateNode = (n: SNode) => hasAttr(n, "data-private");
const isEditableNode = (n: SNode) => hasAttr(n, "contenteditable") && String(n.attributes?.contenteditable).toLowerCase() !== "false";

const INTERACTIVE_TAGS = new Set(["a", "button", "input", "select", "textarea", "summary", "label", "option"]);

function implicitRole(n: SNode): string | undefined {
  const explicit = attr(n, "role");
  if (explicit) return explicit.split(/\s+/)[0];
  switch (n.tagName) {
    case "a":
      return attr(n, "href") !== undefined ? "link" : undefined;
    case "button":
    case "summary":
      return "button";
    case "select":
      return "combobox";
    case "textarea":
      return "textbox";
    case "option":
      return "option";
    case "input": {
      const t = (attr(n, "type") ?? "text").toLowerCase();
      if (t === "checkbox" || t === "radio") return t;
      if (t === "button" || t === "submit" || t === "reset" || t === "image") return "button";
      if (t === "range") return "slider";
      if (t === "number") return "spinbutton";
      if (t === "search") return "searchbox";
      if (t === "hidden") return undefined;
      return "textbox";
    }
  }
  return undefined;
}

/** The nearest element a person meant: the node itself or the closest interactive ancestor, a few levels up at most. */
function interactiveTarget(index: NodeIndex, id: number): SNode | undefined {
  let n = index.get(id);
  if (n?.type === NodeType.Text) n = index.parent(id);
  const start = n;
  for (let depth = 0; n && depth < 6; depth++) {
    if (n.type === NodeType.Element && (INTERACTIVE_TAGS.has(n.tagName ?? "") || attr(n, "role") || attr(n, "onclick") !== undefined)) return n;
    n = index.parent(n.id);
  }
  return start;
}

/** What a person would call the control: its accessible name as far as a snapshot can tell. */
function accessibleName(index: NodeIndex, n: SNode): string {
  const own = attr(n, "aria-label") ?? attr(n, "title") ?? attr(n, "alt");
  if (own) return own;
  const id = attr(n, "id");
  const forLabel = id ? index.labelElement(id) : undefined;
  if (forLabel) return index.readableText(forLabel);
  // A control wrapped in its <label>.
  for (let p = index.parent(n.id), depth = 0; p && depth < 3; p = index.parent(p.id), depth++) {
    if (p.tagName === "label") return index.readableText(p);
  }
  if (n.tagName === "input") {
    const t = (attr(n, "type") ?? "text").toLowerCase();
    if (t === "submit" || t === "button" || t === "reset") return attr(n, "value") ?? t;
    return attr(n, "placeholder") ?? attr(n, "name") ?? "";
  }
  if (n.tagName === "textarea" || n.tagName === "select") return attr(n, "placeholder") ?? attr(n, "name") ?? "";
  return index.readableText(n);
}

// Icon sets name the glyph in a class (lucide-x, fa-trash, bi-gear, ti-copy, icon-close) or an attribute.
const ICON_CLASS = /(?:^|\s)(?:lucide|fa|fas|far|bi|ti|tabler-icon|icon|ri|mdi|heroicon|feather)-([a-z][a-z0-9-]*)/i;
const ICON_NOISE = /^(?:icon|lg|sm|xs|xl|\d+x|fw|solid|regular|light|outline|filled|fill|line|spin|inline)$/i;

/** The icon a control shows, from its own markup or a few levels into it: an svg's <title>, an image's alt, an icon class, a sprite's id. */
function iconName(index: NodeIndex, n: SNode): string | undefined {
  let seen = 0;
  let found: string | undefined;
  const walk = (m: SNode, depth: number) => {
    if (found || depth > 4 || ++seen > 40) return;
    if (m.type === NodeType.Element) {
      if (m.tagName === "title" && depth > 0) found = index.text(m, 40) || undefined;
      found ??= m !== n ? (attr(m, "aria-label") ?? (m.tagName === "img" ? attr(m, "alt") : undefined)) : undefined;
      found ??= attr(m, "data-icon") ?? attr(m, "data-lucide");
      const cls = ICON_CLASS.exec(attr(m, "class") ?? "")?.[1];
      if (!found && cls && !ICON_NOISE.test(cls)) found = `${cls.replace(/-/g, " ")} icon`;
      const sprite = m.tagName === "use" ? (attr(m, "href") ?? attr(m, "xlink:href")) : undefined;
      if (!found && sprite) found = `${sprite.replace(/^.*#/, "").replace(/^(?:icon|i)[-_]/, "").replace(/[-_]+/g, " ")} icon`;
    }
    for (const c of m.childNodes ?? []) walk(c, depth + 1);
  };
  walk(n, 0);
  return found?.trim() || undefined;
}

/** How much of a text-derived click label is kept (a whole card's text names it by its start). */
const CLICK_LABEL_PHRASE = 60;

/** A short phrase, cut at a word near `max`. */
function shortPhrase(s: string, max = 40): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max / 2 ? cut.slice(0, at) : s.slice(0, max)).trim()}…`;
}

/**
 * Where an unnamed control sits: the nearest container a few levels up that
 * says something (its aria-label or title, else its readable text), as a
 * short phrase. The SDK's privacy rules hold: readableText answers "" for a
 * container that holds a field.
 */
function containerContext(index: NodeIndex, n: SNode): string | undefined {
  for (let p = index.parent(n.id), depth = 0; p && depth < 6; p = index.parent(p.id), depth++) {
    if (p.tagName === "body" || p.tagName === "html") return undefined;
    const named = attr(p, "aria-label") ?? attr(p, "title") ?? labelledBy(index, p);
    if (named) return shortPhrase(named);
    const text = index.readableText(p);
    if (text) return shortPhrase(text);
    // A container holding a field (a form, a dialog with inputs) has no readable text; its heading still names it.
    const heading = headingIn(index, p);
    if (heading) return shortPhrase(heading);
  }
  return undefined;
}

/** The text of the element an aria-labelledby points at (a dialog's title). */
function labelledBy(index: NodeIndex, n: SNode): string | undefined {
  const ids = attr(n, "aria-labelledby");
  if (!ids) return undefined;
  for (const id of ids.split(/\s+/)) {
    const el = index.byId(id);
    const text = el ? index.readableText(el) : "";
    if (text) return text;
  }
  return undefined;
}

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "legend", "caption"]);

/** The first heading a few levels into a container, read only if it holds no field. */
function headingIn(index: NodeIndex, root: SNode): string | undefined {
  let seen = 0;
  let found: string | undefined;
  const walk = (m: SNode, depth: number) => {
    if (found || depth > 4 || ++seen > 80) return;
    if (m !== root && m.type === NodeType.Element && (HEADING_TAGS.has(m.tagName ?? "") || attr(m, "role") === "heading")) {
      found = index.readableText(m) || undefined;
      if (found) return;
    }
    for (const c of m.childNodes ?? []) walk(c, depth + 1);
  };
  walk(root, 0);
  return found;
}

/** What a click on a control with no name and no text touched, for a person to read: "x icon in Release this call". */
function clickContext(index: NodeIndex, n: SNode): string | undefined {
  const icon = iconName(index, n);
  const where = containerContext(index, n);
  const out = [icon, where ? `in ${where}` : undefined].filter(Boolean).join(" ");
  return out ? clipTo(out, REPLAY_LIMITS.label_max_chars) : undefined;
}

function cssSelector(n: SNode): string {
  const tag = n.tagName ?? "*";
  const testId = attr(n, "data-testid") ?? attr(n, "data-test-id");
  if (testId) return `[data-testid=${JSON.stringify(testId)}]`;
  const id = attr(n, "id");
  if (id && /^[A-Za-z][\w-]*$/.test(id)) return `${tag}#${id}`;
  const name = attr(n, "name");
  if (name) return `${tag}[name=${JSON.stringify(name)}]`;
  const classes = (attr(n, "class") ?? "").split(/\s+/).filter((c) => /^[A-Za-z][\w-]*$/.test(c)).slice(0, 2);
  return (classes.length ? `${tag}.${classes.join(".")}` : tag).slice(0, REPLAY_LIMITS.selector_max_chars);
}

const clipTo = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

/** rrweb's console plugin stringifies each argument, so a string arrives quoted. */
function consoleText(args: unknown): string {
  const parts = Array.isArray(args) ? args : [args];
  return parts
    .map((p) => {
      if (typeof p !== "string") return JSON.stringify(p) ?? "";
      try {
        const parsed = JSON.parse(p);
        return typeof parsed === "string" ? parsed : p;
      } catch {
        return p;
      }
    })
    .join(" ")
    .slice(0, REPLAY_LIMITS.console_message_max_chars);
}

function consoleLevel(level: unknown): ReplayConsoleLevel | undefined {
  if (level === "error" || level === "assert") return "error";
  if (level === "warn" || level === "warning") return "warn";
  return undefined;
}

/** One request from rrweb's network plugin (url, status, startTime/endTime) or PostHog's (name, responseStatus, duration). */
function networkEvent(r: any, t: number, pageUrl?: string): ReplayEvent | undefined {
  if (!r || typeof r !== "object") return undefined;
  // posthog-js lists each Server-Timing metric of a response beside it
  // (entryType "serverTiming", named like "cfEdge" or "total", no status): a
  // performance entry that is not a resource or a navigation is no request.
  if (typeof r.entryType === "string" && r.entryType !== "resource" && r.entryType !== "navigation") return undefined;
  const url = typeof r.url === "string" ? r.url : typeof r.name === "string" ? r.name : undefined;
  if (!url) return undefined;
  const statusRaw = r.status ?? r.responseStatus ?? r.response?.status;
  const status = typeof statusRaw === "number" ? statusRaw : 0;
  // A request lasts until its response ends. A performance entry's duration
  // means that for a resource but runs to loadEventEnd for a navigation, the
  // whole page's load.
  const start = typeof r.startTime === "number" ? r.startTime : undefined;
  const msRaw = start !== undefined && typeof r.responseEnd === "number" && r.responseEnd > 0 ? r.responseEnd - start
    : typeof r.duration === "number" ? r.duration
    : start !== undefined && typeof r.endTime === "number" ? r.endTime - start : 0;
  const method = typeof r.method === "string" ? r.method.toUpperCase() : "GET";
  // A resource with no status that PostHog reports from the performance API is
  // not a failure: the browser hides cross-origin statuses. Only a fetch or
  // xhr with no status may be.
  const initiator = typeof r.initiatorType === "string" ? r.initiatorType : undefined;
  if (status === 0 && initiator && initiator !== "fetch" && initiator !== "xmlhttprequest") return undefined;
  // A browser without PerformanceResourceTiming.responseStatus (Safari) leaves
  // the field off every entry, so a missing field says nothing. Such a fetch
  // failed only when its detailed timings are visible (same origin, or
  // Timing-Allow-Origin: requestStart is set) and show no response arrived;
  // a cross-origin entry zeroes them all and cannot be judged.
  if (statusRaw === undefined && r.entryType !== undefined) {
    const answered = [r.responseStart, r.transferSize, r.encodedBodySize, r.decodedBodySize].some((n) => typeof n === "number" && n > 0);
    if (answered || !(typeof r.requestStart === "number" && r.requestStart > 0)) return undefined;
  }
  const e: ReplayEvent = { type: "network", t, method, url: cleanUrl(url, pageUrl), status, ms: Math.max(0, Math.round(msRaw)) };
  return isFailedRequest(e) || isSlowRequest(e) ? e : undefined;
}

/**
 * Where a conversion stopped, so the next part of the same recording converts
 * as if it had been read in one pass: the clock's zero, the page as the
 * snapshots and mutations left it, and the page's address and height. A long
 * vendor recording is imported part by part (sources/posthog.ts), each part
 * in its own action, with this carried between them.
 */
export interface RrwebConverterState {
  t0: number;
  root: SNode | null;
  page_url?: string;
  viewport: number;
  last_scroll_at: number;
}

/** Convert an rrweb recording (PostHog's or Sentry's) into replay events, oldest first, `t` relative to the first event. */
export function fromRrweb(input: readonly RrwebEvent[]): ReplayEvent[] {
  return fromRrwebPart(input).events;
}

/**
 * Convert one part of a recording. Without `state`, the part is the start: its
 * first event is the clock's zero. With it, the part continues where the state
 * left off, on the same clock. Answers the events and where this part stopped.
 */
export function fromRrwebPart(input: readonly RrwebEvent[], state?: RrwebConverterState | null): { events: ReplayEvent[]; state: RrwebConverterState | null } {
  const raw = [...input].filter((e) => e && typeof e.type === "number" && typeof e.timestamp === "number").sort((a, b) => a.timestamp - b.timestamp);
  if (!raw.length) return { events: [], state: state ?? null };
  const t0 = state?.t0 ?? raw[0].timestamp;
  const index = new NodeIndex();
  if (state?.root) index.add(state.root);
  const out: ReplayEvent[] = [];
  let lastScrollAt = state?.last_scroll_at ?? -Infinity;
  let viewport = state?.viewport ?? 0;
  let pendingTitle: Extract<ReplayEvent, { type: "nav" }> | undefined;
  let pageUrl: string | undefined = state?.page_url;

  for (const ev of raw) {
    const t = ev.timestamp - t0;
    const d = ev.data ?? {};
    switch (ev.type) {
      case EventType.Meta: {
        if (typeof d.href !== "string") break;
        viewport = typeof d.height === "number" ? d.height : viewport;
        pageUrl = d.href;
        const nav: ReplayEvent = { type: "nav", t, url: cleanUrl(d.href) };
        out.push(nav);
        pendingTitle = nav;
        break;
      }
      case EventType.FullSnapshot: {
        index.reset();
        if (d.node) index.add(d.node);
        const title = index.title();
        if (pendingTitle && title) pendingTitle.title = clipTo(title, REPLAY_LIMITS.label_max_chars);
        pendingTitle = undefined;
        break;
      }
      case EventType.IncrementalSnapshot: {
        if (d.source === Source.Mutation) {
          // rrweb applies removes, then adds, then text and attribute changes.
          for (const r of Array.isArray(d.removes) ? d.removes : []) if (typeof r?.id === "number") index.remove(r.id, r.parentId);
          for (const a of Array.isArray(d.adds) ? d.adds : []) if (a?.node) index.add(a.node, a.parentId, a.nextId);
          for (const x of Array.isArray(d.texts) ? d.texts : []) if (typeof x?.id === "number") index.setText(x.id, x.value);
          for (const x of Array.isArray(d.attributes) ? d.attributes : []) if (typeof x?.id === "number") index.setAttributes(x.id, x.attributes);
        } else if (d.source === Source.MouseInteraction && d.type === MouseClick && typeof d.id === "number") {
          const n = interactiveTarget(index, d.id);
          const at = typeof d.x === "number" && typeof d.y === "number" && d.x >= 0 && d.y >= 0 ? { x: Math.round(d.x), y: Math.round(d.y) } : {};
          if (!n) {
            out.push({ type: "click", t, label: "", selector: `[rrweb-id=${d.id}]`, ...at });
            break;
          }
          // A card or a page region clicked as a whole names itself by all of its text: keep the start of it.
          const name = clipTo(accessibleName(index, n), REPLAY_LIMITS.label_max_chars);
          const label = shortPhrase(name, CLICK_LABEL_PHRASE);
          const text = index.readableText(n);
          const role = implicitRole(n);
          const context = label || text ? undefined : clickContext(index, n);
          out.push({
            type: "click",
            t,
            label,
            ...(role ? { role } : {}),
            selector: cssSelector(n),
            ...(text && text !== label && !name.startsWith(text.slice(0, REPLAY_LIMITS.label_max_chars)) ? { text: clipTo(text, REPLAY_LIMITS.label_max_chars) } : {}),
            ...(context ? { context } : {}),
            ...at,
          });
        } else if (d.source === Source.Input && typeof d.id === "number") {
          const n = index.get(d.id);
          const length = typeof d.text === "string" ? d.text.length : 0;
          // A checkbox or radio toggle arrives as an input with isChecked; it is
          // also a click, which the mouse interaction already recorded.
          if (typeof d.isChecked === "boolean" && n && /checkbox|radio/.test(attr(n, "type") ?? "")) break;
          out.push({
            type: "input",
            t,
            label: n ? clipTo(accessibleName(index, n), REPLAY_LIMITS.label_max_chars) : "",
            selector: n ? cssSelector(n) : `[rrweb-id=${d.id}]`,
            length,
            redacted: true,
          });
        } else if (d.source === Source.Scroll && typeof d.y === "number") {
          if (t - lastScrollAt < REPLAY_LIMITS.scroll_min_interval_ms) break;
          lastScrollAt = t;
          out.push({ type: "scroll", t, y: Math.round(d.y), of: Math.round(d.y + viewport) });
        }
        break;
      }
      case EventType.Plugin: {
        const plugin = d.plugin;
        const payload = d.payload ?? {};
        if (plugin === "rrweb/console@1") {
          const level = consoleLevel(payload.level);
          const line: ReplayEvent | undefined = level ? { type: "console", t, level, message: consoleText(payload.payload) } : undefined;
          if (line && !isRecorderNoise(line)) out.push(line);
        } else if (plugin === "rrweb/network@1") {
          for (const r of Array.isArray(payload.requests) ? payload.requests : []) {
            const n = networkEvent(r, t, pageUrl);
            if (n) out.push(n);
          }
        }
        break;
      }
      case EventType.Custom: {
        // Sentry's replay SDK writes breadcrumbs and performance spans as custom events.
        const payload = d.payload ?? {};
        if (d.tag === "breadcrumb" && payload.category === "console") {
          const level = consoleLevel(payload.level);
          const line: ReplayEvent | undefined = level ? { type: "console", t, level, message: consoleText(payload.message ?? payload.data?.arguments) } : undefined;
          if (line && !isRecorderNoise(line)) out.push(line);
        } else if (d.tag === "performanceSpan" && /^resource\.(fetch|xhr)$/.test(payload.op ?? "")) {
          const ms = typeof payload.endTimestamp === "number" && typeof payload.startTimestamp === "number" ? (payload.endTimestamp - payload.startTimestamp) * 1000 : 0;
          const n = networkEvent({ url: payload.description, method: payload.data?.method, status: payload.data?.statusCode, duration: ms, initiatorType: "fetch" }, t, pageUrl);
          if (n) out.push(n);
        }
        break;
      }
    }
  }
  const next: RrwebConverterState = { t0, root: index.root, viewport, last_scroll_at: Number.isFinite(lastScrollAt) ? lastScrollAt : -1e15, ...(pageUrl ? { page_url: pageUrl } : {}) };
  return { events: sortReplayEvents(out), state: next };
}
