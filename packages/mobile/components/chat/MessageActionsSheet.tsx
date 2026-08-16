import { StyleSheet, TouchableOpacity, View as RNView, Modal, Pressable, Platform } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import * as Haptics from 'expo-haptics';
import { Theme, Spacing } from '@/constants/Theme';
import { ChatAvatar, type MobileChatMessage } from './MessageRow';

// Long-press on a message. One sheet on BOTH platforms — ActionSheetIOS left
// Android with a dead long-press, and a native sheet cannot carry the emoji
// row anyway. The order is by reach: reactions first (the commonest gesture,
// one tap from the thumb), then reply, then the housekeeping verbs.

const QUICK_REACTIONS = ['👍', '🎉', '👀', '❤️', '😂', '🚀'];

export type MessageAction =
  | { kind: 'react'; emoji: string }
  | { kind: 'reply' }
  | { kind: 'copy' }
  | { kind: 'edit' }
  | { kind: 'delete' };

export function MessageActionsSheet({
  message,
  own,
  canReply,
  onAction,
  onClose,
}: {
  message: MobileChatMessage | null;
  /** The viewer wrote it: edit and delete appear. */
  own: boolean;
  /** Channel floor only — a thread reply can't grow a thread of its own. */
  canReply: boolean;
  onAction: (action: MessageAction) => void;
  onClose: () => void;
}) {
  if (!message) return null;
  const act = (action: MessageAction) => {
    if (Platform.OS === 'ios') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onClose();
    onAction(action);
  };
  const mine = new Set((message.reactions ?? []).filter((r) => r.mine).map((r) => r.emoji));
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          {/* Whose words the sheet is acting on — anchored above the actions so
              a mis-aimed long-press is caught before anything fires. */}
          <RNView style={styles.subject}>
            <ChatAvatar author={message.author} size={18} />
            <RNText style={styles.subjectName}>{message.author.name}</RNText>
            <RNText style={styles.subjectPreview} numberOfLines={1}>
              {message.content || 'attachment'}
            </RNText>
          </RNView>

          <RNView style={styles.emojiRow}>
            {QUICK_REACTIONS.map((emoji) => (
              <TouchableOpacity
                key={emoji}
                style={[styles.emoji, mine.has(emoji) && styles.emojiMine]}
                onPress={() => act({ kind: 'react', emoji })}
              >
                <RNText style={styles.emojiText}>{emoji}</RNText>
              </TouchableOpacity>
            ))}
          </RNView>

          {canReply && (
            <SheetRow icon="comment-o" label="Reply in thread" onPress={() => act({ kind: 'reply' })} />
          )}
          <SheetRow icon="copy" label="Copy text" onPress={() => act({ kind: 'copy' })} />
          {own && (
            <SheetRow icon="pencil" label="Edit message" onPress={() => act({ kind: 'edit' })} />
          )}
          {own && (
            <SheetRow icon="trash-o" label="Delete message" danger onPress={() => act({ kind: 'delete' })} />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function SheetRow({ icon, label, danger, onPress }: {
  icon: React.ComponentProps<typeof FontAwesome>['name'];
  label: string;
  danger?: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.row} onPress={onPress}>
      <FontAwesome name={icon} size={14} color={danger ? Theme.red : Theme.textMuted} style={styles.rowIcon} />
      <RNText style={[styles.rowLabel, danger && styles.rowDanger]}>{label}</RNText>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: '#00000066',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: Theme.bg,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 10,
    paddingBottom: 28,
    paddingHorizontal: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Theme.border,
  },
  subject: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.border + '44',
    marginBottom: 8,
  },
  subjectName: { fontSize: 12, fontWeight: '600', color: Theme.textMuted },
  subjectPreview: { flex: 1, fontSize: 11.5, color: Theme.textMuted0 },
  emojiRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    marginBottom: 4,
  },
  emoji: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Theme.bgAlt + '88',
  },
  emojiMine: {
    backgroundColor: Theme.blue + '22',
    borderWidth: 1,
    borderColor: Theme.blue + '88',
  },
  emojiText: { fontSize: 22 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
  },
  rowIcon: { width: 26 },
  rowLabel: { fontSize: 14.5, color: Theme.text },
  rowDanger: { color: Theme.red },
});
