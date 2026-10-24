"use client";

// Stopping a turn stops every subagent it launched. When some are still
// running, the stop names them first; "Don't ask again" turns the question
// off for this person (clientState.ui.confirm_stop_subagents).

import { useState } from "react";
import type { RunningSubagent } from "../../lib/runningSubagents";
import { useInboxStore } from "../../store/inboxStore";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { KeyCap } from "../KeyCap";

export type StopRequest = { subagents: RunningSubagent[]; run: () => void; send?: boolean };

/** Whether a stop that would take these subagents with it asks first. */
export function stopNeedsConfirm(subagents: RunningSubagent[]): boolean {
  return subagents.length > 0 && useInboxStore.getState().clientState?.ui?.confirm_stop_subagents !== false;
}

export function StopConfirm({ request, onClose }: { request: StopRequest | null; onClose: () => void }) {
  const [dontAsk, setDontAsk] = useState(false);
  const confirm = () => {
    if (dontAsk) useInboxStore.getState().updateClientUI({ confirm_stop_subagents: false });
    request?.run();
    onClose();
  };
  const n = request?.subagents.length ?? 0;
  return (
    <Dialog open={!!request} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-sm" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); confirm(); } }}>
        <DialogHeader>
          <DialogTitle>Stop {n} running {n === 1 ? "subagent" : "subagents"}?</DialogTitle>
        </DialogHeader>
        <ul className="max-h-48 overflow-y-auto space-y-1 text-sm text-sol-text">
          {request?.subagents.map((s) => (
            <li key={s.id} className="flex items-center gap-2 min-w-0">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-sol-violet" />
              <span className="truncate">{s.label}</span>
            </li>
          ))}
        </ul>
        <label className="flex items-center gap-2 text-xs text-sol-text-dim select-none">
          <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
          Don't ask again
        </label>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel <KeyCap>Esc</KeyCap></Button>
          <Button variant="red" size="sm" autoFocus onClick={confirm}>{request?.send ? "Stop & send" : "Stop"} <KeyCap>↵</KeyCap></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
