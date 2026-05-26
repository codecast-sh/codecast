import { ConvexHttpClient, ConvexClient } from "convex/browser";
import { redactSecrets } from "./redact.js";
import { hashPath } from "./hash.js";

const MAX_CONTENT_SIZE = 100_000;
const MAX_TOOL_RESULT_SIZE = 50_000;
// Max serialized bytes of one addMessages batch (~0.9MB, well under the 5MB
// that triggered isolate OOM/timeouts in the 2026-05-13 stuck-sync incident).
const MAX_BATCH_BYTES = 900_000;
const MAX_IMAGE_SIZE = 5_000_000;
const MAX_INLINE_IMAGE_SIZE = 500_000;
const MAX_IMAGES_PER_MESSAGE = 10;

const MIN_REQUEST_INTERVAL_MS = 100;

const ADD_MESSAGES_BATCH_TIMEOUT_MS = 60_000;
const ADD_MESSAGES_BATCH_SIZE = 10;
// uploadImage runs *before* the timed addMessages batch, so an un-timed upload
// hang (slow network / contended backend) wedges the whole chunk: the file-watcher
// can't advance its position past the image message and every later turn stops
// syncing. Time-box each network leg so a stuck upload degrades to null (the caller
// then inlines small images or drops oversized ones) instead of freezing the session.
const UPLOAD_IMAGE_TIMEOUT_MS = 30_000;

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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

/**
 * Split prepared messages into mutation-sized batches, bounded by BOTH message
 * count and serialized byte size. The byte bound is what stops a handful of
 * image-heavy messages (large inline base64) from forming a multi-MB mutation
 * that can't commit within the timeout/isolate budget. A single message that
 * alone exceeds the byte cap is emitted in its own batch — one message can't be
 * split, and one ~MAX_INLINE_IMAGE_SIZE message commits fine on its own.
 */
export function chunkMessagesBySize<T>(
  messages: T[],
  maxCount: number = ADD_MESSAGES_BATCH_SIZE,
  maxBytes: number = MAX_BATCH_BYTES,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const msg of messages) {
    const bytes = Buffer.byteLength(JSON.stringify(msg));
    if (current.length > 0 && (current.length >= maxCount || currentBytes + bytes > maxBytes)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(msg);
    currentBytes += bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
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
  repoRoot?: string;
  worktreeName?: string;
  worktreeBranch?: string;
  worktreePath?: string;
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
  subagentDescription?: string;
}

export class SyncService {
  private client: ConvexHttpClient;
  private subscriptionClient: ConvexClient;
  private userId?: string;
  private apiToken?: string;
  private lastRequestTime = 0;
  private throttleQueue: Promise<void> = Promise.resolve();
  // Per-network-leg deadline for image uploads. A field (not the bare constant)
  // only so tests can shorten it; production always uses UPLOAD_IMAGE_TIMEOUT_MS.
  private imageUploadTimeoutMs = UPLOAD_IMAGE_TIMEOUT_MS;

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

  // Offload large inline images to Convex storage *before* the messages enter
  // the send path or the retry queue, mutating each message's images in place:
  // a successful upload replaces `data` with `storageId`; an upload that fails
  // for an image too big to inline is dropped. This is what keeps the retry
  // queue small (it used to persist 682KB of raw base64 per stuck op → a 16MB
  // queue file) and stops every retry from re-uploading the same image. Idempotent:
  // images that already carry a storageId are left untouched.
  async offloadImages(
    messages: Array<{ images?: Array<{ mediaType: string; data?: string; storageId?: string; toolUseId?: string }> }>,
  ): Promise<void> {
    for (const msg of messages) {
      if (!msg.images || msg.images.length === 0) continue;
      const kept: Array<{ mediaType: string; data?: string; storageId?: string; toolUseId?: string }> = [];
      for (const img of msg.images.slice(0, MAX_IMAGES_PER_MESSAGE)) {
        if (img.storageId || !img.data) {
          kept.push(img);
          continue;
        }
        const storageId = await this.uploadImage(img.data, img.mediaType);
        if (storageId) {
          kept.push({ mediaType: img.mediaType, storageId, toolUseId: img.toolUseId });
          continue;
        }
        const dataBytes = Buffer.from(img.data, "base64").length;
        if (dataBytes <= MAX_INLINE_IMAGE_SIZE) {
          kept.push(img);
        } else {
          console.warn(`[SyncService] Image dropped at offload: upload failed and too large for inline (${dataBytes} bytes)`);
        }
      }
      msg.images = kept.length > 0 ? kept : undefined;
    }
  }

  async uploadImage(base64Data: string, mediaType: string): Promise<string | null> {
    if (!base64Data) {
      console.warn("[SyncService] uploadImage called with no data");
      return null;
    }
    try {
      const uploadUrl = await withTimeout(
        this.client.mutation(
          "images:generateUploadUrl" as any,
          { api_token: this.apiToken }
        ),
        this.imageUploadTimeoutMs,
        "images:generateUploadUrl",
      );
      const binaryData = Buffer.from(base64Data, "base64");
      if (binaryData.length > MAX_IMAGE_SIZE) {
        console.warn(`[SyncService] Image too large: ${binaryData.length} bytes > ${MAX_IMAGE_SIZE}`);
        return null;
      }
      const response = await withTimeout(
        fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": mediaType },
          body: binaryData,
        }),
        this.imageUploadTimeoutMs,
        "image upload fetch",
      );
      if (!response.ok) {
        console.warn(`[SyncService] Image upload failed: HTTP ${response.status}`);
        return null;
      }
      const result = await response.json();
      return result.storageId;
    } catch (err) {
      console.warn(`[SyncService] Image upload error: ${err instanceof Error ? err.message : String(err)}`);
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
          git_root: gitInfo?.repoRoot || gitInfo?.root,
          cli_flags: params.cliFlags,
          worktree_name: gitInfo?.worktreeName,
          worktree_branch: gitInfo?.worktreeBranch,
          worktree_path: gitInfo?.worktreePath,
          worktree_status: gitInfo?.worktreeName ? "active" : undefined,
          subagent_description: params.subagentDescription,
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

  async linkSessions(parentConversationId: string, childConversationId: string, subagentDescription?: string): Promise<void> {
    await this.throttle();
    try {
      await this.client.mutation(
        "conversations:linkSessions" as any,
        {
          parent_conversation_id: parentConversationId,
          child_conversation_id: childConversationId,
          subagent_description: subagentDescription,
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

  async linkPlanHandoff(parentConversationId: string, childConversationId: string): Promise<void> {
    await this.throttle();
    try {
      await this.client.mutation(
        "conversations:linkPlanHandoff" as any,
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

  async syncPlanFromPlanMode(params: {
    sessionId: string;
    planContent: string;
    projectPath?: string;
  }): Promise<string | null> {
    await this.throttle();
    try {
      const result = await this.client.mutation(
        "docs:create" as any,
        {
          api_token: this.apiToken,
          title: "",
          content: params.planContent,
          source: "plan_mode",
          conversation_id: params.sessionId,
          project_path: params.projectPath,
        }
      );
      return result?.plan_short_id || null;
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError();
      }
      throw error;
    }
  }

  async syncTaskFromPlanMode(params: {
    sessionId: string;
    title: string;
    description?: string;
    planShortId?: string;
  }): Promise<string | null> {
    await this.throttle();
    try {
      const result = await this.client.mutation(
        "tasks:create" as any,
        {
          api_token: this.apiToken,
          title: params.title,
          description: params.description,
          task_type: "task",
          status: "open",
          priority: "medium",
          source: "plan_mode",
          conversation_id: params.sessionId,
          plan_id: params.planShortId,
        }
      );
      return result?.short_id || null;
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError();
      }
      throw error;
    }
  }

  async updateTaskStatus(shortId: string, status: string, sessionId?: string): Promise<void> {
    await this.throttle();
    try {
      await this.client.mutation(
        "tasks:update" as any,
        {
          api_token: this.apiToken,
          short_id: shortId,
          status,
          conversation_id: sessionId,
        }
      );
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError();
      }
      throw error;
    }
  }

  async getPlanSnippet(planShortId: string): Promise<string | null> {
    await this.throttle();
    try {
      const result = await this.client.query(
        "plans:snippet" as any,
        {
          api_token: this.apiToken,
          plan_short_id: planShortId,
        }
      );
      return result?.snippet || null;
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError();
      }
      return null;
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
        } else {
          const dataBytes = Buffer.from(img.data, "base64").length;
          if (dataBytes <= MAX_INLINE_IMAGE_SIZE) {
            images.push({ media_type: img.mediaType, data: img.data, tool_use_id: img.toolUseId });
          }
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
      images?: Array<{ mediaType: string; data?: string; storageId?: string; toolUseId?: string }>;
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
          // Already offloaded (e.g. by offloadImages before enqueue) — pass through.
          if (img.storageId) {
            images.push({ media_type: img.mediaType, storage_id: img.storageId, tool_use_id: img.toolUseId });
            continue;
          }
          if (!img.data) continue;
          const storageId = await this.uploadImage(img.data, img.mediaType);
          if (storageId) {
            images.push({ media_type: img.mediaType, storage_id: storageId, tool_use_id: img.toolUseId });
          } else {
            const dataBytes = Buffer.from(img.data, "base64").length;
            if (dataBytes <= MAX_INLINE_IMAGE_SIZE) {
              images.push({ media_type: img.mediaType, data: img.data, tool_use_id: img.toolUseId });
            } else {
              console.warn(`[SyncService] Image dropped: upload failed and too large for inline (${dataBytes} bytes)`);
            }
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

    // Batch by bytes, not just count. A single message can carry a large
    // inline image (up to MAX_INLINE_IMAGE_SIZE when Convex storage upload
    // fails), so a count-only cap of BATCH_SIZE lets an image-heavy batch grow
    // to several MB — past what one mutation can commit within
    // ADD_MESSAGES_BATCH_TIMEOUT_MS / the isolate budget. That batch then fails
    // every retry identically, and because sync advances the file position only
    // after a batch lands, the whole tail behind it stays stuck forever. An
    // oversized single message still goes out alone (one message can't split).
    const batches = chunkMessagesBySize(preparedMessages);
    let totalInserted = 0;
    const allIds: string[] = [];

    for (const batch of batches) {
      await this.throttle();
      try {
        const result = await withTimeout(
          this.client.mutation(
            "messages:addMessages" as any,
            {
              conversation_id: params.conversationId,
              messages: batch,
              api_token: this.apiToken,
            }
          ),
          ADD_MESSAGES_BATCH_TIMEOUT_MS,
          `addMessages batch (${batch.length} msgs)`
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

  async setAvailableSkills(conversationId: string | undefined, skills: string, projectPath?: string): Promise<void> {
    try {
      await this.client.mutation("conversations:setAvailableSkills" as any, {
        ...(conversationId ? { conversation_id: conversationId } : {}),
        ...(projectPath ? { project_path: projectPath } : {}),
        skills,
        api_token: this.apiToken,
      });
    } catch {}
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

  async updateSessionId(conversationId: string, sessionId: string, projectPath?: string, gitRoot?: string): Promise<void> {
    try {
      await this.client.mutation("conversations:updateSessionId" as any, {
        conversation_id: conversationId,
        session_id: sessionId,
        project_path: projectPath,
        git_root: gitRoot,
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

  async heartbeatManagedSession(
    sessionId: string,
    agentStatus?: "working" | "idle" | "permission_blocked" | "compacting" | "thinking" | "connected" | "stopped" | "starting" | "resuming",
  ): Promise<{ found: boolean; dismissed?: boolean } | undefined> {
    try {
      return await this.client.mutation("managedSessions:heartbeat" as any, {
        session_id: sessionId,
        api_token: this.apiToken,
        ...(agentStatus ? { agent_status: agentStatus, client_ts: Date.now() } : {}),
      });
    } catch {}
  }

  async reportSessionMetrics(sessionId: string, cpu: number, memory: number, pidCount: number, agentPid?: number, awakeIdleMs?: number): Promise<void> {
    try {
      await this.client.mutation("managedSessions:reportMetrics" as any, {
        session_id: sessionId,
        cpu,
        memory,
        pid_count: pidCount,
        ...(agentPid !== undefined ? { agent_pid: agentPid } : {}),
        ...(awakeIdleMs !== undefined ? { awake_idle_ms: awakeIdleMs } : {}),
        api_token: this.apiToken,
      });
    } catch {}
  }

  async findLocalCheckouts(gitRemoteUrl: string): Promise<string[]> {
    if (!gitRemoteUrl) return [];
    try {
      const result = await this.client.query("conversations:findUserLocalCheckouts" as any, {
        git_remote_url: gitRemoteUrl,
        api_token: this.apiToken,
      });
      if (!Array.isArray(result)) return [];
      return result.map((r: any) => r?.git_root).filter((g: any): g is string => typeof g === "string" && g.length > 0);
    } catch (error) {
      if (isAuthError(error)) throw new AuthExpiredError();
      return [];
    }
  }

  async getProjectInfo(conversationId: string): Promise<{ project_path: string | null; git_root: string | null; git_remote_url: string | null } | null> {
    try {
      const result = await this.client.query("conversations:getProjectInfo" as any, {
        conversation_id: conversationId,
        api_token: this.apiToken,
      });
      if (!result) return null;
      return {
        project_path: result.project_path ?? null,
        git_root: result.git_root ?? null,
        git_remote_url: result.git_remote_url ?? null,
      };
    } catch (error) {
      if (isAuthError(error)) throw new AuthExpiredError();
      return null;
    }
  }

  async ackInjectedMessages(conversationId: string): Promise<void> {
    try {
      await this.client.mutation("pendingMessages:ackInjectedMessages" as any, {
        conversation_id: conversationId,
        api_token: this.apiToken,
      });
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError();
      }
      // Non-critical — don't let ack failures break the sync loop
    }
  }

  async resetInjectedMessages(conversationId: string): Promise<void> {
    try {
      await this.client.mutation("pendingMessages:resetInjectedMessages" as any, {
        conversation_id: conversationId,
        api_token: this.apiToken,
      });
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError();
      }
    }
  }

  async updateMessageStatus(params: {
    messageId: string;
    status: "pending" | "injected" | "delivered" | "failed";
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

  async retryMessage(messageId: string): Promise<void> {
    try {
      await this.client.mutation("pendingMessages:retryMessage" as any, {
        message_id: messageId,
        api_token: this.apiToken,
      });
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError();
      }
      throw error;
    }
  }

  async sendMessageToSession(conversationId: string, content: string): Promise<string | null> {
    if (!this.apiToken) return null;
    try {
      const result = await this.client.mutation(
        "pendingMessages:sendMessageToSession" as any,
        {
          conversation_id: conversationId,
          content,
          api_token: this.apiToken,
        },
      );
      return result as string;
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

  async markSessionCompleted(conversationId: string): Promise<void> {
    if (!this.apiToken) return;
    try {
      await this.client.mutation(
        "conversations:markSessionCompleted" as any,
        {
          conversation_id: conversationId,
          api_token: this.apiToken,
        }
      );
    } catch {}
  }

  async markSessionActive(conversationId: string): Promise<void> {
    if (!this.apiToken) return;
    try {
      await this.client.mutation(
        "conversations:markSessionActive" as any,
        {
          conversation_id: conversationId,
          api_token: this.apiToken,
        }
      );
    } catch {}
  }

  async updateSessionAgentStatus(conversationId: string, status: "working" | "idle" | "permission_blocked" | "compacting" | "thinking" | "connected" | "stopped" | "starting" | "resuming", clientTs?: number, permissionMode?: string): Promise<void> {
    if (!this.apiToken) return;
    try {
      await this.client.mutation(
        "managedSessions:updateAgentStatus" as any,
        {
          conversation_id: conversationId,
          agent_status: status,
          client_ts: clientTs || Date.now(),
          api_token: this.apiToken,
          ...(permissionMode ? { permission_mode: permissionMode } : {}),
        }
      );
    } catch {}
  }

  async listManagedSessions(): Promise<Array<{
    session_id: string;
    conversation_id?: string;
    tmux_session?: string;
    agent_pid?: number;
    last_metrics_at?: number;
  }> | null> {
    try {
      return await this.client.query("managedSessions:listManagedSessionsForDaemon" as any, {
        api_token: this.apiToken,
      });
    } catch {
      return null;
    }
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

  async cancelPermissionRequest(permissionId: string): Promise<boolean> {
    try {
      const ok = await this.client.mutation(
        "permissions:cancelPermissionRequest" as any,
        {
          permission_id: permissionId,
          api_token: this.apiToken,
        }
      );
      return Boolean(ok);
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError();
      }
      throw error;
    }
  }

  async cancelPendingPermissions(sessionId: string, createdBefore?: number): Promise<number> {
    try {
      const cancelled = await this.client.mutation(
        "permissions:cancelPendingPermissions" as any,
        {
          session_id: sessionId,
          ...(createdBefore !== undefined && { created_before: createdBefore }),
          api_token: this.apiToken,
        }
      );
      return Number(cancelled) || 0;
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError();
      }
      throw error;
    }
  }

  async getPermissionDecision(sessionId: string, permissionId?: string): Promise<{
    _id: string;
    status: "approved" | "denied" | "cancelled";
    resolved_at?: number;
    tool_name: string;
  } | null> {
    try {
      const decision = await this.client.query(
        "permissions:getPermissionDecision" as any,
        {
          session_id: sessionId,
          ...(permissionId ? { permission_id: permissionId } : {}),
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

  async getMessageCountsForReconciliation(
    sessionIds: string[],
    conversationIdHints: Array<{ session_id: string; conversation_id: string }> = []
  ): Promise<Array<{
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
          conversation_id_hints: conversationIdHints.length > 0 ? conversationIdHints : undefined,
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
