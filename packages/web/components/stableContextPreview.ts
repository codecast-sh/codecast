import {
  isExcludedStableItem,
  type StableMode,
  type StableContextItem,
} from "@codecast/shared/contracts";

function stableContextLimit(mode: Exclude<StableMode, "off">): number {
  return mode === "team" ? 15 : 10;
}

export function resolveStableContextPreview(
  chosenMode: StableMode | undefined,
  deviceDefault: StableMode,
  deviceGlobal: boolean,
): { effectiveMode: StableMode; globalScope: boolean } {
  return {
    effectiveMode: chosenMode ?? deviceDefault,
    // The picker has no scope control. An explicit mode changes only the mode;
    // the daemon still reads stable_global from this device's config.
    globalScope: deviceGlobal,
  };
}

export function stableContextPreviewFeedParams(
  mode: Exclude<StableMode, "off">,
  projectPath: string | undefined,
  exclusionCount: number,
  now = Date.now(),
) {
  const lookbackDays = mode === "team" ? 14 : 7;
  const normalLimit = stableContextLimit(mode);
  return {
    // The CLI over-fetches by the exclusion count, filters, then takes its
    // normal limit. Preview the same candidate set so crossed-out cards are
    // replaced by the exact pointers the agent will receive.
    limit: Math.min(normalLimit + Math.max(0, exclusionCount), 30),
    start_time: now - lookbackDays * 24 * 60 * 60 * 1000,
    ...(projectPath ? { project_path: projectPath } : {}),
  };
}

/**
 * The feed query deliberately over-fetches so excluded rows can be replaced.
 * The CLI then filters and slices back to its normal limit. Keep excluded
 * candidates visible (crossed out), but never count/show extra included rows
 * that the agent would not actually receive.
 */
export function selectStableContextPreviewItems(
  items: StableContextItem[],
  mode: Exclude<StableMode, "off">,
  exclude: string[],
): StableContextItem[] {
  const limit = stableContextLimit(mode);
  let included = 0;
  return items.filter((item) => {
    if (isExcludedStableItem(item.id, exclude)) return true;
    if (included >= limit) return false;
    included += 1;
    return true;
  });
}
