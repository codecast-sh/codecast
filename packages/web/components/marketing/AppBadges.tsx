import Link from "next/link";
import { NATIVE_APP_LINKS, trackNativeAppClick, type NativeApp } from "@/lib/nativeApps";

export function AppleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
    </svg>
  );
}

export function AndroidIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.609 1.814L13.792 12 3.61 22.186a.996.996 0 01-.61-.92V2.734a1 1 0 01.609-.92zm10.89 10.893l2.302 2.302-10.937 6.333 8.635-8.635zm3.199-3.198l2.807 1.626a1 1 0 010 1.73l-2.808 1.626L15.206 12l2.492-2.491zM5.864 2.658L16.802 8.99l-2.303 2.303-8.635-8.635z" />
    </svg>
  );
}

const DARK = "inline-flex items-center gap-2 rounded-lg bg-[#002b36] px-5 py-2.5 font-medium text-white transition-colors hover:bg-[#073642]";
const LIGHT = "inline-flex items-center gap-2 rounded-lg border border-[#93a1a1] px-5 py-2.5 font-medium text-[#586e75] transition-colors hover:bg-[#eee8d5]";
const MUTED = "inline-flex items-center gap-2 rounded-lg bg-[#eee8d5] px-5 py-2.5 font-medium text-[#657b83] cursor-not-allowed";

const LABEL: Record<NativeApp, string> = { mac: "Download for macOS", ios: "App Store (iOS)" };

/**
 * One store badge on the light marketing pages. The Mac badge goes to the
 * /download page (which starts the dmg on a Mac and explains itself
 * elsewhere) unless `direct` sends it straight to the file; the iOS badge
 * always opens the App Store.
 */
export function AppBadge({ app, location, tone = "dark", direct = false }: { app: NativeApp; location: string; tone?: "dark" | "light"; direct?: boolean }) {
  const className = tone === "dark" ? DARK : LIGHT;
  const onClick = () => trackNativeAppClick(app, location);
  const body = (
    <>
      <AppleIcon className="h-5 w-5" />
      {LABEL[app]}
    </>
  );
  if (app === "mac" && !direct) {
    return <Link href="/download" onClick={onClick} className={className}>{body}</Link>;
  }
  return (
    <a href={NATIVE_APP_LINKS[app]} onClick={onClick} className={className} {...(app === "ios" ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
      {body}
    </a>
  );
}

export function AndroidSoonBadge() {
  return (
    <span className={MUTED}>
      <AndroidIcon className="h-5 w-5" />
      Android coming soon
    </span>
  );
}

/** The full row: Mac, iOS, and the Android placeholder. */
export function AppBadges({ location }: { location: string }) {
  return (
    <div className="flex flex-wrap gap-3">
      <AppBadge app="mac" location={location} />
      <AppBadge app="ios" location={location} />
      <AndroidSoonBadge />
    </div>
  );
}
