import { StyleSheet, FlatList, ActivityIndicator, ScrollView, TouchableOpacity, TextInput, KeyboardAvoidingView, Platform, View as RNView, Text as RNText } from 'react-native';
import { useLocalSearchParams, Stack } from 'expo-router';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { Id } from '@codecast/convex/convex/_generated/dataModel';
import { useState } from 'react';
import * as Haptics from 'expo-haptics';
import { PermissionCard } from '@/components/PermissionCard';
import { Theme, Spacing } from '@/constants/Theme';

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
    hour: 'numeric',
    minute: '2-digit',
  });
}

function ToolCallItem({ toolCall, expanded, onToggle }: {
  toolCall: ToolCall;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <RNView style={styles.toolCallContainer}>
      <TouchableOpacity onPress={onToggle} style={styles.toolCallHeader} activeOpacity={0.7}>
        <RNText style={styles.toolCallName}>{toolCall.name}</RNText>
        <RNText style={styles.toolCallToggle}>{expanded ? '▼' : '▶'}</RNText>
      </TouchableOpacity>

      {expanded && (
        <RNView style={styles.toolCallContent}>
          <RNText style={styles.toolCallInput}>{toolCall.input}</RNText>
        </RNView>
      )}
    </RNView>
  );
}

function MessageBubble({ message }: { message: Message }) {
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
    <RNView style={[styles.messageBubble, isUser ? styles.userBubble : styles.assistantBubble]}>
      <RNView style={styles.bubbleHeader}>
        <RNText style={[styles.bubbleRole, isUser ? styles.userRole : styles.assistantRole]}>
          {isUser ? 'You' : 'Assistant'}
        </RNText>
        <RNText style={styles.bubbleTime}>{formatTimestamp(message.timestamp)}</RNText>
      </RNView>

      {content && (
        <RNView style={styles.bubbleContent}>
          {extractCodeBlocks(content).map((block, idx) => {
            if (block.type === 'code') {
              return (
                <RNView key={idx} style={styles.codeBlock}>
                  <RNView style={styles.codeHeader}>
                    <RNText style={styles.codeLanguage}>{block.language}</RNText>
                  </RNView>
                  <ScrollView horizontal showsHorizontalScrollIndicator={true}>
                    <RNView style={styles.codeContent}>
                      <RNText style={styles.codeText}>{block.content}</RNText>
                    </RNView>
                  </ScrollView>
                </RNView>
              );
            }
            return (
              <RNText key={idx} style={[styles.bubbleText, isUser ? styles.userText : styles.assistantText]}>
                {block.content}
              </RNText>
            );
          })}
        </RNView>
      )}

      {message.tool_calls && message.tool_calls.length > 0 && (
        <RNView style={styles.toolCallsContainer}>
          {message.tool_calls.map((toolCall) => (
            <ToolCallItem
              key={toolCall.id}
              toolCall={toolCall}
              expanded={expandedTools.has(toolCall.id)}
              onToggle={() => toggleTool(toolCall.id)}
            />
          ))}
        </RNView>
      )}
    </RNView>
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

function MessageInput({ conversationId, isActive }: { conversationId: Id<"conversations">; isActive: boolean }) {
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
    <RNView style={styles.inputContainer}>
      {error && (
        <RNView style={styles.errorBanner}>
          <RNText style={styles.errorBannerText}>{error}</RNText>
          <TouchableOpacity onPress={() => setError(null)}>
            <RNText style={styles.errorBannerDismiss}>×</RNText>
          </TouchableOpacity>
        </RNView>
      )}
      <RNView style={styles.inputRow}>
        <TextInput
          style={styles.textInput}
          value={message}
          onChangeText={setMessage}
          placeholder="Type a message..."
          placeholderTextColor={Theme.textMuted0}
          multiline
          maxLength={10000}
          editable={!isSending}
          blurOnSubmit={false}
        />
        <TouchableOpacity
          style={[styles.sendButton, (!message.trim() || isSending) && styles.sendButtonDisabled]}
          onPress={handleSend}
          disabled={!message.trim() || isSending}
          activeOpacity={0.7}
        >
          <RNText style={styles.sendButtonText}>{isSending ? '...' : '→'}</RNText>
        </TouchableOpacity>
      </RNView>
    </RNView>
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
      <RNView style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={Theme.textMuted} />
        <RNText style={styles.loadingText}>Loading...</RNText>
      </RNView>
    );
  }

  if (!conversation) {
    return (
      <RNView style={styles.errorContainer}>
        <RNText style={styles.errorText}>Conversation not found</RNText>
      </RNView>
    );
  }

  const isActive = conversation.status === 'active';

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Conversation',
          headerBackTitle: 'Sessions',
          headerStyle: { backgroundColor: Theme.bgAlt },
          headerTintColor: Theme.text,
          headerTitleStyle: { color: Theme.text, fontWeight: '600', fontSize: 17 },
        }}
      />
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <RNView style={styles.sessionHeader}>
          <RNText style={styles.sessionTitle} numberOfLines={2}>
            {conversation.title}
          </RNText>
          <RNView style={styles.sessionMeta}>
            <RNText style={styles.messageCount}>
              {conversation.messages.length} messages
            </RNText>
            {isActive && (
              <RNView style={styles.activeIndicator}>
                <RNView style={styles.activeDot} />
                <RNText style={styles.activeText}>Active</RNText>
              </RNView>
            )}
          </RNView>
        </RNView>

        <FlatList
          data={conversation.messages}
          renderItem={({ item }) => <MessageBubble message={item} />}
          keyExtractor={(item) => item._id}
          contentContainerStyle={styles.messageList}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={
            pendingPermissions && pendingPermissions.length > 0 ? (
              <RNView style={styles.permissionsContainer}>
                {pendingPermissions.map((permission) => (
                  <PermissionCard key={permission._id} permission={permission} />
                ))}
              </RNView>
            ) : null
          }
        />

        <MessageInput conversationId={id as Id<"conversations">} isActive={isActive} />
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Theme.bg,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Theme.bg,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 15,
    color: Theme.textMuted,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Theme.bg,
    padding: 20,
  },
  errorText: {
    fontSize: 15,
    color: Theme.red,
    textAlign: 'center',
  },
  sessionHeader: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: Theme.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.bgHighlight,
  },
  sessionTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: Theme.text,
    marginBottom: 6,
    lineHeight: 22,
  },
  sessionMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  messageCount: {
    fontSize: 13,
    color: Theme.textMuted,
  },
  activeIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  activeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Theme.greenBright,
  },
  activeText: {
    fontSize: 13,
    color: Theme.greenBright,
    fontWeight: '500',
  },
  messageList: {
    padding: 16,
    paddingBottom: 8,
  },
  permissionsContainer: {
    marginBottom: 16,
  },
  messageBubble: {
    marginBottom: 12,
    borderRadius: 12,
    overflow: 'hidden',
  },
  userBubble: {
    backgroundColor: Theme.userBubble,
    alignSelf: 'flex-end',
    maxWidth: '85%',
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    backgroundColor: Theme.assistantBubble,
    alignSelf: 'flex-start',
    maxWidth: '92%',
    borderBottomLeftRadius: 4,
  },
  bubbleHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 4,
  },
  bubbleRole: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  userRole: {
    color: 'rgba(255,255,255,0.7)',
  },
  assistantRole: {
    color: 'rgba(253,246,227,0.6)',
  },
  bubbleTime: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.5)',
  },
  bubbleContent: {
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  bubbleText: {
    fontSize: 15,
    lineHeight: 21,
  },
  userText: {
    color: Theme.userBubbleText,
  },
  assistantText: {
    color: Theme.assistantBubbleText,
  },
  codeBlock: {
    marginVertical: 8,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#073642',
  },
  codeHeader: {
    backgroundColor: '#002b36',
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  codeLanguage: {
    fontSize: 10,
    color: Theme.textMuted0,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  codeContent: {
    padding: 10,
  },
  codeText: {
    fontFamily: 'SpaceMono',
    fontSize: 12,
    lineHeight: 17,
    color: '#93a1a1',
  },
  toolCallsContainer: {
    paddingHorizontal: 12,
    paddingBottom: 10,
    gap: 6,
  },
  toolCallContainer: {
    backgroundColor: 'rgba(0,0,0,0.2)',
    borderRadius: 8,
    overflow: 'hidden',
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
    color: Theme.cyan,
  },
  toolCallToggle: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.5)',
  },
  toolCallContent: {
    padding: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.1)',
  },
  toolCallInput: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.6)',
    fontFamily: 'SpaceMono',
  },
  inputContainer: {
    backgroundColor: Theme.bgAlt,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Theme.borderLight,
  },
  errorBanner: {
    backgroundColor: Theme.red,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  errorBannerText: {
    color: '#fff',
    fontSize: 13,
    flex: 1,
  },
  errorBannerDismiss: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
    paddingLeft: 12,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
  },
  textInput: {
    flex: 1,
    backgroundColor: Theme.bg,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    color: Theme.text,
    fontSize: 15,
    maxHeight: 100,
    minHeight: 40,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
  },
  sendButton: {
    backgroundColor: Theme.blue,
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendButtonDisabled: {
    backgroundColor: Theme.bgHighlight,
  },
  sendButtonText: {
    fontSize: 18,
    color: '#fff',
    fontWeight: '600',
  },
});
