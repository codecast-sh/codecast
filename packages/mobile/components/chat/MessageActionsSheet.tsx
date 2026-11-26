import { StyleSheet, TouchableOpacity, View as RNView, Modal, Pressable, Platform } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import * as Haptics from 'expo-haptics';
import { Theme, Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { ChatAvatar, type MobileChatMessage } from './MessageRow';
import { openSelectText } from '@/components/SelectTextSheet';
import { readableText } from '@/lib/markdown';

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
  const Theme = useTheme();
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
          <RNView style={styles.handle} />
          {/* Whose words the sheet is acting on — anchored above the actions so
              a mis-aimed long-press is caught before anything fires. */}
          <RNView style={styles.subject}>
            <ChatAvatar author={message.author} size={24} />
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
          {!!message.content && (
            <SheetRow icon="i-cursor" label="Select text" onPress={() => { onClose(); openSelectText(readableText(message.content)); }} />
          )}
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
  const Theme = useTheme();
  return (
    <TouchableOpacity style={styles.row} onPress={onPress}>
      <FontAwesome name={icon} size={17} color={danger ? Theme.red : Theme.textMuted} style={styles.rowIcon} />
      <RNText style={[styles.rowLabel, danger && styles.rowDanger]}>{label}</RNText>
    </TouchableOpacity>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: '#00000066',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: Theme.bgAlt,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingTop: 8,
    paddingBottom: 28,
    paddingHorizontal: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Theme.border,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 5,
    borderRadius: 3,
    backgroundColor: Theme.border,
    marginBottom: 12,
  },
  subject: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.border + '44',
    marginBottom: 8,
  },
  subjectName: { fontSize: 13.5, fontWeight: '600', color: Theme.textMuted },
  subjectPreview: { flex: 1, fontSize: 13, color: Theme.textMuted0 },
  emojiRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    marginBottom: 4,
  },
  emoji: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Theme.bgHighlight,
  },
  emojiMine: {
    backgroundColor: Theme.blue + '22',
    borderWidth: 1,
    borderColor: Theme.blue + '88',
  },
  emojiText: { fontSize: 24 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 50,
  },
  rowIcon: { width: 34 },
  rowLabel: { fontSize: 15.5, color: Theme.text },
  rowDanger: { color: Theme.red },
}));
