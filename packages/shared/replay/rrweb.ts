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
import { isFailedRequest, isSlowRequest, sortReplayEvents } from "./events";

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

interface SNode {
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

  reset() {
    this.nodes.clear();
    this.parents.clear();
    this.labelsFor.clear();
  }

  add(node: SNode, parentId?: number) {
    if (!node || typeof node.id !== "number") return;
    this.nodes.set(node.id, node);
    if (parentId !== undefined) this.parents.set(node.id, parentId);
    if (node.tagName === "label" && typeof node.attributes?.for === "string") this.labelsFor.set(node.attributes.for, node.id);
    for (const child of node.childNodes ?? []) this.add(child, node.id);
  }

  get(id: number) {
    return this.nodes.get(id);
  }

  parent(id: number) {
    const p = this.parents.get(id);
    return p === undefined ? undefined : this.nodes.get(p);
  }

  text(node: SNode | undefined, max = REPLAY_LIMITS.label_max_chars): string {
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
  const msRaw = typeof r.duration === "number" ? r.duration : typeof r.endTime === "number" && typeof r.startTime === "number" ? r.endTime - r.startTime : 0;
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

/** Convert an rrweb recording (PostHog's or Sentry's) into replay events, oldest first, `t` relative to the first event. */
export function fromRrweb(input: readonly RrwebEvent[]): ReplayEvent[] {
  const raw = [...input].filter((e) => e && typeof e.type === "number" && typeof e.timestamp === "number").sort((a, b) => a.timestamp - b.timestamp);
  if (!raw.length) return [];
  const t0 = raw[0].timestamp;
  const index = new NodeIndex();
  const out: ReplayEvent[] = [];
  let lastScrollAt = -Infinity;
  let viewport = 0;
  let pendingTitle: Extract<ReplayEvent, { type: "nav" }> | undefined;
  let pageUrl: string | undefined;

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
          for (const a of Array.isArray(d.adds) ? d.adds : []) if (a?.node) index.add(a.node, a.parentId);
        } else if (d.source === Source.MouseInteraction && d.type === MouseClick && typeof d.id === "number") {
          const n = interactiveTarget(index, d.id);
          if (!n) {
            out.push({ type: "click", t, label: "", selector: `[rrweb-id=${d.id}]` });
            break;
          }
          const label = clipTo(accessibleName(index, n), REPLAY_LIMITS.label_max_chars);
          const text = index.readableText(n);
          const role = implicitRole(n);
          out.push({
            type: "click",
            t,
            label,
            ...(role ? { role } : {}),
            selector: cssSelector(n),
            ...(text && text !== label ? { text: clipTo(text, REPLAY_LIMITS.label_max_chars) } : {}),
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
          if (level) out.push({ type: "console", t, level, message: consoleText(payload.payload) });
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
          if (level) out.push({ type: "console", t, level, message: consoleText(payload.message ?? payload.data?.arguments) });
        } else if (d.tag === "performanceSpan" && /^resource\.(fetch|xhr)$/.test(payload.op ?? "")) {
          const ms = typeof payload.endTimestamp === "number" && typeof payload.startTimestamp === "number" ? (payload.endTimestamp - payload.startTimestamp) * 1000 : 0;
          const n = networkEvent({ url: payload.description, method: payload.data?.method, status: payload.data?.statusCode, duration: ms, initiatorType: "fetch" }, t, pageUrl);
          if (n) out.push(n);
        }
        break;
      }
    }
  }
  return sortReplayEvents(out);
}
