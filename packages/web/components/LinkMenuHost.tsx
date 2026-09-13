"use client";

// The ONE right-click menu for every in-app link: the same destinations the
// modifier clicks reach (lib/openIntent) as a menu, for anyone who doesn't
// know the chords. Links are dense (agent prose, lists, rails), so no link
// owns a menu instance: a document listener catches the right-click, and one
// host mounted in the dashboard shell renders the menu. External links and
// anything a surface already handled (a file link's own menu, defaultPrevented)
// keep the browser's menu; Shift+right-click always does.

import { Columns2, Copy, ExternalLink, PanelTop, AppWindow } from "lucide-react";
import { toast } from "sonner";
import { ContextMenu, CtxItem, CtxSeparator, useContextMenu } from "./ui/context-menu";
import { useEventListener } from "../hooks/useEventListener";
import { anchorAppPath, navigateHere, openIn } from "../lib/openIntent";
import { canOpenBeside } from "../lib/stage";
import { isDesktop } from "../lib/desktop";
import { copyToClipboard, shareOrigin } from "../lib/utils";

/** The open destinations for one in-app path — shared by this host and the
 *  file link menu, so the two menus can never offer different verbs. */
export function OpenLinkItems({ href, openLabel = "Open" }: { href: string; openLabel?: string }) {
  const desktop = isDesktop();
  return (
    <>
      <CtxItem icon={ExternalLink} onSelect={() => navigateHere(href)}>{openLabel}</CtxItem>
      {canOpenBeside() && (
        <CtxItem icon={Columns2} onSelect={() => openIn("split", href)}>Open beside</CtxItem>
      )}
      <CtxItem icon={PanelTop} onSelect={() => openIn("tab", href)}>Open in new tab</CtxItem>
      <CtxItem icon={AppWindow} onSelect={() => desktop ? openIn("window", href) : window.open(href, "_blank")}>
        {desktop ? "Open in new window" : "Open in browser tab"}
      </CtxItem>
      <CtxSeparator />
      <CtxItem
        icon={Copy}
        onSelect={() => copyToClipboard(`${shareOrigin()}${href}`).then(() => toast.success("Link copied"))}
      >
        Copy link
      </CtxItem>
    </>
  );
}

export function LinkMenuHost() {
  const menu = useContextMenu<string>();
  useEventListener(
    "contextmenu",
    (e: MouseEvent) => {
      if (e.defaultPrevented || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      const a = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      // A link a surface already gave its own menu (FilePathLink) never
      // reaches here: that menu stops propagation at the React root.
      if (target?.closest?.('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]')) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && target && sel.containsNode?.(target, true)) return;
      const path = anchorAppPath(a);
      if (!path) return; // external, hash, download, _blank: the browser's menu
      menu.open(e as unknown as React.MouseEvent, path, { force: true });
    },
    document,
  );
  return <ContextMenu state={menu}>{(href) => <OpenLinkItems href={href} />}</ContextMenu>;
}
