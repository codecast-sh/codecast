"use client";

/**
 * A cloud session's working tree, mirrored live into a worktree on one of
 * the viewer's laptops (conversations.local_mirror, written by that laptop's
 * daemon). Two surfaces:
 *
 * - MirrorMenuItems: the section in the session's machine menu that starts
 *   or stops the mirror, naming the laptop it would use (the same
 *   mirrorLaptops choice the server makes).
 * - LocalMirrorChip: the header chip while a mirror exists, with what the
 *   mirror is doing and the one next step for each state.
 */

import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { FolderSync } from "lucide-react";
import { toast } from "sonner";
import { mirrorLaptops, repoNameOf, type LocalMirror } from "@codecast/shared/contracts";
import { useInboxStore } from "../store/inboxStore";
import { openExternalUrl } from "../lib/desktop";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { DeviceDot, DeviceIcon, deviceDisplayName, relativeSeen, useDevices } from "./DeviceBadge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

const ONLINE_MS = 2 * 60_000;

/** The fields the mirror surfaces read, narrowly, so a liveness beat never re-renders them. */
function useMirrorRow(conversationId: string) {
  return useInboxStore(
    useShallow((s) => {
      const row: any = s.sessions[s.resolveLiveSessionId(conversationId)] ?? s.conversations[conversationId];
      return {
        mirror: (row?.local_mirror ?? null) as LocalMirror | null,
        gitRemoteUrl: (row?.git_remote_url ?? null) as string | null,
        projectPath: (row?.project_path ?? null) as string | null,
        seedDevice: (row?.cloud_seed?.device_id ?? null) as string | null,
        seedRoot: (row?.cloud_seed?.laptop_root ?? null) as string | null,
      };
    }),
  );
}

/** Laptops that can mirror this session, best first, with their roster entries. */
function useMirrorLaptops(conversationId: string) {
  const { devices, byId } = useDevices();
  const row = useMirrorRow(conversationId);
  const laptops = useMemo(() => mirrorLaptops(
    devices,
    { git_remote_url: row.gitRemoteUrl, project_path: row.projectPath, cloud_seed: { device_id: row.seedDevice, laptop_root: row.seedRoot } },
    Date.now(),
    ONLINE_MS,
  ).map((l) => ({ ...l, device: byId.get(l.device_id)!, online: !!byId.get(l.device_id)?.online })), [devices, byId, row.gitRemoteUrl, row.projectPath, row.seedDevice, row.seedRoot]);
  return { laptops, row, byId, repo: repoNameOf(row.gitRemoteUrl, row.projectPath) };
}

export function MirrorMenuItems({ conversationId }: { conversationId: string }) {
  const { laptops, row, byId, repo } = useMirrorLaptops(conversationId);
  const setLocalMirror = useInboxStore((s) => s.setLocalMirror);
  const mirror = row.mirror && row.mirror.status !== "stopping" ? row.mirror : null;
  const mirrorDevice = mirror ? byId.get(mirror.device_id) : undefined;
  return (
    <>
      <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-sol-text-dim">Mirror edits · see them on a laptop</DropdownMenuLabel>
      {mirror ? (
        <>
          <DropdownMenuItem disabled>
            <FolderSync className="w-3 h-3 mr-1.5" />
            <span className="flex-1 truncate">Mirroring to {mirrorDevice ? deviceDisplayName(mirrorDevice) : "a laptop"}</span>
            <span className="ml-2 text-[10px] text-gray-400">{STATUS_WORD[mirror.status]}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setLocalMirror(conversationId, false)}>
            <span className="pl-[18px]">Stop mirroring</span>
          </DropdownMenuItem>
        </>
      ) : laptops.length === 0 ? (
        <DropdownMenuItem disabled>
          <span className="text-[11px] text-sol-text-dim">No laptop of yours has a checkout of {repo ?? "this repository"}</span>
        </DropdownMenuItem>
      ) : laptops.map((l) => (
        <DropdownMenuItem
          key={l.device_id}
          disabled={!l.online}
          onSelect={() => l.online && setLocalMirror(conversationId, true, l.device_id)}
          title={`Mirrors into ${l.root}/.codecast/worktrees/sync-… on ${deviceDisplayName(l.device)}`}
        >
          <DeviceIcon d={l.device} className="w-3 h-3 mr-1.5" />
          <span className="flex-1 truncate">Mirror to {deviceDisplayName(l.device)}</span>
          <span className="ml-2 flex shrink-0 items-center gap-1 whitespace-nowrap text-[10px] text-gray-400">
            {l.online ? "" : "offline"}
            <DeviceDot online={l.online} />
          </span>
        </DropdownMenuItem>
      ))}
    </>
  );
}

const STATUS_WORD: Record<LocalMirror["status"], string> = {
  starting: "starting",
  live: "live",
  paused: "paused",
  local_edit: "stopped",
  error: "failed",
  stopping: "stopping",
};

const TONE: Record<LocalMirror["status"], string> = {
  starting: "text-sol-text-dim animate-pulse",
  live: "text-sol-green",
  paused: "text-sol-text-dim",
  local_edit: "text-sol-yellow",
  error: "text-sol-red",
  stopping: "text-sol-text-dim animate-pulse",
};

function chipLabel(m: LocalMirror, now: number): string {
  switch (m.status) {
    case "starting": return "mirroring…";
    case "stopping": return "stopping mirror…";
    case "live": return m.last_landed_at ? `mirrored · ${relativeSeen(Math.min(m.last_landed_at, now))}` : "mirrored";
    case "paused": return "mirror paused";
    case "local_edit": return `mirror stopped · ${m.files?.length ?? 0} edited here`;
    case "error": return "mirror failed";
  }
}

function chipTitle(m: LocalMirror, laptop: string): string {
  const where = m.path ? `${m.path} on ${laptop}` : laptop;
  switch (m.status) {
    case "starting": return `Starting a live mirror into ${where}.`;
    case "stopping": return `Stopping the mirror on ${laptop}. The folder stays.`;
    case "live": return `This session's edits land in ${where} as the agent makes them${m.last_landed_at ? `; the last one landed ${relativeSeen(m.last_landed_at)}` : ""}.`;
    case "paused": return `Mirror into ${where} is paused while the session is idle, so the cloud host can sleep. It resumes when the session works again.`;
    case "local_edit": return `The mirror stopped because ${m.files?.length ?? 0} file(s) were edited in ${where}: ${(m.files ?? []).slice(0, 5).join(", ")}. Overwriting keeps your edits in a backup ref first.`;
    case "error": return `The mirror into ${where} failed: ${m.error ?? "unknown error"}.`;
  }
}

function openIn(scheme: "cursor" | "vscode", p: string) {
  openExternalUrl(`${scheme}://file${p}`);
}

export function LocalMirrorChip({ conversationId, compact = false }: { conversationId: string; compact?: boolean }) {
  const { mirror } = useMirrorRow(conversationId);
  const { byId } = useDevices();
  const setLocalMirror = useInboxStore((s) => s.setLocalMirror);
  const now = useCoarseNow(mirror?.status === "live" ? 5_000 : 60_000);
  if (!mirror) return null;
  const laptop = byId.get(mirror.device_id);
  const laptopName = laptop ? deviceDisplayName(laptop) : "your laptop";
  const copy = () => { if (mirror.path) { void navigator.clipboard.writeText(mirror.path); toast.success("Mirror path copied"); } };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-local-mirror={mirror.status}
          title={chipTitle(mirror, laptopName)}
          className={`inline-flex items-center gap-1 rounded-full border border-sol-border/40 px-2 py-0.5 text-[10px] font-medium outline-none transition-colors hover:border-sol-border/80 ${TONE[mirror.status]}`}
        >
          <FolderSync className="w-3 h-3" />
          {!compact && <span className="whitespace-nowrap cq-sq1">{chipLabel(mirror, now)}</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[16rem] max-w-[24rem]">
        <div className="px-2 py-1.5 text-[11px] leading-snug text-sol-text-muted">{chipTitle(mirror, laptopName)}</div>
        {mirror.path && <div className="px-2 pb-1.5 font-mono text-[10px] text-sol-text-dim break-all">{mirror.path}</div>}
        <DropdownMenuSeparator />
        {mirror.status === "local_edit" && (
          <DropdownMenuItem onSelect={() => setLocalMirror(conversationId, true, mirror.device_id, true)}>Overwrite with the host's (your edits kept in a backup ref)</DropdownMenuItem>
        )}
        {mirror.status === "error" && (
          <DropdownMenuItem onSelect={() => setLocalMirror(conversationId, true, mirror.device_id)}>Retry</DropdownMenuItem>
        )}
        {mirror.path && mirror.status !== "stopping" && (
          <>
            <DropdownMenuItem onSelect={() => openIn("cursor", mirror.path!)}>Open in Cursor</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openIn("vscode", mirror.path!)}>Open in VS Code</DropdownMenuItem>
            <DropdownMenuItem onSelect={copy}>Copy path</DropdownMenuItem>
          </>
        )}
        {mirror.status !== "stopping" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setLocalMirror(conversationId, false)}>Stop mirroring</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
