// Live preview: the note renders itself while you edit it, and the raw syntax
// comes back only where the cursor is.
//
// This is a pure VIEW layer. Every construct is a decoration over bytes that
// are never touched, which is the same promise source mode makes and the reason
// CodeMirror was chosen over a rich-text model in the first place
// (.claude/vault-drive/library-decisions.md #3). `state.doc.toString()` is
// identical with the extension on and off; the test suite asserts exactly that.
//
// Architecture follows blueberrycongee/codemirror-live-markdown's design note —
// a ViewPlugin recomputing decorations from the syntax tree on doc / selection /
// viewport change, with `shouldShowSource` becoming the reveal predicate — with
// two departures:
//
//  * The judgment lives in `livePreviewScan.ts` as plain data, so it can be
//    tested without a browser. That file is where the rules are; this one is
//    the machinery that draws them.
//  * Markers are hidden with `Decoration.replace` plus `EditorView.atomicRanges`
//    rather than a CSS collapse. Collapsing to `max-width: 0` leaves the hidden
//    characters as real cursor stops, which is precisely the "arrow key does
//    nothing" bug; an atomic range makes a marker one traversal step, the same
//    effect Obsidian gets from its zero-width-space padding.
//
// The vault's own syntax (wiki links, tags) reuses the reading view's regexes,
// so `.wiki-link` and `.vault-tag` here are the same classes, resolved the same
// way, as the rendered note.

import { Facet, StateEffect, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { parseWikiInner, type WikiLinkParts } from "./remarkWikiLink";
import {
  scanLivePreview,
  type LiveScanDeps,
  type LiveSpan,
  type LiveWidget,
} from "./livePreviewScan";

export type { LiveSpan, LiveWidget } from "./livePreviewScan";
export { scanLivePreview } from "./livePreviewScan";

/** Everything live preview needs from the app: how a link resolves, where an
 *  asset lives, and what a click on a rendered thing should do. */
export interface LivePreviewContext extends LiveScanDeps {
  /** Follow a wiki link. `newTab` is a Cmd/Ctrl-click. */
  openWikiLink?: (parts: WikiLinkParts, newTab: boolean) => void;
  /** Click on a tag pill. */
  openTag?: (tag: string) => void;
  /** Click on a plain markdown link's text. */
  openHref?: (href: string, newTab: boolean) => void;
}

/** Dispatch this to re-decorate when nothing in the document changed but the
 *  answers did — a new note appearing turns a dangling link live. */
export const refreshLivePreview = StateEffect.define<null>();

const contextFacet = Facet.define<LivePreviewContext, LivePreviewContext>({
  combine: (values) => values[0] ?? {},
});

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-live-bullet";
    span.textContent = "•";
    return span;
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-live-rule";
    return span;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }
  // Same src = same widget: recreating the node would restart the load and
  // flash the image on every unrelated keystroke.
  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt;
  }
  toDOM(view: EditorView) {
    const img = document.createElement("img");
    img.className = "cm-live-image";
    img.src = this.src;
    img.alt = this.alt;
    // The height arrives after the layout was measured; ask for a re-measure so
    // scroll position and the viewport stay honest.
    img.addEventListener("load", () => view.requestMeasure(), { once: true });
    return img;
  }
}

function widgetFor(spec: LiveWidget): WidgetType {
  switch (spec.type) {
    case "bullet":
      return new BulletWidget();
    case "rule":
      return new RuleWidget();
    case "image":
      return new ImageWidget(spec.src, spec.alt);
  }
}

// ---------------------------------------------------------------------------
// Spans → decorations
// ---------------------------------------------------------------------------

export interface LiveDecorations {
  decorations: DecorationSet;
  /** The replaced ranges, handed to `EditorView.atomicRanges` so the cursor
   *  crosses each in one keypress instead of stopping inside something it
   *  can't see. */
  atomic: DecorationSet;
}

/** Build both sets from already-scanned spans. Separate from the scan so tests
 *  can assert on either representation.
 *
 *  Both sets are built with `Decoration.set(…, true)` rather than a
 *  RangeSetBuilder: emphasis nests (`***x***` is a strong node wrapping an
 *  emphasis node), so spans genuinely overlap and arrive in an order no single
 *  comparison of mine would get right — sorting by position AND side is exactly
 *  what that flag does. */
export function decorationsFromSpans(spans: readonly LiveSpan[]): LiveDecorations {
  const hidden = Decoration.replace({});
  const all = [];
  const atomic = [];

  for (const span of spans) {
    switch (span.kind) {
      case "line":
        all.push(Decoration.line({ class: span.class }).range(span.from));
        break;
      case "mark":
        all.push(
          Decoration.mark({ class: span.class, attributes: span.attrs }).range(span.from, span.to),
        );
        break;
      case "hide": {
        const range = hidden.range(span.from, span.to);
        all.push(range);
        atomic.push(range);
        break;
      }
      case "widget": {
        const range = Decoration.replace({ widget: widgetFor(span.widget) }).range(
          span.from,
          span.to,
        );
        all.push(range);
        atomic.push(range);
        break;
      }
    }
  }

  return { decorations: Decoration.set(all, true), atomic: Decoration.set(atomic, true) };
}

function build(view: EditorView): LiveDecorations {
  const ctx = view.state.facet(contextFacet);
  return decorationsFromSpans(scanLivePreview(view.state, view.visibleRanges, ctx));
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    atomic: DecorationSet;

    constructor(view: EditorView) {
      const built = build(view);
      this.decorations = built.decorations;
      this.atomic = built.atomic;
    }

    update(update: ViewUpdate) {
      // Deliberately NOT on every update: focus changes, measurements and
      // geometry updates all arrive here, and re-walking the syntax tree on
      // each one is how a live-preview editor gets slow.
      const forced = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(refreshLivePreview)),
      );
      if (!update.docChanged && !update.selectionSet && !update.viewportChanged && !forced) return;
      const built = build(update.view);
      this.decorations = built.decorations;
      this.atomic = built.atomic;
    }
  },
  { decorations: (v) => v.decorations },
);

// ---------------------------------------------------------------------------
// Clicks on rendered things
// ---------------------------------------------------------------------------

/** A rendered link is a link: clicking it goes there instead of dropping a
 *  cursor into text the reader can't even see. Handled on mousedown and with
 *  the default prevented, because by mouseup CodeMirror has already moved the
 *  selection — which would reveal the raw syntax under the pointer and make the
 *  click feel like it misfired. Clicking anything else is a normal click. */
function clickHandlers(): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || event.shiftKey || event.altKey) return false;
      const target = event.target as HTMLElement | null;
      const el = target?.closest?.("[data-live-wiki], [data-live-tag], [data-live-href]");
      if (!el || !view.contentDOM.contains(el)) return false;
      const ctx = view.state.facet(contextFacet);
      const newTab = event.metaKey || event.ctrlKey;

      const wiki = el.getAttribute("data-live-wiki");
      if (wiki) {
        const parts = parseWikiInner(wiki);
        if (!parts || !ctx.openWikiLink) return false;
        event.preventDefault();
        ctx.openWikiLink(parts, newTab);
        return true;
      }
      const tag = el.getAttribute("data-live-tag");
      if (tag) {
        if (!ctx.openTag) return false;
        event.preventDefault();
        ctx.openTag(tag);
        return true;
      }
      const href = el.getAttribute("data-live-href");
      if (href) {
        if (!ctx.openHref) return false;
        event.preventDefault();
        ctx.openHref(href, newTab);
        return true;
      }
      return false;
    },
  });
}

// ---------------------------------------------------------------------------
// The extension
// ---------------------------------------------------------------------------

export function livePreview(ctx: LivePreviewContext = {}): Extension {
  return [
    contextFacet.of(ctx),
    livePreviewPlugin,
    EditorView.atomicRanges.of(
      (view) => view.plugin(livePreviewPlugin)?.atomic ?? Decoration.none,
    ),
    // Scopes the CSS in globals.css, where the vault's own tokens live, so
    // `.wiki-link` and `.vault-tag` are literally the reading view's rules.
    EditorView.editorAttributes.of({ class: "cm-live" }),
    clickHandlers(),
  ];
}

export default livePreview;
