"use client";

// The ONE right-click menu for every file link in the app. Links are dense in
// agent prose (dozens per message), so each does not own a menu instance;
// they hand the event to this host (lib/filePathMenu requestFilePathMenu),
// mounted once in the dashboard shell next to the other docks.

import { Code2, Columns2, FileDiff, Folder, FolderOpen } from "lucide-react";
import { ContextMenu, CtxItem, CtxSeparator, useContextMenu } from "./ui/context-menu";
import { OpenLinkItems, SessionsLinkItem } from "./LinkMenuHost";
import { fileSessionsLink } from "../lib/sessionSearchLinks";
import { filePathHref, matchSessionChangedFile, resolveMentionPath } from "../lib/filePathLinks";
import { setFilePathMenuListener, type FilePathMenuPayload } from "../lib/filePathMenu";
import { parentDir } from "../lib/utils";
import { editorReachable, openFiles, openInEditor } from "../lib/filesPane";
import { resolveVaultTarget } from "../lib/vault/vaultHref";
import { vaultOp } from "../lib/vault/client";
import { fileManagerName } from "../lib/vault/reveal";
import { useVaultStore } from "../store/vaultStore";
import { useDiffViewerStore } from "../store/diffViewerStore";
import { openSessionChangedPath } from "../lib/sessionChangedFiles";

import { useWatchEffect } from "../hooks/useWatchEffect";
export function FilePathMenuHost() {
  const menu = useContextMenu<FilePathMenuPayload>();
  useWatchEffect(() => setFilePathMenuListener((e, payload) => menu.open(e, payload, { force: true })), [menu]);

  return (
    <ContextMenu state={menu}>
      {(p) => {
        const abs = resolveMentionPath(p.path, p.ctx) ?? p.path;
        const folderHref = filePathHref(parentDir(abs), undefined, p.ctx);
        const reachable = editorReachable(p.ctx);
        const vs = useVaultStore.getState();
        const target = vs.endpoint && !vs.isRemote ? resolveVaultTarget(abs, vs.vaults) : null;
        const dv = useDiffViewerStore.getState();
        const inSessionDiff =
          !!p.ctx?.conversationId &&
          dv.conversationId === p.ctx.conversationId &&
          matchSessionChangedFile(p.path, dv.changes, p.ctx) !== null;
        return (
          <>
            {inSessionDiff && (
              <>
                <CtxItem icon={FileDiff} onSelect={() => openSessionChangedPath(p.path, p.ctx)}>
                  Open in session changes
                </CtxItem>
                <CtxSeparator />
              </>
            )}
            {reachable && (
              <>
                <CtxItem icon={Code2} onSelect={() => openInEditor({ path: p.path, line: p.line, column: p.column, ctx: p.ctx }, { fromLeaf: p.fromLeaf })}>
                  Open in editor
                </CtxItem>
                <CtxItem icon={Columns2} onSelect={() => openInEditor({ path: p.path, line: p.line, column: p.column, ctx: p.ctx }, { fromLeaf: p.fromLeaf, split: true })}>
                  Open in editor in a split
                </CtxItem>
                <CtxSeparator />
              </>
            )}
            <OpenLinkItems href={p.href} openLabel="Open here" />
            <CtxSeparator />
            <CtxItem icon={Folder} onSelect={() => openFiles(folderHref)}>
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
            <SessionsLinkItem link={fileSessionsLink(abs, p.ctx?.gitRoot)} />
          </>
        );
      }}
    </ContextMenu>
  );
}
