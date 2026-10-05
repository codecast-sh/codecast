import { useCallback, useMemo, useState, type RefObject } from "react";
import { useInboxStore } from "../store/inboxStore";
import { useImageGallery, useGalleryMessageId } from "../components/ImageGallery";
import { addPageNote } from "../lib/reviewActions";
import { pinNumbers, type PendingComment } from "../lib/quoteFormat";
import { pageShareUrl } from "../lib/publishedPageUrls";
import { useEventListener } from "./useEventListener";
import { useWatchEffect } from "./useWatchEffect";

// The page's side of this exchange is the notes layer in
// packages/convex/convex/artifactPages.ts. The batch is the one home of every
// note: the frame draws what it is sent and reports gestures, never keeping
// notes of its own, so a note removed from the composer's tray leaves the page
// too.

/** A note as the framed page draws it. */
type FrameNote = { id: string; n: number; x: number; y: number; body: string; snippet?: string };

type FromFrame =
  | { type: "codecast:note-add"; point: { x: number; y: number }; snippet?: string }
  | { type: "codecast:note-body"; id: string; body: string }
  | { type: "codecast:note-edit"; id: string | null }
  | { type: "codecast:note-remove"; id: string }
  | { type: "codecast:pin-mode"; on: boolean };

function notesOn(comments: readonly PendingComment[] | undefined, slug: string): PendingComment[] {
  return (comments ?? []).filter((c) => c.page?.slug === slug);
}

/**
 * Notes pinned to a published page framed in the thread, kept in the
 * conversation's quote batch like gallery pins, so they ride on the next
 * message as quotes. Off (null) where the viewer cannot reply here.
 */
export function usePageNotes(frameRef: RefObject<HTMLIFrameElement | null>, slug: string, title: string) {
  const conversationId = useImageGallery()?.quoteTo;
  const messageId = useGalleryMessageId() ?? "";
  const [pinMode, setPinMode] = useState(false);

  // A signature of what the frame draws, so unrelated batch writes neither
  // re-render the card nor post to the frame.
  const sig = useInboxStore((s) => {
    if (!conversationId) return "";
    const notes = notesOn(s.reviewComments[conversationId], slug);
    const editing = notes.some((c) => c.id === s.reviewEditingId) ? s.reviewEditingId : null;
    return JSON.stringify([notes.map((c) => [c.id, c.page!.point, c.body]), editing]);
  });
  const count = useMemo(() => (sig ? (JSON.parse(sig)[0] as unknown[]).length : 0), [sig]);

  const post = useCallback(() => {
    if (!conversationId) return;
    const s = useInboxStore.getState();
    const all = s.reviewComments[conversationId] ?? [];
    const numbers = pinNumbers(all);
    const notes: FrameNote[] = notesOn(all, slug).flatMap((c) => c.page?.point
      ? [{ id: c.id, n: numbers.get(c.id) ?? 0, ...c.page.point, body: c.body, snippet: c.page.snippet }]
      : []);
    const editing = notes.some((c) => c.id === s.reviewEditingId) ? s.reviewEditingId : null;
    try {
      frameRef.current?.contentWindow?.postMessage({ type: "codecast:notes", notes, editing, pinMode }, "*");
    } catch {
      // The frame is mid-navigation; its load posts again.
    }
  }, [conversationId, slug, pinMode, frameRef]);
  useWatchEffect(post, [post, sig]);

  useEventListener("message", useCallback((e: MessageEvent) => {
    const frame = frameRef.current?.contentWindow;
    if (!conversationId || !frame || e.source !== frame) return;
    const m = e.data as FromFrame;
    if (!m || typeof m.type !== "string") return;
    const s = useInboxStore.getState();
    const mine = notesOn(s.reviewComments[conversationId], slug);
    const owns = (id: unknown) => typeof id === "string" && mine.some((c) => c.id === id);
    switch (m.type) {
      case "codecast:note-add": {
        // A click while a note here still has nothing written moves that
        // note: the first click missed, it was not a second remark.
        const unwritten = mine.find((c) => c.id === s.reviewEditingId && !c.body.trim());
        if (unwritten) s.removeReviewComment(conversationId, unwritten.id);
        const clamp = (v: unknown) => Math.min(1, Math.max(0, Number(v) || 0));
        addPageNote(conversationId, messageId, {
          slug,
          title,
          url: pageShareUrl(slug),
          point: { x: clamp(m.point?.x), y: clamp(m.point?.y) },
          snippet: typeof m.snippet === "string" && m.snippet.trim() ? m.snippet.trim().slice(0, 500) : undefined,
        });
        break;
      }
      case "codecast:note-body":
        if (owns(m.id) && typeof m.body === "string") s.commitReviewComment(conversationId, m.id, m.body.trim());
        break;
      case "codecast:note-edit":
        if (m.id === null ? owns(s.reviewEditingId) : owns(m.id)) s.setReviewEditingId(m.id);
        break;
      case "codecast:note-remove":
        if (owns(m.id)) s.removeReviewComment(conversationId, m.id);
        break;
      case "codecast:pin-mode":
        setPinMode(!!m.on);
        break;
    }
  }, [conversationId, messageId, slug, title, frameRef]), conversationId ? undefined : null);

  if (!conversationId) return null;
  return { count, pinMode, setPinMode, onLoad: post };
}
