"use client";

import { useMemo, useState } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { X } from "lucide-react";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { kindMeta, ScopeChip, type CapabilityDevice } from "./CapabilityCard";
import { EquipControl, type EquipTarget } from "./EquipControl";
import { TokenCostBadge } from "./TokenCostBadge";
import { isBroken, type FleetGridRow } from "./FleetMatrix";

/**
 * Read one capability: the SKILL.md (or command, snippet, agent file) as the
 * machine last sent it, plus where it lives. MCP servers and hooks have no
 * markdown, so this shows the command line instead.
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
            <TokenCostBadge cost={row.cost} />
          </div>
          {row.description && (
            <p className="mt-1 text-xs text-sol-text-muted leading-relaxed">{row.description}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-sol-text-dim hover:text-sol-text"
          aria-label="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="px-3 py-2.5 space-y-3 max-h-[min(70vh,40rem)] overflow-y-auto">
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

        {waiting && (
          <div className="text-xs text-sol-text-dim">Loading file…</div>
        )}
        {!waiting && body && (
          <div>
            <div className="flex items-center justify-end mb-2">
              <button
                type="button"
                onClick={() => setRaw((v) => !v)}
                className="text-[10px] text-sol-text-dim hover:text-sol-text"
              >
                {raw ? "Rendered" : "Raw file"}
              </button>
            </div>
            {raw ? (
              <pre className="text-[11px] font-mono text-sol-text whitespace-pre-wrap break-words">
                {body}
              </pre>
            ) : (
              <MarkdownRenderer content={rendered?.body ?? body} className="!text-[13px]" />
            )}
            {content?.truncated && (
              <p className="mt-2 text-[11px] text-sol-text-dim">This file was cut at 64KB.</p>
            )}
          </div>
        )}
        {!waiting && MARKDOWN_KINDS.has(String(row.kind)) && !body && (
          <p className="text-xs text-sol-text-muted leading-relaxed">
            The file has not synced from a machine yet. New skills usually show
            up within a minute of landing on disk.
          </p>
        )}

        <div className="grid gap-1.5 [grid-template-columns:repeat(auto-fill,minmax(160px,1fr))]">
          {devices.map((d) => {
            const cell = row.byDevice[d.deviceId];
            const status = cell?.status ?? "unknown";
            return (
              <div key={d.deviceId} className="flex items-center gap-2 px-2 py-1.5 rounded bg-sol-bg-alt">
                <span className="text-[11px] text-sol-text truncate flex-1" title={d.name}>
                  {d.name}
                </span>
                {status === "unknown" || !cell ? (
                  <span className="text-[10px] text-sol-yellow">not reported</span>
                ) : status === "absent" ? (
                  <span className="text-[10px] text-sol-text-dim">not here</span>
                ) : isBroken(cell) ? (
                  <span className="text-[10px] text-sol-red">broken</span>
                ) : (
                  <span className="flex items-center gap-1">
                    {cell.scopes.map((scope) => (
                      <ScopeChip key={scope} scope={scope} />
                    ))}
                    {status === "disabled" && (
                      <span className="text-[10px] text-sol-text-dim">off</span>
                    )}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {equip && (
          <div className="flex justify-end">
            <EquipControl target={equip} />
          </div>
        )}
      </div>
    </div>
  );
}
