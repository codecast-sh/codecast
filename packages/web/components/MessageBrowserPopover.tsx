"use client";

import { useState, useRef, useCallback } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { isCommandMessage, cleanContent } from "../lib/conversationProcessor";
import { isSystemMessage } from "../lib/conversationProcessor";
import Link from "next/link";

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

  const processed = messages
    .map(m => ({ ...m, ...processUserMessage(m.content) }))
    .filter(m => m.display.length > 0 && !isSystemMessage(m.display));

  if (processed.length === 0) {
    return (
      <div className="flex items-center justify-center h-20 text-xs text-sol-text-muted/50">
        No messages
      </div>
    );
  }

  const firstMsg = processed[0];
  const allMsgs = processed;

  return (
    <div className="flex gap-0 h-full">
      {/* Left: first message context */}
      <div className="w-[180px] shrink-0 p-3 border-r border-sol-border/20 flex flex-col justify-start">
        <p className="text-[11px] text-sol-text-muted/70 leading-relaxed line-clamp-[10]">
          {firstMsg.display}
        </p>
      </div>

      {/* Right: all user messages as scrollable list */}
      <div className="flex-1 min-w-0 overflow-y-auto max-h-[260px] p-2 space-y-1">
        {allMsgs.map((m) => (
          <Link
            key={m._id}
            href={`/conversation/${conversationId}#msg-${m._id}`}
            onClick={onClose}
            className="block w-full text-left"
          >
            <div
              className={`px-2.5 py-1.5 rounded-lg text-[12px] truncate transition-colors cursor-pointer ${
                m.isCmd
                  ? "bg-sol-bg-alt/80 text-sol-text font-mono font-medium hover:bg-sol-bg-alt"
                  : "bg-sol-bg/50 text-sol-text-muted hover:bg-sol-bg-alt/60 hover:text-sol-text"
              }`}
            >
              {m.display.length > 60 ? m.display.slice(0, 60) + " …" : m.display}
            </div>
          </Link>
        ))}
      </div>
    </div>
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
  const [loaded, setLoaded] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseEnter = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = setTimeout(() => {
      setLoaded(true);
      setOpen(true);
    }, 300);
  }, []);

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
      className="relative"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}

      {open && (
        <div
          className="absolute left-full top-0 ml-2 z-50 w-[420px] bg-white dark:bg-[#1a1a1a] border border-sol-border/30 rounded-xl shadow-xl overflow-hidden"
          style={{ maxHeight: 260 }}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        >
          {loaded && (
            <MessageList conversationId={conversationId} onClose={handleClose} />
          )}
        </div>
      )}
    </div>
  );
}
