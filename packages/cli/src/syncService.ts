import { ConvexHttpClient } from "convex/browser";
import { Id } from "@code-chat-sync/convex";
import { redactSecrets } from "./redact";
import { hashPath } from "./hash";

export type AgentType = "claude_code" | "codex" | "cursor";

export interface SyncConfig {
  convexUrl: string;
  authToken?: string;
  userId?: Id<"users">;
}

export interface CreateConversationParams {
  userId: string;
  teamId?: string;
  sessionId: string;
  agentType: AgentType;
}

export class SyncService {
  private client: ConvexHttpClient;
  private userId?: Id<"users">;

  constructor(config: SyncConfig) {
    this.client = new ConvexHttpClient(config.convexUrl);
    if (config.authToken) {
      this.client.setAuth(config.authToken);
    }
    this.userId = config.userId;
  }

  setUserId(userId: Id<"users">): void {
    this.userId = userId;
  }

  async createConversation(params: CreateConversationParams): Promise<string> {
    const result = await this.client.mutation(
      "conversations:createConversation" as any,
      {
        user_id: params.userId,
        team_id: params.teamId,
        agent_type: params.agentType,
        session_id: params.sessionId,
      }
    );
    return result as string;
  }

  setAuth(token: string): void {
    this.client.setAuth(token);
  }

  async addMessage(params: {
    conversationId: string;
    role: "human" | "assistant" | "tool_use" | "tool_result";
    content: string;
    timestamp: number;
    toolName?: string;
    toolInput?: string;
  }): Promise<string> {
    const redactedContent = redactSecrets(params.content);
    const roleMap: Record<string, "user" | "assistant" | "system" | "tool"> = {
      human: "user",
      assistant: "assistant",
      tool_use: "tool",
      tool_result: "tool",
    };
    const messageId = await this.client.mutation(
      "messages:addMessage" as any,
      {
        conversation_id: params.conversationId,
        role: roleMap[params.role],
        content: redactedContent,
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
