"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useInboxStore } from "../../store/inboxStore";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { DeviceDot } from "../DeviceBadge";
import { DiffView } from "../DiffView";
import { ConsequentialSwitch } from "../consequential/ConsequentialSwitch";
import { kitRemoveLedger, kitShareLedger } from "../consequential/ledgers";
import { isBroken, type FleetGridRow } from "./fleetRows";
import { confidenceFromKind, confidenceFromSurfaces, kindMeta, type CapabilityDevice } from "./kinds";
import { ReachControl } from "./KitList";
import { setKitReach, useKitReach, type KitItem, type KitConflict, type KitWorkspace, type PendingConsent } from "./useKit";

export type Selection = { key: string };

const MARKDOWN_KINDS = new Set(["skill", "command", "subagent", "snippet", "instructions"]);

function withoutFrontmatter(md: string): string {
  if (!md.startsWith("---")) return md;
  const end = md.indexOf("\n---", 3);
  return end < 0 ? md : md.slice(end + 4).replace(/^\s+/, "") || md;
}

/**
 * One capability, opened. The header carries the one action that applies: the
 * reach control for a kit item, Share for something only your machines have.
 * Then where it is, machine by machine, and the file itself.
 */
export function CapabilityPane({
  row,
  kitItem,
  devices,
  ws,
  shareable,
  pending,
  conflicts,
  onClose,
}: {
  row: FleetGridRow | undefined;
  kitItem: KitItem | undefined;
  devices: CapabilityDevice[];
  ws: KitWorkspace;
  shareable: boolean;
  pending: PendingConsent[];
  conflicts: KitConflict[];
  onClose: () => void;
}) {
  const kind = kitItem?.kind ?? String(row?.kind ?? "");
  const name = kitItem?.name ?? row?.identity ?? "";
  const description = kitItem?.description ?? row?.description;
  const meta = kindMeta(kind);

  return (
    <div className="rounded-lg border border-sol-border bg-sol-card overflow-hidden">
      <div className="px-4 pt-3 pb-3 border-b border-sol-border">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-sol-text truncate">{name}</span>
          <span className="text-[11px] text-sol-text-dim">{meta?.label ?? kind}</span>
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="text-sol-text-dim hover:text-sol-text" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        {description && <p className="mt-1 text-xs text-sol-text-muted leading-relaxed line-clamp-3">{description}</p>}
        <div className="mt-3">
          {kitItem ? (
            <KitAction item={kitItem} ws={ws} devices={devices} pending={pending.filter((p) => p.slug === kitItem.slug)} conflicts={conflicts.filter((c) => c.slug === kitItem.slug)} />
          ) : shareable && row ? (
            <ShareAction row={row} devices={devices} ws={ws} />
          ) : null}
        </div>
      </div>

      {devices.length > 0 && <Machines row={row} devices={devices} />}

      {kitItem ? (
        <KitBody item={kitItem} />
      ) : row && MARKDOWN_KINDS.has(kind) ? (
        <MachineBody kind={kind} name={row.identity} />
      ) : row ? (
        <Facts row={row} />
      ) : null}
    </div>
  );
}

function KitAction({
  item,
  ws,
  devices,
  pending,
  conflicts,
}: {
  item: KitItem;
  ws: KitWorkspace;
  devices: CapabilityDevice[];
  pending: PendingConsent[];
  conflicts: KitConflict[];
}) {
  const slugs = useMemo(() => [item.slug], [item.slug]);
  const r = useKitReach(slugs)[item.slug] ?? { reach: "off" as const, teamOn: false };
  const meId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const members = useInboxStore((s) => (ws.kind === "team" ? (s.teamMembers ?? []).length : 1));
  const remove = useInboxStore((s) => s.removeKitItem);
  const allow = useInboxStore((s) => s.grantKitConsent);
  const adopt = useInboxStore((s) => s.adoptKitItem);
  const [allowed, setAllowed] = useState<Set<string>>(() => new Set());
  const canRemove = ws.isAdmin || (!!meId && item.author_user_id === meId);
  const waiting = pending.filter((p) => !allowed.has(`${p.device_id}|${p.hash}`));
  const clashing = conflicts.filter((c) => !allowed.has(`${c.device_id}|${c.hash}`));
  const settle = (c: { device_id: string; hash: string }) => setAllowed((s) => new Set(s).add(`${c.device_id}|${c.hash}`));
  return (
    <div className="space-y-2">
    <div className="flex items-center gap-3">
      <ReachControl
        item={item}
        value={r.reach}
        teamOn={r.teamOn}
        ws={ws}
        disabled={!!item.publishing}
        onChange={(next) => setKitReach(item, next, ws, r)}
      />
      <span className="text-[11px] text-sol-text-dim tabular-nums">
        {item.publishing ? "Uploading from its machine" : `v${item.current_version ?? 1}`}
      </span>
      <div className="flex-1" />
      {canRemove && !item.publishing && (
        <ConsequentialSwitch
          on={false}
          ledger={kitRemoveLedger({ name: item.name, kit: ws.name, members })}
          onTurnOn={() => remove(item._id)}
          onTurnOff={() => undefined}
          trigger={(p) => (
            <button type="button" onClick={p.press} className="text-[11px] text-sol-text-dim hover:text-sol-red">
              Remove from kit
            </button>
          )}
        />
      )}
    </div>
    {clashing.map((c) => {
      const d = devices.find((x) => x.deviceId === c.device_id);
      return (
        <div key={`c|${c.device_id}|${c.hash}`} className="flex items-center gap-2 text-[11px]">
          <span className="h-1.5 w-1.5 rounded-full bg-sol-yellow" />
          <span className="text-sol-text">{d?.name ?? "A machine"}</span>
          <span className="text-sol-text-dim truncate" title={c.detail}>has its own copy</span>
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => {
                setKitReach(item, "off", ws, r);
                settle(c);
              }}
              className="h-6 px-2 rounded border border-sol-border text-sol-text-muted hover:text-sol-text"
            >
              Keep mine
            </button>
            <button
              type="button"
              title="Your copy is moved aside, not deleted"
              onClick={() => {
                adopt(c);
                settle(c);
              }}
              className="h-6 px-2 rounded border border-sol-blue text-sol-blue hover:bg-sol-bg-alt"
            >
              Use the kit's
            </button>
          </div>
        </div>
      );
    })}
    {waiting.map((p) => {
      const d = devices.find((x) => x.deviceId === p.device_id);
      return (
        <div key={`${p.device_id}|${p.hash}`} className="flex items-center gap-2 text-[11px]">
          <span className="h-1.5 w-1.5 rounded-full bg-sol-orange" />
          <span className="text-sol-text">{d?.name ?? "A machine"}</span>
          <span className="text-sol-text-dim">waiting: it runs code</span>
          <button
            type="button"
            onClick={() => {
              allow(p);
              setAllowed((s) => new Set(s).add(`${p.device_id}|${p.hash}`));
            }}
            className="ml-auto h-6 px-2 rounded border border-sol-orange text-sol-orange hover:bg-sol-bg-alt"
          >
            Allow
          </button>
        </div>
      );
    })}
    </div>
  );
}

function ShareAction({ row, devices, ws }: { row: FleetGridRow; devices: CapabilityDevice[]; ws: KitWorkspace }) {
  const share = useInboxStore((s) => s.shareToKit);
  const members = useInboxStore((s) => (ws.kind === "team" ? (s.teamMembers ?? []).length : 1));
  // Upload from a machine that has it, preferring one that is online now.
  const source = devices
    .filter((d) => row.byDevice[d.deviceId]?.present)
    .sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen)[0];
  const ledger = kitShareLedger({
    name: row.identity,
    kindLabel: kindMeta(String(row.kind))?.label ?? String(row.kind),
    kit: ws.name,
    members,
    runs: confidenceFromKind(String(row.kind)),
    machine: source ? `${source.name}${source.online ? "" : " (offline, uploads when it wakes)"}` : "No machine has it",
  });
  if (!ws.key || !ws.ownerId) return null;
  return (
    <ConsequentialSwitch
      on={false}
      ledger={source ? ledger : { ...ledger, blocked: "No machine has it" }}
      onTurnOn={() =>
        source &&
        share({ kind: String(row.kind), name: row.identity, description: row.description, device_id: source.deviceId, workspace: ws.key!, team_id: ws.teamId, owner_id: ws.ownerId! })
      }
      onTurnOff={() => undefined}
      trigger={(p) => (
        <button
          type="button"
          onClick={p.press}
          className="h-7 px-3 rounded-md border border-sol-border text-xs text-sol-text hover:border-sol-blue hover:text-sol-blue transition-colors"
        >
          {ws.kind === "team" ? `Share to ${ws.name}` : "Add to your kit"}
        </button>
      )}
    />
  );
}

/** Where it is: one line when every machine agrees, otherwise the machines that differ, by state. */
function Machines({ row, devices }: { row: FleetGridRow | undefined; devices: CapabilityDevice[] }) {
  const groups: Record<"on" | "missing" | "broken" | "off" | "unknown", CapabilityDevice[]> = {
    on: [],
    missing: [],
    broken: [],
    off: [],
    unknown: [],
  };
  for (const d of devices) {
    const cell = row?.byDevice[d.deviceId];
    const state =
      !cell || cell.status === "unknown"
        ? "unknown"
        : !cell.present
          ? "missing"
          : isBroken(cell)
            ? "broken"
            : !cell.enabled
              ? "off"
              : "on";
    groups[state].push(d);
  }
  const lines: Array<{ key: string; label: string; tone: string; list: CapabilityDevice[] }> = [
    { key: "missing", label: "Missing on", tone: "text-sol-yellow", list: groups.missing },
    { key: "broken", label: "Not downloaded on", tone: "text-sol-red", list: groups.broken },
    { key: "off", label: "Off on", tone: "text-sol-text-muted", list: groups.off },
    { key: "unknown", label: "Not reported by", tone: "text-sol-text-dim", list: groups.unknown },
  ].filter((l) => l.list.length > 0);
  return (
    <div className="px-4 py-3 border-b border-sol-border space-y-1.5 text-[11px]">
      <div className="text-sol-text-muted tabular-nums">
        {groups.on.length === devices.length
          ? `On all ${devices.length} machines`
          : `On ${groups.on.length} of ${devices.length} machines`}
      </div>
      {lines.map((l) => (
        <div key={l.key} className="flex items-baseline gap-2">
          <span className={`shrink-0 ${l.tone}`}>{l.label}</span>
          <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-sol-text">
            {l.list.map((d) => (
              <span key={d.deviceId} className="inline-flex items-center gap-1">
                <DeviceDot online={d.online} />
                {d.name}
              </span>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

function Body({ markdown, footer }: { markdown: string; footer?: string }) {
  const [raw, setRaw] = useState(false);
  return (
    <div className="relative px-4 py-3 max-h-[min(70vh,44rem)] overflow-y-auto">
      <button
        type="button"
        onClick={() => setRaw((r) => !r)}
        className="absolute right-3 top-2 text-[11px] text-sol-text-dim hover:text-sol-text"
      >
        {raw ? "Rendered" : "Source"}
      </button>
      {raw ? (
        <pre className="text-[11px] font-mono text-sol-text whitespace-pre-wrap break-words">{markdown}</pre>
      ) : (
        <MarkdownRenderer content={withoutFrontmatter(markdown)} className="!text-[13px]" />
      )}
      {footer && <p className="mt-3 text-[11px] text-sol-text-dim">{footer}</p>}
    </div>
  );
}

function MachineBody({ kind, name }: { kind: string; name: string }) {
  const { data } = useQueryNoThrow(api.capabilities.webCapabilityContent, { kind, name });
  if (data === undefined) return <p className="px-4 py-3 text-xs text-sol-text-dim">Loading file…</p>;
  if (!data?.body) return <p className="px-4 py-3 text-xs text-sol-text-dim">File not synced yet</p>;
  return <Body markdown={data.body} footer={data.truncated ? "Cut at 64KB" : undefined} />;
}

type KitVersion = {
  version: number;
  note?: string;
  author_user_id?: string;
  created_at: number;
  main_body?: string;
  files?: Array<{ path: string; size: number }>;
  surfaces?: string[];
};

function KitBody({ item }: { item: KitItem }) {
  const { data } = useQueryNoThrow(
    api.teamKit.webVersions,
    item.publishing ? "skip" : { item_id: item._id as any },
  );
  const versions = (data ?? []) as KitVersion[];
  const [picked, setPicked] = useState<number | null>(null);
  const [changes, setChanges] = useState(false);
  const shown = versions.find((v) => v.version === picked) ?? versions[0];
  const previous = shown ? versions.find((v) => v.version === shown.version - 1) : undefined;
  if (item.publishing) return <p className="px-4 py-3 text-xs text-sol-text-dim">Waiting for the upload…</p>;
  if (data === undefined) return <p className="px-4 py-3 text-xs text-sol-text-dim">Loading…</p>;
  if (!shown) return <p className="px-4 py-3 text-xs text-sol-text-dim">No versions</p>;
  const runsCode = confidenceFromSurfaces(shown.surfaces as any) !== "prose";
  return (
    <>
      <div className="px-4 py-2 border-b border-sol-border flex items-center gap-1 flex-wrap">
        {versions.map((v) => (
          <button
            key={v.version}
            type="button"
            onClick={() => setPicked(v.version)}
            title={v.note}
            className={`h-6 px-2 rounded text-[11px] tabular-nums ${
              v.version === shown.version ? "bg-sol-bg-alt text-sol-text" : "text-sol-text-dim hover:text-sol-text"
            }`}
          >
            v{v.version}
          </button>
        ))}
        {previous && (
          <button
            type="button"
            onClick={() => setChanges((c) => !c)}
            className={`ml-2 h-6 px-2 rounded text-[11px] ${changes ? "bg-sol-bg-alt text-sol-text" : "text-sol-text-dim hover:text-sol-text"}`}
          >
            Changes from v{previous.version}
          </button>
        )}
        <div className="flex-1" />
        <span className="text-[11px] text-sol-text-dim tabular-nums">
          {shown.files?.length ?? 0} files
          {runsCode && <span className="ml-2 text-sol-orange">runs code</span>}
        </span>
      </div>
      {shown.note && <p className="px-4 pt-3 text-xs text-sol-text-muted">{shown.note}</p>}
      {changes && previous ? (
        <div className="px-4 py-3 max-h-[min(70vh,44rem)] overflow-y-auto">
          <DiffView oldStr={previous.main_body ?? ""} newStr={shown.main_body ?? ""} fileName={`${item.name}.md`} contextLines={3} />
        </div>
      ) : shown.main_body ? (
        <Body markdown={shown.main_body} />
      ) : null}
    </>
  );
}

function Facts({ row }: { row: FleetGridRow }) {
  const facts = [row.command, row.url, row.event && `on ${row.event}`, row.source].filter(Boolean) as string[];
  if (facts.length === 0) return null;
  return (
    <div className="px-4 py-3 space-y-1">
      {facts.map((f) => (
        <pre key={f} className="text-[11px] font-mono text-sol-text-muted whitespace-pre-wrap break-all">
          {f}
        </pre>
      ))}
    </div>
  );
}
