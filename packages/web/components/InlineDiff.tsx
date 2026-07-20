import { createContext, useContext, useMemo, useState, memo } from "react";
import type { ReactNode } from "react";
import { parsePatch, getFileStatus } from "../lib/patchParser";
import type { PatchHunk } from "../lib/patchParser";
import { DiffView } from "./DiffView";
import { CodeBlock } from "./CodeBlock";

// Inline diff transclusion. A message carries a ```cast-diff fenced block whose
// body is verbatim `git diff` output; it renders as GitHub-PR-style file cards
// instead of a dumb code fence. Generate the diff with full context
// (`git diff -U99999`) and the whole file rides inside the message — the card
// renders collapsed to changed hunks and "expanding" is pure progressive
// disclosure, no server round-trip. The message IS the artifact: nothing is
// synced, so the diff is a frozen snapshot of the review moment by design.
export const DIFF_FENCE = "cast-diff";

// Identity of the message a markdown body belongs to, provided by the
// conversation view. Inside a conversation, diff lines get DiffView's
// per-line comment affordance (comments join the shared review batch and ride
// out on the user's next reply). On surfaces with no conversation — share
// pages, docs — the context is absent and the diff renders inert.
export const MessageIdentity = createContext<{ conversationId: string; messageId: string } | null>(null);

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

interface DiffFileSection {
  path: string;
  status: "added" | "deleted" | "modified";
  hunks: PatchHunk[];
  oldContent: string;
  newContent: string;
  additions: number;
  deletions: number;
  // True when the patch carries the whole file in one hunk (git diff -U<huge>).
  // Only then can DiffView's oldStr/newStr mode re-collapse and expand context
  // client-side; a plain -U3 patch renders its hunks as-is, nothing to expand.
  fullContext: boolean;
}

// Split a (possibly multi-file) `git diff` into per-file sections before
// parsing: parsePatch handles ONE file's patch, and a second file's
// `--- a/...`/`+++ b/...` header lines would otherwise leak into the previous
// file's last hunk as phantom deletion/addition lines.
export function parseCastDiff(raw: string): DiffFileSection[] {
  const segments: string[] = [];
  const headerRe = /^diff --git /;
  let current: string[] = [];
  for (const line of raw.split("\n")) {
    if (headerRe.test(line) && current.length) {
      segments.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length) segments.push(current.join("\n"));

  const files: DiffFileSection[] = [];
  for (const segment of segments) {
    if (!/^@@\s*-\d/m.test(segment)) continue;
    const oldHeader = segment.match(/^--- (?:a\/)?(.+)$/m)?.[1]?.trim();
    const newHeader = segment.match(/^\+\+\+ (?:b\/)?(.+)$/m)?.[1]?.trim();
    const gitHeader = segment.match(/^diff --git a\/.+ b\/(.+)$/m)?.[1]?.trim();
    const status =
      oldHeader === "/dev/null" || /^new file mode /m.test(segment)
        ? "added"
        : newHeader === "/dev/null" || /^deleted file mode /m.test(segment)
          ? "deleted"
          : "modified";
    const path =
      (status === "deleted" ? oldHeader : newHeader && newHeader !== "/dev/null" ? newHeader : oldHeader) ??
      gitHeader;
    if (!path || path === "/dev/null") continue;

    const parsed = parsePatch(segment);
    if (!parsed.hunks.length) continue;
    let additions = 0;
    let deletions = 0;
    for (const hunk of parsed.hunks) {
      for (const line of hunk.lines) {
        if (line.type === "addition") additions++;
        else if (line.type === "deletion") deletions++;
      }
    }
    files.push({
      path,
      status,
      hunks: parsed.hunks,
      oldContent: parsed.oldContent,
      newContent: parsed.newContent,
      additions,
      deletions,
      fullContext:
        status === "modified" && parsed.hunks.length === 1 && parsed.hunks[0].oldStart <= 1 && parsed.hunks[0].newStart <= 1,
    });
  }
  return files;
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

const COLLAPSED_CONTEXT_LINES = 3;
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
            contextLines={expanded ? UNLIMITED : COLLAPSED_CONTEXT_LINES}
            maxLines={expanded ? UNLIMITED : COLLAPSED_MAX_LINES}
            showLineNumbers
            language={language}
            commentContext={commentContext}
            onExpandContext={expanded ? undefined : () => setExpanded(true)}
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
