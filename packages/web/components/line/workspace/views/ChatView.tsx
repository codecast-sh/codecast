"use client";
// The Chat view (line-workspace.md LW1, LW4): a conversation with the line,
// replies carrying live widgets. Placeholder until the line's chat session
// and its thread land here.
import type { LineViewProps } from "./types";

export function ChatView({ model }: LineViewProps) {
  return (
    <div className="lw-empty" data-line-view="chat">
      <b>Talk with {model.title}</b>
      A conversation with the line, its replies drawn as steps, prompts and decisions.
    </div>
  );
}
