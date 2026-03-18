"use client";

import { useState, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { isCommandMessage, cleanContent, isSystemMessage } from "../lib/conversationProcessor";
import { useMountEffect } from "../hooks/useMountEffect";
import { useInboxStore } from "../store/inboxStore";

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

function MessageList({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const messages = useQuery(api.conversations.getUserMessages, {
    conversation_id: conversationId as Id<"conversations">,
  });

  if (!messages) {
    return (
      <div className="flex items-center justify-center h-20 text-xs text-sol-text-muted/50">
        Loading...
      </div>
    );
  }

  type ProcessedMessage = { _id: string; content: string; timestamp: number; display: string; isCmd: boolean };
  const processed: ProcessedMessage[] = messages
    .map((m: { _id: string; content: string; timestamp: number }) => ({ ...m, ...processUserMessage(m.content) }))
    .filter((m: { display: string }) => m.display.length > 0 && !isSystemMessage(m.display));

  if (processed.length === 0) {
    return (
      <div className="flex items-center justify-center h-20 text-xs text-sol-text-muted/50">
        No messages
      </div>
    );
  }

  const previewMsg = (hoveredId ? processed.find((m) => m._id === hoveredId) : null) || processed[0];

  return (
    <div className="flex h-full">
      {/* Left: preview of hovered (or first) message */}
      <div className="w-[160px] shrink-0 p-3 border-r border-sol-border/30 flex flex-col justify-start overflow-hidden">
        <p className="text-[11px] text-sol-text-muted leading-relaxed line-clamp-[12] transition-[color] duration-100">
          {previewMsg.display}
        </p>
      </div>

      {/* Right: all user messages as scrollable list */}
      <div className="flex-1 min-w-0 overflow-y-auto p-2 space-y-0.5">
        {processed.map((m) => (
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
            className={`px-2 py-1 rounded text-[12px] truncate transition-colors cursor-pointer ${
              m.isCmd
                ? "bg-sol-bg-highlight text-sol-cyan font-mono font-medium hover:bg-sol-bg-highlight/80"
                : "text-sol-text-muted hover:bg-sol-bg-alt hover:text-sol-text"
            }`}
          >
            {m.display.length > 55 ? m.display.slice(0, 55) + " …" : m.display}
          </div>
        ))}
      </div>
    </div>
  );
}

interface PopoverPosition {
  top: number;
  left: number;
}

function PopoverPortal({
  position,
  conversationId,
  onClose,
  onMouseEnter,
  onMouseLeave,
}: {
  position: PopoverPosition;
  conversationId: string;
  onClose: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  useMountEffect(() => setMounted(true));

  if (!mounted || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed z-[9999] w-[420px] h-[260px] bg-sol-bg border border-sol-border/40 rounded-xl shadow-2xl overflow-hidden"
      style={{ top: position.top, left: position.left }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <MessageList conversationId={conversationId} onClose={onClose} />
    </div>,
    document.body
  );
}

export function MessageBrowserPopover({
  conversationId,
  children,
}: {
  conversationId: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PopoverPosition>({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const computePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const popoverWidth = 420;
    const popoverHeight = 260;
    const margin = 8;

    // Prefer left of trigger; fall back to right
    let left = rect.left - popoverWidth - margin;
    if (left < margin) {
      left = rect.right + margin;
    }
    // Clamp to viewport width
    left = Math.max(margin, Math.min(left, window.innerWidth - popoverWidth - margin));

    // Align top of popover with top of trigger, clamp to viewport
    let top = rect.top;
    top = Math.max(margin, Math.min(top, window.innerHeight - popoverHeight - margin));

    setPosition({ top, left });
  }, []);

  const handleMouseEnter = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = setTimeout(() => {
      computePosition();
      setOpen(true);
    }, 350);
  }, [computePosition]);

  const handleMouseLeave = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 200);
  }, []);

  const handleClose = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(false);
  }, []);

  return (
    <div
      ref={triggerRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      {open && (
        <PopoverPortal
          position={position}
          conversationId={conversationId}
          onClose={handleClose}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        />
      )}
    </div>
  );
}
