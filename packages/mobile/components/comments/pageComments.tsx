// Comments on a published page, from its own screen: words selected on the
// page, or a spot pinned on it, join the quote batch of the conversation the
// page was opened from, and ride the next message sent there. The web does
// this for a page framed in the thread (hooks/usePageNotes); the page's notes
// layer (convex artifactPages.ts) draws the pins and reports gestures to its
// host. A WebView is no frame, so a script injected here carries those
// messages between the page and the app, and watches the selection, which the
// page only reads on a mouse-up a touch never makes.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View as RNView } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { useNavigation } from 'expo-router';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { addPageNote } from '@codecast/web/lib/reviewActions';
import { pinNumbers } from '@codecast/web/lib/quoteFormat';
import { Text as RNText } from '@/components/Themed';
import { themedStyles, useTheme } from '@/constants/Theme';
import { openCommentEditor } from './CommentEditor';

/** Runs in the page: forwards the notes layer's gestures, reports selections. */
export const PAGE_COMMENT_BRIDGE_JS = `(function(){
  if (window.__ccBridge) return; window.__ccBridge = 1;
  var RN = window.ReactNativeWebView; if (!RN) return;
  var send = function(m){ try { RN.postMessage(JSON.stringify(m)); } catch (e) {} };
  var OUT = { 'codecast:note-add':1, 'codecast:note-body':1, 'codecast:note-edit':1, 'codecast:note-remove':1, 'codecast:pin-mode':1 };
  window.addEventListener('message', function(e){ var d = e.data; if (d && OUT[d.type]) send(d); });
  // The page's own Comment button waits on a mouse-up; here the app's bar offers it.
  try { var st = document.createElement('style'); st.textContent = '#__cc_qbtn{display:none!important}'; (document.head || document.documentElement).appendChild(st); } catch (e) {}
  var t = null;
  document.addEventListener('selectionchange', function(){
    clearTimeout(t);
    t = setTimeout(function(){
      var s = window.getSelection(), txt = s ? String(s).replace(/\\s+/g, ' ').trim() : '';
      if (!txt || !s.rangeCount) return send({ type: 'cc-sel', text: '' });
      var rs = s.getRangeAt(0).getClientRects(), r = rs.length ? rs[rs.length - 1] : s.getRangeAt(0).getBoundingClientRect();
      var d = document.documentElement, W = Math.max(d.scrollWidth, 1), H = Math.max(d.scrollHeight, 1);
      var c = function(v){ return Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000; };
      send({ type: 'cc-sel', text: txt.slice(0, 500), point: { x: c((r.right + window.pageXOffset) / W), y: c((r.top + r.height / 2 + window.pageYOffset) / H) } });
    }, 250);
  });
  window.__ccClearSel = function(){ try { window.getSelection().removeAllRanges(); } catch (e) {} };
  send({ type: 'cc-ready' });
})(); true;`;

type FromPage =
  | { type: 'cc-ready' }
  | { type: 'cc-sel'; text: string; point?: { x: number; y: number } }
  | { type: 'codecast:note-add'; point: { x: number; y: number }; snippet?: string }
  | { type: 'codecast:note-edit'; id: string | null }
  | { type: 'codecast:note-remove'; id: string }
  | { type: 'codecast:note-body'; id: string; body: string }
  | { type: 'codecast:pin-mode'; on: boolean };

type WebViewHandle = { injectJavaScript: (js: string) => void } | null;

/** The conversation this page was opened from: the screen under it, when that is a session. */
export function useOpenedFromSession(): string | null {
  const navigation = useNavigation();
  return useMemo(() => {
    const state = navigation.getState?.();
    const below = state && state.index > 0 ? state.routes[state.index - 1] : undefined;
    const id = below && /^session\//.test(below.name) ? (below.params as { id?: string } | undefined)?.id : undefined;
    return id ? String(id) : null;
    // The screen below does not change while this one is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

const clamp = (v: unknown) => Math.min(1, Math.max(0, Number(v) || 0));

/**
 * The page's side of its comments: the WebView props that bridge it, what is
 * selected now, pin mode, and making a comment. Null with no conversation to
 * send them in.
 */
export function usePageComments(webview: { current: WebViewHandle }, slug: string, title: string, url: string, conversationId: string | null) {
  const [selection, setSelection] = useState<{ text: string; point?: { x: number; y: number } } | null>(null);
  const [pinMode, setPinMode] = useState(false);
  // Read by the page's messages: a pin is taken only while pin mode is on.
  const pinModeRef = useRef(pinMode);
  pinModeRef.current = pinMode;

  // What the page draws: this page's pins, numbered as the send names them.
  const sig = useInboxStore((s) => {
    if (!conversationId) return '';
    const all = s.reviewComments[conversationId] ?? [];
    const numbers = pinNumbers(all);
    const notes = all.filter((c) => c.page?.slug === slug && c.page.point)
      .map((c) => ({ id: c.id, n: numbers.get(c.id) ?? 0, x: c.page!.point!.x, y: c.page!.point!.y, body: c.body, snippet: c.page!.snippet }));
    return JSON.stringify(notes);
  });
  const count = useMemo(() => (sig ? (JSON.parse(sig) as unknown[]).length : 0), [sig]);

  const post = useCallback(() => {
    if (!conversationId) return;
    // The page's own editor never opens: a pin's words are written in the app's.
    const msg = { type: 'codecast:notes', notes: JSON.parse(sig || '[]'), editing: null, pinMode };
    webview.current?.injectJavaScript(`window.postMessage(${JSON.stringify(msg)}, '*'); true;`);
  }, [conversationId, sig, pinMode, webview]);
  const postRef = useRef(post);
  postRef.current = post;
  useEffect(() => { post(); }, [post]);

  const add = useCallback((point: { x: number; y: number } | undefined, snippet: string | undefined) => {
    if (!conversationId) return;
    const id = addPageNote(conversationId, '', {
      slug,
      title,
      url,
      point: point ? { x: clamp(point.x), y: clamp(point.y) } : undefined,
      snippet: snippet?.trim() ? snippet.trim().slice(0, 500) : undefined,
    });
    useInboxStore.getState().setReviewEditingId(null);
    openCommentEditor({ conversationId, id, isNew: true });
  }, [conversationId, slug, title, url]);

  const onMessage = useCallback((e: { nativeEvent: { data: string } }) => {
    if (!conversationId) return;
    let m: FromPage;
    try { m = JSON.parse(e.nativeEvent.data); } catch { return; }
    if (!m || typeof m.type !== 'string') return;
    const mine = (id: unknown) => typeof id === 'string'
      && (useInboxStore.getState().reviewComments[conversationId] ?? []).some((c) => c.id === id && c.page?.slug === slug);
    switch (m.type) {
      case 'cc-ready':
        // A page (re)loaded: nothing is selected on it yet.
        setSelection(null);
        postRef.current();
        break;
      case 'cc-sel':
        setSelection(m.text ? { text: m.text, point: m.point } : null);
        break;
      case 'codecast:note-add':
        // Only a tap the person made in pin mode: the page cannot add notes
        // to their message on its own.
        if (!pinModeRef.current) break;
        setPinMode(false);
        add(m.point, m.snippet);
        break;
      case 'codecast:note-edit':
        if (mine(m.id)) openCommentEditor({ conversationId, id: m.id as string, isNew: false });
        break;
      case 'codecast:note-remove':
        if (mine(m.id)) useInboxStore.getState().removeReviewComment(conversationId, m.id);
        break;
      case 'codecast:pin-mode':
        setPinMode(!!m.on);
        break;
    }
  }, [conversationId, slug, add]);

  const commentOnSelection = () => {
    if (!selection) return;
    add(selection.point, selection.text);
    setSelection(null);
    webview.current?.injectJavaScript('window.__ccClearSel && window.__ccClearSel(); true;');
  };

  if (!conversationId) return null;
  return { onMessage, injectedJavaScript: PAGE_COMMENT_BRIDGE_JS, selection, commentOnSelection, pinMode, setPinMode, count, conversationId };
}

/** The strip under the page: comment on the selection, pin a spot, and how many wait to be sent. */
export function PageCommentBar({ comments, sessionTitle }: { comments: NonNullable<ReturnType<typeof usePageComments>>; sessionTitle?: string }) {
  const Theme = useTheme();
  const { selection, commentOnSelection, pinMode, setPinMode, count } = comments;
  return (
    <RNView style={[styles.bar, { borderTopColor: Theme.border, backgroundColor: Theme.card }]}>
      {selection ? (
        <Pressable onPress={commentOnSelection} style={[styles.primary, { backgroundColor: Theme.accent }]} accessibilityRole="button">
          <Feather name="message-square" size={15} color={Theme.bg} />
          <RNText style={[styles.primaryText, { color: Theme.bg }]}>Comment</RNText>
        </Pressable>
      ) : (
        <Pressable
          onPress={() => setPinMode(!pinMode)}
          style={[styles.secondary, { borderColor: pinMode ? Theme.accent : Theme.border }]}
          accessibilityRole="button"
          accessibilityState={{ selected: pinMode }}
        >
          <Feather name="map-pin" size={14} color={pinMode ? Theme.accent : Theme.textMuted} />
          <RNText style={[styles.secondaryText, { color: pinMode ? Theme.accent : Theme.text }]}>{pinMode ? 'Tap a spot' : 'Pin'}</RNText>
        </Pressable>
      )}
      <RNView style={styles.flex} />
      <Feather name="message-square" size={14} color={count ? Theme.accent : Theme.textMuted0} />
      <RNText style={[styles.where, { color: Theme.textMuted }]} numberOfLines={1}>
        {count ? <RNText style={{ color: Theme.accent, fontWeight: '600' }}>{count} · </RNText> : null}
        {sessionTitle ? `for ${sessionTitle}` : 'for your next message'}
      </RNText>
    </RNView>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, minHeight: 52 },
  flex: { flex: 1 },
  primary: { flexDirection: 'row', alignItems: 'center', gap: 7, height: 40, paddingHorizontal: 16, borderRadius: 20 },
  primaryText: { fontSize: 15, fontWeight: '600' },
  secondary: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 40, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1 },
  secondaryText: { fontSize: 14, fontWeight: '600' },
  where: { fontSize: 13, maxWidth: '55%' },
}));
