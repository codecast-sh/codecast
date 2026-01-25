"use client";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import Link from "next/link";
import { CodeBlock } from "@/components/CodeBlock";

function formatRelativeTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

function formatFullTimestamp(ts: number): string {
  return new Date(ts).toLocaleString();
}

function UserIcon() {
  return (
    <div className="w-5 h-5 rounded-full bg-sol-blue/20 flex items-center justify-center">
      <svg className="w-3 h-3 text-sol-blue" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
      </svg>
    </div>
  );
}

function ClaudeIcon() {
  return (
    <div className="w-5 h-5 rounded-full bg-sol-orange/20 flex items-center justify-center">
      <svg className="w-3 h-3 text-sol-orange" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" strokeWidth="2" fill="none" />
      </svg>
    </div>
  );
}

function MessageBlock({ message, isTarget }: { message: any; isTarget?: boolean }) {
  const isUser = message.role === "user";
  const hasToolResults = message.tool_results && message.tool_results.length > 0;

  if (isUser && hasToolResults) {
    return null;
  }

  return (
    <div className={`relative ${isTarget ? "ring-2 ring-sol-yellow/50 rounded-lg p-4 -m-2 bg-sol-yellow/5" : ""}`}>
      {isUser ? (
        <div className="bg-sol-blue/15 border border-sol-blue/40 rounded-lg p-4 mb-4">
          <div className="flex items-center gap-2 mb-2">
            <UserIcon />
            <span className="text-sol-blue text-xs font-medium">User</span>
            <span
              className="text-sol-text-dim text-xs"
              title={formatFullTimestamp(message.timestamp)}
            >
              {formatRelativeTime(message.timestamp)}
            </span>
          </div>
          <div className="text-sol-text text-sm pl-7 whitespace-pre-wrap break-words">
            {message.content}
          </div>
        </div>
      ) : (
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <ClaudeIcon />
            <span className="text-sol-orange text-xs font-medium">Claude</span>
            <span
              className="text-sol-text-dim text-xs"
              title={formatFullTimestamp(message.timestamp)}
            >
              {formatRelativeTime(message.timestamp)}
            </span>
          </div>
          {message.content && (
            <div className="pl-7 prose prose-invert prose-sm max-w-none text-sol-text">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{
                  pre: ({ node, children, ...props }) => {
                    const codeElement = node?.children?.[0];
                    if (codeElement && codeElement.type === 'element' && codeElement.tagName === 'code') {
                      const className = codeElement.properties?.className as string[] | undefined;
                      const language = className?.find((cls) => cls.startsWith('language-'))?.replace('language-', '');
                      const codeContent = codeElement.children?.[0];
                      const code = codeContent && 'value' in codeContent ? String(codeContent.value) : '';

                      if (code) {
                        return <CodeBlock code={code} language={language} />;
                      }
                    }
                    return <pre {...props}>{children}</pre>;
                  },
                }}
              >
                {message.content}
              </ReactMarkdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function SharedMessagePage() {
  const params = useParams();
  const token = params.token as string;

  const data = useQuery(api.messages.getSharedMessage, { share_token: token });

  if (data === undefined) {
    return (
      <main className="min-h-screen bg-sol-bg flex items-center justify-center">
        <div className="text-sol-text-muted">Loading...</div>
      </main>
    );
  }

  if (data === null) {
    return (
      <main className="min-h-screen bg-sol-bg flex flex-col items-center justify-center">
        <div className="text-center max-w-md px-4">
          <svg className="w-16 h-16 mx-auto mb-4 text-sol-text-dim" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
          <h1 className="text-xl text-sol-text mb-2">Message Not Found</h1>
          <p className="text-sol-text-muted text-sm">
            This share link is invalid or the message has been removed.
          </p>
        </div>
      </main>
    );
  }

  const { message, contextMessages, conversation, user, note, sharedAt } = data;

  return (
    <main className="min-h-screen bg-sol-bg">
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-2">
            {user?.image ? (
              <img src={user.image} alt="" className="w-8 h-8 rounded-full" />
            ) : (
              <div className="w-8 h-8 rounded-full bg-sol-text-dim/20 flex items-center justify-center">
                <svg className="w-4 h-4 text-sol-text-dim" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
              </div>
            )}
            <div>
              <div className="text-sol-text text-sm font-medium">{user?.name || "Anonymous"}</div>
              <div className="text-sol-text-dim text-xs">
                Shared {formatRelativeTime(sharedAt)}
              </div>
            </div>
          </div>

          {conversation.title && (
            <Link
              href={`/conversation/${conversation._id}`}
              className="text-sol-text-muted hover:text-sol-blue text-sm transition-colors inline-flex items-center gap-1"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              {conversation.title}
            </Link>
          )}
        </div>

        {note && (
          <div className="mb-6 p-3 bg-sol-yellow/10 border border-sol-yellow/30 rounded-lg">
            <div className="text-sol-yellow text-xs font-medium mb-1">Note from sharer</div>
            <div className="text-sol-text text-sm">{note}</div>
          </div>
        )}

        <div className="border border-sol-border rounded-lg p-6 bg-sol-bg-alt">
          {contextMessages.map((msg: any, idx: number) => (
            <MessageBlock
              key={msg._id}
              message={msg}
              isTarget={msg._id === message._id}
            />
          ))}
        </div>

        <div className="mt-8 text-center">
          <Link
            href="/"
            className="text-sol-text-muted hover:text-sol-text text-sm transition-colors inline-flex items-center gap-2"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" strokeWidth="2" fill="none" />
            </svg>
            Powered by Codecast
          </Link>
        </div>
      </div>
    </main>
  );
}
