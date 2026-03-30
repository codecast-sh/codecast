import fs from "fs";
import path from "path";
import crypto from "crypto";

interface Config {
  auth_token: string;
  convex_url: string;
  user_id: string;
  team_id?: string;
}

let _config: Config | null = null;

export function getConfig(): Config {
  if (_config) return _config;
  const configPath = path.join(process.env.HOME || "", ".codecast", "config.json");
  _config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  return _config!;
}

async function retryFetch(url: string, init: RequestInit, maxRetries = 3): Promise<any> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, init);
    if (res.status === 429 || res.status >= 500) {
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
    }
    const text = await res.text();
    if (!text) {
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      throw new Error(`Empty response from ${url} (status ${res.status})`);
    }
    return JSON.parse(text);
  }
}

export async function convexMutation<T = any>(
  fnPath: string,
  args: Record<string, any>
): Promise<T> {
  const config = getConfig();
  const json = await retryFetch(`${config.convex_url}/api/mutation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: fnPath, args, format: "json" }),
  });
  if (json?.status === "success") return json.value as T;
  throw new Error(`Mutation ${fnPath} failed: ${JSON.stringify(json)}`);
}

export async function convexQuery<T = any>(
  fnPath: string,
  args: Record<string, any>
): Promise<T> {
  const config = getConfig();
  const json = await retryFetch(`${config.convex_url}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: fnPath, args, format: "json" }),
  });
  if (json?.status === "success") return json.value as T;
  throw new Error(`Query ${fnPath} failed: ${JSON.stringify(json)}`);
}

export async function httpAction<T = any>(
  actionPath: string,
  body: Record<string, any>
): Promise<T> {
  const config = getConfig();
  return retryFetch(`${config.convex_url}${actionPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_token: config.auth_token, ...body }),
  }) as Promise<T>;
}

export function uuid(): string {
  return crypto.randomUUID();
}

export interface Message {
  role: "user" | "assistant";
  content: string;
  message_uuid: string;
  timestamp: number;
}

export function generateMessages(count: number, baseTimestamp = 1700000000000): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i + 1}: ${i % 2 === 0 ? "User prompt" : "Assistant response"} [${uuid().slice(0, 8)}]`,
      message_uuid: `msg-${String(i + 1).padStart(4, "0")}-${uuid().slice(0, 8)}`,
      timestamp: baseTimestamp + i * 1000,
    });
  }
  return messages;
}

export async function createTestConversation(opts: {
  messageCount: number;
  title?: string;
  agentType?: string;
  projectPath?: string;
}): Promise<{ conversationId: string; messages: Message[]; sessionId: string }> {
  const config = getConfig();
  const sessionId = `fork-test-${uuid()}`;
  const projectPath = opts.projectPath || `/tmp/fork-test-${Date.now()}`;

  const conversationId = await convexMutation<string>(
    "conversations:createConversation",
    {
      user_id: config.user_id,
      api_token: config.auth_token,
      agent_type: opts.agentType || "claude_code",
      session_id: sessionId,
      title: opts.title || `Fork Test ${Date.now()}`,
      project_path: projectPath,
    }
  );

  const messages = generateMessages(opts.messageCount);
  const BATCH_SIZE = 25;
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    await convexMutation("messages:addMessages", {
      conversation_id: conversationId,
      api_token: config.auth_token,
      messages: batch,
    });
  }

  return { conversationId, messages, sessionId };
}

export interface ForkResult {
  conversation_id: string;
  short_id: string;
}

export async function forkConversation(
  conversationId: string,
  messageUuid?: string,
  targetAgentType?: string
): Promise<ForkResult> {
  const config = getConfig();
  const args: Record<string, any> = {
    conversation_id: conversationId,
    api_token: config.auth_token,
  };
  if (messageUuid) args.message_uuid = messageUuid;
  if (targetAgentType) args.target_agent_type = targetAgentType;

  return convexMutation<ForkResult>("conversations:forkFromMessage", args);
}

export async function forkViaHttp(
  conversationId: string,
  messageUuid?: string
): Promise<ForkResult> {
  const body: Record<string, any> = { conversation_id: conversationId };
  if (messageUuid) body.message_uuid = messageUuid;
  return httpAction<ForkResult>("/cli/fork", body);
}

export interface TreeNode {
  id: string;
  short_id?: string;
  title: string;
  message_count: number;
  parent_message_uuid?: string;
  started_at: number;
  status: string;
  agent_type?: string;
  is_current: boolean;
  children: TreeNode[];
}

export async function getTree(conversationId: string): Promise<{ tree: TreeNode }> {
  return httpAction<{ tree: TreeNode }>("/cli/tree", {
    conversation_id: conversationId,
  });
}

export async function getTreeViaQuery(conversationId: string): Promise<{ tree: TreeNode } | { error: string }> {
  const config = getConfig();
  return convexQuery("conversations:getConversationTree", {
    conversation_id: conversationId,
    api_token: config.auth_token,
  });
}

export async function getBranchMessages(
  conversationId: string
): Promise<{ messages: any[]; fork_point_uuid: string | null } | { error: string }> {
  const config = getConfig();
  return convexQuery("conversations:getForkBranchMessages", {
    conversation_id: conversationId,
    api_token: config.auth_token,
  });
}

export async function exportMessages(
  conversationId: string
): Promise<{ messages: any[]; conversation: any }> {
  const all: any[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await httpAction<any>("/cli/export", {
      conversation_id: conversationId,
      cursor,
      limit: 200,
    });
    if (result.error) throw new Error(result.error);
    if (result.messages) all.push(...result.messages);
    if (!result.has_more) return { messages: all, conversation: result.conversation };
    cursor = result.cursor;
  }
  return { messages: all, conversation: null };
}

export async function deleteConversation(conversationId: string): Promise<void> {
  const config = getConfig();
  try {
    await convexMutation("conversations:deleteConversation", {
      conversation_id: conversationId,
      api_token: config.auth_token,
    });
  } catch {
    // Ignore deletion errors in cleanup
  }
}

export function countTreeNodes(node: TreeNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countTreeNodes(child), 0);
}

export function maxTreeDepth(node: TreeNode): number {
  if (node.children.length === 0) return 0;
  return 1 + Math.max(...node.children.map(maxTreeDepth));
}

export function findNode(node: TreeNode, id: string): TreeNode | null {
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

export async function findLongSession(minMessages = 100): Promise<string | null> {
  try {
    const result = await httpAction<any>("/cli/feed", {
      limit: 50,
      project_path: "/Users/ashot/src/codecast",
    });
    if (result.conversations) {
      const long = result.conversations.find(
        (c: any) => c.message_count >= minMessages && !c.forked_from
      );
      return long?._id || long?.id || null;
    }
  } catch {}
  return null;
}
