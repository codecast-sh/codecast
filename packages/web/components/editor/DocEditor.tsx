import { useCallback, useRef } from "react";
import { useEditor, EditorContent, ReactRenderer } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import LinkExtension from "@tiptap/extension-link";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Mention from "@tiptap/extension-mention";
import Typography from "@tiptap/extension-typography";
import UnderlineExtension from "@tiptap/extension-underline";
import Highlight from "@tiptap/extension-highlight";
import ImageExtension from "@tiptap/extension-image";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import { Markdown } from "tiptap-markdown";
import { common, createLowlight } from "lowlight";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import { MentionList, type MentionItem } from "./MentionList";
import { SlashCommandExtension } from "./SlashCommandExtension";
import { BubbleToolbar } from "./BubbleToolbar";
import { useMountEffect } from "../../hooks/useMountEffect";

const lowlight = createLowlight(common);

type MentionQueryFn = (query: string) => Promise<MentionItem[]>;

interface DocEditorProps {
  content: string;
  onUpdate: (markdown: string) => void;
  onMentionQuery: MentionQueryFn;
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
  editable = true,
  className = "",
  placeholder = "Start writing, use / for commands, @ to mention...",
}: DocEditorProps) {
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef(content);

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

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        heading: { levels: [1, 2, 3] },
      }),
      Placeholder.configure({ placeholder }),
      LinkExtension.configure({
        openOnClick: true,
        HTMLAttributes: { class: "editor-link" },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Mention.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            type: { default: "doc" },
            sublabel: { default: null },
          };
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
          return [
            "a",
            {
              class: `editor-mention ${colorClass}`,
              href: `${MENTION_ROUTE_MAP[mtype] || "/docs"}/${attrs.id}`,
              "data-mention-type": mtype,
              "data-mention-id": attrs.id,
            },
            `@${attrs.label || attrs.id}`,
          ];
        },
      }),
      SlashCommandExtension,
      Typography,
      UnderlineExtension,
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
    ],
    content,
    editable,
    editorProps: {
      attributes: {
        class: "doc-editor-content focus:outline-none",
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
