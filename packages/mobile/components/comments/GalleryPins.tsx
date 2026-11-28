// Comments pinned to a spot of a picture, in the full-screen gallery. In pin
// mode a tap on the picture drops a numbered pin and opens its editor; pins
// already made draw where they were dropped, each with its words beside it,
// and a tap on one opens it. A pin is an item of the conversation's quote
// batch (lib/reviewActions addImagePin): the send attaches the picture and
// says where on it each pin sits.
import { useEffect, useMemo, useState } from 'react';
import { Image, Pressable, StyleSheet, View as RNView, type GestureResponderEvent } from 'react-native';
import * as Haptics from 'expo-haptics';
import Feather from '@expo/vector-icons/Feather';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { addImagePin } from '@codecast/web/lib/reviewActions';
import { pinNumbers } from '@codecast/web/lib/quoteFormat';
import { Text as RNText } from '@/components/Themed';
import { openCommentEditor } from './CommentEditor';

/** A gallery picture: its stored file or address, and the message it came in. */
export type GalleryPicture = { storageId?: string; src?: string; messageId?: string; timestamp?: number };
type Size = { width: number; height: number };

/** The picture's place on the page: drawn `contain`-fitted and centered. */
function fitRect(natural: Size | null, page: Size) {
  if (!natural?.width || !natural.height) return null;
  const r = Math.min(page.width / natural.width, page.height / natural.height);
  const width = natural.width * r;
  const height = natural.height * r;
  return { left: (page.width - width) / 2, top: (page.height - height) / 2, width, height };
}

/** The message a stored picture arrived in, for the words that name it to the agent. */
function messageWith(conversationId: string, storageId?: string): string | undefined {
  if (!storageId) return undefined;
  const messages = useInboxStore.getState().messages[conversationId] ?? [];
  return messages.find((m: any) => (m.images ?? []).some((i: any) => i.storage_id === storageId))?._id;
}

export function GalleryPins({ conversationId, picture, uri, page, pinMode, accent, onPinned }: {
  conversationId: string;
  picture: GalleryPicture;
  uri: string | undefined;
  page: Size;
  pinMode: boolean;
  accent: string;
  onPinned: () => void;
}) {
  const [natural, setNatural] = useState<Size | null>(null);
  useEffect(() => {
    setNatural(null);
    if (!uri) return;
    let live = true;
    Image.getSize(uri, (width, height) => { if (live) setNatural({ width, height }); }, () => {});
    return () => { live = false; };
  }, [uri]);
  const fit = useMemo(() => fitRect(natural, page), [natural, page]);

  const key = picture.storageId ?? picture.src ?? uri;
  // The pins on this picture, and each one's number as the send names it.
  const sig = useInboxStore((s) => {
    const all = s.reviewComments[conversationId] ?? [];
    const numbers = pinNumbers(all);
    const mine = all.filter((c) => c.image?.point && (c.image.storageId ?? c.image.src) === key);
    return mine.length ? JSON.stringify(mine.map((c) => [c.id, numbers.get(c.id) ?? 0, c.image!.point!.x, c.image!.point!.y, c.body])) : '';
  });
  const pins = useMemo(() => (sig ? (JSON.parse(sig) as [string, number, number, number, string][]) : []), [sig]);

  if (!fit || !key) return null;

  const drop = (e: GestureResponderEvent) => {
    const { locationX, locationY } = e.nativeEvent;
    const x = (locationX - fit.left) / fit.width;
    const y = (locationY - fit.top) / fit.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    const round = (v: number) => Math.round(v * 1000) / 1000;
    const id = addImagePin(conversationId, {
      src: uri ?? picture.src ?? '',
      storageId: picture.storageId,
      // A picture with no stored file is named by its address, never a data: blob.
      href: picture.src && /^https?:/.test(picture.src) ? picture.src : undefined,
      width: natural?.width,
      height: natural?.height,
      messageId: picture.messageId ?? messageWith(conversationId, picture.storageId),
      timestamp: picture.timestamp,
    }, { x: round(x), y: round(y) });
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPinned();
    openCommentEditor({ conversationId, id, isNew: true, surface: 'gallery' });
  };

  return (
    <RNView style={[StyleSheet.absoluteFill]} pointerEvents="box-none">
      {pinMode ? <Pressable style={StyleSheet.absoluteFill} onPress={drop} accessibilityLabel="Tap a spot on the picture to pin a comment" /> : null}
      {pins.map(([id, n, px, py, body]) => {
        const left = fit.left + px * fit.width;
        const top = fit.top + py * fit.height;
        // The words sit right of the pin, or left of it past the middle, in a
        // box as wide as they need (the face is near enough to monospace).
        const flip = left > page.width / 2;
        const width = Math.min(LABEL_MAX, Math.max(48, body.length * 7.4 + 18));
        return (
          <RNView key={id} style={[styles.pinAt, { left, top }]} pointerEvents="box-none">
            <Pressable
              onPress={() => openCommentEditor({ conversationId, id, isNew: false, surface: 'gallery' })}
              hitSlop={10}
              style={[styles.pin, { backgroundColor: accent }]}
              accessibilityRole="button"
              accessibilityLabel={`Comment ${n}${body ? `: ${body}` : ''}`}
            >
              <RNText style={styles.pinNumber}>{n}</RNText>
            </Pressable>
            {body ? (
              <Pressable
                onPress={() => openCommentEditor({ conversationId, id, isNew: false, surface: 'gallery' })}
                style={[styles.label, { width }, flip ? styles.labelLeft : styles.labelRight]}
              >
                <RNText style={styles.labelText} numberOfLines={3}>{body}</RNText>
              </Pressable>
            ) : null}
          </RNView>
        );
      })}
    </RNView>
  );
}

/** On a picture in the transcript: how many comments are pinned on it. */
export function PictureCommentCount({ conversationId, pictureKey, accent }: { conversationId: string; pictureKey: string | undefined; accent: string }) {
  const n = useInboxStore((s) => (pictureKey ? (s.reviewComments[conversationId] ?? []).filter((c) => c.image && (c.image.storageId ?? c.image.src) === pictureKey).length : 0));
  if (!n) return null;
  return (
    <RNView style={[styles.count, { backgroundColor: accent }]} pointerEvents="none" accessibilityLabel={`${n} comment${n === 1 ? '' : 's'} pinned on this picture`}>
      <Feather name="message-square" size={11} color="#fff" />
      <RNText style={styles.countText}>{n}</RNText>
    </RNView>
  );
}

const PIN = 26;
const LABEL_MAX = 170;
const styles = StyleSheet.create({
  pinAt: { position: 'absolute', width: 0, height: 0 },
  pin: {
    position: 'absolute',
    left: -PIN / 2,
    top: -PIN / 2,
    width: PIN,
    height: PIN,
    borderRadius: PIN / 2,
    borderWidth: 2,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  pinNumber: { color: '#fff', fontSize: 12, fontWeight: '700' },
  label: {
    position: 'absolute',
    top: -12,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  labelRight: { left: PIN / 2 + 6 },
  labelLeft: { right: PIN / 2 + 6 },
  labelText: { color: '#1c2a2a', fontSize: 13, lineHeight: 17 },
  count: { position: 'absolute', top: 8, left: 8, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, height: 22, borderRadius: 11 },
  countText: { color: '#fff', fontSize: 12, fontWeight: '700' },
});
