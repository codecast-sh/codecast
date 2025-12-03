import { ConvexHttpClient } from "convex/browser";
import { redactSecrets } from "./redact";

export type AgentType = "claude_code" | "codex" | "cursor";

export interface SyncConfig {
  convexUrl: string;
  authToken?: string;
}

export interface CreateConversationParams {
  userId: string;
  teamId?: string;
  sessionId: string;
  agentType: AgentType;
}

export class SyncService {
  private client: ConvexHttpClient;

  constructor(config: SyncConfig) {
    this.client = new ConvexHttpClient(config.convexUrl);
    if (config.authToken) {
      this.client.setAuth(config.authToken);
    }
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
}
