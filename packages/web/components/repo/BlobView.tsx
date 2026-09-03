// One file, line by line.
//
// Every line is its own row so three things can hang off it: a line number that
// is also an anchor, a blame note in front of it, and a comment thread under
// it. The code itself is highlighted once for the whole file and split per line
// (lib/codeLanguage), so a block comment keeps its colour across the break.
import { useMemo, type ReactNode } from "react";
import Link from "next/link";
import { MessageSquarePlus } from "lucide-react";
import { highlightLines, languageForPath } from "../../lib/codeLanguage";
import {
  HIGHLIGHT_LINE_LIMIT,
  indexBlameRanges,
  isLineSelected,
  startsBlameRange,
  type LineRange,
  type RepoBlameRange,
} from "../../lib/repoView";
import { relTimeShort } from "../../lib/utils";

export function BlobView({
  repository,
  path,
  content,
  selection,
  onSelectLine,
  blameRanges,
  blameOn,
  threadsByLine,
  renderThread,
  onComment,
}: {
  repository: string;
  path: string;
  content: string;
  selection: LineRange | null;
  /** A plain click selects one line; shift extends from where the selection started. */
  onSelectLine: (line: number, extend: boolean) => void;
  blameRanges?: readonly RepoBlameRange[];
  blameOn: boolean;
  threadsByLine?: ReadonlyMap<number, unknown[]>;
  renderThread?: (line: number, items: unknown[]) => ReactNode;
  onComment?: (line: number) => void;
}) {
  const lines = useMemo(() => content.split("\n"), [content]);
  const tooBigToColour = lines.length > HIGHLIGHT_LINE_LIMIT;

  const html = useMemo(
    () => (tooBigToColour ? null : highlightLines(content, languageForPath(path))),
    [content, path, tooBigToColour],
  );

  const blameAt = useMemo(() => indexBlameRanges(blameRanges), [blameRanges]);
  const gutterWidth = `${Math.max(2, String(lines.length).length)}ch`;

  return (
    <div className="repo-code h-full overflow-auto text-[12px] leading-[20px]">
      <div className="min-w-max pb-24">
        {lines.map((line, index) => {
          const number = index + 1;
          const range = blameOn ? blameAt(number) : undefined;
          const selected = isLineSelected(selection, number);
          const thread = threadsByLine?.get(number);

          return (
            <div key={number}>
              <div
                id={`L${number}`}
                className={`repo-line flex items-start ${selected ? "repo-line-selected" : ""}`}
              >
                {blameOn && (
                  <div
                    className={`repo-blame w-[15rem] shrink-0 px-2 truncate text-[10px] ${
                      startsBlameRange(range, number) ? "repo-blame-start" : ""
                    }`}
                    title={range?.message}
                  >
                    {startsBlameRange(range, number) && range && (
                      <span className="flex items-center gap-1.5">
                        <Link
                          href={`/commit/${repository}/${range.sha}`}
                          className="font-mono hover:text-sol-text transition-colors"
                          style={{ color: "var(--repo-accent)" }}
                        >
                          {range.sha.slice(0, 7)}
                        </Link>
                        <span className="truncate">{range.author_login || range.author_name}</span>
                        {range.committed_at ? (
                          <span className="ml-auto shrink-0">{relTimeShort(range.committed_at)}</span>
                        ) : null}
                      </span>
                    )}
                  </div>
                )}

                <div className="flex items-center gap-1 shrink-0 pl-1 pr-2">
                  {onComment && (
                    <button
                      type="button"
                      onClick={() => onComment(number)}
                      className="repo-line-handle rounded p-0.5 text-sol-text-dim hover:text-sol-text"
                      title={`Comment on line ${number}`}
                      aria-label={`Comment on line ${number}`}
                    >
                      <MessageSquarePlus className="w-3 h-3" />
                    </button>
                  )}
                  <a
                    href={`#L${number}`}
                    onClick={(e) => {
                      e.preventDefault();
                      onSelectLine(number, e.shiftKey);
                    }}
                    className="repo-line-number block text-right tabular-nums"
                    style={{ width: gutterWidth }}
                  >
                    {number}
                  </a>
                </div>

                {html ? (
                  <code
                    className="whitespace-pre pr-6"
                    dangerouslySetInnerHTML={{ __html: html[index] ?? "" }}
                  />
                ) : (
                  <code className="whitespace-pre pr-6">{line}</code>
                )}
              </div>

              {thread && renderThread && (
                <div className="pl-[3.5rem] pr-6 max-w-3xl">{renderThread(number, thread)}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
