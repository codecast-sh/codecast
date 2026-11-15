// A file read from the machine a conversation ran on (lib/vault/remoteFile),
// shown read-only. The bytes stay on that machine; this is a copy for reading.

import { memo, useMemo } from "react";
import { FileQuestion, Loader2, Monitor } from "lucide-react";
import { isVaultMarkdownPath, READ_FILE_MAX_BYTES } from "@codecast/shared/contracts";
import { splitFrontmatter } from "../../lib/vault/frontmatter";
import type { RemoteFileState } from "../../lib/vault/remoteFile";
import { CodeText, formatSize } from "./VaultFileView";
import { VaultMarkdown } from "./VaultMarkdown";

export const RemoteFileView = memo(function RemoteFileView({ state }: { state: RemoteFileState }) {
  const title = state.abs.slice(state.abs.lastIndexOf("/") + 1);
  const markdown = isVaultMarkdownPath(state.abs);
  const body = useMemo(
    () => (state.status === "ready" && markdown ? splitFrontmatter(state.content)[1] : null),
    [state, markdown],
  );

  if (state.status !== "ready") {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 px-8 text-center text-sol-text-muted">
        {state.status === "loading" ? (
          <Loader2 className="w-6 h-6 animate-spin opacity-50" />
        ) : (
          <FileQuestion className="w-8 h-8 opacity-30" />
        )}
        <div className="text-sm break-all">
          {state.status === "loading" ? `Reading ${title} from ${state.machine ?? "the session's machine"}…` : state.message}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto" data-vault-note-scroll>
      <div className={markdown ? "max-w-3xl mx-auto px-8 py-6" : "px-6 pr-10 py-5"}>
        <div className="text-meta text-sol-text-dim mb-1 break-all">{state.abs}</div>
        <div className="flex items-start gap-3 mb-3">
          <h1 className="flex-1 text-2xl font-semibold text-sol-text break-words">{title}</h1>
          <span
            className="mt-2 flex flex-shrink-0 items-center gap-1 text-meta text-sol-text-muted"
            title={`Read from ${state.machine}. Edit it there.`}
          >
            <Monitor className="w-3 h-3" />
            {state.machine}
          </span>
        </div>
        {body !== null ? (
          <div className="vault-prose prose prose-sm max-w-none">
            <VaultMarkdown content={body} />
          </div>
        ) : (
          <CodeText content={state.content} path={state.abs} />
        )}
        <div className="mt-4 pt-2 border-t border-sol-border/20 flex items-center gap-3 text-meta text-sol-text-dim">
          <span className="tabular-nums">{formatSize(state.size)}</span>
          <span>Read-only</span>
          {state.truncated && <span className="text-sol-yellow">First {formatSize(READ_FILE_MAX_BYTES)} shown</span>}
        </div>
      </div>
    </div>
  );
});
