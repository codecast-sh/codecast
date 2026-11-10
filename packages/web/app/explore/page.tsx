import { useRef, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { AgentTypeIcon } from "../../components/AgentTypeIcon";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { LoadingSkeleton } from "../../components/LoadingSkeleton";
import { EmptyState } from "../../components/EmptyState";
import { Search, TrendingUp, Clock, Eye, MessageSquare } from "lucide-react";

function formatTimeAgo(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

type PublicConversation = {
  _id: string;
  title: string;
  description?: string;
  tags?: string[];
  preview_text: string;
  agent_type: string;
  message_count: number;
  created_at: number;
  view_count: number;
  author_name: string;
  author_avatar?: string;
  share_token: string | null;
};

function ConversationCard({ conversation }: { conversation: PublicConversation }) {
  if (!conversation.share_token) {
    return null;
  }

  return (
    <Link href={`/share/${conversation.share_token}`}>
      <Card className="h-full hover:bg-sol-bg-alt/50 transition-colors cursor-pointer border-sol-border">
        <CardHeader>
          <div className="flex items-start justify-between gap-2 mb-2">
            <CardTitle className="text-base font-serif line-clamp-2">{conversation.title}</CardTitle>
            <AgentTypeIcon agentType={conversation.agent_type} className="w-5 h-5 flex-shrink-0" />
          </div>
          {conversation.description && (
            <CardDescription className="line-clamp-2">{conversation.description}</CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <p className="text-sm text-sol-text-muted line-clamp-3 mb-4">{conversation.preview_text}</p>

          <div className="flex items-center gap-2 mb-3 text-xs text-sol-text-muted">
            <span>{conversation.author_name}</span>
            <span>•</span>
            <span>{formatTimeAgo(conversation.created_at)}</span>
          </div>

          <div className="flex items-center gap-4 text-xs text-sol-text-muted mb-3">
            <div className="flex items-center gap-1">
              <Eye className="w-3 h-3" />
              <span>{conversation.view_count}</span>
            </div>
            <div className="flex items-center gap-1">
              <MessageSquare className="w-3 h-3" />
              <span>{conversation.message_count}</span>
            </div>
          </div>

          {conversation.tags && conversation.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {conversation.tags.slice(0, 3).map((tag) => (
                <Badge key={tag} variant="secondary" className="text-xs">
                  {tag}
                </Badge>
              ))}
              {conversation.tags.length > 3 && (
                <Badge variant="secondary" className="text-xs">
                  +{conversation.tags.length - 3}
                </Badge>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}

export default function ExplorePage() {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"recent" | "popular">("recent");
  const [agentType, setAgentType] = useState<string | null>(null);

  // The query follows the box after a pause in typing, and the grid keeps the
  // last answer while the next one loads instead of flashing skeletons.
  const [query, setQuery] = useState("");
  useWatchEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const result = useQuery(api.conversations.listPublicConversations, {
    search: query || undefined,
    sort,
    agent_type: agentType || undefined,
    limit: 24,
  });
  const lastResult = useRef(result);
  if (result !== undefined) lastResult.current = result;
  const conversations = result ?? lastResult.current;

  const isLoading = conversations === undefined;
  const isEmpty = conversations !== undefined && conversations.length === 0;

  return (
    <div className="min-h-screen bg-sol-bg">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="mb-8">
          <h1 className="text-4xl font-serif text-sol-text mb-2">Explore</h1>
          <p className="text-sol-text-muted">Discover public conversations from the community</p>
        </div>

        <div className="mb-6 space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sol-text-muted" />
            <Input
              placeholder="Search conversations..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <div className="flex gap-2">
              <Button
                variant={sort === "recent" ? "default" : "outline"}
                size="sm"
                onClick={() => setSort("recent")}
                className="gap-1"
              >
                <Clock className="w-3 h-3" />
                Recent
              </Button>
              <Button
                variant={sort === "popular" ? "default" : "outline"}
                size="sm"
                onClick={() => setSort("popular")}
                className="gap-1"
              >
                <TrendingUp className="w-3 h-3" />
                Popular
              </Button>
            </div>

            <div className="flex gap-2">
              <Button
                variant={agentType === null ? "default" : "outline"}
                size="sm"
                onClick={() => setAgentType(null)}
              >
                All
              </Button>
              <Button
                variant={agentType === "claude_code" ? "default" : "outline"}
                size="sm"
                onClick={() => setAgentType("claude_code")}
                className="gap-1"
              >
                <AgentTypeIcon agentType="claude_code" className="w-3 h-3" />
                Claude Code
              </Button>
              <Button
                variant={agentType === "codex" ? "default" : "outline"}
                size="sm"
                onClick={() => setAgentType("codex")}
                className="gap-1"
              >
                <AgentTypeIcon agentType="codex" className="w-3 h-3" />
                Codex
              </Button>
              <Button
                variant={agentType === "cursor" ? "default" : "outline"}
                size="sm"
                onClick={() => setAgentType("cursor")}
                className="gap-1"
              >
                <AgentTypeIcon agentType="cursor" className="w-3 h-3" />
                Cursor
              </Button>
              <Button
                variant={agentType === "gemini" ? "default" : "outline"}
                size="sm"
                onClick={() => setAgentType("gemini")}
                className="gap-1"
              >
                <AgentTypeIcon agentType="gemini" className="w-3 h-3" />
                Gemini
              </Button>
            </div>
          </div>
        </div>

        {isLoading && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-64">
                <LoadingSkeleton />
              </div>
            ))}
          </div>
        )}

        {isEmpty && !isLoading && (
          <EmptyState
            title="No conversations found"
            description={
              search
                ? "Try adjusting your search or filters"
                : "No public conversations have been shared yet"
            }
          />
        )}

        {conversations && conversations.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {conversations.map((conv) => (
              <ConversationCard key={conv._id} conversation={conv} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
