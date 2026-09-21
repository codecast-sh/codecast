import { useState } from "react";
import { AvatarImg } from "../../../lib/avatarCache";
import { type NestedStepOutcome } from "@codecast/shared/render";
import { toast } from "sonner";
import { AgentTypeIcon } from "../../AgentTypeIcon";
import { CodexIcon as CodexMark, GrokIcon as GrokMark } from "../../BrandIcons";
import { copyToClipboard } from "../../../lib/utils";
import { Bot } from "lucide-react";
import { renderAnsi } from "../../../lib/conversationFormat";

// A copyable command chip — the command in a mono pill with a copy affordance, so
// the fix for a stopped session is one click away.
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        copyToClipboard(command)
          .then(() => { setCopied(true); toast.success("Command copied"); setTimeout(() => setCopied(false), 1500); })
          .catch(() => toast.error("Couldn't copy"));
      }}
      title="Copy command"
      className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-sol-bg-alt/60 hover:bg-sol-bg-alt text-sol-text-secondary font-mono text-xs transition-colors"
    >
      <span>{command}</span>
      <svg className="w-3 h-3 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        {copied
          ? <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
          : <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 012-2h10" strokeLinecap="round" /></>}
      </svg>
    </button>
  );
}

/**
 * The steps of a batched tool call, one row each: label, what the step asked
 * for, and — once the result is in — what it reported. Shared by the
 * extension's browser_batch, Codex's exec program and `cast browser do`, so a
 * batch reads the same whichever client ran it. A failed step goes red; steps
 * after a failure never ran and stay dim with no outcome.
 */
export function NestedStepList({ steps, outcomes, labelClass }: {
  steps: Array<{ label: string; summary?: string }>;
  outcomes?: NestedStepOutcome[];
  labelClass?: string;
}) {
  return (
    <div className="divide-y divide-sol-border/20 border-b border-sol-border/20 bg-sol-bg-highlight/20">
      {steps.map((step, index) => {
        const outcome = outcomes?.[index];
        const failed = outcome?.ok === false;
        const skipped = !!outcomes && outcome?.ok === undefined && !outcome?.output;
        return (
          <div key={`${step.label}-${index}`} className={`px-2 py-1.5 text-xs font-mono ${skipped ? "opacity-50" : ""}`}>
            <div className="flex items-start gap-2">
              <span className="shrink-0 w-4 text-right tabular-nums text-sol-text-dim">{index + 1}</span>
              <span className={`shrink-0 ${failed ? "text-sol-red" : labelClass ?? "text-sol-cyan/80"}`}>{step.label}</span>
              {step.summary && <span className="min-w-0 break-words text-sol-text-muted">{step.summary}</span>}
            </div>
            {outcome?.output && (
              <pre className={`mt-0.5 pl-6 whitespace-pre-wrap break-words ${failed ? "text-sol-red" : "text-sol-text-secondary/80"}`}>
                {renderAnsi(outcome.output)}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ClaudeIcon() {
  return (
    <span className="w-6 h-6 rounded bg-sol-orange flex items-center justify-center shrink-0">
      <svg className="w-3.5 h-3.5 text-sol-bg" viewBox="0 0 24 24" fill="currentColor">
        <path d="M17.3041 3.541h-3.6718l6.696 16.918H24L17.3041 3.541Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409H6.696Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456H6.3247Z" />
      </svg>
    </span>
  );
}

function CodexIcon() {
  return <CodexMark className="w-6 h-6" />;
}

function CursorIcon() {
  return (
    <div className="w-6 h-6 rounded bg-[#1a1a2e] flex items-center justify-center shrink-0">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" xmlns="http://www.w3.org/2000/svg">
        <path d="M4 4l16 6-8 2-2 8z"/>
      </svg>
    </div>
  );
}

function GeminiIcon() {
  return (
    <div className="w-6 h-6 rounded bg-[#1a73e8] flex items-center justify-center shrink-0">
      <svg width="14" height="14" viewBox="0 0 28 28" fill="white" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 0C12 0 12 6.268 8.134 10.134C4.268 14 0 14 0 14C0 14 6.268 14 10.134 17.866C14 21.732 14 28 14 28C14 28 14 21.732 17.866 17.866C21.732 14 28 14 28 14C28 14 21.732 14 17.866 10.134C14 6.268 14 0 14 0" />
      </svg>
    </div>
  );
}

function OpencodeIcon() {
  return (
    <div className="w-6 h-6 rounded bg-orange-500 flex items-center justify-center shrink-0">
      <svg className="w-3.5 h-3.5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="8 6 3 12 8 18" />
        <polyline points="16 6 21 12 16 18" />
      </svg>
    </div>
  );
}

function PiIcon() {
  return (
    <div className="w-6 h-6 rounded bg-teal-500 flex items-center justify-center shrink-0">
      <span className="text-white text-sm font-semibold leading-none">π</span>
    </div>
  );
}

function GrokIcon() {
  return (
    <div className="w-6 h-6 rounded bg-sol-text flex items-center justify-center shrink-0">
      <GrokMark className="w-3.5 h-3.5 text-sol-bg" />
    </div>
  );
}

export function AssistantIcon({ agentType }: { agentType?: string }) {
  if (!agentType) return <Bot className="w-6 h-6 text-sol-text-dim" />;
  if (agentType === "codex") return <CodexIcon />;
  if (agentType === "cursor") return <CursorIcon />;
  if (agentType === "gemini") return <GeminiIcon />;
  if (agentType === "opencode") return <OpencodeIcon />;
  if (agentType === "pi") return <PiIcon />;
  if (agentType === "grok") return <GrokIcon />;
  if (agentType === "muse") return <AgentTypeIcon agentType="muse" className="w-6 h-6" />;
  return <ClaudeIcon />;
}

// Shared footer action style for expanded blocks (code/markdown/plan): muted
// icon + small label, cyan on hover — mirrors the long-message footer.
export function FooterIconButton({ onClick, title, label, children }: { onClick: (e: React.MouseEvent) => void; title: string; label?: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="p-1 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-cyan transition-colors flex items-center gap-1"
      title={title}
    >
      {children}
      {label && <span className="hidden sm:inline text-xs text-sol-text-dim">{label}</span>}
    </button>
  );
}

export function FullscreenIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
    </svg>
  );
}

export function UserIcon({ avatarUrl, size = "w-6 h-6" }: { avatarUrl?: string | null; size?: string }) {
  return (
    <AvatarImg
      src={avatarUrl}
      alt=""
      className={`${size} rounded shrink-0 object-cover shadow-[0_0_0_0.5px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.06)]`}
      fallback={
        <div className={`${size} rounded bg-sol-blue flex items-center justify-center shrink-0`}>
          <svg width="70%" height="70%" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        </div>
      }
    />
  );
}
