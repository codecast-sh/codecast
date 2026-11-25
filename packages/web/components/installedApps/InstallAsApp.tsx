// "Install as app" in a page's Share menus. In the desktop app the act opens
// the install sheet; in a browser it hands the page to the desktop app over
// codecast://install/<slug>, and when nothing on this computer takes the link
// it offers the desktop app instead (useInstallAsApp). The surface holds the
// hook, so the fallback outlives the menu that started it.
import { AppWindow, RotateCw } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { KeyCap } from "../KeyCap";
import { CtxItem } from "../ui/context-menu";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import type { InstallAsApp } from "../../hooks/useInstalledApps";
import { DESKTOP_DOWNLOADS, trackNativeAppClick } from "../../lib/nativeApps";
import { INSTALL_AS_APP } from "../../lib/installedApps";
import { AppIcon } from "./AppIcon";

const AppleMark = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden fill="currentColor"><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" /></svg>
);

const WindowsMark = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 16 16" className={className} aria-hidden fill="currentColor"><path d="M0 2.2 6.5 1.3v6.2H0zM7.3 1.2 16 0v7.5H7.3zM0 8.3h6.5v6.3L0 13.7zM7.3 8.3H16V16l-8.7-1.2z" /></svg>
);

/** The menu entry, for every Share or page menu built from CtxItem. */
export function InstallAsAppItem({ act }: { act: InstallAsApp }) {
  return <CtxItem icon={AppWindow} onSelect={act.install} data-install-as-app>{INSTALL_AS_APP}</CtxItem>;
}

/** The browser's fallback: the desktop app to download, platform first, and a retry once it is installed. */
export function InstallHandoff({ slug, title, act }: { slug: string; title?: string; act: InstallAsApp }) {
  if (!act.fallback) return null;
  return <InstallHandoffDialog slug={slug} title={title} act={act} />;
}

function InstallHandoffDialog({ slug, title, act }: { slug: string; title?: string; act: InstallAsApp }) {
  // Signed in, the page's own name and icon head the choice; without them the act still reads.
  const info = useQueryNoThrow(api.artifacts.appInfo, { slug }).data;
  const app = info && !("error" in info) ? info : null;
  const name = app?.app.name ?? (title?.trim() || "this page");
  const onWindows = typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent);
  const order = onWindows ? [DESKTOP_DOWNLOADS[1], DESKTOP_DOWNLOADS[0]] : [...DESKTOP_DOWNLOADS];
  return (
    <Dialog open onOpenChange={(open) => { if (!open) act.closeFallback(); }}>
      <DialogContent hideClose className="w-[24rem] max-w-[calc(100vw-1.5rem)] gap-0 overflow-hidden border-sol-border bg-sol-bg p-0 text-sol-text sm:rounded-xl" data-install-handoff={slug}>
        <header className="flex items-center gap-3.5 border-b border-sol-border/60 px-5 py-4">
          <AppIcon src={app?.icons["512"]} name={app?.app.name ?? (title?.trim() || "?")} size={44} />
          <div className="min-w-0">
            <DialogTitle className="truncate text-[15px] font-semibold leading-tight text-sol-text">Install {name}</DialogTitle>
            <DialogDescription className="truncate text-[12.5px] text-sol-text-muted">Needs Codecast for desktop</DialogDescription>
          </div>
        </header>
        <div className="grid grid-cols-2 gap-2 px-5 py-4">
          {order.map((d, i) => (
            <a
              key={d.os}
              href={d.href}
              onClick={() => { if (d.os === "mac") trackNativeAppClick("mac", "install_as_app"); }}
              className={`group flex flex-col items-start gap-2 rounded-lg border px-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-blue/50 ${i === 0 ? "border-sol-blue/60 bg-sol-blue/10 hover:bg-sol-blue/15" : "border-sol-border hover:bg-sol-bg-alt"}`}
              data-download={d.os}
            >
              {d.os === "mac" ? <AppleMark className="h-5 w-5 text-sol-text" /> : <WindowsMark className="h-[18px] w-[18px] text-sol-text" />}
              <span className="flex flex-col">
                <span className="text-[13px] font-semibold text-sol-text">{d.label}</span>
                <span className="text-meta text-sol-text-muted">{d.detail}</span>
              </span>
            </a>
          ))}
        </div>
        <footer className="flex items-center justify-between gap-2 border-t border-sol-border/60 bg-sol-bg-alt/40 px-5 py-3">
          <button type="button" onClick={act.closeFallback} className="inline-flex h-8 items-center gap-2 rounded-md border border-sol-border px-3 text-[12.5px] text-sol-text-muted hover:text-sol-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-blue/50" data-handoff-close>
            Close <KeyCap size="xs">esc</KeyCap>
          </button>
          <Button type="button" variant="outline" size="sm" onClick={() => { act.closeFallback(); act.retry(); }} data-handoff-retry>
            <RotateCw className="h-3.5 w-3.5" /> Open in Codecast
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
