/**
 * The device a marketing visitor is on, for choosing which install path to lead
 * with. Only a hint: the answer picks a default, never hides an option.
 * iPadOS reports platform "MacIntel" but is touch-first, so it counts as iOS.
 */
export type VisitorPlatform = "mac" | "ios" | "windows" | "linux" | "other";

export function visitorPlatform(): VisitorPlatform {
  if (typeof navigator === "undefined") return "other";
  const platform = navigator.platform || "";
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/.test(ua) || (/Mac/.test(platform) && (navigator.maxTouchPoints ?? 0) > 1)) return "ios";
  if (/Mac/.test(platform)) return "mac";
  if (/Win/.test(platform) || /Windows/.test(ua)) return "windows";
  if (/Linux|X11|CrOS/.test(`${platform} ${ua}`) && !/Android/.test(ua)) return "linux";
  return "other";
}
