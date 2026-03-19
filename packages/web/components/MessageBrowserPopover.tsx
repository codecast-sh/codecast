"use client";

import { useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { isCommandMessage, cleanContent, isSystemMessage } from "../lib/conversationProcessor";
import { useMountEffect } from "../hooks/useMountEffect";
import { isConvexId, useInboxStore } from "../store/inboxStore";

function getCommandLabel(content: string): string | null {
  const m = content.match(/<command-(?:name|message)>([^<]*)<\/command-(?:name|message)>/);
  return m ? `/${m[1].replace(/^\//, "")}` : null;
}

function processUserMessage(content: string): { display: string; isCmd: boolean } {
  const isCmd = isCommandMessage(content);
  if (isCmd) {
    const label = getCommandLabel(content);
    return { display: label || cleanContent(content), isCmd: true };
  }
  return { display: cleanContent(content), isCmd: false };
}

type PM = { _id: string; display: string; isCmd: boolean };

function NavDropdown({
  messages,
  conversationId,
  currentMessageId,
  triggerRect,
  onClose,
  onMouseEnter,
  onMouseLeave,
}: {
  messages: PM[];
  conversationId: string;
  currentMessageId: string | null;
  triggerRect: DOMRect;
  onClose: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  useMountEffect(() => setMounted(true));

  if (!mounted || typeof document === "undefined") return null;

  const dropdownWidth = 300;
  const margin = 8;
  // Open to the left of the trigger button
  const left = Math.max(margin, triggerRect.left - dropdownWidth - 8);
  // Align vertically with the trigger
  const top = Math.max(margin, triggerRect.top);

  return createPortal(
    <div
      className="fixed z-[9999] bg-white dark:bg-sol-bg border border-sol-border/20 rounded-xl shadow-2xl overflow-hidden py-1.5"
      style={{ top, left, width: dropdownWidth }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {messages.map((m) => {
        const isCurrent = m._id === currentMessageId;
        const isHovered = m._id === hoveredId;
        return (
          <div
            key={m._id}
            onMouseEnter={() => setHoveredId(m._id)}
            onMouseLeave={() => setHoveredId(null)}
            onClick={() => {
              useInboxStore.setState({
                pendingNavigateId: conversationId,
                pendingScrollToMessageId: m._id,
              });
              onClose();
            }}
            className={`px-4 py-2 text-[13px] cursor-pointer truncate transition-colors leading-snug ${
              isCurrent
                ? "bg-sol-bg-alt/60 text-sol-text font-semibold"
                : isHovered
                ? "bg-sol-bg-alt/40 text-sol-text"
                : m.isCmd
                ? "text-sol-text-muted font-mono"
                : "text-sol-text-muted"
            }`}
          >
            {m.display.length > 52 ? m.display.slice(0, 52) + "…" : m.display}
          </div>
        );
      })}
    </div>,
    document.body
  );
}

export function MessageNavButton({
  conversationId,
  currentMessageId,
  scrollProgress = 1,
}: {
  conversationId: string;
  currentMessageId: string | null;
  scrollProgress?: number;
}) {
  const [open, setOpen] = useState(false);
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const messages = useQuery(
    api.conversations.getUserMessages,
    isConvexId(conversationId)
      ? { conversation_id: conversationId as Id<"conversations"> }
      : "skip"
  );

  const processed: PM[] = messages
    ? messages
        .map((m: { _id: string; content: string; timestamp: number }) => ({
          _id: m._id,
          ...processUserMessage(m.content),
        }))
        .filter((m: PM) => m.display.length > 0 && !isSystemMessage(m.display))
    : [];

  const total = processed.length;
  const effectiveId = currentMessageId === "__fallback__" ? null : currentMessageId;
  const currentIndex = effectiveId ? processed.findIndex((m) => m._id === effectiveId) : -1;
  const activeIndex =
    currentIndex >= 0 ? currentIndex : Math.min(total - 1, Math.floor(scrollProgress * total));

  const scheduleOpen = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    openTimerRef.current = setTimeout(() => {
      if (btnRef.current) setTriggerRect(btnRef.current.getBoundingClientRect());
      setOpen(true);
    }, 180);
  }, []);

  const scheduleClose = useCallback(() => {
    if (openTimerRef.current) clearTimeout(openTimerRef.current);
    closeTimerRef.current = setTimeout(() => setOpen(false), 250);
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);

  if (!messages || total < 2) return null;

  const MAX_BARS = 24;
  const displayCount = Math.min(total, MAX_BARS);

  return (
    <>
      <button
        ref={btnRef}
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
        className={`flex flex-col gap-[3px] items-end justify-center px-2 py-1.5 rounded transition-colors ${
          open ? "text-sol-cyan" : "text-sol-text-dim hover:text-sol-text-secondary"
        }`}
        title={`${total} user message${total !== 1 ? "s" : ""}`}
      >
        {Array.from({ length: displayCount }).map((_, i) => {
          const isActive = total <= MAX_BARS
            ? i === activeIndex
            : Math.round((i / (displayCount - 1)) * (total - 1)) === activeIndex;
          return (
            <span
              key={i}
              className={`block rounded-full transition-all duration-150 ${
                isActive ? "bg-sol-text w-4 h-[2.5px]" : "bg-current w-3 h-px opacity-35"
              }`}
            />
          );
        })}
      </button>
      {open && triggerRect && (
        <NavDropdown
          messages={processed}
          conversationId={conversationId}
          currentMessageId={effectiveId}
          triggerRect={triggerRect}
          onClose={() => setOpen(false)}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        />
      )}
    </>
  );
}
