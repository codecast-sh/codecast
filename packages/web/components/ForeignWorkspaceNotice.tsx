"use client";
// The honest state of a page whose record lives in another workspace: its
// lists read from the active workspace, so instead of empty lists that are
// not true, it names where the record lives and offers the switch.
import { ArrowLeftRight } from "lucide-react";
import type { ForeignWorkspace } from "../hooks/useForeignWorkspace";

export function ForeignWorkspaceNotice({ foreign, what, className = "" }: { foreign: ForeignWorkspace; what: string; className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-sol-violet/30 bg-sol-violet/5 px-4 py-3 text-[13px] text-sol-text ${className}`} data-foreign-workspace={foreign.name}>
      <span className="min-w-0 flex-1">
        This {what} lives in <span className="font-medium">{foreign.name}</span>.{foreign.switchTo ? ` Switch to see its ${what === "project" ? "tasks and line" : "lists"}.` : ""}
      </span>
      {foreign.switchTo && (
        <button type="button" onClick={foreign.switchTo} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-sol-violet/40 text-[12px] text-sol-violet hover:bg-sol-violet/10 transition-colors" data-foreign-switch>
          <ArrowLeftRight className="w-3.5 h-3.5" />
          Switch to {foreign.name}
        </button>
      )}
    </div>
  );
}
