import { useContext, useMemo, useState, memo } from "react";
import type { ReactNode } from "react";
import { getFileStatus } from "../lib/patchParser";
import { DIFF_FENCE, parseCastDiff, type DiffFileSection } from "../lib/castDiff";
import { DiffView } from "./DiffView";
import { CodeBlock } from "./CodeBlock";
import { MessageIdentity } from "../lib/conversationBlockContexts";

// Inline diff transclusion. A message carries a ```cast-diff fenced block whose
// body is verbatim `git diff` output; it renders as GitHub-PR-style file cards
// instead of a dumb code fence. Generate the diff with full context
// (`git diff -U99999`) and the whole file rides inside the message — the card
// renders collapsed to changed hunks and "expanding" is pure progressive
// disclosure, no server round-trip. The message IS the artifact: nothing is
// synced, so the diff is a frozen snapshot of the review moment by design.

// Inside a conversation (MessageIdentity), diff lines get DiffView's per-line
// comment affordance (comments join the shared review batch and ride out on
// the user's next reply). On surfaces with no conversation — share pages,
// docs — the context is absent and the diff renders inert.
export { MessageIdentity };
export { DIFF_FENCE, parseCastDiff };

export function MessageIdentityProvider({
  conversationId,
  messageId,
  children,
}: {
  conversationId: string;
  messageId: string;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ conversationId, messageId }), [conversationId, messageId]);
  return <MessageIdentity.Provider value={value}>{children}</MessageIdentity.Provider>;
}

/** Returns a rendered inline diff for a cast-diff fence, else null (caller falls back to CodeBlock). */
export function tryRenderCastDiff(language: string | undefined, code: string): ReactNode {
  if (language === DIFF_FENCE && code) return <InlineDiff raw={code} />;
  return null;
}

const EXT_TO_LANGUAGE: Record<string, string> = {
  md: "markdown",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  py: "python",
  json: "json",
  css: "css",
  sh: "bash",
  yml: "yaml",
  yaml: "yaml",
};

function languageFromPath(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext ? EXT_TO_LANGUAGE[ext] : undefined;
}

const COLLAPSED_MAX_LINES = 40;
const UNLIMITED = Number.MAX_SAFE_INTEGER;

export const InlineDiff = memo(function InlineDiff({ raw }: { raw: string }) {
  const identity = useContext(MessageIdentity);
  const files = useMemo(() => parseCastDiff(raw), [raw]);
  if (!files.length) return <CodeBlock code={raw} language="diff" />;
  return (
    <div className="not-prose my-3 space-y-3">
      {files.map((file) => (
        <DiffFileCard key={file.path} file={file} identity={identity} />
      ))}
    </div>
  );
});

function DiffFileCard({
  file,
  identity,
}: {
  file: DiffFileSection;
  identity: { conversationId: string; messageId: string } | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const statusMeta = getFileStatus(file.status);
  const language = languageFromPath(file.path);
  const commentContext = identity
    ? {
        conversationId: identity.conversationId,
        anchorKey: `diff:${identity.messageId}:${file.path}`,
        filePath: file.path,
      }
    : undefined;

  return (
    <div className="rounded-md border border-sol-border/60 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-sol-bg-highlight/50 border-b border-sol-border/40 text-xs font-mono">
        <span className={`${statusMeta.color} ${statusMeta.bgColor} rounded px-1 font-semibold select-none`}>
          {statusMeta.label}
        </span>
        <span className="text-sol-text-muted truncate">{file.path}</span>
        <span className="ml-auto flex items-center gap-2 shrink-0">
          {file.additions > 0 && <span className="text-sol-green">+{file.additions}</span>}
          {file.deletions > 0 && <span className="text-sol-red">−{file.deletions}</span>}
          {file.fullContext && (
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              className="text-sol-blue hover:text-sol-cyan transition-colors"
            >
              {expanded ? "collapse" : "expand all"}
            </button>
          )}
        </span>
      </div>
      <div className="px-2 py-1">
        {file.fullContext ? (
          <DiffView
            oldStr={file.oldContent}
            newStr={file.newContent}
            expandUnchanged={expanded}
            maxLines={expanded ? UNLIMITED : COLLAPSED_MAX_LINES}
            showLineNumbers
            language={language}
            commentContext={commentContext}
          />
        ) : (
          <DiffView
            hunks={file.hunks}
            maxLines={COLLAPSED_MAX_LINES}
            showLineNumbers
            language={language}
            commentContext={commentContext}
          />
        )}
      </div>
    </div>
  );
}
