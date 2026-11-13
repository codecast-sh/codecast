"use client";

// The Claude backend control: where a session runs (a tmux pane or an Agent
// SDK host) and the move to the other, keeping the same session. Two
// surfaces: the "Runs in" rows of the session control panel, and the header
// pill an SDK session shows where a tmux session shows its terminal pill.

import { Cpu, SquareTerminal } from "lucide-react";
import type { ClaudeBackend } from "@codecast/shared/contracts";
import { useClaudeBackend } from "../hooks/useSessionCommands";
import { useManagedSessionFields } from "../hooks/useManagedSessionFields";
import { requestBackendSwitch } from "../lib/sessionCommands";
import { backendRows, type BackendRow } from "../lib/claudeBackendControl";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { DeviceDot } from "./DeviceBadge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

const BACKEND_ICON: Record<ClaudeBackend, typeof Cpu> = { tmux: SquareTerminal, sdk: Cpu };

function press(conversationId: string, row: BackendRow) {
  if (!row.action) return;
  // A refusal settles the row with the standard dispatch toast; a daemon's refusal shows on the control.
  void requestBackendSwitch(conversationId, row.backend, row.action === "interrupt_and_switch").catch(() => {});
}

function useBackendRows(conversationId: string) {
  const { backend, switching } = useClaudeBackend(conversationId);
  const status = useManagedSessionFields(conversationId)?.agent_status;
  return { backend, switching, rows: backendRows(backend, status, switching) };
}

/** The session control panel's "Runs in" section. */
export function BackendRunsInRows({ conversationId, sectionLabelClassName }: { conversationId: string; sectionLabelClassName: string }) {
  const { switching, rows } = useBackendRows(conversationId);
  return (
    <div data-backend-rows>
      <div className={sectionLabelClassName}>Runs in</div>
      <div className="pb-1">
        {rows.map((row) => {
          const Icon = BACKEND_ICON[row.backend];
          return (
            <DropdownMenuItem
              key={row.backend}
              data-backend-row={row.backend}
              data-current={row.current || undefined}
              disabled={!row.action && !row.current}
              onSelect={(e) => { e.preventDefault(); press(conversationId, row); }}
              className={`group mx-1 flex items-center gap-2.5 px-2 py-1.5 ${row.current ? "cursor-default" : ""}`}
            >
              <Icon className={`h-3.5 w-3.5 shrink-0 transition-colors ${row.current ? "text-sol-cyan" : "text-sol-text-dim group-focus:text-sol-cyan"}`} />
              <span className="flex min-w-0 flex-col">
                <span className="text-xs text-sol-text">{row.verb ?? row.label}</span>
                <span className="truncate text-[10px] text-sol-text-dim">{row.verb ? row.label : row.hint}</span>
              </span>
              {row.current && <span className="ml-auto shrink-0 text-[10px] text-sol-text-dim">current</span>}
            </DropdownMenuItem>
          );
        })}
        {switching && "failed" in switching && (
          <div data-backend-failed className="mx-3 mt-0.5 mb-1 text-[10px] leading-snug text-sol-red">{switching.failed}</div>
        )}
      </div>
    </div>
  );
}

/**
 * The header pill of a session running in an Agent SDK host. It sits where a
 * tmux session's terminal pill sits, because that is where a person looks for
 * the terminal; it has none, so it offers the move to one.
 */
export function SdkBackendPill({ conversationId, isLive, canSwitch }: { conversationId: string; isLive: boolean; canSwitch: boolean }) {
  const { switching, rows } = useBackendRows(conversationId);
  const toTerminal = rows.find((r) => r.backend === "tmux")!;
  const moving = switching && "moving" in switching;
  const failed = switching && "failed" in switching ? switching.failed : null;
  const colors = failed
    ? "bg-sol-red/10 text-sol-red border-sol-red/30 hover:bg-sol-red/20"
    : isLive
      ? "bg-sol-violet/10 text-sol-violet border-sol-violet/30 hover:bg-sol-violet/20"
      : "bg-gray-500/10 text-gray-400 border-gray-500/25 hover:bg-gray-500/20";
  const body = (
    <span className="inline-flex items-center gap-1">
      <Cpu className="w-3 h-3" />
      <span className="cq-sq2">{moving ? "SDK → tmux" : "SDK"}</span>
      <DeviceDot online={isLive} />
    </span>
  );
  const pillClass = `inline-flex items-center rounded-full border pl-2 pr-1.5 py-0.5 text-[10px] font-medium transition-colors ${colors}`;
  if (!canSwitch) {
    return (
      <ShortcutTooltip label="Runs in an Agent SDK host: no terminal pane" side="bottom">
        <span data-sdk-pill className={pillClass}>{body}</span>
      </ShortcutTooltip>
    );
  }
  return (
    <DropdownMenu>
      <ShortcutTooltip label={failed ?? "Runs in an Agent SDK host: no terminal pane"} side="bottom">
        <DropdownMenuTrigger asChild>
          <button type="button" data-sdk-pill className={pillClass}>{body}</button>
        </DropdownMenuTrigger>
      </ShortcutTooltip>
      <DropdownMenuContent align="start" className="w-64 p-1">
        <DropdownMenuItem
          data-sdk-to-terminal
          disabled={!toTerminal.action}
          onSelect={() => press(conversationId, toTerminal)}
          className="flex items-center gap-2.5 px-2 py-1.5"
        >
          <SquareTerminal className="h-3.5 w-3.5 shrink-0 text-sol-text-dim" />
          <span className="flex min-w-0 flex-col">
            <span className="text-xs text-sol-text">{toTerminal.verb ?? "Switch to terminal"}</span>
            <span className="truncate text-[10px] text-sol-text-dim">{moving ? "Moving…" : "Same session, in a tmux pane"}</span>
          </span>
        </DropdownMenuItem>
        {failed && <div data-backend-failed className="px-2 pb-1 text-[10px] leading-snug text-sol-red">{failed}</div>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
