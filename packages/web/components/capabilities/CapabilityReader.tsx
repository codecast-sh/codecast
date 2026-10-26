"use client";

import { useMemo, useState } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { X } from "lucide-react";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { kindMeta, ScopeChip, type CapabilityDevice } from "./CapabilityCard";
import { EquipControl, type EquipTarget } from "./EquipControl";
import { TokenCostBadge } from "./TokenCostBadge";
import { isBroken, shortPin, type FleetGridRow } from "./FleetMatrix";
import { DeviceDot } from "../DeviceBadge";
import { SegmentedToggle } from "../SegmentedToggle";

/**
 * One capability, opened: where it is on (the equip control, top right), what
 * each machine holds, then the SKILL.md (or command, snippet, agent file) as a
 * machine last sent it. MCP servers and hooks have no markdown, so they show
 * their command line instead. Installed and Machines both open this panel.
 */

function splitFrontmatter(md: string): { body: string; hadMatter: boolean } {
  if (!md.startsWith("---")) return { body: md, hadMatter: false };
  const end = md.indexOf("\n---", 3);
  if (end < 0) return { body: md, hadMatter: false };
  const rest = md.slice(end + 4).replace(/^\s+/, "");
  return { body: rest || md, hadMatter: true };
}

const MARKDOWN_KINDS = new Set(["skill", "command", "subagent", "snippet"]);

export function CapabilityReader({
  row,
  devices,
  onClose,
  equip,
}: {
  row: FleetGridRow;
  devices: CapabilityDevice[];
  onClose: () => void;
  equip?: EquipTarget;
}) {
  const meta = kindMeta(String(row.kind));
  const Icon = meta?.icon;
  const [raw, setRaw] = useState(false);
  const { data: content } = useQueryNoThrow(
    api.capabilities.webCapabilityContent,
    MARKDOWN_KINDS.has(String(row.kind))
      ? { kind: String(row.kind), name: row.identity }
      : "skip",
  );
  const waiting = MARKDOWN_KINDS.has(String(row.kind)) && content === undefined;
  const body = content?.body;
  const rendered = useMemo(() => (body ? splitFrontmatter(body) : null), [body]);

  return (
    <div className="rounded-lg border border-sol-border bg-sol-card overflow-hidden">
      <div className="flex items-start gap-2 px-3 py-2.5 border-b border-sol-border/60">
        {Icon && <Icon className="w-4 h-4 mt-0.5 text-sol-magenta flex-shrink-0" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm text-sol-text">{row.identity}</span>
            <span className="text-[10px] text-sol-text-dim">{meta?.label ?? String(row.kind)}</span>
            {row.marketplace && (
              <span className="text-[10px] font-mono text-sol-text-dim">{row.marketplace}</span>
            )}
            <TokenCostBadge cost={row.cost} />
          </div>
          {row.description && (
            <p className="mt-1 text-xs text-sol-text-muted leading-relaxed line-clamp-3">{row.description}</p>
          )}
        </div>
        {equip && <EquipControl target={equip} />}
        <button
          type="button"
          onClick={onClose}
          className="mt-1 text-sol-text-dim hover:text-sol-text"
          aria-label="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <DeviceStatusGrid row={row} devices={devices} />

      <div className="px-3 py-2.5 space-y-3 max-h-[min(70vh,40rem)] overflow-y-auto border-t border-sol-border/60">
        {row.command && (
          <pre className="text-[11px] font-mono text-sol-text bg-sol-bg-alt rounded px-2 py-1.5 overflow-x-auto">
            {row.command}
          </pre>
        )}
        {row.url && (
          <div className="text-[11px] font-mono text-sol-text-muted break-all">{row.url}</div>
        )}
        {row.event && (
          <div className="text-[11px] text-sol-text-muted">
            event <span className="font-mono text-sol-text">{row.event}</span>
          </div>
        )}
        {row.source && (
          <div className="text-[11px] font-mono text-sol-text-dim break-all">{row.source}</div>
        )}

        {waiting && <div className="text-xs text-sol-text-dim">Loading file…</div>}
        {!waiting && body && (
          <div>
            <div className="flex items-center justify-end mb-2">
              <SegmentedToggle
                size="sm"
                variant="bare"
                value={raw ? "raw" : "rendered"}
                onChange={(v) => setRaw(v === "raw")}
                items={[
                  { key: "rendered", label: "Rendered" },
                  { key: "raw", label: "Raw" },
                ]}
              />
            </div>
            {raw ? (
              <pre className="text-[11px] font-mono text-sol-text whitespace-pre-wrap break-words">
                {body}
              </pre>
            ) : (
              <MarkdownRenderer content={rendered?.body ?? body} className="!text-[13px]" />
            )}
            {content?.truncated && (
              <p className="mt-2 text-[11px] text-sol-text-dim">Cut at 64KB</p>
            )}
          </div>
        )}
        {!waiting && MARKDOWN_KINDS.has(String(row.kind)) && !body && (
          <p className="text-xs text-sol-text-dim">File not synced yet</p>
        )}
      </div>
    </div>
  );
}

/**
 * Where this capability is, machine by machine: the scopes beyond user, and
 * the pin when the machines hold more than one.
 */
function DeviceStatusGrid({ row, devices }: { row: FleetGridRow; devices: CapabilityDevice[] }) {
  return (
    <div className="px-3 py-2 grid gap-x-3 gap-y-1 [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]">
      {devices.map((d) => {
        const cell = row.byDevice[d.deviceId];
        const status = cell?.status ?? "unknown";
        return (
          <div key={d.deviceId} className="flex items-center gap-2 min-w-0 h-6">
            <DeviceDot online={d.online} />
            <span className="text-[11px] text-sol-text truncate flex-1" title={d.name}>
              {d.name}
            </span>
            {status === "unknown" || !cell ? (
              <span className="text-[10px] text-sol-yellow">not reported</span>
            ) : status === "absent" ? (
              <span className="text-[10px] text-sol-text-dim">—</span>
            ) : isBroken(cell) ? (
              <span className="text-[10px] text-sol-red">not downloaded</span>
            ) : (
              <span className="flex items-center gap-1 flex-shrink-0">
                {status !== "disabled" && (
                  <span
                    className={`h-1.5 w-1.5 rounded-[2px] ${
                      status === "pin_differs" ? "bg-sol-orange" : "bg-sol-green"
                    }`}
                  />
                )}
                {/* User scope is the default and gets no mark, as in the matrix;
                    project and local are the answers to "why is this here?". */}
                {cell.scopes.filter((scope) => scope !== "user").map((scope) => (
                  <ScopeChip key={scope} scope={scope} />
                ))}
                {cell.pin && row.pins.length > 1 && (
                  <span
                    className={`text-[10px] font-mono ${
                      status === "pin_differs" ? "text-sol-orange" : "text-sol-text-muted"
                    }`}
                  >
                    {shortPin(cell.pin)}
                  </span>
                )}
                {status === "disabled" && <span className="text-[10px] text-sol-text-dim">off</span>}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
