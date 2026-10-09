// A vendor's rrweb capture, made fit to keep (docs/architecture/external-data.md
// X5, "Playing a replay"). The semantic stream never holds what a person typed
// or anything a page marked private; the DOM capture kept beside it for the
// player follows the same rule, so storing the page does not store more than
// the stream already refused to. PostHog and Sentry mask by their own
// settings at record time, which a customer may have loosened; this holds the
// line whatever they recorded with:
//
//   - an input event's text becomes stars of the same length
//   - a field's value attribute (input, textarea, select, option) the same,
//     in snapshots, added nodes and attribute mutations
//   - a textarea's text, and every text node under [data-private], an
//     editable region (contenteditable) or rrweb's own .rr-block / .ph-no-capture,
//     becomes stars, in snapshots, added nodes and text mutations
//   - a Meta event's href keeps its query keys but not their values (cleanUrl)
//
// Stars keep each string's length, so layout replays the way it looked.
// Events are changed in place: a capture is tens of MB, and a copy would
// double what an import holds in memory.
import { cleanUrl } from "../contracts/replay";
import { replayCaptureProblem } from "../contracts/replayPlayer";
import type { RrwebEvent } from "./rrweb";

const EventType = { FullSnapshot: 2, IncrementalSnapshot: 3, Meta: 4 } as const;
const Source = { Mutation: 0, Input: 5 } as const;
const NodeType = { Element: 2, Text: 3, CDATA: 4, Comment: 5 } as const;

const FIELD_TAGS = new Set(["input", "textarea", "select", "option"]);
const PRIVATE_CLASSES = ["rr-block", "rr-mask", "ph-no-capture", "sentry-block", "sentry-mask"];

const stars = (s: unknown) => (typeof s === "string" ? "*".repeat(s.length) : s);

function isPrivateElement(n: any): boolean {
  const a = n?.attributes;
  if (!a || typeof a !== "object") return false;
  if (a["data-private"] !== undefined && a["data-private"] !== null && a["data-private"] !== "false") return true;
  const editable = a.contenteditable;
  if (editable !== undefined && editable !== null && editable !== "false") return true;
  const cls = typeof a.class === "string" ? a.class.split(/\s+/) : [];
  return PRIVATE_CLASSES.some((c) => cls.includes(c));
}

class Scrubber {
  /** Text nodes whose text is never kept (under a private element or in a textarea). */
  private privateText = new Set<number>();
  /** Elements whose subtree is private, so nodes added under them later are too. */
  private privateParents = new Set<number>();
  /** Field elements, whose value attribute is masked when it changes. */
  private fields = new Set<number>();
  /** Textareas, whose text children are values. */
  private textareas = new Set<number>();

  reset() {
    this.privateText.clear();
    this.privateParents.clear();
    this.fields.clear();
    this.textareas.clear();
  }

  /** Walk a serialized node (a snapshot's tree, or an added node), masking as it goes. */
  node(n: any, inPrivate: boolean, inTextarea: boolean) {
    if (!n || typeof n !== "object") return;
    const id = typeof n.id === "number" ? n.id : undefined;
    if (n.type === NodeType.Element) {
      const tag = typeof n.tagName === "string" ? n.tagName.toLowerCase() : "";
      const priv = inPrivate || isPrivateElement(n);
      if (priv && id !== undefined) this.privateParents.add(id);
      if (FIELD_TAGS.has(tag)) {
        if (id !== undefined) this.fields.add(id);
        if (n.attributes && typeof n.attributes === "object" && "value" in n.attributes) n.attributes.value = stars(n.attributes.value);
      }
      if (tag === "textarea" && id !== undefined) this.textareas.add(id);
      for (const c of Array.isArray(n.childNodes) ? n.childNodes : []) this.node(c, priv, tag === "textarea");
      return;
    }
    if (n.type === NodeType.Text || n.type === NodeType.CDATA || n.type === NodeType.Comment) {
      if (inPrivate || inTextarea) {
        n.textContent = stars(n.textContent);
        if (id !== undefined) this.privateText.add(id);
      }
      return;
    }
    for (const c of Array.isArray(n.childNodes) ? n.childNodes : []) this.node(c, inPrivate, inTextarea);
  }

  mutation(d: any) {
    for (const add of Array.isArray(d.adds) ? d.adds : []) {
      const parent = typeof add?.parentId === "number" ? add.parentId : -1;
      this.node(add?.node, this.privateParents.has(parent), this.textareas.has(parent));
    }
    for (const t of Array.isArray(d.texts) ? d.texts : []) {
      if (t && this.privateText.has(t.id)) t.value = stars(t.value);
    }
    for (const a of Array.isArray(d.attributes) ? d.attributes : []) {
      if (!a || typeof a.attributes !== "object" || !a.attributes) continue;
      if ("value" in a.attributes && (this.fields.has(a.id) || this.privateParents.has(a.id))) a.attributes.value = stars(a.attributes.value);
    }
  }
}

/**
 * The capture as it is stored: valid events only, in time order, masked by
 * the rules above. The events themselves are masked in place; the array
 * returned is a new one.
 */
export function prepareDomCapture(input: readonly RrwebEvent[]): RrwebEvent[] {
  const events = input.filter((e) => e && typeof e === "object" && typeof e.type === "number" && typeof e.timestamp === "number" && Number.isFinite(e.timestamp));
  events.sort((a, b) => a.timestamp - b.timestamp);
  const s = new Scrubber();
  for (const e of events) {
    const d = e.data;
    if (!d || typeof d !== "object") continue;
    if (e.type === EventType.Meta && typeof d.href === "string") d.href = cleanUrl(d.href);
    else if (e.type === EventType.FullSnapshot) {
      s.reset();
      s.node(d.node, false, false);
    } else if (e.type === EventType.IncrementalSnapshot) {
      if (d.source === Source.Input && "text" in d) d.text = stars(d.text);
      else if (d.source === Source.Mutation) s.mutation(d);
    }
  }
  return events;
}

/** Whether a capture can be played at all: rrweb needs a full snapshot of a document to draw anything. */
export function domCapturePlayable(events: readonly RrwebEvent[]): boolean {
  return replayCaptureProblem(events) === null;
}
