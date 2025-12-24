import { ConvexHttpClient, ConvexClient } from "convex/browser";
import { redactSecrets } from "./redact.js";
import { hashPath } from "./hash.js";

const MAX_CONTENT_SIZE = 100_000;
const MAX_TOOL_RESULT_SIZE = 50_000;
const MAX_TOTAL_MESSAGE_SIZE = 900_000;

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + `\n... [truncated ${str.length - maxLen} chars]`;
}

export type AgentType = "claude_code" | "codex" | "cursor";

export interface SyncConfig {
  convexUrl: string;
  authToken?: string;
  userId?: string;
}

export interface GitInfo {
  commitHash?: string;
  branch?: string;
  remoteUrl?: string;
  status?: string;
  diff?: string;
  diffStaged?: string;
  root?: string;
}

export interface CreateConversationParams {
  userId: string;
  teamId?: string;
  sessionId: string;
  agentType: AgentType;
  projectPath?: string;
  slug?: string;
  title?: string;
  startedAt?: number;
  parentMessageUuid?: string;
  gitCommitHash?: string;
  gitInfo?: GitInfo;
}

export class SyncService {
  private client: ConvexHttpClient;
  private subscriptionClient: ConvexClient;
  private userId?: string;
  private apiToken?: string;

  constructor(config: SyncConfig) {
    this.client = new ConvexHttpClient(config.convexUrl);
    this.subscriptionClient = new ConvexClient(config.convexUrl);
    this.userId = config.userId;
    this.apiToken = config.authToken;
  }

  getClient(): ConvexHttpClient {
    return this.client;
  }

  getSubscriptionClient(): ConvexClient {
    return this.subscriptionClient;
  }

  setUserId(userId: string): void {
    this.userId = userId;
  }

  setApiToken(token: string): void {
    this.apiToken = token;
  }

  async createConversation(params: CreateConversationParams): Promise<string> {
    const projectHash = params.projectPath
      ? hashPath(params.projectPath)
      : undefined;
    const gitInfo = params.gitInfo;
    const result = await this.client.mutation(
      "conversations:createConversation" as any,
      {
        user_id: params.userId,
        team_id: params.teamId,
        agent_type: params.agentType,
        session_id: params.sessionId,
        project_hash: projectHash,
        project_path: params.projectPath,
        slug: params.slug,
        title: params.title,
        started_at: params.startedAt,
        parent_message_uuid: params.parentMessageUuid,
        git_commit_hash: gitInfo?.commitHash || params.gitCommitHash,
        git_branch: gitInfo?.branch,
        git_remote_url: gitInfo?.remoteUrl,
        git_status: gitInfo?.status,
        git_diff: gitInfo?.diff,
        git_diff_staged: gitInfo?.diffStaged,
        git_root: gitInfo?.root,
        api_token: this.apiToken,
      }
    );
    return result as string;
  }

  async addMessage(params: {
    conversationId: string;
    messageUuid?: string;
    role: "human" | "assistant" | "system";
    content: string;
    timestamp: number;
    thinking?: string;
    toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
    toolResults?: Array<{ toolUseId: string; content: string; isError?: boolean }>;
    images?: Array<{ mediaType: string; data: string }>;
    subtype?: string;
  }): Promise<string> {
    const redactedContent = truncate(redactSecrets(params.content), MAX_CONTENT_SIZE);
    const redactedThinking = params.thinking
      ? truncate(redactSecrets(params.thinking), MAX_CONTENT_SIZE)
      : undefined;
    const roleMap: Record<string, "user" | "assistant" | "system" | "tool"> = {
      human: "user",
      assistant: "assistant",
      system: "system",
    };

    const toolCalls = params.toolCalls?.map(tc => ({
      id: tc.id,
      name: tc.name,
      input: truncate(redactSecrets(JSON.stringify(tc.input)), MAX_TOOL_RESULT_SIZE),
    }));

    const toolResults = params.toolResults?.map(tr => ({
      tool_use_id: tr.toolUseId,
      content: truncate(redactSecrets(tr.content), MAX_TOOL_RESULT_SIZE),
      is_error: tr.isError,
    }));

    const images = params.images?.filter(img => {
      const size = img.data.length;
      return size < MAX_TOOL_RESULT_SIZE;
    }).slice(0, 5);

    const messageId = await this.client.mutation(
      "messages:addMessage" as any,
      {
        conversation_id: params.conversationId,
        message_uuid: params.messageUuid,
        role: roleMap[params.role],
        content: redactedContent,
        thinking: redactedThinking,
        tool_calls: toolCalls,
        tool_results: toolResults,
        images,
        subtype: params.subtype,
        timestamp: params.timestamp,
        api_token: this.apiToken,
      }
    );
    return messageId as string;
  }

  async updateSyncCursor(params: {
    filePath: string;
    byteOffset: number;
  }): Promise<void> {
    if (!this.userId) {
      throw new Error("userId required for sync cursor operations");
    }
    const filePathHash = hashPath(params.filePath);
    await this.client.mutation("syncCursors:updateSyncCursor" as any, {
      user_id: this.userId,
      file_path_hash: filePathHash,
      last_position: params.byteOffset,
      api_token: this.apiToken,
    });
  }

  async getSyncCursor(filePath: string): Promise<number> {
    if (!this.userId) {
      throw new Error("userId required for sync cursor operations");
    }
    const filePathHash = hashPath(filePath);
    const position = await this.client.query(
      "syncCursors:getSyncCursor" as any,
      {
        user_id: this.userId,
        file_path_hash: filePathHash,
        api_token: this.apiToken,
      }
    );
    return position ?? 0;
  }

  async updateTitle(conversationId: string, title: string): Promise<void> {
    await this.client.mutation("conversations:updateTitle" as any, {
      conversation_id: conversationId,
      title,
      api_token: this.apiToken,
    });
  }

  async updateMessageStatus(params: {
    messageId: string;
    status: "pending" | "delivered" | "failed";
    deliveredAt?: number;
  }): Promise<void> {
    await this.client.mutation("pendingMessages:updateMessageStatus" as any, {
      message_id: params.messageId,
      status: params.status,
      delivered_at: params.deliveredAt,
      api_token: this.apiToken,
    });
  }
}
