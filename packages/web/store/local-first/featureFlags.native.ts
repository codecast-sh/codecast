// Native twin of featureFlags — every flag reads "off". Metro resolves this
// file for the mobile app; Vite never sees it. The web version's env reads use
// `import.meta.env`, which breaks Hermes at parse time (the same reason
// useSyncBuckets was platform-split, 18dd5e1a), and mutativeMiddleware — which
// inboxStore pulls into every bundle — imports this module, so without the twin
// the mobile app cannot bundle at all. Local-first has no native runtime; when
// it lands one, port the slice flags here rather than re-importing the web env.

export type LocalFirstSlice = "buckets" | "comments" | "smallViews" | "messageSend";
export type LocalFirstSliceMode = "off" | "shadow" | "cutover" | "shadow-lts" | "cutover-lts";

export type LocalFirstFeatureFlags = Readonly<Record<LocalFirstSlice, LocalFirstSliceMode>>;

export type LocalFirstWriteFlags = Readonly<{
  enabled: boolean;
  rollbackRailEnabled: boolean;
}>;

export function isCutoverMode(value: LocalFirstSliceMode): boolean {
  return value === "cutover" || value === "cutover-lts";
}

export function isShadowMode(value: LocalFirstSliceMode): boolean {
  return value === "shadow" || value === "shadow-lts";
}

export function isLogTsMode(value: LocalFirstSliceMode): boolean {
  return value === "shadow-lts" || value === "cutover-lts";
}

export function readLocalFirstFeatureFlags(): LocalFirstFeatureFlags {
  return LOCAL_FIRST_FEATURE_FLAGS;
}

export const LOCAL_FIRST_FEATURE_FLAGS: LocalFirstFeatureFlags = Object.freeze({
  buckets: "off",
  comments: "off",
  smallViews: "off",
  messageSend: "off",
});

export function readLocalFirstWriteFlags(): LocalFirstWriteFlags {
  return LOCAL_FIRST_WRITE_FLAGS;
}

export const LOCAL_FIRST_WRITE_FLAGS: LocalFirstWriteFlags = Object.freeze({
  enabled: false,
  rollbackRailEnabled: false,
});

export function isLocalFirstWriteEnabled(): boolean {
  return false;
}

export function localFirstSliceMode(slice: LocalFirstSlice): LocalFirstSliceMode {
  return LOCAL_FIRST_FEATURE_FLAGS[slice];
}

export function isLocalFirstShadowEnabled(_slice: LocalFirstSlice): boolean {
  return false;
}

export function isLocalFirstCutoverEnabled(_slice: LocalFirstSlice): boolean {
  return false;
}
