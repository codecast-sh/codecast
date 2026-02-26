import { ConvexHttpClient, ConvexClient } from "convex/browser";
import { redactSecrets } from "./redact.js";
import { hashPath } from "./hash.js";

const MAX_CONTENT_SIZE = 100_000;
const MAX_TOOL_RESULT_SIZE = 50_000;
const MAX_TOTAL_MESSAGE_SIZE = 900_000;
const MAX_IMAGE_SIZE = 5_000_000;
const MAX_IMAGES_PER_MESSAGE = 10;

const MIN_REQUEST_INTERVAL_MS = 100;

export class AuthExpiredError extends Error {
  constructor(message: string = "Authentication token expired") {
    super(message);
    this.name = "AuthExpiredError";
  }
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + `\n... [truncated ${str.length - maxLen} chars]`;
}

function isAuthError(error: any): boolean {
  const message = (error?.message || String(error)).toLowerCase();

  // Skip transient server errors - these are NOT auth errors
  if (
    message.includes("server error") ||
    message.includes("request id:") ||
    message.includes("optimisticconcurrencycontrolfailure") ||
    message.includes("rate limit") ||
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("econnrefused") ||
    message.includes("econnreset")
  ) {
    return false;
  }

  // Only match definitive auth errors, not generic "unauthorized"
  return (
    message.includes("invalid token") ||
    message.includes("token expired") ||
    message.includes("token not found") ||
    message.includes("authentication failed") ||
    (message.includes("auth") && message.includes("expired"))
  );
}

export type AgentType = "claude_code" | "codex" | "cursor" | "gemini";

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
  parentConversationId?: string;
  gitCommitHash?: string;
  gitInfo?: GitInfo;
  cliFlags?: string;
}

export class SyncService {
  private client: ConvexHttpClient;
  private subscriptionClient: ConvexClient;
  private userId?: string;
  private apiToken?: string;
  private lastRequestTime = 0;
  private throttleQueue: Promise<void> = Promise.resolve();

  constructor(config: SyncConfig) {
    this.client = new ConvexHttpClient(config.convexUrl);
    this.subscriptionClient = new ConvexClient(config.convexUrl);
    this.userId = config.userId;
    this.apiToken = config.authToken;
  }

  private async throttle(): Promise<void> {
    const ticket = this.throttleQueue.then(async () => {
      const now = Date.now();
      const elapsed = now - this.lastRequestTime;
      if (elapsed < MIN_REQUEST_INTERVAL_MS) {
        await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
      }
      this.lastRequestTime = Date.now();
    });
    this.throttleQueue = ticket;
    await ticket;
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

  async uploadImage(base64Data: string, mediaType: string): Promise<string | null> {
    try {
      const uploadUrl = await this.client.mutation(
        "images:generateUploadUrl" as any,
        { api_token: this.apiToken }
      );
      const binaryData = Buffer.from(base64Data, "base64");
      if (binaryData.length > MAX_IMAGE_SIZE) {
        return null;
      }
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": mediaType },
        body: binaryData,
      });
      if (!response.ok) {
        return null;
      }
      const result = await response.json();
      return result.storageId;
    } catch {
      return null;
    }
  }

  async createConversation(params: CreateConversationParams): Promise<string> {
    await this.throttle();
    const projectHash = params.projectPath
      ? hashPath(params.projectPath)
      : undefined;
    const gitInfo = params.gitInfo;
    try {
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
          parent_conversation_id: params.parentConversationId,
          git_commit_hash: gitInfo?.commitHash || params.gitCommitHash,
          git_branch: gitInfo?.branch,
          git_remote_url: gitInfo?.remoteUrl,
          git_status: gitInfo?.status,
          git_diff: gitInfo?.diff,
          git_diff_staged: gitInfo?.diffStaged,
          git_root: gitInfo?.root,
          cli_flags: params.cliFlags,
          api_token: this.apiToken,
        }
      );
      return result as string;
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError();
      }
      throw error;
    }
  }

  async linkSessions(parentConversationId: string, childConversationId: string): Promise<void> {
    await this.throttle();
    try {
      await this.client.mutation(
        "conversations:linkSessions" as any,
        {
          parent_conversation_id: parentConversationId,
          child_conversation_id: childConversationId,
          api_token: this.apiToken,
        }
      );
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError();
      }
      throw error;
    }
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
    images?: Array<{ mediaType: string; data: string; toolUseId?: string }>;
    subtype?: string;
  }): Promise<string> {
    await this.throttle();
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

    const images: Array<{ media_type: string; storage_id?: string; data?: string; tool_use_id?: string }> = [];
    if (params.images && params.images.length > 0) {
      const imagesToProcess = params.images.slice(0, MAX_IMAGES_PER_MESSAGE);
      for (const img of imagesToProcess) {
        const storageId = await this.uploadImage(img.data, img.mediaType);
        if (storageId) {
          images.push({ media_type: img.mediaType, storage_id: storageId, tool_use_id: img.toolUseId });
        }
      }
    }

    try {
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
          images: images.length > 0 ? images : undefined,
          subtype: params.subtype,
          timestamp: params.timestamp,
          api_token: this.apiToken,
        }
      );
      return messageId as string;
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError();
      }
      throw error;
    }
  }

  async addMessages(params: {
    conversationId: string;
    messages: Array<{
      messageUuid?: string;
      role: "human" | "assistant" | "system";
      content: string;
      timestamp: number;
      thinking?: string;
      toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
      toolResults?: Array<{ toolUseId: string; content: string; isError?: boolean }>;
      images?: Array<{ mediaType: string; data: string; toolUseId?: string }>;
      subtype?: string;
    }>;
  }): Promise<{ inserted: number; ids: string[] }> {
    if (params.messages.length === 0) {
      return { inserted: 0, ids: [] };
    }

    const roleMap: Record<string, "user" | "assistant" | "system" | "tool"> = {
      human: "user",
      assistant: "assistant",
      system: "system",
    };

    const preparedMessages: Array<any> = [];
    for (const msg of params.messages) {
      const redactedContent = truncate(redactSecrets(msg.content), MAX_CONTENT_SIZE);
      const redactedThinking = msg.thinking
        ? truncate(redactSecrets(msg.thinking), MAX_CONTENT_SIZE)
        : undefined;
      const toolCalls = msg.toolCalls?.map(tc => ({
        id: tc.id,
        name: tc.name,
        input: truncate(redactSecrets(JSON.stringify(tc.input)), MAX_TOOL_RESULT_SIZE),
      }));
      const toolResults = msg.toolResults?.map(tr => ({
        tool_use_id: tr.toolUseId,
        content: truncate(redactSecrets(tr.content), MAX_TOOL_RESULT_SIZE),
        is_error: tr.isError,
      }));

      const images: Array<{ media_type: string; storage_id?: string; data?: string; tool_use_id?: string }> = [];
      if (msg.images && msg.images.length > 0) {
        const imagesToProcess = msg.images.slice(0, MAX_IMAGES_PER_MESSAGE);
        for (const img of imagesToProcess) {
          const storageId = await this.uploadImage(img.data, img.mediaType);
          if (storageId) {
            images.push({ media_type: img.mediaType, storage_id: storageId, tool_use_id: img.toolUseId });
          }
        }
      }

      preparedMessages.push({
        message_uuid: msg.messageUuid,
        role: roleMap[msg.role],
        content: redactedContent,
        thinking: redactedThinking,
        tool_calls: toolCalls,
        tool_results: toolResults,
        images: images.length > 0 ? images : undefined,
        subtype: msg.subtype,
        timestamp: msg.timestamp,
      });
    }

    const BATCH_SIZE = 25;
    let totalInserted = 0;
    const allIds: string[] = [];

    for (let i = 0; i < preparedMessages.length; i += BATCH_SIZE) {
      const batch = preparedMessages.slice(i, i + BATCH_SIZE);
      await this.throttle();
      try {
        const result = await this.client.mutation(
          "messages:addMessages" as any,
          {
            conversation_id: params.conversationId,
            messages: batch,
            api_token: this.apiToken,
          }
        );
        const typed = result as { inserted: number; ids: string[] };
        totalInserted += typed.inserted;
        allIds.push(...typed.ids);
      } catch (error) {
        if (isAuthError(error)) {
          throw new AuthExpiredError();
        }
        throw error;
      }
    }

    return { inserted: totalInserted, ids: allIds };
  }

  async updateSyncCursor(params: {
    filePath: string;
    byteOffset: number;
  }): Promise<void> {
    if (!this.userId) {
      throw new Error("userId required for sync cursor operations");
    }
    const filePathHash = hashPath(params.filePath);
    try {
      await this.client.mutation("syncCursors:updateSyncCursor" as any, {
        user_id: this.userId,
        file_path_hash: filePathHash,
        last_position: params.byteOffset,
        api_token: this.apiToken,
      });
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError();
      }
      throw error;
    }
  }

  async getSyncCursor(filePath: string): Promise<number> {
    if (!this.userId) {
      throw new Error("userId required for sync cursor operations");
    }
    const filePathHash = hashPath(filePath);
    try {
      const position = await this.client.query(
        "syncCursors:getSyncCursor" as any,
        {
          user_id: this.userId,
          file_path_hash: filePathHash,
          api_token: this.apiToken,
        }
      );
      return position ?? 0;
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError();
      }
      throw error;
    }
  }

  async updateTitle(conversationId: string, title: string): Promise<void> {
    try {
      await this.client.mutation("conversations:updateTitle" as any, {
        conversation_id: conversationId,
        title,
        api_token: this.apiToken,
      });
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError();
      }
      throw error;
    }
  }

  async updateProjectPath(sessionId: string, projectPath: string, gitRoot?: string): Promise<{ updated: boolean } | null> {
    try {
      const result = await this.client.mutation("conversations:updateProjectPath" as any, {
        session_id: sessionId,
        project_path: projectPath,
        git_root: gitRoot,
        api_token: this.apiToken,
      });
      return result as { updated: boolean } | null;
    } catch {
      return null;
    }
  }

  async updateSessionId(conversationId: string, sessionId: string): Promise<void> {
    try {
      await this.client.mutation("conversations:updateSessionId" as any, {
        conversation_id: conversationId,
        session_id: sessionId,
        api_token: this.apiToken,
      });
    } catch {}
  }

  async registerManagedSession(sessionId: string, pid: number, tmuxSession?: string, conversationId?: string): Promise<void> {
    try {
      await this.client.mutation("managedSessions:registerManagedSession" as any, {
        session_id: sessionId,
        pid,
        tmux_session: tmuxSession,
        conversation_id: conversationId,
        api_token: this.apiToken,
      });
    } catch {}
  }

  async heartbeatManagedSession(sessionId: string): Promise<void> {
    try {
      await this.client.mutation("managedSessions:heartbeat" as any, {
        session_id: sessionId,
        api_token: this.apiToken,
      });
    } catch {}
  }

  async updateMessageStatus(params: {
    messageId: string;
    status: "pending" | "delivered" | "failed";
    deliveredAt?: number;
  }): Promise<void> {
    try {
      await this.client.mutation("pendingMessages:updateMessageStatus" as any, {
        message_id: params.messageId,
        status: params.status,
        delivered_at: params.deliveredAt,
        api_token: this.apiToken,
      });
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError();
      }
      throw error;
    }
  }

  async setSessionError(conversationId: string, error?: string): Promise<void> {
    if (!this.apiToken) return;
    try {
      await this.client.mutation(
        "conversations:setSessionError" as any,
        {
          conversation_id: conversationId,
          error,
          api_token: this.apiToken,
        }
      );
    } catch {}
  }

  async updateSessionAgentStatus(conversationId: string, status: "working" | "idle" | "permission_blocked" | "compacting" | "thinking" | "connected", clientTs?: number): Promise<void> {
    if (!this.apiToken) return;
    try {
      await this.client.mutation(
        "managedSessions:updateAgentStatus" as any,
        {
          conversation_id: conversationId,
          agent_status: status,
          client_ts: clientTs || Date.now(),
          api_token: this.apiToken,
        }
      );
    } catch {}
  }

  async checkManagedSession(conversationId: string): Promise<{ managed: boolean; session_id?: string; pid?: number } | null> {
    try {
      const result = await this.client.query("managedSessions:isSessionManaged" as any, {
        conversation_id: conversationId,
        api_token: this.apiToken,
      });
      return result;
    } catch {
      return null;
    }
  }

  async createPermissionRequest(params: {
    conversation_id: string;
    session_id: string;
    tool_name: string;
    arguments_preview: string;
  }): Promise<string> {
    try {
      const permissionId = await this.client.mutation(
        "permissions:createPermissionRequest" as any,
        {
          conversation_id: params.conversation_id,
          session_id: params.session_id,
          tool_name: params.tool_name,
          arguments_preview: params.arguments_preview,
          api_token: this.apiToken,
        }
      );
      return permissionId as string;
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError();
      }
      throw error;
    }
  }

  async getPermissionDecision(sessionId: string): Promise<{
    _id: string;
    status: "approved" | "denied";
    resolved_at?: number;
    tool_name: string;
  } | null> {
    try {
      const decision = await this.client.query(
        "permissions:getPermissionDecision" as any,
        {
          session_id: sessionId,
          api_token: this.apiToken,
        }
      );
      return decision as any;
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError();
      }
      throw error;
    }
  }

  async getMinCliVersion(): Promise<string | null> {
    try {
      const version = await this.client.query(
        "systemConfig:getMinCliVersion" as any,
        {}
      );
      return version as string | null;
    } catch {
      return null;
    }
  }

  async syncLogs(logs: Array<{
    level: "debug" | "info" | "warn" | "error";
    message: string;
    metadata?: {
      session_id?: string;
      error_code?: string;
      stack?: string;
    };
    daemon_version?: string;
    platform?: string;
    timestamp: number;
  }>): Promise<{ inserted: number } | null> {
    if (!this.apiToken || logs.length === 0) {
      return null;
    }
    try {
      const result = await this.client.mutation(
        "daemonLogs:insertBatch" as any,
        {
          api_token: this.apiToken,
          logs,
        }
      );
      return result as { inserted: number };
    } catch {
      return null;
    }
  }

  async createSessionNotification(params: {
    conversation_id: string;
    type: "session_idle" | "permission_request" | "session_error";
    title: string;
    message: string;
  }): Promise<void> {
    if (!this.apiToken) return;
    try {
      await this.client.mutation(
        "notifications:createSessionNotification" as any,
        {
          api_token: this.apiToken,
          conversation_id: params.conversation_id,
          type: params.type,
          title: params.title,
          message: params.message,
        }
      );
    } catch {
      // Best-effort notification
    }
  }

  async getMessageCountsForReconciliation(sessionIds: string[]): Promise<Array<{
    session_id: string;
    conversation_id: string;
    message_count: number;
    updated_at: number;
  }>> {
    if (!this.apiToken || sessionIds.length === 0) {
      return [];
    }
    try {
      const result = await this.client.query(
        "conversations:getMessageCountsForReconciliation" as any,
        {
          session_ids: sessionIds,
          api_token: this.apiToken,
        }
      );
      return result as Array<{
        session_id: string;
        conversation_id: string;
        message_count: number;
        updated_at: number;
      }>;
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError();
      }
      throw error;
    }
  }

  // --- Agent Tasks ---

  async getDueTasks(limit?: number): Promise<any[]> {
    if (!this.apiToken) return [];
    try {
      const result = await this.client.query(
        "agentTasks:getDueTasks" as any,
        { api_token: this.apiToken, limit }
      );
      return (result as any[]) || [];
    } catch {
      return [];
    }
  }

  async claimTask(taskId: string, daemonId: string): Promise<any> {
    if (!this.apiToken) return null;
    try {
      return await this.client.mutation(
        "agentTasks:claimTask" as any,
        { api_token: this.apiToken, task_id: taskId, daemon_id: daemonId }
      );
    } catch {
      return null;
    }
  }

  async renewTaskLease(taskId: string, daemonId: string): Promise<boolean> {
    if (!this.apiToken) return false;
    try {
      const result = await this.client.mutation(
        "agentTasks:renewLease" as any,
        { api_token: this.apiToken, task_id: taskId, daemon_id: daemonId }
      );
      return result as boolean;
    } catch {
      return false;
    }
  }

  async completeTaskRun(taskId: string, daemonId: string, summary?: string, conversationId?: string): Promise<boolean> {
    if (!this.apiToken) return false;
    try {
      const result = await this.client.mutation(
        "agentTasks:completeTaskRun" as any,
        {
          api_token: this.apiToken,
          task_id: taskId,
          daemon_id: daemonId,
          summary,
          conversation_id: conversationId,
        }
      );
      return result as boolean;
    } catch {
      return false;
    }
  }

  async failTaskRun(taskId: string, daemonId: string, error?: string): Promise<boolean> {
    if (!this.apiToken) return false;
    try {
      const result = await this.client.mutation(
        "agentTasks:failTaskRun" as any,
        { api_token: this.apiToken, task_id: taskId, daemon_id: daemonId, error }
      );
      return result as boolean;
    } catch {
      return false;
    }
  }
}
