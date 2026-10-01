import { useCallback, useRef, useState } from "react";
import { useAction } from "convex/react";
import type { Editor } from "@tiptap/core";
import { toast } from "sonner";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { LabRequest, LabResult } from "@codecast/shared/docs";
import { useInboxStore, useTrackedStore } from "../../../store/inboxStore";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import {
  applyLabResultInEditor,
  docPlainText,
  draftingState,
  setDraftingEnabled,
  setDraftingFocus,
  type DraftingOptions,
  type Range,
} from "../../editor/DraftingExtension";

const api = _api as any;

export type LabRun = { kind: LabRequest["tool"]; label: string } | null;

/** What the last trim proposed, for the result bar ("535 -> 480 words"). */
export type TrimSummary = { level: string; label: string; before: number; after: number; applied: number };

/**
 * The doc page's drafting layer: which panels are open, the live editor they
 * work on, the Lab's model calls, and the Overflow text (docs.overflow,
 * written through the store's updateDoc like any other doc field).
 */
export function useDrafting(docId: string) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [labRun, setLabRun] = useState<LabRun>(null);
  const [trim, setTrim] = useState<TrimSummary | null>(null);
  const runLab = useAction(api.docLab.run);

  const s = useTrackedStore([
    (st) => st.clientState.ui?.doc_drafting,
    (st) => (st.docDetails[docId] as any)?.overflow,
    (st) => (st.docs[docId] as any)?.overflow,
  ]);
  const enabled = !!s.clientState.ui?.doc_drafting;
  const overflow: string = (s.docDetails[docId] as any)?.overflow ?? (s.docs[docId] as any)?.overflow ?? "";

  // The editor's plugin carries the flag its decorations read; mirror the
  // preference into it whenever either side changes (a fresh mount included).
  useWatchEffect(() => {
    if (editor && !editor.isDestroyed && draftingState(editor.state)?.enabled !== enabled) setDraftingEnabled(editor, enabled);
  }, [editor, enabled]);

  const setEnabled = useCallback((on: boolean) => {
    useInboxStore.getState().updateClientUI({ doc_drafting: on });
  }, []);

  const setOverflow = useCallback(
    (text: string) => useInboxStore.getState().updateDoc(docId, { overflow: text }),
    [docId],
  );

  const openAlternatives = useCallback(
    (range: Range) => {
      if (!editor) return;
      setEnabled(true);
      setDraftingFocus(editor, range);
      setPanelOpen(true);
    },
    [editor, setEnabled],
  );

  const closeAlternatives = useCallback(() => {
    if (editor && !editor.isDestroyed) setDraftingFocus(editor, null);
    setPanelOpen(false);
    editor?.commands.focus();
  }, [editor]);

  const lab = useCallback(
    async (req: LabRequest, label: string, target?: Range): Promise<LabResult | null> => {
      if (!editor || labRun) return null;
      setLabRun({ kind: req.tool, label });
      try {
        const text = docPlainText(editor.state.doc);
        const result: LabResult = await runLab({ ...req, text });
        if (editor.isDestroyed) return null;
        const landed = applyLabResultInEditor(editor.view, result, target);
        if (result.tool !== "alternatives" && result.tool !== "trim") {
          toast.message(landed.applied ? `${label}: ${landed.applied} marked` : `${label}: nothing to mark`);
        }
        return result;
      } catch (e: any) {
        toast.error(e?.message?.replace(/^.*Uncaught Error: /, "").split("\n")[0] || "The Lab failed");
        return null;
      } finally {
        setLabRun(null);
      }
    },
    [editor, labRun, runLab],
  );

  const aiAlternatives = useCallback(
    (range: Range) => {
      if (!editor) return;
      openAlternatives(range);
      const { state } = editor;
      const $from = state.doc.resolve(range.from);
      const target = state.doc.textBetween(range.from, range.to, " ");
      const context = $from.parent.textContent;
      void lab({ tool: "alternatives", target, context }, "AI alternatives", range);
    },
    [editor, lab, openAlternatives],
  );

  const stash = useCallback(
    (text: string) => {
      const current = useInboxStore.getState().docDetails[docId] as any;
      const prev: string = current?.overflow ?? (useInboxStore.getState().docs[docId] as any)?.overflow ?? "";
      setOverflow(prev.trim() ? `${prev.replace(/\s+$/, "")}\n\n${text.trim()}` : text.trim());
      setOverflowOpen(true);
    },
    [docId, setOverflow],
  );

  // The extension's shortcuts call through this ref, so handlers can change
  // without rebuilding the editor's extension list.
  const draftingRef = useRef<DraftingOptions>({});
  draftingRef.current = { onOpenAlternatives: openAlternatives, onAiAlternatives: aiAlternatives, onStash: stash };

  return {
    editor,
    setEditor,
    enabled,
    setEnabled,
    panelOpen,
    openAlternatives,
    closeAlternatives,
    aiAlternatives,
    overflow,
    setOverflow,
    overflowOpen,
    setOverflowOpen,
    stash,
    lab,
    labRun,
    trim,
    setTrim,
    draftingRef,
  };
}

export type Drafting = ReturnType<typeof useDrafting>;
