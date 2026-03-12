"use client";

import { useState } from "react";
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

function ClaudeIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.3041 3.541h-3.6718l6.696 16.918H24L17.3041 3.541Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409H6.696Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456H6.3247Z" />
    </svg>
  );
}

function OpenAIIcon({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
    </svg>
  );
}

function AgentIcon({ agentType, className = "w-4 h-4" }: { agentType: string; className?: string }) {
  if (agentType === "claude_code") {
    return <ClaudeIcon className={`${className} text-sol-orange`} />;
  } else if (agentType === "codex") {
    return <OpenAIIcon className={`${className} text-emerald-400`} />;
  }
  return null;
}

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
            <AgentIcon agentType={conversation.agent_type} className="w-5 h-5 flex-shrink-0" />
          </div>
          {conversation.description && (
            <CardDescription className="line-clamp-2">{conversation.description}</CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <p className="text-sm text-sol-text-muted0 line-clamp-3 mb-4">{conversation.preview_text}</p>

          <div className="flex items-center gap-2 mb-3 text-xs text-sol-text-muted0">
            <span>{conversation.author_name}</span>
            <span>•</span>
            <span>{formatTimeAgo(conversation.created_at)}</span>
          </div>

          <div className="flex items-center gap-4 text-xs text-sol-text-muted0 mb-3">
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

  const conversations = useQuery(api.conversations.listPublicConversations, {
    search: search || undefined,
    sort,
    agent_type: agentType || undefined,
    limit: 24,
  });

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
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sol-text-muted0" />
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
                <ClaudeIcon className="w-3 h-3" />
                Claude Code
              </Button>
              <Button
                variant={agentType === "codex" ? "default" : "outline"}
                size="sm"
                onClick={() => setAgentType("codex")}
                className="gap-1"
              >
                <OpenAIIcon className="w-3 h-3" />
                Codex
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
