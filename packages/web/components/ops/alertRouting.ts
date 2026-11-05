// The hooks behind a watch's alert routing: the team's channels, the names
// behind a watch's stored targets, the folder and projects a fix starts in,
// and the review a fix that starts on its own goes through. The plain values
// (names, summary, deliveries per transition) are alertRoutingModel.ts.
import { useMemo } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import type { SwitchLedger } from "../consequential/ConsequentialSwitch";
import { useOwnerOptions, type OwnerOption } from "./issueAssign";
import type { OpsSource, OpsWatch } from "./opsTypes";
import { notifyTargets, type ChannelOption } from "./alertRoutingModel";


type ChannelRow = { _id: string; name?: string; team_id?: string; kind?: string; archived_at?: number };

const NO_CHANNELS: Record<string, ChannelRow> = {};

/** The team channels a watch in `workspace` can post to, by name; none for a personal workspace. */
export function useChannelOptions(workspace: string): ChannelOption[] {
  const channels = useInboxStore((s) => ((s as any).chatChannels as Record<string, ChannelRow> | undefined) ?? NO_CHANNELS);
  return useMemo(() => {
    if (!workspace.startsWith("team:")) return [];
    return Object.values(channels)
      .filter((c) => c && c.name && `team:${c.team_id}` === workspace && c.kind !== "dm" && c.kind !== "group" && !c.archived_at)
      .map((c) => ({ _id: c._id, name: c.name! }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [channels, workspace]);
}

/** The people, roles and channels with their names, for a watch: what the routing control and the summaries read. */
export function useNotifyTargets(watch: Pick<OpsWatch, "notify" | "workspace">) {
  const options = useOwnerOptions();
  const channels = useChannelOptions(watch.workspace);
  const targets = useMemo(() => notifyTargets(watch.notify, options, channels), [watch.notify, options, channels]);
  return { options, channels, targets };
}

/** The folder a fix that starts on its own would run in: the source's project's. */
export function useFixFolder(source: OpsSource | undefined): string | null {
  return useInboxStore((s) => (source?.project_id ? ((s as any).projects?.[source.project_id]?.project_path as string | undefined) ?? null : null));
}

type FolderProject = { _id: string; title?: string; project_path?: string; archived_at?: number };
const folderSig = (p: FolderProject) => `${p.title ?? ""}|${p.project_path ?? ""}|${p.archived_at ?? ""}`;

/** The workspace's projects a fix can run in (those with a folder), by title. */
export function useFolderProjects(): { _id: string; title: string }[] {
  const rows = useWorkspaceCollection<FolderProject>("projects", folderSig);
  return useMemo(
    () => rows.filter((p) => p.project_path && !p.archived_at).map((p) => ({ _id: p._id, title: p.title || p.project_path!.split("/").pop()! })).sort((a, b) => a.title.localeCompare(b.title)),
    [rows],
  );
}

/** The review before a crossing may start a fix session by itself. */
/** What the auto-fix review names: a saved watch, or the one the New watch sheet is making (no short id yet). */
export type FixSubject = Pick<OpsWatch, "name" | "direction" | "threshold"> & { short_id?: string };

export function autoFixLedger(watch: FixSubject, source: OpsSource | undefined, folder: string | null, me: string): SwitchLedger {
  return {
    name: "Start fix on alert",
    subject: watch.short_id ? `${watch.name} · ${watch.short_id}` : watch.name || "New watch",
    figures: [{ value: "1", label: "session per episode" }, { value: "3", label: "a workspace an hour, at most" }],
    rows: [
      { k: "When", v: `It crosses ${watch.direction === "above" ? ">" : "<"} ${watch.threshold ?? "the line"}` },
      { k: "Runs as", v: me },
      { k: "Folder", v: folder ?? `${source?.name ?? "The source"} has no project`, tone: folder ? undefined : "warn" },
      { k: "Works on", v: "The issue and its problem task" },
      { k: "Cost", v: "One agent session each time", tone: "warn" },
    ],
    stop: "Turn off here, or Mute",
    confirm: "Start fixes on alert",
    ...(folder ? {} : { blocked: "Attach the source to a project first" }),
  };
}


