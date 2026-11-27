// How a person's huddles start in each workspace: on the board, and with
// Scribe invited. Per person (the clientState.ui bag, so it follows them to
// every device) and per workspace (keyed by workspace key, "team:<id>": a
// huddle always belongs to a team). Absent means off.
import { useInboxStore } from "../../store/inboxStore";

export type HuddleSettingKey = "huddleBoardView" | "huddleAutoScribe";

/** A huddle's workspace key, from its team. */
export const huddleWorkspaceKey = (teamId: string | null | undefined): string | null => (teamId ? `team:${teamId}` : null);

export function readHuddleSetting(ui: unknown, key: HuddleSettingKey, workspace: string | null): boolean {
  return !!workspace && (ui as { [k in HuddleSettingKey]?: Record<string, boolean> } | undefined)?.[key]?.[workspace] === true;
}

export function useHuddleSetting(key: HuddleSettingKey, workspace: string | null): boolean {
  return useInboxStore((s) => readHuddleSetting(s.clientState?.ui, key, workspace));
}

/** Write any of the settings for one workspace, leaving the other workspaces' as they are. */
export function setHuddleSettings(workspace: string, values: Partial<Record<HuddleSettingKey, boolean>>): void {
  const s = useInboxStore.getState();
  const ui = s.clientState.ui;
  const patch: { [k in HuddleSettingKey]?: Record<string, boolean> } = {};
  for (const [k, v] of Object.entries(values) as Array<[HuddleSettingKey, boolean]>) {
    if ((ui?.[k]?.[workspace] === true) !== v) patch[k] = { ...ui?.[k], [workspace]: v };
  }
  if (Object.keys(patch).length) s.updateClientUI(patch);
}

/** What one person did with the board's banners in one call: dismissed the
 *  invite, invited Scribe from it, closed or saved the "Next time" one. */
export type BannerMemo = { dismissed?: true; invited?: true; nextClosed?: true };

/** Which banner shows over the board, if any. */
export function boardBannerState(opts: { present: boolean; memo: BannerMemo; boardViewOn: boolean; autoScribeOn: boolean }): "invite" | "next" | null {
  const { present, memo } = opts;
  if (!present) return memo.dismissed ? null : "invite";
  if (memo.invited && !memo.nextClosed && !(opts.boardViewOn && opts.autoScribeOn)) return "next";
  return null;
}
