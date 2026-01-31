"use client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { CodeBlock } from "../CodeBlock";

interface MarkdownRendererProps {
  content: string;
  filePath?: string;
  className?: string;
}

export function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return ext === 'md' || ext === 'mdx';
}

export function isPlanFile(filePath: string, content: string): boolean {
  const fileName = filePath.split('/').pop()?.toLowerCase() || '';
  if (fileName.includes('plan') || fileName === 'plan.md') {
    return true;
  }
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

export function MarkdownRenderer({ content, filePath = '', className = '' }: MarkdownRendererProps) {
  return (
    <div className={`prose prose-invert prose-sm max-w-none ${className}`}>
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
          h1: ({ children }) => (
            <h1 className="text-lg font-bold mt-0 mb-3 text-sol-text">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-base font-semibold mt-4 mb-2 text-sol-text">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-sm font-semibold mt-3 mb-1 text-sol-text-muted">
              {children}
            </h3>
          ),
          ul: ({ children }) => (
            <ul className="my-2 space-y-1 list-disc list-inside">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-2 space-y-1 list-decimal list-inside">{children}</ol>
          ),
          li: ({ children }) => {
            const text = String(children);
            const isCheckbox = text.startsWith('[ ]') || text.startsWith('[x]') || text.startsWith('[X]');
            if (isCheckbox) {
              const checked = text.startsWith('[x]') || text.startsWith('[X]');
              const label = text.slice(3).trim();
              return (
                <li className="flex items-start gap-2 list-none -ml-4">
                  <span className={`mt-0.5 ${checked ? 'text-emerald-400' : 'text-sol-text-dim'}`}>
                    {checked ? '✓' : '○'}
                  </span>
                  <span className={checked ? 'text-sol-text-muted line-through' : ''}>{label}</span>
                </li>
              );
            }
            return <li className="text-sol-text-secondary">{children}</li>;
          },
          strong: ({ children }) => (
            <strong className="font-semibold">{children}</strong>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-sol-border pl-3 my-2 text-sol-text-muted italic">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a href={href} className="text-blue-400 hover:text-blue-300 underline" target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-3">
              <table className="min-w-full text-xs border-collapse border border-sol-border/50">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-sol-border/50 px-2 py-1 bg-sol-bg-highlight text-left font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-sol-border/50 px-2 py-1">{children}</td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
