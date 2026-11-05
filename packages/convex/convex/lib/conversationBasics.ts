// Small pure helpers conversations.ts uses for share links, titles from
// session slugs, and telling a real message from an empty one.

export function generateShareToken(): string {
  return crypto.randomUUID();
}

export function formatSlugAsTitle(slug: string): string {
  return slug
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

type MessageLike = {
  content?: string | null;
  tool_calls?: unknown[] | null;
  tool_results?: unknown[] | null;
};

export function isNonEmptyMessage(m: MessageLike): boolean {
  const hasContent = m.content && m.content.trim();
  const hasToolCalls = m.tool_calls && m.tool_calls.length > 0;
  const hasToolResults = m.tool_results && m.tool_results.length > 0;
  return !!(hasContent || hasToolCalls || hasToolResults);
}
