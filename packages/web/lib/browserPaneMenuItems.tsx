"use client";
// The menu a printed web address wears, wherever one appears.
//
// A dev server URL in a transcript and the tab an agent drove are different
// things, and their pills say so. What you can DO with the address they carry
// is the same four verbs, so they read them from here: two hand-written copies
// drift the moment either one grows a fifth.
//
// The pane row's wording is the one real difference. Opening a link someone
// printed is not the same act as going to see the page an agent worked on, and
// the menu should say which one you are about to do.
//
// A plain function in lib/, not a component module: a .tsx file under
// components/ that exports a helper breaks Fast Refresh for everything that
// imports it (lib/__tests__/fastRefreshBoundaries.guard.test.ts).

import { Columns2, Copy, ExternalLink, PanelTop } from "lucide-react";
import { toast } from "sonner";
import { CtxItem, CtxSeparator } from "../components/ui/context-menu";
import { openBrowserPane } from "./stage";
import { copyToClipboard } from "./utils";

export function browserPaneMenuItems(url: string, opts?: { paneLabel?: string }) {
  return (
    <>
      <CtxItem icon={Columns2} onSelect={() => openBrowserPane({ kind: "url", url })}>
        {opts?.paneLabel ?? "Open in a pane"}
      </CtxItem>
      <CtxItem
        icon={PanelTop}
        onSelect={() => openBrowserPane({ kind: "url", url }, { beside: false })}
      >
        Open in a pane, full width
      </CtxItem>
      <CtxItem
        icon={ExternalLink}
        onSelect={() => window.open(url, "_blank", "noopener,noreferrer")}
      >
        Open in a browser tab
      </CtxItem>
      <CtxSeparator />
      <CtxItem
        icon={Copy}
        onSelect={() => void copyToClipboard(url).then(() => toast.success("Address copied"))}
      >
        Copy address
      </CtxItem>
    </>
  );
}
