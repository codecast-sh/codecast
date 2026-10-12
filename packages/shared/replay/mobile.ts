// PostHog mobile recordings as an rrweb page (docs/architecture/external-data.md
// X5, "Playing a replay"). PostHog's iOS, Android, React Native and Flutter
// SDKs do not record a DOM. Each screen arrives as "wireframes": an rrweb-like
// stream whose full snapshot carries `data.wireframes`, a tree of boxes with
// absolute x/y/width/height, a type (text, image, screenshot, rectangle, div,
// input, radio_group, web_view, placeholder, status_bar, navigation_bar), a
// small style object and base64 images. Later screens arrive as mutations
// whose `adds` and `updates` carry wireframes instead of DOM nodes.
//
// This turns such a recording into an ordinary rrweb capture of a simple page
// (every box an absolutely positioned element, text as text, images as data
// URIs), so the player, the frame renderer, the semantic converter (fromRrweb)
// and the masking (prepareDomCapture) read it unchanged. Ported from PostHog's
// own mobile transformer (common/replay-shared/src/mobile/transformer in
// github.com/PostHog/posthog, MIT, outside its ee/ directory), with these
// differences:
//
//   - every wireframe id is remapped into one sequence the converter owns, so
//     a synthetic node (a text node, an option) can never take a real view's id
//   - style values are checked before they reach a style attribute: a color
//     or font that could close the declaration, or a background image that is
//     not a data URI, is dropped, so a recording cannot make the replayed page
//     fetch anything
//   - a tap (a touch start and end close in place and time) also becomes an
//     rrweb click on the box under the finger, so the timeline names what was
//     tapped; the touches themselves are kept for the player
//   - rrweb seeks from the last Meta event before a moment, assuming a full
//     snapshot follows each one (a web recorder's checkout always does); a
//     mobile SDK sends a Meta at each screen change alone, so the converter
//     draws the current screen as a full snapshot right after it
//   - each screen's visible text is read off the wireframes as an outline
//     (`views`), the way our recorder outlines a page: at a full snapshot, a
//     screen change, before a tap and before an error, and otherwise at most
//     every few seconds while the screen changes. A field's value is never in it.
//
// Masking stays prepareDomCapture's: an input's value becomes a value
// attribute on an input, textarea or select, which it stars like any other.
import type { RrwebEvent } from "./rrweb";
import { REPLAY_LIMITS } from "../contracts/replay";

const EventType = { FullSnapshot: 2, IncrementalSnapshot: 3, Meta: 4, Custom: 5, Plugin: 6 } as const;
const Source = { Mutation: 0, MouseInteraction: 2 } as const;
const Touch = { Start: 7, End: 9 } as const;
const MouseClick = 2;
const NodeType = { Document: 0, DocumentType: 1, Element: 2, Text: 3 } as const;

// Fixed nodes of the page every mobile capture becomes.
const DOCUMENT_ID = 1;
const DOCTYPE_ID = 2;
const HTML_ID = 3;
const HEAD_ID = 4;
export const MOBILE_BODY_ID = 5;
const NAV_BAR_PARENT_ID = 7;
const KEYBOARD_PARENT_ID = 9;
const KEYBOARD_ID = 10;
const STATUS_BAR_PARENT_ID = 11;
const FIRST_FREE_ID = 100;
/** Where each kind of system bar is drawn, above the app. */
const BAR_SLOTS: Record<string, number> = { status_bar: STATUS_BAR_PARENT_ID, navigation_bar: NAV_BAR_PARENT_ID };

const PLACEHOLDER_BG = "#f3f4ef";
const PLACEHOLDER_FG = "#35373e";

/** A tap: the finger came up this close to where it went down, this soon. */
const TAP_MAX_MS = 1_000;
const TAP_MAX_MOVE = 12;
/** How often a screen that keeps changing is outlined again. */
const VIEW_MIN_INTERVAL_MS = 5_000;

type Wireframe = Record<string, any> & { id?: unknown; type?: unknown; childWireframes?: unknown };
type SNode = Record<string, any> & { id: number; type: number };

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const num = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
const kids = (w: Wireframe): Wireframe[] => (Array.isArray(w.childWireframes) ? w.childWireframes.filter(isObj) : []);

/** Whether a recording is PostHog's mobile wireframe format rather than a DOM capture. */
export function isMobileCapture(events: readonly RrwebEvent[]): boolean {
  for (const e of events) {
    const d = e?.data;
    if (!isObj(d)) continue;
    if (e.type === EventType.FullSnapshot) {
      if (Array.isArray(d.wireframes)) return true;
      if (isObj(d.node)) return false;
    } else if (e.type === EventType.IncrementalSnapshot && d.source === Source.Mutation) {
      const first = (Array.isArray(d.adds) && d.adds[0]) || (Array.isArray(d.updates) && d.updates[0]);
      if (isObj(first) && isObj(first.wireframe)) return true;
    }
  }
  return false;
}

// ── Styles ──────────────────────────────────────────────────────────────────

// A value that stays one CSS value: no `;`, braces, quotes that open a url(), or backslashes.
const SAFE_COLOR = /^[#\w(),.%\s-]{1,64}$/;
const SAFE_FONT = /^[\w\s,'"-]{1,120}$/;

function px(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return `${v}px`;
  if (typeof v === "string" && /^-?\d+(\.\d+)?(px)?$/.test(v.trim())) return `${v.trim().replace(/px$/, "")}px`;
  return undefined;
}
const color = (v: unknown) => (typeof v === "string" && SAFE_COLOR.test(v) && !/url\s*\(/i.test(v) ? v : undefined);

/** A base64 image as a data URI; PNG when the SDK sent bare base64. Anything that is not an image is dropped. */
export function imageDataUri(src: unknown): string | undefined {
  if (typeof src !== "string" || !src) return undefined;
  const s = src.replace(/\s+/g, "");
  if (s.startsWith("data:")) return /^data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+$/.test(s) ? s : undefined;
  return /^[A-Za-z0-9+/=]+$/.test(s) ? `data:image/png;base64,${s}` : undefined;
}

interface StyleOpts {
  /** Leave colors and borders off (a labelled checkbox's input). */
  bare?: boolean;
  /** Pin to the bottom of the screen instead of x/y (the keyboard). */
  bottom?: boolean;
  defaults?: { backgroundColor?: string; color?: string };
  center?: boolean;
}

function styleOf(w: Wireframe, opts: StyleOpts = {}): string {
  const s = isObj(w.style) ? w.style : {};
  const out: string[] = ["position:fixed"];
  if (w.width === "100vw") out.push("width:100vw");
  else if (px(w.width)) out.push(`width:${px(w.width)}`);
  if (px(w.height)) out.push(`height:${px(w.height)}`);
  if (opts.bottom) out.push("bottom:0", "left:0");
  else out.push(`left:${px(w.x) ?? "0px"}`, `top:${px(w.y) ?? "0px"}`);
  if (!opts.bare) {
    const bg = color(s.backgroundColor) ?? opts.defaults?.backgroundColor;
    if (bg) out.push(`background-color:${bg}`);
    const img = imageDataUri(s.backgroundImage);
    if (img) out.push(`background-image:url('${img}')`, `background-size:${["contain", "cover", "auto"].includes(s.backgroundSize) ? s.backgroundSize : "contain"}`, "background-repeat:no-repeat");
    const fg = color(s.color) ?? opts.defaults?.color;
    if (fg) out.push(`color:${fg}`);
    // A radius alone rounds the box; only a width or a color draws a border.
    if (px(s.borderRadius)) out.push(`border-radius:${px(s.borderRadius)}`);
    const bw = px(s.borderWidth), bc = color(s.borderColor);
    if (bw || bc) out.push(`border-width:${bw ?? "1px"}`, `border-color:${bc ?? "currentColor"}`, "border-style:solid");
  }
  const v = opts.center ? "center" : s.verticalAlign;
  const h = opts.center ? "center" : s.horizontalAlign;
  const align: Record<string, string> = { top: "flex-start", left: "flex-start", center: "center", bottom: "flex-end", right: "flex-end" };
  if (align[v] || align[h]) {
    out.push("display:flex");
    if (align[v]) out.push(`align-items:${align[v]}`);
    if (align[h]) out.push(`justify-content:${align[h]}`);
  }
  for (const side of ["Left", "Right", "Top", "Bottom"] as const) {
    const p = px(s[`padding${side}`]);
    if (p) out.push(`padding-${side.toLowerCase()}:${p}`);
  }
  if (px(s.fontSize)) out.push(`font-size:${px(s.fontSize)}`);
  // An app's font is rarely installed where the frame is drawn ("System" is React Native's own name), so it falls back to the platform's sans.
  if (typeof s.fontFamily === "string" && SAFE_FONT.test(s.fontFamily)) out.push(`font-family:${s.fontFamily},-apple-system,system-ui,Roboto,sans-serif`);
  return `${out.join(";")};`;
}

const RESET_CSS = [
  "html,body{margin:0;height:100vh;width:100vw;overflow:hidden;font-family:-apple-system,system-ui,Roboto,sans-serif;}",
  "*{box-sizing:border-box;}",
  "input,button,select,textarea{font:inherit;margin:0;padding:0;border:0;outline:0;background:transparent;}",
  "img{border-style:none;}",
].join("\n");

// ── The converter ───────────────────────────────────────────────────────────

class MobileConverter {
  private ids = new Map<number, number>();
  private next = FIRST_FREE_ID;
  /** The screen as the wireframes now describe it, for hit tests and outlines. */
  private roots: Wireframe[] = [];
  private byId = new Map<number, Wireframe>();
  private parentOf = new Map<number, number>();

  fresh(): number {
    return this.next++;
  }

  /** Our id for a wireframe's id; a box with no usable id gets a fresh one. */
  idFor(raw: unknown): number {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return this.fresh();
    let id = this.ids.get(raw);
    if (id === undefined) {
      id = this.fresh();
      this.ids.set(raw, id);
    }
    return id;
  }

  /** Our id for a wireframe id another event names (a parent, a removal, a touch), or undefined if none was seen. */
  known(raw: unknown): number | undefined {
    return typeof raw === "number" ? this.ids.get(raw) : undefined;
  }

  // ── wireframes to nodes ──

  private el(id: number, tagName: string, attributes: Record<string, unknown>, childNodes: SNode[] = []): SNode {
    return { type: NodeType.Element, id, tagName, attributes, childNodes };
  }

  private text(textContent: string): SNode {
    return { type: NodeType.Text, id: this.fresh(), textContent };
  }

  private placeholder(w: Wireframe, id: number, label: string, children: SNode[]): SNode {
    return this.el(id, "div", { style: `${styleOf(w, { center: true, defaults: { backgroundColor: PLACEHOLDER_BG, color: PLACEHOLDER_FG } })}overflow:hidden;` }, [this.text(label), ...children]);
  }

  private input(w: Wireframe, id: number, children: SNode[]): SNode {
    const kind = typeof w.inputType === "string" ? w.inputType : "text";
    const value = typeof w.value === "string" ? w.value : typeof w.value === "number" ? String(w.value) : "";
    const disabled = w.disabled === true ? { disabled: true } : {};
    switch (kind) {
      case "button":
        return this.el(id, "button", { style: styleOf(w), ...disabled }, [...(value ? [this.text(value)] : []), ...children]);
      case "select": {
        const options = Array.isArray(w.options) ? w.options.filter((o: unknown): o is string => typeof o === "string") : [];
        return this.el(id, "select", { style: styleOf(w), value, ...disabled }, [
          ...options.map((o: string) => this.el(this.fresh(), "option", o === value ? { selected: true } : {}, [this.text(o)])),
          ...children,
        ]);
      }
      case "text_area":
        return this.el(id, "textarea", { style: styleOf(w), value, ...disabled }, children);
      case "progress": {
        const max = num(w.max);
        const v = num(w.value);
        return this.el(id, "progress", { style: styleOf(w), ...(v !== undefined ? { value: String(v) } : {}), ...(max !== undefined ? { max: String(max) } : {}) }, children);
      }
      case "checkbox":
      case "radio":
      case "toggle": {
        // The wireframe's id always names the outermost node drawn, so a later update or removal takes the label with it.
        const labelled = typeof w.label === "string";
        const box = this.el(labelled ? this.fresh() : id, "input", { type: kind === "radio" ? "radio" : "checkbox", ...(w.checked === true ? { checked: true } : {}), ...disabled }, children);
        if (!labelled) {
          box.attributes.style = styleOf(w);
          return box;
        }
        const label = this.text(w.label);
        return this.el(id, "label", { style: `${styleOf(w)}display:flex;align-items:center;gap:4px;` }, kind === "toggle" ? [label, box] : [box, label]);
      }
      default: {
        const type = ["text", "password", "email", "number", "search", "tel", "url"].includes(kind) ? kind : "text";
        return this.el(id, "input", { style: styleOf(w), type, value, ...disabled }, children);
      }
    }
  }

  /** One wireframe and its children as a serialized node tree, or null for something that is not a box. */
  node(w: Wireframe): SNode | null {
    if (!isObj(w)) return null;
    const id = this.idFor(w.id);
    const children = kids(w).map((c) => this.node(c)).filter((n): n is SNode => !!n);
    const type = typeof w.type === "string" ? w.type : "div";
    switch (type) {
      case "text":
        return this.el(id, "div", { style: `${styleOf(w)}overflow:hidden;white-space:normal;` }, [...(typeof w.text === "string" ? [this.text(w.text)] : []), ...children]);
      case "image":
      case "screenshot": {
        const src = imageDataUri(w.base64);
        if (!src) return this.placeholder(w, id, type, children);
        return this.el(id, "img", { src, style: styleOf(w), ...(type === "screenshot" ? { "data-screenshot": "true" } : {}) }, children);
      }
      case "input":
        return this.input(w, id, children);
      case "web_view":
        return this.placeholder(w, id, "web view", children);
      case "placeholder":
        return this.placeholder(w, id, typeof w.label === "string" && w.label ? w.label : "placeholder", children);
      default:
        // rectangle, div, radio_group, status_bar, navigation_bar and any type a newer SDK adds.
        return this.el(id, "div", { style: `${styleOf(w)}overflow:hidden;white-space:nowrap;` }, children);
    }
  }

  // ── the screen model ──

  private track(w: Wireframe, parent: number | undefined) {
    if (!isObj(w)) return;
    const id = this.idFor(w.id);
    this.byId.set(id, w);
    if (parent !== undefined) this.parentOf.set(id, parent);
    for (const c of kids(w)) this.track(c, id);
  }

  private untrack(id: number) {
    const w = this.byId.get(id);
    if (!w) return;
    for (const c of kids(w)) {
      const cid = this.known(c.id);
      if (cid !== undefined) this.untrack(cid);
    }
    this.byId.delete(id);
    const parent = this.parentOf.get(id);
    this.parentOf.delete(id);
    if (parent === undefined) this.roots = this.roots.filter((r) => r !== w);
    else {
      const p = this.byId.get(parent);
      if (p && Array.isArray(p.childWireframes)) p.childWireframes = p.childWireframes.filter((c: Wireframe) => c !== w);
    }
  }

  private place(w: Wireframe, parent: number | undefined) {
    const p = parent === undefined ? undefined : this.byId.get(parent);
    if (p) p.childWireframes = [...kids(p), w];
    else this.roots.push(w);
    this.track(w, p ? parent : undefined);
  }

  /** A full snapshot: the whole page, and the screen model starts over. */
  full(e: RrwebEvent): RrwebEvent {
    const wireframes: Wireframe[] = (e.data.wireframes as unknown[]).filter(isObj);
    this.roots = [];
    this.byId.clear();
    this.parentOf.clear();
    this.bars.clear();
    for (const w of wireframes) {
      const kept = this.liftBars(w, (bar, slot) => void (this.bars.has(slot) || this.bars.set(slot, bar)));
      if (kept) this.place(kept, undefined);
    }
    this.drawn = true;
    return this.snapshot(e.timestamp);
  }

  /**
   * The status and navigation bars are lifted out of the tree into their own
   * slots, so they stack above the app. Returns the wireframe without them
   * (undefined when it is itself a bar) and hands each bar found to onBar.
   */
  private liftBars(w: Wireframe, onBar: (bar: Wireframe, slot: number) => void): Wireframe | undefined {
    const slot = BAR_SLOTS[String(w.type)];
    if (slot !== undefined) return void onBar(w, slot);
    const children = kids(w).map((c) => this.liftBars(c, onBar)).filter((c): c is Wireframe => !!c);
    return { ...w, childWireframes: children };
  }

  /** The bar slot a drawn wireframe id sits in, if it is a bar. */
  private barSlotOf(id: number): number | undefined {
    for (const [slot, bar] of this.bars) if (this.known(bar.id) === id) return slot;
    return undefined;
  }

  /** Whether a full snapshot has been seen, so the screen model can be drawn again. */
  drawn = false;
  /** The bar wireframe drawn in each bar slot (STATUS_BAR_PARENT_ID, NAV_BAR_PARENT_ID). */
  private bars = new Map<number, Wireframe>();
  private keyboardOpen: Record<string, any> | undefined;

  /** The screen as the model now holds it, as a full rrweb snapshot. */
  snapshot(timestamp: number): RrwebEvent {
    const bar = (id: number, w: Wireframe | undefined) => this.el(id, "div", {}, w ? [this.node(w)].filter((n): n is SNode => !!n) : []);
    const body = this.el(MOBILE_BODY_ID, "body", {}, [
      ...this.roots.map((w) => this.node(w)).filter((n): n is SNode => !!n),
      this.el(KEYBOARD_PARENT_ID, "div", {}, this.keyboardOpen ? [this.keyboardBox(this.keyboardOpen)] : []),
      bar(NAV_BAR_PARENT_ID, this.bars.get(NAV_BAR_PARENT_ID)),
      bar(STATUS_BAR_PARENT_ID, this.bars.get(STATUS_BAR_PARENT_ID)),
    ]);
    const head = this.el(HEAD_ID, "head", {}, [this.el(this.fresh(), "style", { type: "text/css" }, [this.text(RESET_CSS)])]);
    return {
      type: EventType.FullSnapshot,
      timestamp,
      data: {
        node: { type: NodeType.Document, id: DOCUMENT_ID, childNodes: [{ type: NodeType.DocumentType, id: DOCTYPE_ID, name: "html", publicId: "", systemId: "" }, this.el(HTML_ID, "html", {}, [head, body])] },
        initialOffset: { top: 0, left: 0 },
      },
    };
  }

  /** rrweb adds one node per mutation (it skips children), so a tree is added parent first. */
  private flatten(node: SNode, parentId: number, out: Map<number, any>) {
    const { childNodes, ...rest } = node;
    out.delete(node.id);
    out.set(node.id, { parentId, nextId: null, node: Array.isArray(childNodes) ? { ...rest, childNodes: [] } : rest });
    for (const c of Array.isArray(childNodes) ? childNodes : []) this.flatten(c, node.id, out);
  }

  private parentFor(w: Wireframe, raw: unknown): number {
    if (w.type === "screenshot") return MOBILE_BODY_ID;
    return this.known(raw) ?? MOBILE_BODY_ID;
  }

  /**
   * A wireframe mutation in our ids: a removal names the node's drawn parent,
   * an update is a removal and an add, adds are flattened nodes, and a bar
   * replaces the one in its slot. Ids the converter never drew are dropped.
   */
  mutation(e: RrwebEvent): RrwebEvent {
    const d = isObj(e.data) ? e.data : {};
    const removes: { parentId: number; id: number }[] = [];
    const adds = new Map<number, any>();
    const remove = (id: number) => {
      const slot = this.barSlotOf(id);
      if (slot !== undefined) this.bars.delete(slot);
      else if (!this.byId.has(id)) return;
      removes.push({ parentId: slot ?? this.parentOf.get(id) ?? MOBILE_BODY_ID, id });
      this.untrack(id);
    };
    for (const r of Array.isArray(d.removes) ? d.removes : []) {
      const id = this.known(r?.id);
      if (id !== undefined) remove(id);
    }
    const setBar = (bar: Wireframe, slot: number) => {
      const prev = this.bars.get(slot);
      const prevId = prev === undefined ? undefined : this.known(prev.id);
      if (prevId !== undefined) remove(prevId);
      const node = this.node(bar);
      if (!node) return;
      this.bars.set(slot, bar);
      this.flatten(node, slot, adds);
    };
    const apply = (m: any, update: boolean) => {
      if (!isObj(m) || !isObj(m.wireframe)) return;
      const parent = this.parentFor(m.wireframe, m.parentId);
      if (update) {
        const old = this.known(m.wireframe.id);
        if (old !== undefined) remove(old);
      }
      const w = this.liftBars(m.wireframe, setBar);
      if (!w) return;
      const node = this.node(w);
      if (!node) return;
      this.place(w, parent === MOBILE_BODY_ID ? undefined : parent);
      this.flatten(node, parent, adds);
    };
    for (const m of Array.isArray(d.adds) ? d.adds : []) apply(m, false);
    for (const m of Array.isArray(d.updates) ? d.updates : []) apply(m, true);
    return { type: EventType.IncrementalSnapshot, timestamp: e.timestamp, data: { source: Source.Mutation, texts: [], attributes: [], removes, adds: [...adds.values()] } };
  }

  private keyboardBox(p: Record<string, any>): SNode {
    const positioned = num(p.x) !== undefined || num(p.y) !== undefined;
    const box = this.placeholder({ x: p.x, y: p.y, width: num(p.width) ?? "100vw", height: num(p.height) ?? 0, style: {} }, KEYBOARD_ID, "keyboard", []);
    if (!positioned) box.attributes.style = styleOf({ width: num(p.width) ?? "100vw", height: num(p.height) ?? 0 }, { bottom: true, center: true, defaults: { backgroundColor: PLACEHOLDER_BG, color: PLACEHOLDER_FG } });
    return box;
  }

  /** The keyboard showing or hiding, as a box at the bottom of the screen. */
  keyboard(e: RrwebEvent): RrwebEvent {
    const p = isObj(e.data?.payload) ? e.data.payload : {};
    const removes = this.keyboardOpen ? [{ parentId: KEYBOARD_PARENT_ID, id: KEYBOARD_ID }] : [];
    const adds = new Map<number, any>();
    this.keyboardOpen = p.open ? p : undefined;
    if (this.keyboardOpen) this.flatten(this.keyboardBox(p), KEYBOARD_PARENT_ID, adds);
    return { type: EventType.IncrementalSnapshot, timestamp: e.timestamp, data: { source: Source.Mutation, texts: [], attributes: [], removes, adds: [...adds.values()] } };
  }

  /** The topmost, deepest box under a point, as our id. */
  hit(x: number, y: number): number | undefined {
    const inside = (w: Wireframe) => {
      const wx = num(w.x) ?? 0, wy = num(w.y) ?? 0, ww = num(w.width) ?? 0, wh = num(w.height) ?? 0;
      return x >= wx && y >= wy && x <= wx + ww && y <= wy + wh;
    };
    const walk = (list: Wireframe[]): Wireframe | undefined => {
      for (let i = list.length - 1; i >= 0; i--) {
        const w = list[i];
        if (!inside(w)) continue;
        return walk(kids(w)) ?? w;
      }
      return undefined;
    };
    const w = walk(this.roots);
    return w ? this.known(w.id) : undefined;
  }

  /** The screen's visible text, the way our recorder outlines a page. Never a field's value. */
  outline(): string {
    const lines: string[] = [];
    let size = 0;
    const push = (line: string) => {
      const l = line.replace(/\s+/g, " ").trim();
      if (!l || lines[lines.length - 1] === l || size > REPLAY_LIMITS.view_outline_max_chars) return;
      lines.push(l);
      size += l.length + 1;
    };
    const walk = (w: Wireframe) => {
      if (!((num(w.width) ?? 1) > 0 && (num(w.height) ?? 1) > 0)) return;
      if (w.type === "text" && typeof w.text === "string") push(w.text);
      else if (w.type === "input") {
        const label = typeof w.label === "string" ? w.label : "";
        if (w.inputType === "button" && typeof w.value === "string") push(`[button] ${w.value}`);
        else if (w.inputType === "checkbox" || w.inputType === "radio" || w.inputType === "toggle") push(`[${w.inputType}${w.checked ? " on" : ""}] ${label}`);
        else if (w.inputType !== "progress") push(`[field] ${label}`);
      } else if (w.type === "web_view") push("[web view]");
      else if (w.type === "placeholder" && typeof w.label === "string") push(`[${w.label}]`);
      for (const c of kids(w)) walk(c);
    };
    for (const w of this.roots) walk(w);
    return lines.join("\n").slice(0, REPLAY_LIMITS.view_outline_max_chars);
  }
}

/** Whether a wireframe full snapshot comes right after this event, before anything that changes the screen. */
function nextIsSnapshot(events: readonly RrwebEvent[], at: number): boolean {
  for (let i = at + 1; i < events.length; i++) {
    const e = events[i];
    if (e.type === EventType.FullSnapshot) return Array.isArray(e.data?.wireframes);
    if (e.type === EventType.IncrementalSnapshot || e.type === EventType.Meta || (e.type === EventType.Custom && e.data?.tag === "keyboard")) return false;
  }
  return false;
}

export interface MobileConversion {
  /** The recording as an rrweb capture of a plain page, valid events only, in time order. */
  events: RrwebEvent[];
  /** Each screen's visible text, at the epoch ms it was read. */
  views: { timestamp: number; outline: string }[];
}

/** Convert a PostHog mobile (wireframe) recording into an rrweb DOM capture. Events the page needs no change for pass through as they are. */
export function fromMobileWireframes(input: readonly RrwebEvent[]): MobileConversion {
  const raw = input.filter((e) => e && typeof e === "object" && typeof e.type === "number" && typeof e.timestamp === "number" && Number.isFinite(e.timestamp));
  raw.sort((a, b) => a.timestamp - b.timestamp);
  const c = new MobileConverter();
  const events: RrwebEvent[] = [];
  const views: MobileConversion["views"] = [];
  let lastView: { timestamp: number; outline: string } | undefined;
  let dirtyAt: number | undefined;
  /** A screen change (Meta) since the last outline: the next screen is outlined as soon as it draws. */
  let newScreen = false;
  let touch: { x: number; y: number; t: number } | undefined;

  const view = (timestamp: number, force: boolean) => {
    if (dirtyAt === undefined) return;
    if (!force && lastView && timestamp - lastView.timestamp < VIEW_MIN_INTERVAL_MS) return;
    const outline = c.outline();
    dirtyAt = undefined;
    newScreen = false;
    if (!outline || outline === lastView?.outline) return;
    lastView = { timestamp, outline };
    views.push(lastView);
  };

  for (let i = 0; i < raw.length; i++) {
    const e = raw[i];
    const d = isObj(e.data) ? e.data : undefined;
    if (e.type === EventType.FullSnapshot && d && Array.isArray(d.wireframes)) {
      events.push(c.full(e));
      dirtyAt = e.timestamp;
      view(e.timestamp, true);
    } else if (e.type === EventType.IncrementalSnapshot && d?.source === Source.Mutation) {
      // Every mutation goes through the converter, removals-only included: its ids are wireframe ids, which would name the wrong node of the drawn page.
      events.push(c.mutation(e));
      dirtyAt = e.timestamp;
      view(e.timestamp, newScreen);
    } else if (e.type === EventType.Custom && d?.tag === "keyboard") {
      events.push(c.keyboard(e));
    } else if (e.type === EventType.IncrementalSnapshot && d?.source === Source.MouseInteraction) {
      const x = num(d.x), y = num(d.y);
      const target = c.known(d.id) ?? (x !== undefined && y !== undefined ? c.hit(x, y) : undefined) ?? MOBILE_BODY_ID;
      events.push({ ...e, data: { ...d, id: target } });
      if (d.type === Touch.Start && x !== undefined && y !== undefined) {
        touch = { x, y, t: e.timestamp };
        view(e.timestamp, true);
      } else if (d.type === Touch.End && touch && x !== undefined && y !== undefined) {
        if (e.timestamp - touch.t <= TAP_MAX_MS && Math.hypot(x - touch.x, y - touch.y) <= TAP_MAX_MOVE) {
          events.push({ type: EventType.IncrementalSnapshot, timestamp: e.timestamp, data: { source: Source.MouseInteraction, type: MouseClick, id: c.hit(touch.x, touch.y) ?? MOBILE_BODY_ID, x: touch.x, y: touch.y } });
        }
        touch = undefined;
      }
    } else if (e.type === EventType.Meta) {
      view(e.timestamp, true);
      newScreen = true;
      events.push(e);
      // rrweb seeks from the last Meta at or before a moment and drops
      // everything earlier, because a web recorder always follows a Meta with
      // a full snapshot. A mobile SDK sends a Meta at each screen change with
      // no snapshot after it, so the converter draws the screen again here.
      if (c.drawn && !nextIsSnapshot(raw, i)) events.push(c.snapshot(e.timestamp));
    } else {
      if (e.type === EventType.Plugin && d?.plugin === "rrweb/console@1" && /error|assert/.test(String(d.payload?.level))) view(e.timestamp, true);
      events.push(e);
    }
  }
  if (dirtyAt !== undefined) view(dirtyAt, true);
  return { events, views };
}
