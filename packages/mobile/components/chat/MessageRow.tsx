import { memo } from 'react';
import { StyleSheet, TouchableOpacity, View as RNView, Image, useWindowDimensions } from 'react-native';
import { useQuery } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { Text as RNText } from '@/components/Themed';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Theme, Spacing } from '@/constants/Theme';
import { MarkdownContent } from '@/components/MarkdownRenderer';

// One chat message on mobile. The same rules as the web row, in RN idiom:
// a fixed avatar gutter that keeps its width when a message is grouped under
// the one above (so text never shifts sideways), agent identity in violet with
// a chip, the viewer's mention tinting the whole row, and the failure states
// (agent error, unsent message) rendered loudly enough that nobody scrolls
// past them unaware.

/** One uploaded image. The URL comes from the same storage query the session
 *  screen uses; a tile keeps a fixed footprint while it resolves so the
 *  transcript doesn't jump when the bytes land. */
function AttachmentImage({ storageId, onOpen }: { storageId: string; onOpen?: (url: string) => void }) {
  const { width } = useWindowDimensions();
  const url = useQuery(api.images.getImageUrl, { storageId: storageId as any });
  const side = Math.min(width - 96, 280);
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      disabled={!url || !onOpen}
      onPress={() => url && onOpen?.(url)}
      style={[styles.attachment, { width: side, height: side * 0.75 }]}
    >
      {url ? (
        <Image source={{ uri: url }} style={styles.attachmentImg} resizeMode="cover" />
      ) : null}
    </TouchableOpacity>
  );
}

export type ChatAuthorLite = {
  id: string;
  name: string;
  avatarUrl?: string;
  isAgent?: boolean;
};

export type MobileChatMessage = {
  id: string;
  author: ChatAuthorLite;
  content: string;
  createdAt: number;
  editedAt?: number;
  deletedAt?: number;
  mentionsMe?: boolean;
  agentStatus?: 'thinking' | 'streaming' | 'done' | 'error';
  agentDeadlineAt?: number;
  pending?: boolean;
  failed?: boolean;
  reactions?: { emoji: string; count: number; mine: boolean }[];
  /** Uploaded images, shown as tappable tiles under the text. */
  attachments?: { storage_id: string; name?: string }[];
  thread?: {
    replyCount: number;
    replyCapped: boolean;
    lastReplyAt: number;
    agentStatus?: 'thinking' | 'streaming' | 'error';
  };
};

const AVATAR_HUES = [Theme.blue, Theme.cyan, Theme.green, Theme.violet, Theme.magenta, Theme.orange];
function hueFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_HUES[h % AVATAR_HUES.length];
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2);
  return parts[0][0] + parts[parts.length - 1][0];
}

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function ChatAvatar({ author, size = 26 }: { author: ChatAuthorLite; size?: number }) {
  if (author.isAgent) {
    return (
      <RNView style={[styles.avatar, styles.avatarAgent, { width: size, height: size }]}>
        <FontAwesome name="microchip" size={size * 0.5} color={Theme.violet} />
      </RNView>
    );
  }
  if (author.avatarUrl) {
    return <Image source={{ uri: author.avatarUrl }} style={[styles.avatar, { width: size, height: size }]} />;
  }
  return (
    <RNView style={[styles.avatar, { width: size, height: size, backgroundColor: hueFor(author.name) }]}>
      <RNText style={[styles.avatarInitials, { fontSize: Math.max(8, size * 0.38) }]}>
        {initials(author.name).toUpperCase()}
      </RNText>
    </RNView>
  );
}

export const MessageRow = memo(function MessageRow({
  message,
  grouped,
  now,
  onOpenThread,
  onLongPress,
  onToggleReaction,
  onStopAgent,
  onRetrySend,
  onOpenImage,
  inThread,
  knownMentionHandles,
}: {
  message: MobileChatMessage;
  grouped?: boolean;
  now: number;
  onOpenThread?: (id: string) => void;
  onLongPress?: (message: MobileChatMessage) => void;
  onToggleReaction?: (id: string, emoji: string) => void;
  onStopAgent?: (id: string) => void;
  onRetrySend?: (id: string) => void;
  /** Tap on an attachment tile — the parent opens the full-screen viewer. */
  onOpenImage?: (url: string) => void;
  inThread?: boolean;
  /** Handles the server actually resolves (the shared vocabulary). With it, an
   *  unknown @word stays plain text instead of wearing a chip that notifies
   *  nobody — the same gate the web renderer applies. */
  knownMentionHandles?: Set<string>;
}) {
  const { author, agentStatus } = message;
  const thinking = agentStatus === 'thinking' || agentStatus === 'streaming';
  const errored = agentStatus === 'error';
  const elapsed = thinking ? Math.max(0, Math.round((now - message.createdAt) / 1000)) : 0;

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onLongPress={() => onLongPress?.(message)}
      delayLongPress={350}
      style={[
        styles.row,
        !grouped && styles.rowLead,
        message.mentionsMe && styles.rowMentionsMe,
        message.failed && styles.rowFailed,
        message.pending && !message.failed && styles.rowPending,
      ]}
    >
      <RNView style={styles.gutter}>
        {!grouped && <ChatAvatar author={author} />}
      </RNView>

      <RNView style={styles.body}>
        {!grouped && (
          <RNView style={styles.head}>
            <RNText style={styles.author} numberOfLines={1}>{author.name}</RNText>
            {author.isAgent && (
              <RNView style={styles.agentChip}>
                <RNText style={styles.agentChipText}>AGENT</RNText>
              </RNView>
            )}
            <RNText style={styles.time}>{clock(message.createdAt)}</RNText>
          </RNView>
        )}

        {message.deletedAt ? (
          <RNText style={styles.deleted}>This message was deleted</RNText>
        ) : thinking ? (
          <RNView style={styles.thinkingRow}>
            <RNText style={styles.thinking}>
              {author.name} is thinking{elapsed >= 5 ? ` · ${elapsed}s` : ''}
            </RNText>
            {onStopAgent && (
              <TouchableOpacity onPress={() => onStopAgent(message.id)} hitSlop={8}>
                <RNText style={styles.stop}>Stop</RNText>
              </TouchableOpacity>
            )}
          </RNView>
        ) : errored ? (
          <RNView style={styles.errorRow}>
            <FontAwesome name="exclamation-triangle" size={11} color={Theme.red} />
            <RNText style={styles.errorText}>
              {message.content || `${author.name} could not answer`}
            </RNText>
          </RNView>
        ) : (
          <RNView>
            <MarkdownContent
              text={message.content}
              baseStyle={styles.mdBase}
              knownMentionHandles={knownMentionHandles}
              // Long-press is the actions gesture in chat; the OS selection
              // callout would float over the sheet. Copy lives in the sheet.
              selectable={false}
            />
            {!!message.editedAt && <RNText style={styles.edited}>(edited)</RNText>}
          </RNView>
        )}

        {!!message.attachments?.length && (
          <RNView style={styles.attachments}>
            {message.attachments.map((att) => (
              <AttachmentImage key={att.storage_id} storageId={att.storage_id} onOpen={onOpenImage} />
            ))}
          </RNView>
        )}

        {message.failed && (
          <RNView style={styles.failedRow}>
            <RNText style={styles.failedText}>Not sent</RNText>
            {onRetrySend && (
              <TouchableOpacity onPress={() => onRetrySend(message.id)} hitSlop={8}>
                <RNText style={styles.retry}>Retry</RNText>
              </TouchableOpacity>
            )}
          </RNView>
        )}

        {!!message.reactions?.length && (
          <RNView style={styles.reactions}>
            {message.reactions.map((r) => (
              <TouchableOpacity
                key={r.emoji}
                style={[styles.reaction, r.mine && styles.reactionMine]}
                onPress={() => onToggleReaction?.(message.id, r.emoji)}
              >
                <RNText style={styles.reactionText}>{r.emoji} {r.count}</RNText>
              </TouchableOpacity>
            ))}
          </RNView>
        )}

        {!inThread && message.thread && (
          <TouchableOpacity style={styles.threadLink} onPress={() => onOpenThread?.(message.id)}>
            <FontAwesome name="comment-o" size={11} color={Theme.blue} />
            <RNText style={styles.threadText}>
              {message.thread.agentStatus === 'thinking' || message.thread.agentStatus === 'streaming'
                ? 'Anchor is thinking…'
                : `${message.thread.replyCount}${message.thread.replyCapped ? '+' : ''} ${message.thread.replyCount === 1 ? 'reply' : 'replies'}`}
            </RNText>
          </TouchableOpacity>
        )}
      </RNView>
    </TouchableOpacity>
  );
});

export function DayDivider({ label }: { label: string }) {
  return (
    <RNView style={styles.day}>
      <RNView style={styles.dayLine} />
      <RNText style={styles.dayLabel}>{label}</RNText>
      <RNView style={styles.dayLine} />
    </RNView>
  );
}

export function NewDivider() {
  return (
    <RNView style={styles.newRule}>
      <RNText style={styles.newLabel}>NEW</RNText>
      <RNView style={styles.newLine} />
    </RNView>
  );
}

const styles = StyleSheet.create({
  avatar: {
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: Theme.bgAlt,
  },
  avatarAgent: {
    backgroundColor: Theme.violet + '22',
    borderWidth: 1,
    borderColor: Theme.violet + '55',
  },
  avatarInitials: { fontWeight: '700', color: Theme.bg },
  mdBase: { fontSize: 13.5, lineHeight: 20, color: Theme.textSecondary },
  row: {
    flexDirection: 'row',
    paddingHorizontal: Spacing.md,
    paddingVertical: 1,
  },
  rowLead: { marginTop: 10 },
  rowMentionsMe: {
    backgroundColor: Theme.orange + '12',
    borderLeftWidth: 2,
    borderLeftColor: Theme.orange,
  },
  rowFailed: {
    backgroundColor: Theme.red + '12',
    borderLeftWidth: 2,
    borderLeftColor: Theme.red,
  },
  rowPending: { opacity: 0.55 },
  gutter: { width: 36, alignItems: 'flex-end', paddingRight: 8, paddingTop: 2 },
  body: { flex: 1, minWidth: 0 },
  head: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginBottom: 1 },
  author: { fontSize: 13, fontWeight: '600', color: Theme.text, flexShrink: 1 },
  agentChip: {
    borderWidth: 1,
    borderColor: Theme.violet + '70',
    borderRadius: 3,
    paddingHorizontal: 3,
  },
  agentChipText: { fontSize: 7.5, fontWeight: '700', color: Theme.violet, letterSpacing: 0.8 },
  time: { fontSize: 10, color: Theme.textMuted0 },
  deleted: { fontSize: 12.5, fontStyle: 'italic', color: Theme.textMuted0 },
  edited: { fontSize: 10, color: Theme.textMuted0, marginTop: -4, marginBottom: 2 },
  thinkingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  thinking: { fontSize: 12.5, color: Theme.textMuted },
  stop: { fontSize: 11.5, color: Theme.blue, textDecorationLine: 'underline' },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  errorText: { fontSize: 12.5, color: Theme.red, flexShrink: 1 },
  failedRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  failedText: { fontSize: 11, color: Theme.red },
  retry: { fontSize: 11, fontWeight: '600', color: Theme.blue, textDecorationLine: 'underline' },
  attachments: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 6,
  },
  attachment: {
    borderRadius: 10,
    overflow: 'hidden',
    // Scheme-agnostic translucent well behind a loading image.
    backgroundColor: '#00000014',
  },
  attachmentImg: {
    width: '100%',
    height: '100%',
  },
  reactions: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  reaction: {
    borderWidth: 1,
    borderColor: Theme.border + '60',
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 1,
    backgroundColor: Theme.bgAlt + '80',
  },
  reactionMine: {
    borderColor: Theme.blue + '99',
    backgroundColor: Theme.blue + '22',
  },
  reactionText: { fontSize: 11, color: Theme.textMuted },
  threadLink: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, paddingVertical: 2 },
  threadText: { fontSize: 11.5, fontWeight: '600', color: Theme.blue },
  day: { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 10, paddingHorizontal: Spacing.md },
  dayLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: Theme.border + '55' },
  dayLabel: { fontSize: 10, fontWeight: '600', color: Theme.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  newRule: { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 6, paddingHorizontal: Spacing.md },
  newLabel: { fontSize: 9, fontWeight: '700', color: Theme.orange, letterSpacing: 1 },
  newLine: { flex: 1, height: 1, backgroundColor: Theme.orange + '66' },
});
