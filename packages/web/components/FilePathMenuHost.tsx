"use client";

// The ONE right-click menu for every file link in the app. Links are dense in
// agent prose (dozens per message), so each does not own a menu instance;
// they hand the event to this host (lib/filePathMenu requestFilePathMenu),
// mounted once in the dashboard shell next to the other docks.

import { ExternalLink, FileText, Folder, FolderOpen, PanelRightOpen } from "lucide-react";
import { ContextMenu, CtxItem, CtxSeparator, useContextMenu } from "./ui/context-menu";
import { filePathHref } from "../lib/filePathLinks";
import { setFilePathMenuListener, type FilePathMenuPayload } from "../lib/filePathMenu";
import { resolveCustomPath, parentDir } from "../lib/utils";
import { canOpenFilesBeside, openFilesBeside } from "../lib/filesPane";
import { tabNavigate } from "../src/compat/tabRouting";
import { openIn } from "../lib/openIntent";
import { resolveVaultTarget } from "../lib/vault/vaultHref";
import { vaultOp } from "../lib/vault/client";
import { fileManagerName } from "../lib/vault/reveal";
import { useVaultStore } from "../store/vaultStore";

import { useWatchEffect } from "../hooks/useWatchEffect";
export function FilePathMenuHost() {
  const menu = useContextMenu<FilePathMenuPayload>();
  useWatchEffect(() => setFilePathMenuListener((e, payload) => menu.open(e, payload, { force: true })), [menu]);

  return (
    <ContextMenu state={menu}>
      {(p) => {
        const abs = resolveCustomPath(p.path, p.ctx?.home, p.ctx?.base) ?? p.path;
        const folderHref = filePathHref(parentDir(abs), undefined, null);
        const beside = canOpenFilesBeside();
        const vs = useVaultStore.getState();
        const target = vs.endpoint && !vs.isRemote ? resolveVaultTarget(abs, vs.vaults) : null;
        const go = (href: string, preferBeside: boolean) => {
          if (preferBeside && beside) openFilesBeside(href);
          else tabNavigate(href, "push");
        };
        return (
          <>
            <CtxItem icon={FileText} onSelect={() => go(p.href, true)}>
              {beside ? "Open beside" : "Open in Files"}
            </CtxItem>
            {beside && (
              <CtxItem icon={PanelRightOpen} onSelect={() => go(p.href, false)}>
                Open in Files
              </CtxItem>
            )}
            <CtxItem icon={ExternalLink} onSelect={() => openIn("tab", p.href)}>
              Open in new tab
            </CtxItem>
            <CtxSeparator />
            <CtxItem icon={Folder} onSelect={() => go(folderHref, true)}>
              Open containing folder
            </CtxItem>
            {target && (
              <CtxItem
                icon={FolderOpen}
                onSelect={() => {
                  void vaultOp(vs.endpoint!, target.vaultId, { op: "reveal", path: target.rel, mode: "reveal" }).catch(() => {});
                }}
              >
                {`Reveal in ${fileManagerName()}`}
              </CtxItem>
            )}
          </>
        );
      }}
    </ContextMenu>
  );
}
