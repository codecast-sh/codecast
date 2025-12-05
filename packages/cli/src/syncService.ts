import { ConvexHttpClient } from "convex/browser";
import { redactSecrets } from "./redact.js";
import { hashPath } from "./hash.js";

export type AgentType = "claude_code" | "codex" | "cursor";

export interface SyncConfig {
  convexUrl: string;
  authToken?: string;
  userId?: string;
}

export interface CreateConversationParams {
  userId: string;
  teamId?: string;
  sessionId: string;
  agentType: AgentType;
  projectPath?: string;
  slug?: string;
  startedAt?: number;
}

export class SyncService {
  private client: ConvexHttpClient;
  private userId?: string;

  constructor(config: SyncConfig) {
    this.client = new ConvexHttpClient(config.convexUrl);
    if (config.authToken) {
      this.client.setAuth(config.authToken);
    }
    this.userId = config.userId;
  }

  setUserId(userId: string): void {
    this.userId = userId;
  }

  async createConversation(params: CreateConversationParams): Promise<string> {
    const projectHash = params.projectPath
      ? hashPath(params.projectPath)
      : undefined;
    const result = await this.client.mutation(
      "conversations:createConversation" as any,
      {
        user_id: params.userId,
        team_id: params.teamId,
        agent_type: params.agentType,
        session_id: params.sessionId,
        project_hash: projectHash,
        slug: params.slug,
        started_at: params.startedAt,
      }
    );
    return result as string;
  }

  setAuth(token: string): void {
    this.client.setAuth(token);
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
    const redactedContent = redactSecrets(params.content);
    const redactedThinking = params.thinking ? redactSecrets(params.thinking) : undefined;
    const roleMap: Record<string, "user" | "assistant" | "system" | "tool"> = {
      human: "user",
      assistant: "assistant",
      system: "system",
    };

    const toolCalls = params.toolCalls?.map(tc => ({
      id: tc.id,
      name: tc.name,
      input: redactSecrets(JSON.stringify(tc.input)),
    }));

    const toolResults = params.toolResults?.map(tr => ({
      tool_use_id: tr.toolUseId,
      content: redactSecrets(tr.content),
      is_error: tr.isError,
    }));

    const images = params.images?.map(img => ({
      media_type: img.mediaType,
      data: img.data,
    }));

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
      }
    );
    return position ?? 0;
  }
}
