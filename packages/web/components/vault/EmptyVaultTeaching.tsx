import { FolderTree } from "lucide-react";

/** What /files shows before any project or folder has anything to browse. */
export function EmptyVaultTeaching() {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 text-center px-8">
      <FolderTree className="w-10 h-10 text-sol-text-dim opacity-40" />
      <div className="text-sol-text font-medium">Nothing to browse yet</div>
      <div className="text-sm text-sol-text-muted max-w-md">
        Your projects show up here on their own, as soon as one of them has a
        README or a docs folder. To browse a folder of notes that isn&apos;t a
        project, point the CLI at it:
      </div>
      <pre className="text-[13px] bg-sol-bg-alt border border-sol-border/30 rounded px-4 py-2 text-sol-text">
        cast files add ~/notes
      </pre>
      <div className="text-xs text-sol-text-dim max-w-md">
        Files stay on your machine — the browser reads them directly from the
        local daemon.
      </div>
    </div>
  );
}
