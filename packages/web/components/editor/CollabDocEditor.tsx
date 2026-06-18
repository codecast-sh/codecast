import { useRef, useState } from "react";
import {
  EditorProvider,
  useCurrentEditor,
  ReactRenderer,
  ReactNodeViewRenderer,
} from "@tiptap/react";
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
import { Editor as HeadlessEditor, Extension } from "@tiptap/core";
import { getVersion, sendableSteps } from "prosemirror-collab";
import type { ComposeEditorHandle } from "./ComposeEditor";
import { AppLoader } from "../AppLoader";
import tippy, { type Instance as TippyInstance } from "tippy.js";
import { useTiptapSync } from "@convex-dev/prosemirror-sync/tiptap";
import { useQuery, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { MentionList, type MentionItem } from "./MentionList";
import { MentionNodeView } from "./MentionNodeView";
import { SlashCommandExtension } from "./SlashCommandExtension";
import { DateMentionExtension } from "./DateMentionExtension";
import { TabIndentExtension } from "./TabIndentExtension";
import { EntityIdExtension } from "./EntityIdExtension";
import { BubbleToolbar } from "./BubbleToolbar";
import { ImageUploadPlaceholder, uploadImageWithPlaceholder } from "./ImageUploadPlugin";
import { createWikiLinkExtension } from "./WikiLinkExtension";
import { useMountEffect } from "../../hooks/useMountEffect";
import type { SyncApi } from "@convex-dev/prosemirror-sync";

const api = _api as any;
const lowlight = createLowlight(common);

type MentionQueryFn = (query: string) => Promise<MentionItem[]>;

interface CollabDocEditorProps {
  docId: string;
  markdownContent: string;
  onMentionQuery: MentionQueryFn;
  onImageUpload?: (file: File) => Promise<string | null>;
  // When set, pasted/dropped images are routed here (the chat composer's
  // attachment pipeline) instead of being uploaded and inlined into the doc body.
  // Takes precedence over onImageUpload. Omitted by /docs.
  onImagePaste?: (file: File) => void;
  editable?: boolean;
  className?: string;
  placeholder?: string;
  getMarkdownRef?: React.MutableRefObject<(() => string) | null>;
  cliEditedAt?: number;
  /**
   * Whether `markdownContent` reflects the loaded doc (vs. a lite list row whose
   * content hasn't arrived yet). When false and there's no content, the editor
   * waits instead of seeding an empty collab snapshot — seeding empty over a
   * still-loading doc would wipe its markdown server-side. Defaults to true for
   * callers that pass authoritative content synchronously.
   */
  contentReady?: boolean;
  // ── Compose-mode affordances (the chat composer's expanded "doc" view) ──
  // When provided, the editor binds Cmd/Ctrl+Enter → onSubmit and Cmd+Shift+E →
  // onExit, reports content emptiness via onContentChange, and exposes an
  // imperative handle so the composer can read/clear it on send. `clear()` empties
  // the shared OT doc, which propagates to every collaborator. Omitted by /docs.
  onSubmit?: () => void;
  onExit?: () => void;
  onContentChange?: (hasContent: boolean) => void;
  composeHandleRef?: React.MutableRefObject<ComposeEditorHandle | null>;
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

function createMentionSuggestion(queryFn: MentionQueryFn) {
  return {
    allowSpaces: true,
    items: async ({ query }: { query: string }) => queryFn(query),
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

function buildExtensions(onMentionQuery: MentionQueryFn, placeholder: string) {
  return [
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
    Mention.extend({
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
              messageCount: el.getAttribute("data-message-count")
                ? Number(el.getAttribute("data-message-count"))
                : null,
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
                  messageCount: item.messageCount || null,
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
        if (attrs.messageCount != null)
          htmlAttrs["data-message-count"] = String(attrs.messageCount);
        if (attrs.projectPath) htmlAttrs["data-project-path"] = attrs.projectPath;
        if (attrs.image) htmlAttrs["data-image"] = attrs.image;
        if (attrs.goal) htmlAttrs["data-goal"] = attrs.goal;
        if (attrs.model) htmlAttrs["data-model"] = attrs.model;
        if (attrs.agentType) htmlAttrs["data-agent-type"] = attrs.agentType;
        if (attrs.updatedAt != null) htmlAttrs["data-updated-at"] = String(attrs.updatedAt);
        if (attrs.idleSummary) htmlAttrs["data-idle-summary"] = attrs.idleSummary;
        return ["a", htmlAttrs, `@${attrs.label || attrs.id}`];
      },
    }),
    SlashCommandExtension,
    DateMentionExtension,
    TabIndentExtension,
    EntityIdExtension,
    Typography,
    Highlight.configure({ HTMLAttributes: { class: "editor-highlight" } }),
    ImageExtension.configure({ HTMLAttributes: { class: "editor-image" } }),
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
    ImageUploadPlaceholder,
    // Wiki links: [[ trigger opens doc-only suggestion
    createWikiLinkExtension(async (query: string) => {
      const results = await onMentionQuery(query);
      return results.filter((item) => item.type === "doc");
    }),
  ];
}

type PresenceEntry = {
  user_name: string;
  user_color: string;
  cursor_pos?: number;
  anchor_pos?: number;
};

function CursorOverlay({ presences }: { presences: PresenceEntry[] }) {
  const { editor } = useCurrentEditor();
  const [, setTick] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useMountEffect(() => {
    tickRef.current = setInterval(() => setTick((t) => t + 1), 500);
    return () => { if (tickRef.current) clearInterval(tickRef.current); };
  });

  // `editor.view` is a Proxy that THROWS on any property access (e.g. `.dom`)
  // until the ProseMirror view is mounted — so `!editor.view` never short-circuits
  // (the proxy is always truthy) and the `.dom` read below blows up during the
  // mount race. `isInitialized` flips true only once editorView exists, and reading
  // it never touches the proxy. (Sentry: "[tiptap error]: Cannot access view['dom']".)
  if (!editor || !editor.isInitialized) return null;

  const editorEl = editor.view.dom;
  const editorRect = editorEl.getBoundingClientRect();

  return (
    <>
      {presences.map((p, i) => {
        if (p.cursor_pos == null) return null;
        const pos = Math.min(p.cursor_pos, editor.state.doc.content.size);
        try {
          const coords = editor.view.coordsAtPos(pos);
          const top = coords.top - editorRect.top;
          const left = coords.left - editorRect.left;
          return (
            <div
              key={i}
              className="collab-cursor"
              style={{
                position: "absolute",
                top,
                left,
                height: coords.bottom - coords.top,
                borderLeftColor: p.user_color,
                pointerEvents: "none",
                zIndex: 10,
              }}
            >
              <span
                className="collab-cursor-label"
                style={{ backgroundColor: p.user_color }}
              >
                {p.user_name}
              </span>
            </div>
          );
        } catch {
          return null;
        }
      })}
    </>
  );
}

function ExternalEditSync({ markdownContent, extensions }: { markdownContent: string; extensions: any[] }) {
  const { editor } = useCurrentEditor();
  useMountEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const json = markdownToJson(markdownContent, extensions);
    editor.commands.setContent(json);
  });
  return null;
}

function EditorInner({
  docId,
  editable,
  presences,
  getMarkdownRef,
  composeHandleRef,
  onContentChange,
}: {
  docId: string;
  editable: boolean;
  presences: PresenceEntry[];
  getMarkdownRef?: React.MutableRefObject<(() => string) | null>;
  composeHandleRef?: React.MutableRefObject<ComposeEditorHandle | null>;
  onContentChange?: (hasContent: boolean) => void;
}) {
  const { editor } = useCurrentEditor();

  const readMarkdown = () =>
    editor ? ((editor.storage as any).markdown?.getMarkdown?.() ?? editor.getText()) : "";

  if (getMarkdownRef && editor && !editor.isDestroyed) {
    getMarkdownRef.current = readMarkdown;
  }
  // Same imperative contract as ComposeEditor so the composer's send/collapse
  // paths are unchanged. clear() empties the shared doc → propagates via OT.
  if (composeHandleRef && editor && !editor.isDestroyed) {
    composeHandleRef.current = {
      getMarkdown: readMarkdown,
      focus: () => editor.commands.focus("end"),
      clear: () => editor.commands.clearContent(),
    };
  }

  useMountEffect(() => {
    if (!editor || !onContentChange) return;
    const report = () => onContentChange(readMarkdown().trim().length > 0);
    report();
    editor.on("update", report);
    return () => editor.off("update", report);
  });
  const updatePresence = useMutation(api.docSync.updatePresence);
  const removePresence = useMutation(api.docSync.removePresence);
  const presenceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastPosRef = useRef<{ cursor: number | undefined; anchor: number | undefined }>({
    cursor: undefined,
    anchor: undefined,
  });

  useMountEffect(() => {
    if (!editor) return;
    let cacheTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleCacheWrite = () => {
      if (cacheTimer) clearTimeout(cacheTimer);
      cacheTimer = setTimeout(() => writeSyncCache(docId, editor), 1000);
    };
    editor.on("update", scheduleCacheWrite);
    writeSyncCache(docId, editor); // cache on open so revisits skip the loading round-trip
    return () => {
      if (cacheTimer) clearTimeout(cacheTimer);
      editor.off("update", scheduleCacheWrite);
      writeSyncCache(docId, editor);
    };
  });

  useMountEffect(() => {
    if (!editor) return;
    const sendPresence = () => {
      if (!editor || editor.isDestroyed) return;
      const { from, to } = editor.state.selection;
      if (from === lastPosRef.current.cursor && to === lastPosRef.current.anchor) return;
      lastPosRef.current = { cursor: from, anchor: to };
      updatePresence({ doc_id: docId, cursor_pos: from, anchor_pos: to });
    };
    presenceTimerRef.current = setInterval(sendPresence, 2000);
    editor.on("selectionUpdate", sendPresence);
    return () => {
      if (presenceTimerRef.current) clearInterval(presenceTimerRef.current);
      editor.off("selectionUpdate", sendPresence);
      removePresence({ doc_id: docId });
    };
  });

  if (!editor) return null;

  return (
    <>
      {editable && <BubbleToolbar editor={editor} />}
      <CursorOverlay presences={presences} />
    </>
  );
}

// useTiptapSync reads a sessionStorage cache (`convex-sync-<id>`) to skip the
// snapshot round-trip on mount, but never writes it — we write it here so
// reopening a doc renders the editor instantly and catches up via getSteps.
function writeSyncCache(docId: string, editor: HeadlessEditor) {
  if (editor.isDestroyed) return;
  // Only cache confirmed state: content holding unconfirmed local steps would
  // get those steps re-applied by the catch-up fetch on restore.
  if (sendableSteps(editor.state)) return;
  try {
    sessionStorage.setItem(
      `convex-sync-${docId}`,
      JSON.stringify({ content: editor.state.doc.toJSON(), version: getVersion(editor.state) }),
    );
  } catch {
    // best-effort — without the cache, loading falls back to the server path
  }
}

function markdownToJson(markdown: string, extensions: any[]): any {
  const editor = new HeadlessEditor({
    extensions,
    content: markdown,
    editable: false,
  });
  const json = editor.getJSON();
  editor.destroy();
  return json;
}

export function CollabDocEditor({
  docId,
  markdownContent,
  onMentionQuery,
  onImageUpload,
  editable = true,
  className = "",
  placeholder = "Start writing, use / for commands, @ to mention, # for dates...",
  getMarkdownRef,
  cliEditedAt,
  contentReady = true,
  onSubmit,
  onExit,
  onContentChange,
  composeHandleRef,
}: CollabDocEditorProps) {
  const onImageUploadRef = useRef(onImageUpload);
  onImageUploadRef.current = onImageUpload;
  const syncApi = api.docSync as unknown as SyncApi;
  const sync = useTiptapSync(syncApi, docId);
  const presences = useQuery(api.docSync.getPresence, { doc_id: docId }) || [];
  const createdRef = useRef(false);
  const extensionsRef = useRef<any[] | null>(null);

  // Compose keymap: bound to refs so the latest handlers fire without rebuilding
  // the editor. Created once and only when compose handlers are supplied (the
  // document editor passes none, so its keymap is unchanged).
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const composeKeymapRef = useRef<Extension | null>(null);
  if ((onSubmit || onExit) && !composeKeymapRef.current) {
    composeKeymapRef.current = Extension.create({
      name: "composeKeymap",
      addKeyboardShortcuts() {
        return {
          "Mod-Enter": () => { onSubmitRef.current?.(); return true; },
          "Mod-Shift-e": () => { onExitRef.current?.(); return true; },
        };
      },
    });
  }

  if (!extensionsRef.current) {
    extensionsRef.current = buildExtensions(onMentionQuery, placeholder);
  }

  if (sync.isLoading) {
    // Paint the content we already have (store-cached markdown) as a read-only
    // editor while the snapshot loads; the live editor swaps in when ready.
    if (markdownContent) {
      return (
        <div className={`doc-editor ${className}`} style={{ position: "relative" }}>
          <EditorProvider
            key={`preview-${markdownContent.length}`}
            content={markdownContent}
            extensions={extensionsRef.current}
            editable={false}
            editorProps={{
              attributes: { class: "doc-editor-content focus:outline-none" },
            }}
          />
        </div>
      );
    }
    return (
      <div className={`doc-editor ${className}`}>
        <AppLoader className="min-h-0 bg-transparent py-8" size={24} />
      </div>
    );
  }

  if (!sync.initialContent) {
    // No snapshot exists yet — we must seed one from the doc's markdown. Only do
    // so once we actually have the content: either markdownContent is non-empty,
    // or the doc detail has loaded and confirms it's genuinely empty. Seeding an
    // empty snapshot while the markdown is still loading wipes it server-side.
    const canSeed = !!markdownContent || contentReady;
    if (canSeed && !createdRef.current) {
      createdRef.current = true;
      const json = markdownContent
        ? markdownToJson(markdownContent, extensionsRef.current)
        : { type: "doc", content: [{ type: "paragraph" }] };
      (sync as any).create(json);
    }
    return (
      <div className={`doc-editor ${className}`}>
        <AppLoader className="min-h-0 bg-transparent py-8" size={24} />
      </div>
    );
  }

  const allExtensions = [
    ...extensionsRef.current,
    sync.extension,
    ...(composeKeymapRef.current ? [composeKeymapRef.current] : []),
  ];

  return (
    <div className={`doc-editor ${className}`} style={{ position: "relative" }}>
      <EditorProvider
        key="live"
        content={sync.initialContent}
        extensions={allExtensions}
        editable={editable}
        editorProps={{
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
                uploadImageWithPlaceholder(view, file, view.state.selection.from, onImageUploadRef.current);
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
              uploadImageWithPlaceholder(view, file, pos, onImageUploadRef.current);
            }
            return true;
          },
        }}
      >
        <EditorInner
          docId={docId}
          editable={editable}
          presences={presences}
          getMarkdownRef={getMarkdownRef}
          composeHandleRef={composeHandleRef}
          onContentChange={onContentChange}
        />
        {cliEditedAt && (
          <ExternalEditSync
            key={cliEditedAt}
            markdownContent={markdownContent}
            extensions={extensionsRef.current!}
          />
        )}
      </EditorProvider>
    </div>
  );
}
