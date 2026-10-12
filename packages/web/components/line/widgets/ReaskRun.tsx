"use client";
// The one act for a trial run paused where no answer can land: its step left
// the line, or no session asked its card. Asking the run again has its asking
// station present a new decision at a step the line still has. The app has no
// call for that yet (the re-ask stops the run's runner on its own machine, so
// it lives in the CLI), so the act hands over the exact command.
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { reaskCommand } from "../../../lib/line/fixDecision";
import { copyToClipboard } from "../../../lib/utils";

export function ReaskRun({ task, className = "lw-act", primary }: { task: string; className?: string; primary?: boolean }) {
  const [copied, setCopied] = useState(false);
  const command = reaskCommand(task);
  return (
    <button type="button" className={className} data-primary={primary ? "" : undefined} title={command} data-line-reask={task}
      onClick={(e) => { e.stopPropagation(); void copyToClipboard(command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }); }}>
      {copied ? <Check className="w-3.5 h-3.5" aria-hidden /> : <Copy className="w-3.5 h-3.5" aria-hidden />}{copied ? "Copied" : "Copy re-ask command"}
    </button>
  );
}

/** The same act where the answers would be, with the reason in a line and the command in view. */
export function ReaskNotice({ task, reason }: { task: string; reason: string }) {
  return (
    <div className="ld-reask" data-line-decision-reask>
      <b>{reason}</b>
      <code>{reaskCommand(task)}</code>
      <ReaskRun task={task} primary />
    </div>
  );
}
