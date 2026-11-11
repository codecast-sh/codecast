// Ask an agent to work on a live artifact. One control for every product:
// the shell's top-bar button, a product's "Describe a change" on a selection,
// and a comment's "Send to agent" all end here.
//
// Routing reuses the existing paths. A live session gets an ordinary message
// through the store's sendMessage. A new agent starts in the artifact's project
// through spawnSessionWithPrompt. With no project known, the new-session
// composer opens pre-filled so the person picks where it runs. The brief
// (shared askAgentBrief) tells the agent the exact `cast <cli>` verbs to read
// and write the artifact; its writes then show up live with its own cursor.
import { useCallback, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Bot, Send } from "lucide-react";
import type { ArtifactElement } from "@codecast/shared/artifacts";
import { KeyCap } from "../KeyCap";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { isMac } from "../../shortcuts/registry";
import { Button } from "../ui/button";
import { useEventListener } from "../../hooks/useEventListener";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { ASK_BUTTON_CLASS, pickAskTarget, sendAsk, useAskConfirm, useAskDraft, useClaimAsk, type AskDoc, type AskTarget } from "./askAgent";

/** Mount once where asks can start agents (the artifact page): the confirm review. */
export function AskConfirmHost() {
  const { pending, done } = useAskConfirm();
  if (!pending) return null;
  return <SwitchReview ledger={pending.ledger} onClose={() => done(false)} onConfirm={() => done(true)} />;
}

/** The Ask agent button. In a product toolbar it claims the page's Ask, so the header shows none. */
export function AskButton({ label = "Ask agent", className, ...rest }: { label?: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  useClaimAsk();
  return (
    <button type="button" data-live-ask-button className={`${ASK_BUTTON_CLASS}${className ? ` ${className}` : ""}`} {...rest}>
      <Bot className="w-3.5 h-3.5" />
      {label}
    </button>
  );
}

/**
 * The Ask agent button with its inline prompt. `selected` is what the person
 * has selected now; the agent receives it with the request.
 */
export function AskAgentControl({
  doc,
  selected,
  draftDefault = false,
  label = "Ask agent",
  onSent,
}: {
  doc: AskDoc;
  selected: ArtifactElement[];
  draftDefault?: boolean;
  label?: string;
  onSent?: (sessionId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const { text: prompt, setText: setPrompt } = useAskDraft(doc._id, "header", () => setOpen(true));
  const [draft, setDraft] = useState(draftDefault);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useWatchEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  useEventListener("mousedown", (e) => {
    if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
  }, open ? window : null);

  const submit = useCallback(async (target: AskTarget) => {
    if (!prompt.trim()) return;
    setOpen(false);
    const id = await sendAsk(doc, { slot: "header", prompt, selected, draft }, target);
    onSent?.(id);
  }, [doc, prompt, selected, draft, onSent]);

  const choose = useCallback(() => {
    if (!prompt.trim()) return;
    setOpen(false);
    pickAskTarget("Ask which agent?", submit, () => setOpen(true));
  }, [prompt, submit]);

  return (
    <div className="relative" ref={boxRef}>
      <button type="button" data-live-ask onClick={() => setOpen((o) => !o)} className={ASK_BUTTON_CLASS}>
        <Bot className="w-3.5 h-3.5" />
        {label}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-50 w-[360px] rounded-lg border border-sol-border/60 bg-sol-bg shadow-xl p-2.5">
          <textarea
            ref={inputRef}
            data-live-ask-input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              if (e.key === "Enter" && !e.shiftKey && (e.metaKey || e.ctrlKey)) { e.preventDefault(); choose(); }
              else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit({ kind: "new" }); }
            }}
            rows={3}
            placeholder={selected.length ? `What should change in the ${selected.length} selected?` : "What should the agent do?"}
            className="w-full resize-none bg-sol-bg-alt rounded-md px-2.5 py-2 text-sm text-sol-text placeholder:text-sol-text-dim outline-none border border-sol-border/40 focus:border-sol-violet/50"
          />
          <div className="mt-2 flex items-center gap-2">
            {selected.length > 0 && <span className="text-meta text-sol-text-dim">{selected.length} selected</span>}
            <label className="inline-flex items-center gap-1.5 text-meta text-sol-text-muted cursor-pointer select-none">
              <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} className="accent-[var(--sol-violet)]" />
              As draft
            </label>
            <span className="flex-1" />
            <button
              type="button"
              disabled={!prompt.trim()}
              onClick={choose}
              className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-xs text-sol-text-muted hover:bg-sol-bg-alt disabled:opacity-40"
              title="Send to a running session"
            >
              Session… <KeyCap>{isMac ? "⌘" : "Ctrl"}</KeyCap><KeyCap>↵</KeyCap>
            </button>
            <Button
              type="button"
              variant="violet"
              size="xs"
              data-live-ask-new
              disabled={!prompt.trim()}
              onClick={() => submit({ kind: "new" })}
            >
              <Send className="w-3 h-3" /> New agent <KeyCap>↵</KeyCap>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
