// The notes that ride the next send, just above the session composer: the
// phone twin of the web ReviewBar's quote rows. Collapsed it is one line, the
// count in the gallery header's words, with Clear. Expanded it lists each note
// in send order: a pin on a picture shows the picture with the pin's number
// and opens that picture at the note's editor; a text quote shows its words.
// Each row can be taken out. Proposal answers stay on their own card
// (lib/notesTray). Grayscale-safe: numbers ride a ring in contrast, and
// every state is a word or a shape, never a hue.
import { useEffect, useMemo, useState } from 'react';
import { Image, ScrollView, StyleSheet, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import * as Haptics from 'expo-haptics';
import { Text } from '@/components/Themed';
import { CHROME_FONT_CAP, themedStyles, useTheme } from '@/constants/Theme';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { openImageNote } from '@/lib/imagePins';
import { clearWords, trayHeadline, traySig, type TrayRow } from '@/lib/notesTray';

const DISARM_MS = 4000;

export function NotesTray({ conversationId }: { conversationId: string }) {
  const Theme = useTheme();
  const { height: winHeight } = useWindowDimensions();
  // A signature of the rows drawn, so a write elsewhere in the store (or to a
  // proposal answer in the same batch) re-renders nothing.
  const sig = useInboxStore((s) => traySig(s.reviewComments[conversationId]));
  const rows = useMemo<TrayRow[]>(() => (sig ? JSON.parse(sig) : []), [sig]);
  const [expanded, setExpanded] = useState(false);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), DISARM_MS);
    return () => clearTimeout(t);
  }, [armed]);
  // A change to the rows changes what Clear would take: ask again.
  useEffect(() => setArmed(false), [sig]);

  const head = trayHeadline(rows);
  if (!head) return null;

  const remove = (id: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    useInboxStore.getState().removeReviewComment(conversationId, id);
  };
  const clear = () => {
    if (!armed) return setArmed(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const store = useInboxStore.getState();
    for (const r of rows) store.removeReviewComment(conversationId, r.id);
    setArmed(false);
    setExpanded(false);
  };

  return (
    <View style={styles.tray} testID="notes-tray">
      <View style={styles.head}>
        <TouchableOpacity
          style={styles.toggle}
          activeOpacity={0.6}
          onPress={() => setExpanded((e) => !e)}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={`${head}. ${expanded ? 'Hide' : 'Show'} them`}
          testID="notes-tray-toggle"
        >
          <Feather name={expanded ? 'chevron-down' : 'chevron-up'} size={16} color={Theme.text} />
          <Text style={styles.headText} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>{head}</Text>
        </TouchableOpacity>
        {/* Armed, it inverts: a fill, not a hue, says the next press discards. */}
        <TouchableOpacity
          style={[styles.clear, armed && { backgroundColor: Theme.text }]}
          activeOpacity={0.6}
          onPress={clear}
          hitSlop={{ top: 4, bottom: 4 }}
          accessibilityRole="button"
          accessibilityLabel={armed ? `Discard ${rows.length} notes` : 'Clear notes'}
          testID="notes-tray-clear"
        >
          <Text style={[styles.clearText, armed && { color: Theme.bg }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{clearWords(rows.length, armed)}</Text>
        </TouchableOpacity>
      </View>
      {expanded && (
        // 'always', as every strip over the composer: a tap here keeps the keyboard.
        <ScrollView style={{ maxHeight: Math.round(winHeight * 0.3) }} keyboardShouldPersistTaps="always" nestedScrollEnabled>
          {rows.map((r) => <Row key={r.id} row={r} conversationId={conversationId} onRemove={remove} />)}
        </ScrollView>
      )}
    </View>
  );
}

function Row({ row, conversationId, onRemove }: { row: TrayRow; conversationId: string; onRemove: (id: string) => void }) {
  const Theme = useTheme();
  const label = row.number ? `Note ${row.number}` : row.src ? 'Picture' : 'Quote';
  const body = (
    <>
      {row.src ? (
        <View style={styles.thumbWrap}>
          <Image source={{ uri: row.src }} style={styles.thumb} resizeMode="cover" />
          {row.number ? (
            <View style={styles.badge}><Text style={styles.badgeText} maxFontSizeMultiplier={1}>{row.number}</Text></View>
          ) : null}
        </View>
      ) : (
        <Feather name="message-square" size={16} color={Theme.textMuted} style={styles.quoteMark} />
      )}
      <View style={styles.words}>
        {row.quote ? <Text style={styles.quote} numberOfLines={1}>{row.quote}</Text> : null}
        {row.note
          ? <Text style={styles.note} numberOfLines={2}>{row.note}</Text>
          : row.src ? <Text style={styles.noNote}>No note</Text> : null}
      </View>
    </>
  );
  return (
    <View style={styles.row}>
      {/* A pin opens its picture at the note's editor; a text quote has nowhere to open. */}
      {row.src ? (
        <TouchableOpacity
          style={styles.main}
          activeOpacity={0.6}
          onPress={() => openImageNote(conversationId, row.id)}
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${row.note || 'no note'}. Open the picture`}
        >
          {body}
        </TouchableOpacity>
      ) : (
        <View style={styles.main} accessibilityLabel={`${label}: ${row.quote}${row.note ? `. ${row.note}` : ''}`}>{body}</View>
      )}
      <TouchableOpacity
        style={styles.remove}
        activeOpacity={0.6}
        onPress={() => onRemove(row.id)}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${label.toLowerCase()} from your message`}
      >
        <Feather name="x" size={16} color={Theme.textMuted} />
      </TouchableOpacity>
    </View>
  );
}

const THUMB = 40;
const BADGE = 20;

const styles = themedStyles((Theme) => StyleSheet.create({
  // The owners strip's shell (OwnerComposerLines), so the rows over the
  // composer read as one family.
  tray: {
    marginBottom: 6,
    marginHorizontal: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
    backgroundColor: Theme.bgAlt,
    overflow: 'hidden',
  },
  head: { flexDirection: 'row', alignItems: 'center' },
  toggle: { flex: 1, minWidth: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 10 },
  headText: { flexShrink: 1, fontSize: 13, fontWeight: '600', color: Theme.text },
  clear: { minHeight: 36, minWidth: 64, marginVertical: 4, marginRight: 4, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: Theme.border, alignItems: 'center', justifyContent: 'center' },
  clearText: { fontSize: 13, fontWeight: '600', color: Theme.text },
  row: { flexDirection: 'row', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.borderLight },
  main: { flex: 1, minWidth: 0, minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 10, paddingVertical: 6 },
  thumbWrap: { width: THUMB + 6, height: THUMB + 6, justifyContent: 'center' },
  thumb: { width: THUMB, height: THUMB, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.border, backgroundColor: Theme.bg },
  // GalleryNotes' PinBadge, smaller: white disc, dark ring, dark number.
  badge: {
    position: 'absolute', right: 0, bottom: 0, width: BADGE, height: BADGE, borderRadius: BADGE / 2,
    alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff', borderWidth: 2, borderColor: '#000',
  },
  badgeText: { color: '#000', fontSize: 11, fontWeight: '700', lineHeight: 13 },
  quoteMark: { width: 20, textAlign: 'center' },
  words: { flex: 1, minWidth: 0 },
  quote: { fontSize: 13, color: Theme.textMuted, fontStyle: 'italic' },
  note: { fontSize: 14, color: Theme.text },
  noNote: { fontSize: 13, color: Theme.textMuted0, fontStyle: 'italic' },
  remove: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
}));
