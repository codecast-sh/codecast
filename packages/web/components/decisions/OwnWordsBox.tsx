"use client";

import type { RefObject } from "react";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { isMac } from "../../shortcuts";

/** What Return does in the box: ask the session (⌘Return answers), ask only (a gate takes only its options), or send the words as the answer. */
export type OwnWordsKeys = "ask-or-answer" | "ask" | "send";

// The decision card's typed-answer box, with the keys that send it beneath.
// The card's key handler (decisionCardKeys) acts on them; this only draws them.
export function OwnWordsBox({ boxRef, value, onChange, placeholder, keys }: {
  boxRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
  keys: OwnWordsKeys;
}) {
  return (
    <div className="mt-3">
      <textarea
        ref={boxRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        placeholder={placeholder}
        className="w-full bg-sol-card border border-sol-border rounded px-2 py-1.5 text-sm text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-blue/50"
      />
      <div className="flex items-center gap-2 mt-1 text-meta text-sol-text-dim">
        <KeyCap size="xs">return</KeyCap><span>{keys === "send" ? "send" : "ask"}</span>
        {keys === "ask-or-answer" && <><KeyCap size="xs">{isMac ? "⌘" : "ctrl"}</KeyCap><KeyCap size="xs">return</KeyCap><span>answer with this</span></>}
        <KeyCap size="xs">esc</KeyCap><span>cancel</span>
      </div>
    </div>
  );
}
