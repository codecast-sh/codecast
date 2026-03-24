import { useCallback, useRef } from "react";
import { useEditor, EditorContent, ReactRenderer, ReactNodeViewRenderer } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
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
import "./editor.css";
import { SlashCommandExtension } from "./SlashCommandExtension";
import { DateMentionExtension } from "./DateMentionExtension";
import { BubbleToolbar } from "./BubbleToolbar";
import { useMountEffect } from "../../hooks/useMountEffect";

const lowlight = createLowlight(common);

type MentionQueryFn = (query: string) => Promise<MentionItem[]>;

interface DocEditorProps {
  content: string;
  onUpdate: (markdown: string) => void;
  onMentionQuery: MentionQueryFn;
  onImageUpload?: (file: File) => Promise<string | null>;
  editable?: boolean;
  className?: string;
  placeholder?: string;
}

function createMentionSuggestion(queryFn: MentionQueryFn) {
  return {
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
            popup[0].setProps({
              getReferenceClientRect: props.clientRect,
            });
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

const MENTION_ROUTE_MAP: Record<string, string> = {
  person: "/team",
  task: "/tasks",
  doc: "/docs",
  session: "/conversation",
  plan: "/plans",
};

const MENTION_COLOR_MAP: Record<string, string> = {
  person: "mention-person",
  task: "mention-task",
  doc: "mention-doc",
  session: "mention-session",
  plan: "mention-plan",
};

export function DocEditor({
  content,
  onUpdate,
  onMentionQuery,
  onImageUpload,
  editable = true,
  className = "",
  placeholder = "Start writing, use / for commands, @ to mention, # for dates...",
}: DocEditorProps) {
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef(content);
  const onImageUploadRef = useRef(onImageUpload);
  onImageUploadRef.current = onImageUpload;

  const debouncedSave = useCallback(
    (md: string) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        if (md !== lastSavedRef.current) {
          lastSavedRef.current = md;
          onUpdate(md);
        }
      }, 500);
    },
    [onUpdate]
  );

  const baseExtensions = [
    StarterKit.configure({
      codeBlock: false,
      heading: { levels: [1, 2, 3] },
      link: {
        openOnClick: true,
        HTMLAttributes: { class: "editor-link" },
      },
    }),
    Placeholder.configure({ placeholder }),
    TaskList,
    TaskItem.configure({ nested: true }),
    SlashCommandExtension,
    Typography,
    Highlight.configure({
      HTMLAttributes: { class: "editor-highlight" },
    }),
    ImageExtension.configure({
      HTMLAttributes: { class: "editor-image" },
    }),
    CodeBlockLowlight.configure({ lowlight }),
    Table.configure({ resizable: false }),
    TableRow,
    TableCell,
    TableHeader,
    Markdown.configure({
      html: true,
      transformPastedText: true,
      transformCopiedText: true,
    }) as any,
  ];

  const mentionExtension = onMentionQuery ? Mention.extend({
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
                label: item.label,
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
  }) : null;

  const extensions = mentionExtension
    ? [...baseExtensions, mentionExtension, DateMentionExtension]
    : [...baseExtensions, DateMentionExtension];

  const editor = useEditor({
    extensions,
    content,
    editable,
    editorProps: {
      attributes: {
        class: "doc-editor-content focus:outline-none",
      },
      handlePaste: (view, event) => {
        const items = event.clipboardData?.items;
        if (!items || !onImageUploadRef.current) return false;
        for (const item of Array.from(items)) {
          if (item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (!file) continue;
            event.preventDefault();
            onImageUploadRef.current(file).then((url) => {
              if (url) view.dispatch(view.state.tr.replaceSelectionWith(
                view.state.schema.nodes.image.create({ src: url })
              ));
            });
            return true;
          }
        }
        return false;
      },
      handleDrop: (view, event) => {
        const files = event.dataTransfer?.files;
        if (!files?.length || !onImageUploadRef.current) return false;
        const imageFiles = Array.from(files).filter(f => f.type.startsWith("image/"));
        if (!imageFiles.length) return false;
        event.preventDefault();
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
        for (const file of imageFiles) {
          onImageUploadRef.current(file).then((url) => {
            if (url) view.dispatch(view.state.tr.insert(
              pos, view.state.schema.nodes.image.create({ src: url })
            ));
          });
        }
        return true;
      },
    },
    onUpdate: ({ editor: e }) => {
      const md = (e.storage as any).markdown?.getMarkdown() ?? e.getHTML();
      debouncedSave(md);
    },
  });

  useMountEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  });

  if (!editor) return null;

  return (
    <div className={`doc-editor ${className}`}>
      {editable && <BubbleToolbar editor={editor} />}
      <EditorContent editor={editor} />
    </div>
  );
}
