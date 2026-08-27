import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { NodeType } from "@tiptap/pm/model";
import {
  parseEntityUrl,
  parsePublishedPageUrl,
  MENTION_ID_SOURCE,
  entityTypeFromId,
  isConvexId,
} from "../../lib/entityLinks";
import { EntityRefNodeView } from "./EntityRefNodeView";

/**
 * Edit-mode twin of the read-mode entity rendering (EntityAwareLink in
 * EntityIdPill.tsx): object references authored as markdown — a
 * `[label](https://codecast.sh/…)` link, a pasted app URL, or an
 * `@[Title id]` mention — render as the SAME rich pills the read view shows,
 * instead of plain underlined links and literal text.
 *
 * Mechanically: an appendTransaction plugin converts those text shapes into
 * `entityRef` atom nodes; the node view renders EntityIdPill /
 * PublishedPagePill. Serialization is the contract that makes this safe —
 * every form writes back the exact markdown it came from:
 *
 *   form "link"    → `[label](href)` (or the bare href when the label IS the
 *                    href, so autolinked URLs keep their form)
 *   form "mention" → `@[label refId]`
 *
 * Both the client serializer (below, for copy/compose) and the server's
 * doc.content deriver (convex/docSync.ts toMarkdown) know these forms — a new
 * form here needs the matching case there.
 */

// `@[Title id]` with a REQUIRED entity id. Deliberately narrower than the
// shared entityMentionRegex(): that one also swallows an optional trailing
// `(…)` parenthetical, which is fine for display but would DELETE the
// parenthetical from the doc when we serialize the node back. Editing must
// never alter text it didn't render, so we match only the bracketed core.
function mentionWithIdRegex(): RegExp {
  return new RegExp(`@\\[([^\\]]*?)\\s+(${MENTION_ID_SOURCE})\\]`, "g");
}

/** An id we can actually render a pill for (label: mentions stay text). */
function isPillableRef(id: string): boolean {
  if (/^label:/i.test(id)) return false;
  return /^doc:/i.test(id) || !!entityTypeFromId(id) || isConvexId(id);
}

/** True when this href renders as a rich pill (entity page or published page). */
export function isPillableHref(href: string | null | undefined): boolean {
  return !!(parseEntityUrl(href) || parsePublishedPageUrl(href));
}

/**
 * Build a transaction converting pillable references — entity/published-page
 * links and `@[Title id]` mentions — into entityRef atoms. `cursorPos` (when
 * given) protects the reference under the cursor; pass null for the initial
 * whole-document pass on editor creation.
 */
function buildConversionTr(
  state: EditorState,
  refType: NodeType,
  cursorPos: number | null,
): Transaction | null {
  const replacements: {
    from: number;
    to: number;
    attrs: Record<string, unknown>;
    // Defaults to the entityRef type; a date mention rebuilds its own node.
    nodeType?: NodeType;
  }[] = [];

  state.doc.descendants((node, pos, parent, index) => {
    if (!node.isText || !node.text) return;
    // Never rewrite code: block or inline. Read mode has the same rule.
    if (parent?.type.spec.code) return;
    if (node.marks.some((m) => m.type.name === "code")) return;

    const linkMark = node.marks.find((m) => m.type.name === "link");
    if (linkMark) {
      const href: string | undefined = linkMark.attrs?.href;
      if (!href || !isPillableHref(href)) return;
      // A link whose text spans several nodes (partly bold, say) would pill
      // only a fragment — leave those as plain links.
      if (parent && index != null) {
        const prev = index > 0 ? parent.child(index - 1) : null;
        const next = index < parent.childCount - 1 ? parent.child(index + 1) : null;
        if ((prev && linkMark.isInSet(prev.marks)) || (next && linkMark.isInSet(next.marks))) return;
      }
      replacements.push({
        from: pos,
        to: pos + node.text.length,
        attrs: { form: "link", href, label: node.text, refId: null },
      });
      return;
    }

    const re = mentionWithIdRegex();
    let match;
    while ((match = re.exec(node.text)) !== null) {
      // `@[<label> date:<iso>]` is a serialized date pill, not an object ref —
      // rebuild the dateMention node so it round-trips to the same rich pill
      // it was written as (schema lookup: editors without DateMentionExtension
      // leave the text alone).
      const dateIso = match[2].match(/^date:(\d{4}-\d{2}-\d{2})$/i)?.[1];
      if (dateIso) {
        const dateType = state.schema.nodes.dateMention;
        if (dateType) {
          replacements.push({
            from: pos + match.index,
            to: pos + match.index + match[0].length,
            attrs: { id: dateIso, label: match[1].trim() || dateIso, type: "date", dateValue: dateIso },
            nodeType: dateType,
          });
        }
        continue;
      }
      if (!isPillableRef(match[2])) continue;
      replacements.push({
        from: pos + match.index,
        to: pos + match.index + match[0].length,
        attrs: { form: "mention", href: null, label: match[1].trim(), refId: match[2] },
      });
    }
  });

  const eligible =
    cursorPos == null
      ? replacements
      : replacements.filter((r) => cursorPos < r.from || cursorPos > r.to);
  if (eligible.length === 0) return null;

  const tr = state.tr;
  for (let i = eligible.length - 1; i >= 0; i--) {
    const { from, to, attrs, nodeType } = eligible[i];
    tr.replaceWith(from, to, (nodeType ?? refType).create(attrs));
  }
  return tr;
}

export const EntityRefExtension = Node.create({
  name: "entityRef",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      // "link" | "mention" — which markdown form this node round-trips to.
      form: { default: "link" },
      href: { default: null },
      label: { default: "" },
      refId: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-entity-ref]",
        getAttrs: (el: HTMLElement) => ({
          form: el.getAttribute("data-form") || "link",
          href: el.getAttribute("data-href") || null,
          label: el.getAttribute("data-label") || el.textContent || "",
          refId: el.getAttribute("data-ref-id") || null,
        }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const { form, href, label, refId } = node.attrs;
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-entity-ref": "",
        "data-form": form,
        ...(href ? { "data-href": href } : {}),
        ...(refId ? { "data-ref-id": refId } : {}),
        "data-label": label ?? "",
      }),
      label || refId || href || "",
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(EntityRefNodeView);
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.write(serializeEntityRef(node.attrs));
        },
        parse: {},
      },
    };
  },

  // The initial whole-document pass — loading content dispatches no
  // transaction, so appendTransaction alone leaves a freshly opened doc
  // unconverted until the first keystroke.
  onCreate() {
    const tr = buildConversionTr(this.editor.state, this.type, null);
    if (tr) this.editor.view.dispatch(tr);
  },

  addProseMirrorPlugins() {
    const refType = this.type;
    return [
      new Plugin({
        key: new PluginKey("entityRefAutoConvert"),
        appendTransaction(transactions, _oldState, newState) {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          return buildConversionTr(newState, refType, newState.selection.$head.pos);
        },
      }),
    ];
  },
});

/** The exact markdown an entityRef writes back — shared shape with the server
 *  serializer in convex/docSync.ts (which cannot import web code). */
export function serializeEntityRef(attrs: {
  form?: string;
  href?: string | null;
  label?: string | null;
  refId?: string | null;
}): string {
  if (attrs.form === "mention") return `@[${attrs.label} ${attrs.refId}]`;
  const href = attrs.href || "";
  if (!attrs.label || attrs.label === href) return href;
  return `[${attrs.label}](${href})`;
}
