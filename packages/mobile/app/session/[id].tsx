import { StyleSheet, FlatList, ActivityIndicator, ScrollView, TouchableOpacity, TextInput, KeyboardAvoidingView, Platform } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Text, View } from '@/components/Themed';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { Id } from '@codecast/convex/convex/_generated/dataModel';
import { useState } from 'react';
import SyntaxHighlighter from 'react-native-syntax-highlighter';
import { atomOneDark } from 'react-syntax-highlighter/styles/hljs';
import * as Haptics from 'expo-haptics';
import { PermissionCard } from '@/components/PermissionCard';

type ToolCall = {
  id: string;
  name: string;
  input: string;
};

type ToolResult = {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

type Message = {
  _id: string;
  role: string;
  content?: string;
  timestamp: number;
  thinking?: string;
  tool_calls?: ToolCall[];
  tool_results?: ToolResult[];
};

type ConversationData = {
  _id: string;
  title: string;
  status: string;
  messages: Message[];
};

function extractCodeBlocks(text: string): Array<{ type: 'text' | 'code'; content: string; language?: string }> {
  const blocks: Array<{ type: 'text' | 'code'; content: string; language?: string }> = [];
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;

  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const textContent = text.slice(lastIndex, match.index);
      if (textContent.trim()) {
        blocks.push({ type: 'text', content: textContent });
      }
    }

    blocks.push({
      type: 'code',
      content: match[2],
      language: match[1] || 'plaintext',
    });

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    const textContent = text.slice(lastIndex);
    if (textContent.trim()) {
      blocks.push({ type: 'text', content: textContent });
    }
  }

  return blocks.length > 0 ? blocks : [{ type: 'text', content: text }];
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

type MessageBubbleProps = {
  message: Message;
};

function ToolCallItem({ toolCall, expanded, onToggle }: {
  toolCall: ToolCall;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <View style={styles.toolCallContainer}>
      <TouchableOpacity onPress={onToggle} style={styles.toolCallHeader}>
        <Text style={styles.toolCallName}>{toolCall.name}</Text>
        <Text style={styles.toolCallToggle}>{expanded ? '▼' : '▶'}</Text>
      </TouchableOpacity>

      {expanded && (
        <View style={styles.toolCallContent}>
          <Text style={styles.toolCallInput}>{toolCall.input}</Text>
        </View>
      )}
    </View>
  );
}

function MessageBubble({ message }: MessageBubbleProps) {
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());

  const isUser = message.role === 'user';
  const content = message.content || message.thinking || '';

  const toggleTool = (toolId: string) => {
    setExpandedTools(prev => {
      const next = new Set(prev);
      if (next.has(toolId)) {
        next.delete(toolId);
      } else {
        next.add(toolId);
      }
      return next;
    });
  };

  const hasToolResults = message.tool_results && message.tool_results.length > 0;
  if (hasToolResults) {
    return null;
  }

  return (
    <View style={[styles.messageContainer, isUser ? styles.userMessage : styles.assistantMessage]}>
      <View style={styles.messageHeader}>
        <Text style={styles.messageRole}>{isUser ? 'You' : 'Assistant'}</Text>
        <Text style={styles.messageTime}>{formatTimestamp(message.timestamp)}</Text>
      </View>

      {content && (
        <View style={styles.messageContent}>
          {extractCodeBlocks(content).map((block, idx) => {
            if (block.type === 'code') {
              return (
                <View key={idx} style={styles.codeBlock}>
                  <View style={styles.codeHeader}>
                    <Text style={styles.codeLanguage}>{block.language}</Text>
                  </View>
                  <ScrollView horizontal showsHorizontalScrollIndicator={true}>
                    <SyntaxHighlighter
                      language={block.language}
                      style={atomOneDark}
                      customStyle={styles.codeContent}
                      fontSize={12}
                    >
                      {block.content}
                    </SyntaxHighlighter>
                  </ScrollView>
                </View>
              );
            }
            return (
              <Text key={idx} style={styles.messageText}>
                {block.content}
              </Text>
            );
          })}
        </View>
      )}

      {message.tool_calls && message.tool_calls.length > 0 && (
        <View style={styles.toolCallsContainer}>
          {message.tool_calls.map((toolCall) => (
            <ToolCallItem
              key={toolCall.id}
              toolCall={toolCall}
              expanded={expandedTools.has(toolCall.id)}
              onToggle={() => toggleTool(toolCall.id)}
            />
          ))}
        </View>
      )}
    </View>
  );
}

type PendingMessage = {
  _id: string;
  conversation_id: string;
  content: string;
  status: 'pending' | 'delivered' | 'failed';
  created_at: number;
  retry_count: number;
};

type MessageInputProps = {
  conversationId: Id<"conversations">;
  isActive: boolean;
};

function MessageInput({ conversationId, isActive }: MessageInputProps) {
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendMessage = useMutation(api.pendingMessages.sendMessageToSession);
  const retryMessage = useMutation(api.pendingMessages.retryMessage);

  const pendingMessages = useQuery(
    api.pendingMessages.getPendingMessages,
    isActive ? {} : "skip"
  ) as PendingMessage[] | undefined;

  const conversationPendingMessages = pendingMessages?.filter(
    (msg) => msg.conversation_id === conversationId
  ) || [];

  if (!isActive) {
    return null;
  }

  const handleRetry = async (messageId: Id<"pending_messages">) => {
    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await retryMessage({ message_id: messageId });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  const handleSend = async () => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage || isSending) return;

    setIsSending(true);
    setError(null);

    try {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await sendMessage({
        conversation_id: conversationId,
        content: trimmedMessage,
      });
      setMessage('');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setIsSending(false);
    }
  };

  return (
    <View style={styles.messageInputContainer}>
      {conversationPendingMessages.length > 0 && (
        <View style={styles.pendingMessagesContainer}>
          {conversationPendingMessages.map((msg) => (
            <View key={msg._id} style={styles.pendingMessageItem}>
              <View style={styles.pendingMessageContent}>
                <Text style={styles.pendingMessageText} numberOfLines={1}>
                  {msg.content}
                </Text>
                <View style={styles.pendingMessageStatus}>
                  {msg.status === 'pending' && (
                    <Text style={styles.statusPending}>⏱ Pending</Text>
                  )}
                  {msg.status === 'delivered' && (
                    <Text style={styles.statusDelivered}>✓ Delivered</Text>
                  )}
                  {msg.status === 'failed' && (
                    <>
                      <Text style={styles.statusFailed}>✕ Failed</Text>
                      <TouchableOpacity
                        style={styles.retryButton}
                        onPress={() => handleRetry(msg._id as Id<"pending_messages">)}
                      >
                        <Text style={styles.retryButtonText}>Retry</Text>
                      </TouchableOpacity>
                    </>
                  )}
                </View>
              </View>
            </View>
          ))}
        </View>
      )}
      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>{error}</Text>
          <TouchableOpacity onPress={() => setError(null)}>
            <Text style={styles.errorBannerDismiss}>✕</Text>
          </TouchableOpacity>
        </View>
      )}
      <View style={styles.inputRow}>
        <TextInput
          style={styles.textInput}
          value={message}
          onChangeText={setMessage}
          placeholder="Type a message..."
          placeholderTextColor="#666"
          multiline
          maxLength={10000}
          editable={!isSending}
          onSubmitEditing={handleSend}
          blurOnSubmit={false}
        />
        <TouchableOpacity
          style={[
            styles.sendButton,
            (!message.trim() || isSending) && styles.sendButtonDisabled
          ]}
          onPress={handleSend}
          disabled={!message.trim() || isSending}
        >
          <Text style={styles.sendButtonText}>
            {isSending ? '...' : '→'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function SessionDetailScreen() {
  const { id } = useLocalSearchParams();

  const conversation = useQuery(
    api.conversations.getAllMessages,
    id ? { conversation_id: id as Id<"conversations"> } : "skip"
  ) as ConversationData | null | undefined;

  const pendingPermissions = useQuery(
    api.permissions.getPendingPermissions,
    id ? { conversation_id: id as Id<"conversations"> } : "skip"
  );

  if (conversation === undefined) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#fff" />
        <Text style={styles.loadingText}>Loading conversation...</Text>
      </View>
    );
  }

  if (!conversation) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorText}>Conversation not found</Text>
      </View>
    );
  }

  const renderMessage = ({ item }: { item: Message }) => (
    <MessageBubble message={item} />
  );

  const isActive = conversation.status === 'active';

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {conversation.title}
        </Text>
        <View style={styles.headerRight}>
          <Text style={styles.messageCount}>
            {conversation.messages.length} messages
          </Text>
          {isActive && (
            <View style={styles.activeIndicator}>
              <View style={styles.activeDot} />
              <Text style={styles.activeText}>Active</Text>
            </View>
          )}
        </View>
      </View>

      <FlatList
        data={conversation.messages}
        renderItem={renderMessage}
        keyExtractor={(item) => item._id}
        contentContainerStyle={styles.messageList}
        ListHeaderComponent={
          pendingPermissions && pendingPermissions.length > 0 ? (
            <View style={styles.permissionsContainer}>
              {pendingPermissions.map((permission) => (
                <PermissionCard key={permission._id} permission={permission} />
              ))}
            </View>
          ) : null
        }
      />

      <MessageInput conversationId={id as Id<"conversations">} isActive={isActive} />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 16,
    fontSize: 16,
    color: '#888',
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  errorText: {
    fontSize: 16,
    color: '#ff6b6b',
    textAlign: 'center',
  },
  header: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#333',
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 4,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  messageCount: {
    fontSize: 13,
    color: '#888',
  },
  activeIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  activeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#4ade80',
  },
  activeText: {
    fontSize: 12,
    color: '#4ade80',
    fontWeight: '600',
  },
  messageList: {
    padding: 16,
  },
  permissionsContainer: {
    marginBottom: 16,
  },
  messageContainer: {
    marginBottom: 16,
    padding: 12,
    borderRadius: 8,
  },
  userMessage: {
    backgroundColor: '#1a4d2e',
    alignSelf: 'flex-end',
    maxWidth: '85%',
  },
  assistantMessage: {
    backgroundColor: '#1a1a2e',
    alignSelf: 'flex-start',
    maxWidth: '95%',
  },
  messageHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  messageRole: {
    fontSize: 12,
    fontWeight: '600',
    color: '#888',
    textTransform: 'uppercase',
  },
  messageTime: {
    fontSize: 11,
    color: '#666',
  },
  messageContent: {
    marginTop: 4,
  },
  messageText: {
    fontSize: 15,
    lineHeight: 22,
    color: '#e0e0e0',
  },
  codeBlock: {
    marginVertical: 8,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: '#282c34',
  },
  codeHeader: {
    backgroundColor: '#21252b',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#181a1f',
  },
  codeLanguage: {
    fontSize: 11,
    color: '#abb2bf',
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  codeContent: {
    margin: 0,
    padding: 12,
    backgroundColor: '#282c34',
  },
  toolCallsContainer: {
    marginTop: 8,
  },
  toolCallContainer: {
    marginBottom: 8,
    backgroundColor: '#0d1117',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#30363d',
  },
  toolCallHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 10,
  },
  toolCallName: {
    fontSize: 13,
    fontWeight: '600',
    color: '#58a6ff',
  },
  toolCallToggle: {
    fontSize: 12,
    color: '#888',
  },
  toolCallContent: {
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: '#30363d',
  },
  toolCallInput: {
    fontSize: 12,
    color: '#8b949e',
    fontFamily: 'monospace',
  },
  messageInputContainer: {
    borderTopWidth: 1,
    borderTopColor: '#333',
    backgroundColor: '#0d1117',
  },
  pendingMessagesContainer: {
    padding: 12,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#333',
  },
  pendingMessageItem: {
    backgroundColor: '#1a1a2e',
    borderRadius: 8,
    padding: 10,
  },
  pendingMessageContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
  },
  pendingMessageText: {
    flex: 1,
    color: '#e0e0e0',
    fontSize: 14,
  },
  pendingMessageStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusPending: {
    fontSize: 12,
    color: '#fbbf24',
  },
  statusDelivered: {
    fontSize: 12,
    color: '#4ade80',
  },
  statusFailed: {
    fontSize: 12,
    color: '#ff6b6b',
  },
  retryButton: {
    backgroundColor: '#1e40af',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  retryButtonText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
  errorBanner: {
    backgroundColor: '#ff6b6b',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
  },
  errorBannerText: {
    color: '#fff',
    fontSize: 13,
    flex: 1,
  },
  errorBannerDismiss: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
    paddingLeft: 12,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 12,
    gap: 8,
  },
  textInput: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: '#e0e0e0',
    fontSize: 15,
    maxHeight: 100,
    minHeight: 40,
  },
  sendButton: {
    backgroundColor: '#4ade80',
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendButtonDisabled: {
    backgroundColor: '#333',
    opacity: 0.5,
  },
  sendButtonText: {
    fontSize: 20,
    color: '#0d1117',
    fontWeight: 'bold',
  },
});
