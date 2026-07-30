export type LocalFirstSlice = "buckets" | "comments" | "smallViews" | "messageSend";
/**
 * Plain modes run the v2 (view-revision watermark) contracts; the `-lts`
 * modes run the v3 stamped-log-ts contracts, which migrate the durable view
 * via contract supersession on first claim.
 */
export type LocalFirstSliceMode = "off" | "shadow" | "cutover" | "shadow-lts" | "cutover-lts";

export type LocalFirstFeatureFlags = Readonly<Record<LocalFirstSlice, LocalFirstSliceMode>>;

type ViteEnvironment = Readonly<Record<string, string | boolean | undefined>>;

export type LocalFirstWriteFlags = Readonly<{
  enabled: boolean;
  /** One-switch rollback rail shared with every read slice. */
  rollbackRailEnabled: boolean;
}>;

const ENV_KEYS: Readonly<Record<LocalFirstSlice, string>> = {
  buckets: "VITE_LOCAL_FIRST_BUCKETS_MODE",
  comments: "VITE_LOCAL_FIRST_COMMENTS_MODE",
  smallViews: "VITE_LOCAL_FIRST_SMALL_VIEWS_MODE",
  messageSend: "VITE_LOCAL_FIRST_MESSAGE_SEND_MODE",
};

function mode(value: unknown): LocalFirstSliceMode {
  return value === "shadow" || value === "cutover" ||
    value === "shadow-lts" || value === "cutover-lts"
    ? value
    : "off";
}

/** The slice's rendered store feed comes from the durable v2 view. */
export function isCutoverMode(value: LocalFirstSliceMode): boolean {
  return value === "cutover" || value === "cutover-lts";
}

/** The slice digest-compares v1 against the durable view without cutting over. */
export function isShadowMode(value: LocalFirstSliceMode): boolean {
  return value === "shadow" || value === "shadow-lts";
}

/** The slice runs the v3 stamped-log-ts contract instead of v2. */
export function isLogTsMode(value: LocalFirstSliceMode): boolean {
  return value === "shadow-lts" || value === "cutover-lts";
}

/**
 * Rollout is fail-closed twice: every slice has an explicit mode and all v2
 * traffic also requires the global rail. A typo, absent variable, or production
 * build made before review therefore keeps both the v2 queries and commands off.
 */
export function readLocalFirstFeatureFlags(
  environment: ViteEnvironment = import.meta.env,
): LocalFirstFeatureFlags {
  if (environment.VITE_LOCAL_FIRST_V2_ENABLED !== "1") {
    return Object.freeze({ buckets: "off", comments: "off", smallViews: "off", messageSend: "off" });
  }
  // The accelerated release is built once in its coherent final posture.
  // One rollback switch (VITE_LOCAL_FIRST_V2_ENABLED=0) still returns every
  // supported read and write slice to the legacy paths without deleting the
  // v3 store or its unresolved journal.
  if (environment.VITE_LOCAL_FIRST_FINAL_MODE === "1") {
    return Object.freeze({
      buckets: "cutover-lts",
      comments: "cutover-lts",
      // Server contracts exist for small views, but no web materializer is
      // mounted yet. "Supported" therefore remains the two reference slices.
      smallViews: "off",
      messageSend: "cutover-lts",
    });
  }
  return Object.freeze({
    buckets: mode(environment[ENV_KEYS.buckets]),
    comments: mode(environment[ENV_KEYS.comments]),
    smallViews: mode(environment[ENV_KEYS.smallViews]),
    messageSend: mode(environment[ENV_KEYS.messageSend]),
  });
}

export const LOCAL_FIRST_FEATURE_FLAGS = readLocalFirstFeatureFlags();

export function readLocalFirstWriteFlags(
  environment: ViteEnvironment = import.meta.env,
): LocalFirstWriteFlags {
  const rollbackRailEnabled = environment.VITE_LOCAL_FIRST_V2_ENABLED === "1";
  return Object.freeze({
    rollbackRailEnabled,
    enabled: rollbackRailEnabled && (
      environment.VITE_LOCAL_FIRST_FINAL_MODE === "1" ||
      environment.VITE_LOCAL_FIRST_WRITES_ENABLED === "1"
    ),
  });
}

export const LOCAL_FIRST_WRITE_FLAGS = readLocalFirstWriteFlags();

export function isLocalFirstWriteEnabled(): boolean {
  return LOCAL_FIRST_WRITE_FLAGS.enabled;
}

export function localFirstSliceMode(slice: LocalFirstSlice): LocalFirstSliceMode {
  return LOCAL_FIRST_FEATURE_FLAGS[slice];
}

export function isLocalFirstShadowEnabled(slice: LocalFirstSlice): boolean {
  return localFirstSliceMode(slice) !== "off";
}

export function isLocalFirstCutoverEnabled(slice: LocalFirstSlice): boolean {
  return isCutoverMode(localFirstSliceMode(slice));
}
