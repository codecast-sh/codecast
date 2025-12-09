/**
 * Message Reducer for Codecast
 *
 * Transforms raw Convex messages into structured, deduplicated messages with
 * proper tool call lifecycle tracking.
 *
 * Key responsibilities:
 * 1. Deduplication using message_uuid
 * 2. Tool call lifecycle tracking (pending → running → completed/error)
 * 3. Matching tool results to tool calls
 * 4. Extracting latest TodoWrite todos
 * 5. Extracting usage data from assistant messages
 */

export type ToolState = 'pending' | 'running' | 'completed' | 'error';

export type ToolCall = {
  id: string;
  name: string;
  state: ToolState;
  input: any;
  result?: any;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
};

export type ProcessedMessage = {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content?: string;
  tool?: ToolCall;
  thinking?: string;
  timestamp: number;
};

export type UsageData = {
  inputTokens: number;
  outputTokens: number;
  cacheCreation: number;
  cacheRead: number;
  contextSize: number;
  timestamp: number;
};

export type ReducerState = {
  messageUuids: Set<string>;
  toolIdToMessageId: Map<string, string>;
  messages: Map<string, ProcessedMessage>;
  latestTodos?: { todos: any[]; timestamp: number };
  latestUsage?: UsageData;
  orphanToolResults: Map<string, Array<{ content: any; isError: boolean; timestamp: number }>>
};

type RawMessage = {
  _id: string;
  message_uuid?: string;
  role: string;
  content?: string;
  timestamp: number;
  thinking?: string;
  tool_calls?: Array<{
    id: string;
    name: string;
    input: string;
  }>;
  tool_results?: Array<{
    tool_use_id: string;
    content: string;
    is_error?: boolean;
  }>;
  tokens_used?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

export function createReducer(): ReducerState {
  return {
    messageUuids: new Set(),
    toolIdToMessageId: new Map(),
    messages: new Map(),
    orphanToolResults: new Map(),
  };
}

function allocateId() {
  return Math.random().toString(36).substring(2, 15);
}

export function reducer(state: ReducerState, rawMessages: RawMessage[]): ProcessedMessage[] {
  const newMessages: ProcessedMessage[] = [];
  const changed: Set<string> = new Set();

  //
  // Phase 1: Process text messages and create tool call placeholders
  //
  for (const msg of rawMessages) {
    // Skip if already processed by UUID
    if (msg.message_uuid && state.messageUuids.has(msg.message_uuid)) {
      continue;
    }

    // User messages
    if (msg.role === 'user' && msg.content && !msg.tool_results) {
      const mid = allocateId();
      const processedMsg: ProcessedMessage = {
        id: mid,
        role: 'user',
        content: msg.content,
        timestamp: msg.timestamp,
      };

      state.messages.set(mid, processedMsg);
      if (msg.message_uuid) {
        state.messageUuids.add(msg.message_uuid);
      }
      changed.add(mid);
    }

    // Assistant text messages
    if (msg.role === 'assistant') {
      // Mark as seen
      if (msg.message_uuid) {
        state.messageUuids.add(msg.message_uuid);
      }

      // Extract usage data if present
      if (msg.usage) {
        const cacheCreation = msg.usage.cache_creation_input_tokens || 0;
        const cacheRead = msg.usage.cache_read_input_tokens || 0;
        const contextSize = cacheCreation + cacheRead + msg.usage.input_tokens;

        // Only update if this is newer than current usage
        if (!state.latestUsage || msg.timestamp > state.latestUsage.timestamp) {
          state.latestUsage = {
            inputTokens: msg.usage.input_tokens,
            outputTokens: msg.usage.output_tokens,
            cacheCreation,
            cacheRead,
            contextSize,
            timestamp: msg.timestamp,
          };
        }
      }

      // Create text message if there's content
      if (msg.content) {
        const mid = allocateId();
        const processedMsg: ProcessedMessage = {
          id: mid,
          role: 'assistant',
          content: msg.content,
          thinking: msg.thinking,
          timestamp: msg.timestamp,
        };

        state.messages.set(mid, processedMsg);
        changed.add(mid);
      }

      // Create tool call messages
      if (msg.tool_calls) {
        for (const toolCall of msg.tool_calls) {
          // Check if we already have this tool
          const existingMessageId = state.toolIdToMessageId.get(toolCall.id);
          if (existingMessageId) {
            continue;
          }

          // Parse tool input
          let parsedInput: any;
          try {
            parsedInput = JSON.parse(toolCall.input);
          } catch {
            parsedInput = toolCall.input;
          }

          // Track TodoWrite todos
          if (toolCall.name === 'TodoWrite' && parsedInput?.todos) {
            if (!state.latestTodos || msg.timestamp > state.latestTodos.timestamp) {
              state.latestTodos = {
                todos: parsedInput.todos,
                timestamp: msg.timestamp,
              };
            }
          }

          const mid = allocateId();
          const tool: ToolCall = {
            id: toolCall.id,
            name: toolCall.name,
            state: 'running',
            input: parsedInput,
            createdAt: msg.timestamp,
            startedAt: msg.timestamp,
            completedAt: null,
          };

          const processedMsg: ProcessedMessage = {
            id: mid,
            role: 'assistant',
            tool,
            timestamp: msg.timestamp,
          };

          state.messages.set(mid, processedMsg);
          state.toolIdToMessageId.set(toolCall.id, mid);
          changed.add(mid);

          const orphans = state.orphanToolResults.get(toolCall.id);
          if (orphans && orphans.length > 0) {
            const orphan = orphans[0];
            tool.state = orphan.isError ? 'error' : 'completed';
            tool.result = orphan.content;
            tool.completedAt = orphan.timestamp;
            state.orphanToolResults.delete(toolCall.id);
          }
        }
      }
    }
  }

  //
  // Phase 2: Process tool results
  //
  for (const msg of rawMessages) {
    if (msg.role === 'user' && msg.tool_results) {
      for (const result of msg.tool_results) {
        const messageId = state.toolIdToMessageId.get(result.tool_use_id);
        if (!messageId) {
          let parsedResult: any;
          try {
            parsedResult = JSON.parse(result.content);
          } catch {
            parsedResult = result.content;
          }

          const orphans = state.orphanToolResults.get(result.tool_use_id) || [];
          orphans.push({
            content: parsedResult,
            isError: result.is_error ?? false,
            timestamp: msg.timestamp,
          });
          state.orphanToolResults.set(result.tool_use_id, orphans);
          continue;
        }

        const message = state.messages.get(messageId);
        if (!message?.tool) {
          continue;
        }

        // Only update if still running
        if (message.tool.state !== 'running') {
          continue;
        }

        // Parse result
        let parsedResult: any;
        try {
          parsedResult = JSON.parse(result.content);
        } catch {
          parsedResult = result.content;
        }

        message.tool.state = result.is_error ? 'error' : 'completed';
        message.tool.result = parsedResult;
        message.tool.completedAt = msg.timestamp;

        changed.add(messageId);
      }
    }
  }

  //
  // Collect changed messages
  //
  for (const id of changed) {
    const message = state.messages.get(id);
    if (message) {
      newMessages.push(message);
    }
  }

  return newMessages;
}
