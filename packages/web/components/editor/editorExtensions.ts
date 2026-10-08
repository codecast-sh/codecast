import { ReactRenderer, ReactNodeViewRenderer } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Node } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Mention from "@tiptap/extension-mention";
import Typography from "@tiptap/extension-typography";
import Highlight from "@tiptap/extension-highlight";
import ImageExtension from "@tiptap/extension-image";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { Markdown } from "tiptap-markdown";
import { common, createLowlight } from "lowlight";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import { MentionList, type MentionItem } from "./MentionList";
import { MentionNodeView } from "./MentionNodeView";
import { CodeBlockNodeView } from "./CodeBlockNodeView";
import { SlashCommandExtension } from "./SlashCommandExtension";
import { DateMentionExtension } from "./DateMentionExtension";
import { TabIndentExtension } from "./TabIndentExtension";
import { ImageUploadPlaceholder } from "./ImageUploadPlugin";
import { DocTitleExtension, TitleFirstDocument } from "./DocTitleExtension";
import { DRAFTING_MARKS } from "./DraftingExtension";
import { splitOnImagePlaceholders } from "../../lib/imagePlaceholder";
import { identityLine } from "../../lib/sessionIdentity";
import { personifyAllNow } from "../../hooks/usePersonifyAll";

const lowlight = createLowlight(common);

export type MentionQueryFn = (query: string) => Promise<MentionItem[]>;

export const MENTION_ROUTE_MAP: Record<string, string> = {
  person: "/team",
  task: "/tasks",
  doc: "/docs",
  session: "/conversation",
  plan: "/plans",
  label: "/inbox", // labels have no page of their own; they live in the sessions panel
};

export const MENTION_COLOR_MAP: Record<string, string> = {
  person: "mention-person",
  task: "mention-task",
  doc: "mention-doc",
  session: "mention-session",
  plan: "mention-plan",
  label: "mention-label",
};

/** What a picked mention reads as: a session that wears a character or a role
 *  is named as that person, everything else keeps its own label. */
function mentionLabel(item: MentionItem): string {
  if (item.type !== "session" || !item.identity) return item.label;
  return identityLine(item.identity, item.label, personifyAllNow()).name ?? item.label;
}

export function createMentionSuggestion(queryFn: MentionQueryFn) {
  return {
    allowSpaces: true,
    items: async ({ query }: { query: string }) => {
      return queryFn(query);
    },
    render: () => {
      let component: ReactRenderer<any> | null = null;
      let popup: TippyInstance[] | null = null;

      return {
        onStart: (props: any) => {
          component = new ReactRenderer(MentionList, {
            props,
            editor: props.editor,
          });
          if (!props.clientRect) return;
          popup = tippy("body", {
            getReferenceClientRect: props.clientRect,
            appendTo: () => document.body,
            content: component.element,
            showOnCreate: true,
            interactive: true,
            trigger: "manual",
            placement: "bottom-start",
            zIndex: 10002,
          });
        },
        onUpdate(props: any) {
          component?.updateProps(props);
          if (popup?.[0] && props.clientRect) {
            popup[0].setProps({ getReferenceClientRect: props.clientRect });
          }
        },
        onKeyDown(props: any) {
          if (props.event.key === "Escape") {
            popup?.[0]?.hide();
            return true;
          }
          return component?.ref?.onKeyDown(props) ?? false;
        },
        onExit() {
          popup?.[0]?.destroy();
          component?.destroy();
        },
      };
    },
  };
}

/** True when the link at `index` is one text node whose text IS its href: a
 *  URL typed or pasted bare. Same rule as serializeEntityRef. */
function isBareUrlLink(mark: any, parent: any, index: number): boolean {
  if (mark.attrs.title) return false;
  const node = parent.child(index);
  if (!node.isText || node.text !== mark.attrs.href) return false;
  const next = index + 1 < parent.childCount ? parent.child(index + 1) : null;
  return !(next && mark.isInSet(next.marks));
}

/**
 * Links, with the markdown contract every editor shares: a bare URL in a body
 * (a task description, a doc, a plan) parses as a link, and writes back as the
 * same bare URL rather than `<url>` or `[url](url)`. Only text with a scheme
 * links: fuzzy matching would turn `deploy.sh` and `README.md` into sites.
 */
const MarkdownLink = Link.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize: {
          open(state: any, mark: any, parent: any, index: number) {
            state.inAutolink = isBareUrlLink(mark, parent, index);
            return state.inAutolink ? "" : "[";
          },
          close(state: any, mark: any) {
            const bare = state.inAutolink;
            state.inAutolink = undefined;
            if (bare) return "";
            const title = mark.attrs.title ? ` "${String(mark.attrs.title).replace(/"/g, '\\"')}"` : "";
            return `](${String(mark.attrs.href).replace(/[()"]/g, "\\$&")}${title})`;
          },
          mixable: true,
        },
        parse: {
          setup(md: any) {
            md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });
          },
        },
      },
    };
  },
});

/**
 * Text, writing `[Image N]` attachment tokens back verbatim. The default
 * serializer escapes the brackets, and the agent then gets `\[Image 1\]`
 * instead of a reference to the image it was sent.
 */
const MarkdownText = Node.create({
  name: "text",
  group: "inline",
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          splitOnImagePlaceholders(node.text).forEach((part, i) => {
            if (part) state.text(i % 2 ? part : part.replace(/</g, "&lt;").replace(/>/g, "&gt;"), i % 2 === 0);
          });
        },
        parse: {},
      },
    };
  },
});

export function createBaseExtensions(opts: {
  placeholder?: string;
  withTables?: boolean;
  /**
   * Title-first document (see DocTitleExtension): the first block is the
   * title, a required level 1 heading. `fallbackTitle` is the stored title,
   * written in when a body opens without one.
   */
  titleFirst?: { fallbackTitle: () => string };
}) {
  const bodyPlaceholder = opts.placeholder || "Start writing...";
  const exts: any[] = [
    StarterKit.configure({
      codeBlock: false,
      heading: { levels: [1, 2, 3] },
      link: false,
      text: false,
      ...(opts.titleFirst ? { document: false } : {}),
    }),
    ...(opts.titleFirst
      ? [
          TitleFirstDocument,
          DocTitleExtension.configure({ fallbackTitle: opts.titleFirst.fallbackTitle }),
          // The title block always reads "Untitled" while empty (not only when
          // focused); the body hint sits on the first paragraph below it —
          // editor.css scopes which empty blocks show theirs.
          Placeholder.configure({
            showOnlyCurrent: false,
            placeholder: ({ pos }) => (pos === 0 ? "Untitled" : bodyPlaceholder),
          }),
        ]
      : [Placeholder.configure({ placeholder: bodyPlaceholder })]),
    MarkdownText,
    MarkdownLink.configure({
      openOnClick: true,
      HTMLAttributes: { class: "editor-link" },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    SlashCommandExtension,
    Typography,
    Highlight.configure({ HTMLAttributes: { class: "editor-highlight" } }),
    ImageExtension.configure({ HTMLAttributes: { class: "editor-image" } }),
    CodeBlockLowlight.extend({
      addNodeView() {
        return ReactNodeViewRenderer(CodeBlockNodeView);
      },
    }).configure({ lowlight }),
    Markdown.configure({
      html: true,
      linkify: true,
      transformPastedText: true,
      transformCopiedText: true,
    }) as any,
    DateMentionExtension,
    TabIndentExtension,
    ImageUploadPlaceholder,
    // Drafting markup (alternatives, ghosts, Lab flags) is part of a doc's
    // text; every editor keeps it, the doc page's adds the behaviour.
    ...DRAFTING_MARKS,
  ];

  if (opts.withTables !== false) {
    exts.push(
      Table.configure({ resizable: false }),
      TableRow,
      TableCell,
      TableHeader,
    );
  }

  return exts;
}

export function createMentionExtension(onMentionQuery: MentionQueryFn) {
  return Mention.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        type: { default: "doc" },
        sublabel: { default: null },
        shortId: { default: null },
        status: { default: null },
        priority: { default: null },
        docType: { default: null },
        messageCount: { default: null },
        projectPath: { default: null },
        image: { default: null },
        goal: { default: null },
        model: { default: null },
        agentType: { default: null },
        updatedAt: { default: null },
        idleSummary: { default: null },
      };
    },
    parseHTML() {
      return [
        {
          tag: "a.editor-mention",
          getAttrs: (el: HTMLElement) => ({
            id: el.getAttribute("data-mention-id"),
            type: el.getAttribute("data-mention-type") || "doc",
            label: el.textContent?.replace(/^@/, "") || "",
            shortId: el.getAttribute("data-short-id") || null,
            status: el.getAttribute("data-status") || null,
            priority: el.getAttribute("data-priority") || null,
            docType: el.getAttribute("data-doc-type") || null,
            messageCount: el.getAttribute("data-message-count") ? Number(el.getAttribute("data-message-count")) : null,
            projectPath: el.getAttribute("data-project-path") || null,
            image: el.getAttribute("data-image") || null,
            goal: el.getAttribute("data-goal") || null,
            model: el.getAttribute("data-model") || null,
            agentType: el.getAttribute("data-agent-type") || null,
            updatedAt: el.getAttribute("data-updated-at") ? Number(el.getAttribute("data-updated-at")) : null,
            idleSummary: el.getAttribute("data-idle-summary") || null,
          }),
        },
        ...(this.parent?.() || []),
      ];
    },
    addNodeView() {
      return ReactNodeViewRenderer(MentionNodeView);
    },
  }).configure({
    HTMLAttributes: { class: "editor-mention" },
    suggestion: {
      ...createMentionSuggestion(onMentionQuery),
      command: ({ editor: e, range, props: item }: any) => {
        e.chain()
          .focus()
          .insertContentAt(range, [
            {
              type: "mention",
              attrs: {
                id: item.id,
                // A personified session is named as its character, the same
                // words the composer's own dropdown writes (S3). The node view
                // draws the live pill either way; this is the fallback text.
                label: mentionLabel(item),
                type: item.type,
                shortId: item.shortId || null,
                status: item.status || null,
                priority: item.priority || null,
                docType: item.docType || null,
                messageCount: item.messageCount ?? null,
                projectPath: item.projectPath || null,
                image: item.image || null,
                goal: item.goal || null,
                model: item.model || null,
                agentType: item.agentType || null,
                updatedAt: item.updatedAt ?? null,
                idleSummary: item.idleSummary || null,
              },
            },
            { type: "text", text: " " },
          ])
          .run();
      },
    },
    renderHTML({ node }) {
      const attrs = node.attrs;
      const mtype = attrs.type || "doc";
      const colorClass = MENTION_COLOR_MAP[mtype] || "mention-doc";
      const htmlAttrs: Record<string, string> = {
        class: `editor-mention ${colorClass}`,
        href: `${MENTION_ROUTE_MAP[mtype] || "/docs"}/${attrs.id}`,
        "data-mention-type": mtype,
        "data-mention-id": attrs.id,
      };
      if (attrs.shortId) htmlAttrs["data-short-id"] = attrs.shortId;
      if (attrs.status) htmlAttrs["data-status"] = attrs.status;
      if (attrs.priority) htmlAttrs["data-priority"] = attrs.priority;
      if (attrs.docType) htmlAttrs["data-doc-type"] = attrs.docType;
      if (attrs.messageCount != null) htmlAttrs["data-message-count"] = String(attrs.messageCount);
      if (attrs.projectPath) htmlAttrs["data-project-path"] = attrs.projectPath;
      if (attrs.image) htmlAttrs["data-image"] = attrs.image;
      if (attrs.goal) htmlAttrs["data-goal"] = attrs.goal;
      if (attrs.model) htmlAttrs["data-model"] = attrs.model;
      if (attrs.agentType) htmlAttrs["data-agent-type"] = attrs.agentType;
      if (attrs.updatedAt != null) htmlAttrs["data-updated-at"] = String(attrs.updatedAt);
      if (attrs.idleSummary) htmlAttrs["data-idle-summary"] = attrs.idleSummary;
      return ["a", htmlAttrs, `@${attrs.label || attrs.id}`];
    },
  });
}
