"use client";

/**
 * A cloud session's working folder kept in step with a copy on one of the
 * viewer's laptops (conversations.local_mirror, written by that laptop's
 * daemon). Changes travel both ways by default, or only from the cloud in
 * watch-only mode. Two surfaces:
 *
 * - MirrorMenuItems: the section in the session's machine menu that starts
 *   or stops the sync, naming the laptop it would use (the same
 *   mirrorLaptops choice the server makes).
 * - LocalMirrorChip: the header chip while a sync exists: what it is doing,
 *   files changed on both sides with a pick for each, what stayed on its own
 *   machine and why, and the one next step for each state.
 */

import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { FolderSync } from "lucide-react";
import { toast } from "sonner";
import { describeSyncSkipped, groupSyncSkipped, mirrorLaptops, repoNameOf, type LocalMirror, type LocalMirrorMode } from "@codecast/shared/contracts";
import { useInboxStore } from "../store/inboxStore";
import { openExternalUrl } from "../lib/desktop";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { DeviceDot, DeviceIcon, deviceDisplayName, relativeSeen, useDevices } from "./DeviceBadge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

const ONLINE_MS = 2 * 60_000;

/** The fields the sync surfaces read, narrowly, so a liveness beat never re-renders them. */
function useMirrorRow(conversationId: string) {
  return useInboxStore(
    useShallow((s) => {
      const session: any = s.sessions[s.resolveLiveSessionId(conversationId)];
      const conv: any = s.conversations[conversationId];
      const row: any = session ?? conv;
      // Two feeds carry the row: the inbox feed re-sends it only when its
      // activity moves, which a sync report does not, while the conversation
      // feed carries every report. The newer report wins.
      const a: LocalMirror | null = session?.local_mirror ?? null;
      const b: LocalMirror | null = conv?.local_mirror ?? null;
      const mirror = a && b ? (b.at > a.at ? b : a) : a ?? b;
      return {
        mirror,
        gitRemoteUrl: (row?.git_remote_url ?? null) as string | null,
        projectPath: (row?.project_path ?? null) as string | null,
        seedDevice: (row?.cloud_seed?.device_id ?? null) as string | null,
        seedRoot: (row?.cloud_seed?.laptop_root ?? null) as string | null,
      };
    }),
  );
}

/** Laptops that can hold this session's copy, best first, with their roster entries. */
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
      <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-sol-text-dim">Keep a copy on a laptop, in step</DropdownMenuLabel>
      {mirror ? (
        <>
          <DropdownMenuItem disabled>
            <FolderSync className="w-3 h-3 mr-1.5" />
            <span className="flex-1 truncate">Syncing with {mirrorDevice ? deviceDisplayName(mirrorDevice) : "a laptop"}</span>
            <span className="ml-2 text-[10px] text-gray-400">{STATUS_WORD[mirror.status]}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setLocalMirror(conversationId, false)}>
            <span className="pl-[18px]">Stop syncing</span>
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
          title={`Keeps a copy in ${l.root}/.codecast/worktrees/sync-… on ${deviceDisplayName(l.device)}; edits there travel back here`}
        >
          <DeviceIcon d={l.device} className="w-3 h-3 mr-1.5" />
          <span className="flex-1 truncate">Sync with {deviceDisplayName(l.device)}</span>
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
  live: "in step",
  paused: "paused",
  conflict: "needs a pick",
  local_edit: "stopped",
  error: "failed",
  stopping: "stopping",
};

const TONE: Record<LocalMirror["status"], string> = {
  starting: "text-sol-text-dim animate-pulse",
  live: "text-sol-green",
  paused: "text-sol-text-dim",
  conflict: "text-sol-yellow",
  local_edit: "text-sol-yellow",
  error: "text-sol-red",
  stopping: "text-sol-text-dim animate-pulse",
};

const DOT: Record<LocalMirror["status"], string> = {
  starting: "bg-current opacity-60",
  live: "bg-sol-green",
  paused: "bg-sol-text-dim opacity-60",
  conflict: "bg-sol-yellow",
  local_edit: "bg-sol-yellow",
  error: "bg-sol-red",
  stopping: "bg-current opacity-60",
};

/** A start or stop the laptop has not answered: its daemon is offline, or too old to know the command. */
export const MIRROR_UNANSWERED_MS = 90_000;
function unanswered(m: LocalMirror, now: number): boolean {
  return (m.status === "starting" || m.status === "stopping") && now - m.at > MIRROR_UNANSWERED_MS;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function chipLabel(m: LocalMirror, now: number, laptop: string): string {
  if (unanswered(m, now)) return `sync waiting on ${laptop}`;
  switch (m.status) {
    case "starting": return "syncing…";
    case "stopping": return "stopping sync…";
    case "live": return m.last_landed_at ? `in step · ${relativeSeen(Math.min(m.last_landed_at, now))}` : "in step";
    case "paused": return "sync paused";
    case "conflict": return `${plural(m.conflicts?.length ?? 0, "file")} changed on both sides`;
    case "local_edit": return `laptop copy edited · ${m.files?.length ?? 0}`;
    case "error": return "sync failed";
  }
}

function direction(m: LocalMirror): string {
  return (m.mode ?? "two_way") === "two_way" ? "Changes travel both ways" : "Changes go from the cloud to the laptop only";
}

function chipTitle(m: LocalMirror, laptop: string, now: number, withPath = true): string {
  const where = m.path && withPath ? `${m.path} on ${laptop}` : laptop;
  if (unanswered(m, now)) return `${laptop} has not answered for ${relativeSeen(m.at).replace(" ago", "")}. Its daemon may be offline, or older than this feature (cast update there). Retry, or forget this sync.`;
  const last = m.last_landed_at ? ` Last change ${relativeSeen(m.last_landed_at)}${m.to_host || m.to_laptop ? `: ${[m.to_laptop ? `${plural(m.to_laptop, "file")} to the laptop` : "", m.to_host ? `${plural(m.to_host, "file")} to the cloud` : ""].filter(Boolean).join(", ")}` : ""}.` : "";
  switch (m.status) {
    case "starting": return `Starting a copy in ${where}.`;
    case "stopping": return `Stopping the sync with ${laptop}. Both copies stay as they are.`;
    case "live": return `This session's folder and ${where} are in step. ${direction(m)}.${last}`;
    case "paused": return `Paused while the session is idle, so the cloud host can sleep. It picks up where it left off when the session works again${(m.mode ?? "two_way") === "two_way" ? ", or when you edit the laptop copy while the host is awake" : ""}.`;
    case "conflict": return `${plural(m.conflicts?.length ?? 0, "file")} changed on both the laptop and the cloud. Each side keeps its own version until you pick one; everything else stays in step.`;
    case "local_edit": return `The laptop copy is watch-only and ${plural(m.files?.length ?? 0, "file was", "files were")} edited in it: ${(m.files ?? []).slice(0, 5).join(", ")}. Send those edits to the cloud by switching to both ways, or overwrite them (kept in a backup ref first).`;
    case "error": return `The sync with ${where} failed: ${m.error ?? "unknown error"}.`;
  }
}

function openIn(scheme: "cursor" | "vscode", p: string) {
  openExternalUrl(`${scheme}://file${p}`);
}

const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

export function LocalMirrorChip({ conversationId, compact = false }: { conversationId: string; compact?: boolean }) {
  const { mirror } = useMirrorRow(conversationId);
  const { byId } = useDevices();
  const setLocalMirror = useInboxStore((s) => s.setLocalMirror);
  const now = useCoarseNow(mirror?.status === "live" || mirror?.status === "starting" || mirror?.status === "stopping" ? 5_000 : 60_000);
  if (!mirror) return null;
  const laptop = byId.get(mirror.device_id);
  const laptopName = laptop ? deviceDisplayName(laptop) : "your laptop";
  const waiting = unanswered(mirror, now);
  const mode: LocalMirrorMode = mirror.mode ?? "two_way";
  const conflicts = mirror.conflicts ?? [];
  const skipped = mirror.skipped ?? [];
  const settled = mirror.status !== "stopping" && mirror.status !== "starting";
  const copy = (text: string, what: string) => { void navigator.clipboard.writeText(text); toast.success(`${what} copied`); };
  const keep = (side: "laptop" | "cloud", paths?: string[]) => setLocalMirror(conversationId, true, mirror.device_id, { resolve: { keep: side, ...(paths ? { paths } : {}) } });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-local-mirror={mirror.status}
          data-mirror-mode={mode}
          title={chipTitle(mirror, laptopName, now)}
          className={`inline-flex items-center gap-1 rounded-full border border-sol-border/40 px-2 py-0.5 text-[10px] font-medium outline-none transition-colors hover:border-sol-border/80 ${waiting ? "text-sol-yellow" : TONE[mirror.status]}`}
        >
          <FolderSync className="w-3 h-3" />
          {!compact && <span className="whitespace-nowrap cq-sq1">{chipLabel(mirror, now, laptopName)}</span>}
          <span className={`w-1.5 h-1.5 rounded-full ${waiting ? "bg-sol-yellow" : DOT[mirror.status]}`} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[17rem] max-w-[25rem]">
        <div className="px-2 py-1.5 text-[11px] leading-snug text-sol-text-muted">{chipTitle(mirror, laptopName, now, false)}</div>
        {mirror.path && <div className="px-2 pb-1.5 font-mono text-[10px] text-sol-text-dim break-all">{mirror.path}</div>}

        {mirror.status === "conflict" && conflicts.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-sol-yellow">Changed on both sides</DropdownMenuLabel>
            {conflicts.slice(0, 8).map((p) => (
              <DropdownMenuSub key={p}>
                <DropdownMenuSubTrigger className="font-mono text-[11px]" title={p}>
                  <span className="truncate">{baseName(p)}</span>
                  {baseName(p) !== p && <span className="ml-2 truncate text-[10px] text-sol-text-dim">{p.slice(0, -baseName(p).length - 1)}</span>}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-[12rem]">
                  <DropdownMenuItem onSelect={() => keep("laptop", [p])}>Keep the laptop's</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => keep("cloud", [p])}>Keep the cloud's</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => copy(`cast sync diff ${p} --session ${conversationId}`, "Compare command")}>Copy a compare command</DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ))}
            {conflicts.length > 8 && <div className="px-2 py-1 text-[10px] text-sol-text-dim">and {conflicts.length - 8} more</div>}
            <DropdownMenuItem onSelect={() => keep("laptop")}>Keep the laptop's for all</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => keep("cloud")}>Keep the cloud's for all</DropdownMenuItem>
          </>
        )}

        {mirror.status === "local_edit" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setLocalMirror(conversationId, true, mirror.device_id, { mode: "two_way" })}>Send those edits to the cloud (sync both ways)</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setLocalMirror(conversationId, true, mirror.device_id, { overwrite: true })}>Overwrite with the cloud's (edits kept in a backup ref)</DropdownMenuItem>
          </>
        )}
        {(mirror.status === "error" || (waiting && mirror.status === "starting")) && (
          <DropdownMenuItem onSelect={() => setLocalMirror(conversationId, true, mirror.device_id)}>Retry</DropdownMenuItem>
        )}
        {waiting && mirror.status === "stopping" && (
          <DropdownMenuItem onSelect={() => setLocalMirror(conversationId, false)}>Forget this sync</DropdownMenuItem>
        )}

        {settled && !waiting && mirror.status !== "local_edit" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup value={mode} onValueChange={(v) => v !== mode && setLocalMirror(conversationId, true, mirror.device_id, { mode: v as LocalMirrorMode })}>
              <DropdownMenuRadioItem value="two_way" onSelect={(e) => e.preventDefault()}>Both ways</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="from_cloud" onSelect={(e) => e.preventDefault()}>Cloud to laptop only</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </>
        )}

        {skipped.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="text-[11px]">
              <span className="flex-1">Stayed on its own machine</span>
              <span className="ml-2 text-[10px] opacity-60">{mirror.skipped_count ?? skipped.length}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-w-[26rem]">
              {(["cloud", "laptop"] as const).map((side) => {
                const { rebuilt, named, more } = groupSyncSkipped(skipped.filter((s) => s.side === side));
                if (!rebuilt.length && !named.length) return null;
                const line = "truncate px-2 py-0.5 font-mono text-[10px] text-sol-text-muted";
                return (
                  <div key={side}>
                    <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-sol-text-dim">On the {side === "cloud" ? "cloud" : laptopName}</DropdownMenuLabel>
                    {rebuilt.length > 0 && (
                      <div className={line} title={rebuilt.map((s) => s.path).join("\n")}>{plural(rebuilt.length, "dependency or build folder")}: rebuilt on each machine</div>
                    )}
                    {named.map((s) => <div key={s.path} className={line} title={describeSyncSkipped(s)}>{describeSyncSkipped(s)}</div>)}
                    {more > 0 && <div className={line}>and {more} more</div>}
                  </div>
                );
              })}
              <DropdownMenuSeparator />
              <div className="px-2 py-1 text-[10px] leading-snug text-sol-text-dim">
                An agent fetches any of these with <code className="font-mono">cast sync pull &lt;path&gt;</code>. To sync one always, add it under <code className="font-mono">[sync] always</code> in <code className="font-mono">.codecast/workspace.toml</code>.
              </div>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}

        {mirror.path && mirror.status !== "stopping" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => openIn("cursor", mirror.path!)}>Open in Cursor</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openIn("vscode", mirror.path!)}>Open in VS Code</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => copy(mirror.path!, "Path")}>Copy path</DropdownMenuItem>
          </>
        )}
        {mirror.status !== "stopping" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setLocalMirror(conversationId, false)}>Stop syncing</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
