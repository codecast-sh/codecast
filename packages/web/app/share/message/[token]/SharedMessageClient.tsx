"use client";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import Link from "next/link";
import { CodeBlock } from "@/components/CodeBlock";
import { CollapsibleImage } from "@/components/tools/MarkdownRenderer";

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

function formatToolName(name: string): string {
  if (name.startsWith("mcp__claude-in-chrome__")) {
    const method = name.replace("mcp__claude-in-chrome__", "");
    return method.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()).slice(0, 12);
  }
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const method = parts[2] || parts[1] || name;
    return method.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()).slice(0, 12);
  }
  return name;
}

function getToolSummary(tool: any): string | null {
  let parsedInput: Record<string, unknown> = {};
  try {
    parsedInput = JSON.parse(tool.input);
  } catch {}

  const truncateStr = (s: string, max: number) => s.length > max ? s.slice(0, max) + "..." : s;

  if (tool.name === "Edit" || tool.name === "Read" || tool.name === "Write") {
    const filePath = String(parsedInput.file_path || "");
    const parts = filePath.split("/");
    return parts.slice(-2).join("/");
  }
  if (tool.name === "Bash" && parsedInput.command) {
    const cmd = String(parsedInput.command);
    return cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd;
  }
  if (tool.name === "Glob" && parsedInput.pattern) return String(parsedInput.pattern);
  if (tool.name === "Grep" && parsedInput.pattern) return String(parsedInput.pattern);
  if (tool.name === "Task" && parsedInput.description) return truncateStr(String(parsedInput.description), 40);
  return null;
}

const toolColors: Record<string, string> = {
  Edit: "text-sol-orange/80",
  Write: "text-sol-orange/80",
  Read: "text-sol-blue/80",
  Bash: "text-sol-green/80",
  Glob: "text-sol-violet/80",
  Grep: "text-sol-violet/80",
  Task: "text-sol-cyan/80",
  TodoWrite: "text-sol-magenta/80",
};

function getLanguageFromPath(filePath: string): string | undefined {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const extMap: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rs: "rust", go: "go", rb: "ruby", java: "java",
    css: "css", scss: "scss", html: "html", json: "json", yaml: "yaml",
    yml: "yaml", toml: "toml", sql: "sql", sh: "bash", bash: "bash",
    zsh: "bash", swift: "swift", kt: "kotlin", c: "c", cpp: "cpp",
    h: "c", hpp: "cpp", md: "markdown", mdx: "markdown",
  };
  return ext ? extMap[ext] : undefined;
}

function isPlanFile(filePath: string, content: string): boolean {
  const fileName = filePath.split('/').pop()?.toLowerCase() || '';
  if (fileName.includes('plan') || fileName === 'plan.md') return true;
  if (filePath.includes('.claude/plans/')) return true;
  const planPatterns = [
    /^#\s*(implementation\s+)?plan/im,
    /^##\s*(goals?|objectives?|overview)/im,
    /^##\s*(steps?|phases?|tasks?|approach)/im,
    /^\d+\.\s+\*\*[^*]+\*\*/m,
    /^-\s+\[[ x]\]/im,
  ];
  let matches = 0;
  for (const pattern of planPatterns) {
    if (pattern.test(content)) {
      matches++;
      if (matches >= 2) return true;
    }
  }
  return false;
}

function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return ext === 'md' || ext === 'mdx';
}

function parseWriteToolCall(tool: any): { filePath: string; content: string } | null {
  if (tool.name !== "Write") return null;
  try {
    const parsed = JSON.parse(tool.input);
    const filePath = String(parsed.file_path || "");
    const content = parsed.content || "";
    if (!content) return null;
    return { filePath, content };
  } catch {
    return null;
  }
}

function parseEditToolCall(tool: any): { filePath: string; oldString: string; newString: string } | null {
  if (tool.name !== "Edit") return null;
  try {
    const parsed = JSON.parse(tool.input);
    return {
      filePath: String(parsed.file_path || ""),
      oldString: parsed.old_string || "",
      newString: parsed.new_string || "",
    };
  } catch {
    return null;
  }
}


function WriteCodeBlock({ filePath, content }: { filePath: string; content: string }) {
  const fileName = filePath.split("/").pop() || filePath;
  const language = getLanguageFromPath(filePath);

  return (
    <div className="mb-4 rounded-lg border border-sol-border/60 bg-sol-bg-alt/30 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-sol-border/40">
        <svg className="w-3.5 h-3.5 text-sol-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
        </svg>
        <span className="text-xs font-mono text-sol-text-muted truncate">{fileName}</span>
      </div>
      <div className="max-h-[600px] overflow-y-auto">
        <CodeBlock code={content} language={language} />
      </div>
    </div>
  );
}

function EditDiffBlock({ filePath, oldString, newString }: { filePath: string; oldString: string; newString: string }) {
  const fileName = filePath.split("/").pop() || filePath;
  const language = getLanguageFromPath(filePath);

  return (
    <div className="mb-4 rounded-lg border border-sol-border/60 bg-sol-bg-alt/30 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-sol-border/40">
        <svg className="w-3.5 h-3.5 text-sol-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
        <span className="text-xs font-mono text-sol-text-muted truncate">{fileName}</span>
      </div>
      <div className="max-h-[600px] overflow-y-auto">
        <CodeBlock code={newString} language={language} />
      </div>
    </div>
  );
}

function MarkdownContentBlock({ content, label, timestamp }: { content: string; label: string; timestamp?: number }) {
  return (
    <div className="mb-4 rounded-lg border border-sol-border/60 bg-sol-bg-alt/30 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-sol-border/40">
        <svg className="w-3.5 h-3.5 text-sol-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
        </svg>
        <span className="text-xs font-medium text-sol-text-muted">{label}</span>
        {timestamp && (
          <span className="text-xs text-sol-text-dim">{formatRelativeTime(timestamp)}</span>
        )}
      </div>
      <div className="px-4 py-3 prose prose-invert prose-sm max-w-none text-sol-text">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={{
            img: ({ src, alt }) => <CollapsibleImage src={src} alt={alt} />,
            pre: ({ node, children, ...props }) => {
              const codeElement = node?.children?.[0];
              if (codeElement && codeElement.type === 'element' && codeElement.tagName === 'code') {
                const className = codeElement.properties?.className as string[] | undefined;
                const lang = className?.find((cls) => cls.startsWith('language-'))?.replace('language-', '');
                const codeContent = codeElement.children?.[0];
                const code = codeContent && 'value' in codeContent ? String(codeContent.value) : '';
                if (code) return <CodeBlock code={code} language={lang} />;
              }
              return <pre {...props}>{children}</pre>;
            },
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}

function ToolCallBlock({ tool }: { tool: any }) {
  const summary = getToolSummary(tool);
  const color = toolColors[tool.name] || (tool.name.startsWith("mcp__") ? "text-sol-cyan/80" : "text-sol-text-dim");

  return (
    <div className="my-0.5 pl-7">
      <div className="flex items-center gap-1.5 text-xs">
        <span className={`font-mono ${color}`}>{formatToolName(tool.name)}</span>
        {summary && (
          <span className="text-sol-text-muted font-mono truncate">{summary}</span>
        )}
      </div>
    </div>
  );
}

function MessageBlock({ message, isTarget }: { message: any; isTarget?: boolean }) {
  const isUser = message.role === "user";
  const hasToolResults = message.tool_results && message.tool_results.length > 0;
  const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;
  const hasContent = message.content && message.content.trim().length > 0;

  if (isUser && hasToolResults) {
    return null;
  }

  if (!isUser && !hasContent && !hasToolCalls) {
    return null;
  }

  return (
    <div className={`relative ${isTarget ? "bg-sol-yellow/5 rounded-lg" : ""}`}>
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
          {hasToolCalls && message.tool_calls.map((tc: any) => {
            const writeData = parseWriteToolCall(tc);
            if (writeData) {
              if (isPlanFile(writeData.filePath, writeData.content)) {
                return <MarkdownContentBlock key={tc.id} content={writeData.content} label="Plan" timestamp={message.timestamp} />;
              }
              if (isMarkdownFile(writeData.filePath)) {
                const fileName = writeData.filePath.split("/").pop() || writeData.filePath;
                return <MarkdownContentBlock key={tc.id} content={writeData.content} label={fileName} timestamp={message.timestamp} />;
              }
              return <WriteCodeBlock key={tc.id} filePath={writeData.filePath} content={writeData.content} />;
            }
            const editData = parseEditToolCall(tc);
            if (editData && editData.newString) {
              return <EditDiffBlock key={tc.id} filePath={editData.filePath} oldString={editData.oldString} newString={editData.newString} />;
            }
            return <ToolCallBlock key={tc.id} tool={tc} />;
          })}
          {hasContent && (
            <div className="pl-7 prose prose-invert prose-sm max-w-none text-sol-text">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{
                  img: ({ src, alt }) => <CollapsibleImage src={src} alt={alt} />,
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

export default function SharedMessageClient() {
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
      <div className="max-w-4xl mx-auto px-4 py-8">
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
