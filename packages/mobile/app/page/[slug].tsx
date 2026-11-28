// A published page's own screen (cast publish), the phone twin of the web's
// /a/<slug>: the page itself in a WebView framed through the viewer's own
// gate keys (artifacts.embedInfo, so a password-, email- or team-gated page
// opens for the reader the app admits), and its comment threads as native
// rows under it. `?c=<comment id>` opens the discussion on that thread.
//
// Local-first: the discussion lives in the store's pageThreads row (the same
// home the Threads inbox writes), fed by artifacts.discussionForApp; a reply
// is addPageComment's stub and a resolve flips the row before the server
// answers.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View as RNView,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Feather from '@expo/vector-icons/Feather';
import { api } from '@codecast/convex/convex/_generated/api';
import { pageShareUrl } from '@codecast/shared/entities';
import { pageEmbedUrl, pageServingOrigin } from '@codecast/shared/contracts';
import { mobileRelativeTime } from '@codecast/shared/render/mobileSessionStyle';
import { useInboxStore, useTrackedStore } from '@codecast/web/store/inboxStore';
import { newPageCommentClientId, withPageCommentStubs } from '@codecast/web/store/pageCommentStubs';
import type { PageCommentRow, PageThreadRow } from '@codecast/web/store/threadTypes';
import { pageGateKeys, usePageEmbedQuery, type PageInfo } from '@codecast/web/hooks/pageEmbedQuery';
import { useQueryNoThrow } from '@codecast/web/hooks/useQueryNoThrow';
import { useConvexSync } from '@codecast/web/hooks/useConvexSync';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { useConvexAuth } from 'convex/react';
import { Text as RNText, TextInput } from '@/components/Themed';
import { CHROME_FONT_CAP, getActiveScheme, Spacing, themedStyles, useTheme } from '@/constants/Theme';
import { Mono, uiFace } from '@/constants/fonts';
import { ObjectHeader, ObjectMissing } from '@/components/objects/ObjectParts';
import { ChatAvatar } from '@/components/chat/MessageRow';
import { CONVEX_ORIGIN } from '@/lib/convex';
import { openInBrowser, openLink } from '@/lib/links';
import { optionalNative } from '@/lib/optionalNative';
import { PageCommentBar, useOpenedFromSession, usePageComments } from '@/components/comments/pageComments';
import { useAndroidImeInset } from '@/hooks/useAndroidImeInset';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const WebViewComp: any = optionalNative('RNCWebViewModule', () => require('react-native-webview').WebView);

type Thread = { root: PageCommentRow; replies: PageCommentRow[] };

/** Roots oldest first, each with its replies (one level deep, as the table stores them). */
function threadsOf(comments: PageCommentRow[]): Thread[] {
  const byParent = new Map<string, PageCommentRow[]>();
  for (const c of comments) {
    if (!c.parent_comment_id) continue;
    byParent.set(c.parent_comment_id, [...(byParent.get(c.parent_comment_id) ?? []), c]);
  }
  return comments
    .filter((c) => !c.parent_comment_id)
    .sort((a, b) => a.created_at - b.created_at)
    .map((root) => ({ root, replies: (byParent.get(root._id) ?? []).sort((a, b) => a.created_at - b.created_at) }));
}

/** Feeds the page's discussion into its pageThreads row, keeping this window's unsent reply stubs. */
function usePageDiscussionFeed(slug: string | undefined, ready: boolean) {
  const { data } = useQueryNoThrow((api as any).artifacts.discussionForApp, slug && ready ? { slug } : 'skip');
  useConvexSync(data as PageThreadRow | null | undefined, useCallback((row: PageThreadRow | null) => {
    if (!row) return;
    const s = useInboxStore.getState() as any;
    s.syncTable('pageThreads', withPageCommentStubs([row], s.pageThreads ?? {}));
  }, []));
  return data as (PageThreadRow & { comments_disabled?: boolean }) | null | undefined;
}

export default function PageScreen() {
  const Theme = useTheme();
  const insets = useSafeAreaInsets();
  const imeInset = useAndroidImeInset();
  const { slug: rawSlug, c: focusId } = useLocalSearchParams<{ slug: string; c?: string }>();
  const slug = rawSlug?.trim();
  const { isAuthenticated } = useConvexAuth();
  const now = useCoarseNow(30_000);

  usePageEmbedQuery(useMemo(() => (slug && isAuthenticated ? { pages: [{ slug }] } : 'skip' as const), [slug, isAuthenticated]));
  const served = usePageDiscussionFeed(slug, isAuthenticated);
  const pid = served?._id;
  const s = useTrackedStore([
    (st: any) => (slug ? st.pageEmbeds?.[slug] : undefined),
    (st: any) => st.currentUser?._id,
    (st: any) => (pid ? st.pageThreads?.[pid] : undefined),
  ]) as any;
  const info = slug ? (s.pageEmbeds?.[slug] as PageInfo | undefined) : undefined;
  const page = pid ? (s.pageThreads?.[pid] as PageThreadRow | undefined) : undefined;
  const meId = s.currentUser?._id ? String(s.currentUser._id) : null;
  const isOwner = !!page && !!meId && page.user_id === meId;

  const threads = useMemo(() => threadsOf(page?.comments ?? []), [page?.comments]);
  const open = threads.filter((t) => t.root.status !== 'resolved');
  const resolved = threads.filter((t) => t.root.status === 'resolved');
  // ?c= names a comment; a reply opens its root's thread.
  const focusRoot = useMemo(() => {
    if (!focusId || !page) return null;
    const c = page.comments.find((x) => x._id === focusId);
    return c ? (c.parent_comment_id ?? c._id) : null;
  }, [focusId, page]);

  const [sheetOpen, setSheetOpen] = useState(!!focusId);
  const [showResolved, setShowResolved] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [text, setText] = useState('');
  const focusApplied = useRef(false);
  useEffect(() => {
    if (!focusRoot || focusApplied.current) return;
    focusApplied.current = true;
    setSheetOpen(true);
    if (resolved.some((t) => t.root._id === focusRoot)) setShowResolved(true);
  }, [focusRoot, resolved]);

  // Opening the discussion reads it, as the Threads inbox does.
  const artifactId = page?._id;
  useEffect(() => {
    if (sheetOpen && artifactId) (useInboxStore.getState() as any).markThreadRead('page', artifactId);
  }, [sheetOpen, artifactId, page?.comments.length]);

  // Opened from a session, the page takes comments into the next message sent there.
  const webview = useRef<{ injectJavaScript: (js: string) => void } | null>(null);
  const fromSession = useOpenedFromSession();
  const sessionTitle = useInboxStore((st: any) => (fromSession ? (st.sessions?.[fromSession]?.title as string | undefined) : undefined));
  const promptComments = usePageComments(webview, slug ?? '', info?.title || page?.title || 'Published page', slug ? pageShareUrl(slug) : '', slug ? fromSession : null);

  if (!slug) return <ObjectMissing what="Page" loading={false} />;
  const shareUrl = pageShareUrl(slug);
  const browse = () => void openInBrowser(shareUrl);
  if (!info) return <ObjectMissing what="Page" loading />;
  if (info.missing) return <ObjectMissing what="Page" id={slug} loading={false} action={{ label: 'Open in browser', onPress: browse }} />;

  const title = info.title || page?.title || 'Published page';
  const header = <ObjectHeader type={null} link={shareUrl} title={title} menu={[{ label: 'Open in browser', onPress: browse }]} />;

  if (info.locked) {
    return (
      <>
        {header}
        <RNView style={styles.center}>
          <Feather name="lock" size={26} color={Theme.textMuted0} />
          <RNText style={styles.dim}>Locked for this account</RNText>
          <BrowserButton onPress={browse} />
        </RNView>
      </>
    );
  }

  const origin = pageServingOrigin(CONVEX_ORIGIN);
  // appHost: the page's own bar and theme button stand down, since this screen carries both.
  const src = pageEmbedUrl(CONVEX_ORIGIN, slug, getActiveScheme(), pageGateKeys(info), info.version, true);
  const commentsOff = !!served?.comments_disabled;

  const send = () => {
    const t = text.trim();
    if (!t || !artifactId) return;
    (useInboxStore.getState() as any).addPageComment({ artifactId, text: t, clientId: newPageCommentClientId(), ...(replyTo ? { parentId: replyTo } : {}) });
    setText('');
    setReplyTo(null);
  };
  const resolve = (id: string, on: boolean) => artifactId && (useInboxStore.getState() as any).resolvePageComment(artifactId, id, on);
  const replyName = replyTo ? page?.comments.find((c) => c._id === replyTo)?.author_name : null;

  return (
    <>
      {header}
      {/* Android edge-to-edge never resizes the window for the keyboard, so the
          screen shrinks by its height and the comment sheet rides above it. */}
      <RNView style={[styles.flex, imeInset > 0 && { marginBottom: imeInset }]}>
        <RNView style={styles.flex}>
          {WebViewComp ? (
            <WebViewComp
              key={src}
              ref={webview}
              source={{ uri: src }}
              injectedJavaScript={promptComments?.injectedJavaScript}
              onMessage={promptComments?.onMessage}
              originWhitelist={[origin]}
              onShouldStartLoadWithRequest={(req: { url: string; isTopFrame?: boolean }) => {
                if (req.isTopFrame === false || req.url.startsWith(origin) || req.url === 'about:blank') return true;
                void openLink(req.url);
                return false;
              }}
              startInLoadingState
              renderLoading={() => <RNView style={[styles.center, StyleSheet.absoluteFill]}><ActivityIndicator color={Theme.textMuted} /></RNView>}
              javaScriptEnabled
              allowsInlineMediaPlayback
              setSupportMultipleWindows={false}
              style={{ backgroundColor: Theme.bg }}
              testID="page-frame"
            />
          ) : (
            <RNView style={styles.center}>
              <Feather name="alert-circle" size={22} color={Theme.textMuted0} />
              <RNText style={styles.dim}>Update the app to view pages</RNText>
            </RNView>
          )}
        </RNView>
        {promptComments && !sheetOpen ? <PageCommentBar comments={promptComments} sessionTitle={sessionTitle} /> : null}

        {sheetOpen ? (
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={insets.top + 44} style={styles.sheet}>
            <TouchableOpacity style={styles.sheetHead} onPress={() => setSheetOpen(false)} activeOpacity={0.7} testID="page-comments-close">
              <Feather name="message-square" size={13} color={Theme.cyan} />
              <RNText style={styles.sheetTitle} maxFontSizeMultiplier={CHROME_FONT_CAP}>
                {threads.length ? `${open.length} open${resolved.length ? ` · ${resolved.length} resolved` : ''}` : 'Comments'}
              </RNText>
              <RNView style={styles.flex} />
              <Feather name="chevron-down" size={16} color={Theme.textMuted} />
            </TouchableOpacity>
            <ScrollView style={styles.sheetBody} contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
              {served === undefined && !page ? <ActivityIndicator style={styles.pad} color={Theme.textMuted} /> : null}
              {served !== undefined && threads.length === 0 ? <RNText style={[styles.dim, styles.pad]}>No comments</RNText> : null}
              {open.map((t) => (
                <ThreadCard key={t.root._id} t={t} now={now} focused={t.root._id === focusRoot} owner={isOwner}
                  replying={replyTo === t.root._id} onReply={() => setReplyTo(replyTo === t.root._id ? null : t.root._id)} onResolve={resolve} />
              ))}
              {resolved.length > 0 && (
                <TouchableOpacity style={styles.foldRow} onPress={() => setShowResolved(!showResolved)} activeOpacity={0.6}>
                  <Feather name={showResolved ? 'chevron-down' : 'chevron-right'} size={13} color={Theme.textMuted} />
                  <RNText style={styles.foldText}>{`Resolved · ${resolved.length}`}</RNText>
                </TouchableOpacity>
              )}
              {showResolved && resolved.map((t) => (
                <ThreadCard key={t.root._id} t={t} now={now} focused={t.root._id === focusRoot} owner={isOwner}
                  replying={replyTo === t.root._id} onReply={() => setReplyTo(replyTo === t.root._id ? null : t.root._id)} onResolve={resolve} />
              ))}
            </ScrollView>
            {commentsOff ? (
              <RNView style={[styles.composer, { paddingBottom: insets.bottom + 8 }]}>
                <Feather name="slash" size={13} color={Theme.textMuted0} />
                <RNText style={styles.dim}>Comments off</RNText>
              </RNView>
            ) : (
              <RNView style={[styles.composerWrap, { paddingBottom: insets.bottom + 8 }]}>
                {replyTo ? (
                  <TouchableOpacity style={styles.replyChip} onPress={() => setReplyTo(null)} activeOpacity={0.6}>
                    <Feather name="corner-down-right" size={11} color={Theme.cyan} />
                    <RNText style={styles.replyChipText} numberOfLines={1}>{replyName ?? 'thread'}</RNText>
                    <Feather name="x" size={11} color={Theme.textMuted} />
                  </TouchableOpacity>
                ) : null}
                <RNView style={styles.composer}>
                  <TextInput
                    style={styles.input}
                    value={text}
                    onChangeText={setText}
                    placeholder={replyTo ? 'Reply' : 'Comment on the page'}
                    placeholderTextColor={Theme.textMuted0}
                    multiline
                    testID="page-comment-input"
                  />
                  <TouchableOpacity onPress={send} disabled={!text.trim() || !artifactId} hitSlop={8} testID="page-comment-send"
                    style={[styles.sendBtn, { backgroundColor: text.trim() ? Theme.cyan : Theme.border }]}>
                    <Feather name="arrow-up" size={15} color={Theme.bg} />
                  </TouchableOpacity>
                </RNView>
              </RNView>
            )}
          </KeyboardAvoidingView>
        ) : (
          <RNView style={[styles.bar, { paddingBottom: insets.bottom + 8 }]}>
            <TouchableOpacity style={styles.barComments} onPress={() => setSheetOpen(true)} activeOpacity={0.7} testID="page-comments-open">
              <Feather name="message-square" size={15} color={open.length ? Theme.cyan : Theme.textMuted} />
              <RNText style={[styles.barText, open.length > 0 && { color: Theme.text }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>
                {open.length ? `${open.length} open` : 'Comments'}
              </RNText>
              {resolved.length ? <RNText style={styles.dim} maxFontSizeMultiplier={CHROME_FONT_CAP}>{`${resolved.length} resolved`}</RNText> : null}
            </TouchableOpacity>
            <BrowserButton onPress={browse} />
          </RNView>
        )}
      </RNView>
    </>
  );
}

/** Leaves the app for Safari with the page's public address. */
function BrowserButton({ onPress }: { onPress: () => void }) {
  const Theme = useTheme();
  return (
    <TouchableOpacity style={styles.browserBtn} onPress={onPress} activeOpacity={0.6} accessibilityRole="link" testID="page-open-browser">
      <Feather name="external-link" size={14} color={Theme.text} />
      <RNText style={styles.browserText} maxFontSizeMultiplier={CHROME_FONT_CAP}>Open in browser</RNText>
    </TouchableOpacity>
  );
}

function ThreadCard({ t, now, focused, owner, replying, onReply, onResolve }: {
  t: Thread; now: number; focused: boolean; owner: boolean; replying: boolean;
  onReply: () => void; onResolve: (id: string, on: boolean) => void;
}) {
  const Theme = useTheme();
  const isResolved = t.root.status === 'resolved';
  const stub = t.root._id.startsWith('pagecmtstub-');
  return (
    <RNView style={[styles.card, focused && { borderColor: Theme.cyan }, isResolved && styles.cardResolved]} testID={`page-thread-${t.root._id}`}>
      <CommentRow c={t.root} now={now} />
      {t.replies.map((r) => <RNView key={r._id} style={styles.reply}><CommentRow c={r} now={now} /></RNView>)}
      {!stub && (
        <RNView style={styles.actions}>
          <TouchableOpacity onPress={onReply} hitSlop={6} style={styles.action} activeOpacity={0.6}>
            <Feather name="corner-down-right" size={12} color={replying ? Theme.cyan : Theme.textMuted} />
            <RNText style={[styles.actionText, replying && { color: Theme.cyan }]}>Reply</RNText>
          </TouchableOpacity>
          {owner && (
            <TouchableOpacity onPress={() => onResolve(t.root._id, !isResolved)} hitSlop={6} style={styles.action} activeOpacity={0.6} testID={`page-resolve-${t.root._id}`}>
              <Feather name={isResolved ? 'rotate-ccw' : 'check'} size={12} color={isResolved ? Theme.textMuted : Theme.green} />
              <RNText style={[styles.actionText, !isResolved && { color: Theme.green }]}>{isResolved ? 'Reopen' : 'Resolve'}</RNText>
            </TouchableOpacity>
          )}
        </RNView>
      )}
    </RNView>
  );
}

function CommentRow({ c, now }: { c: PageCommentRow; now: number }) {
  const pending = c._id.startsWith('pagecmtstub-');
  return (
    <RNView style={[styles.comment, pending && { opacity: 0.55 }]}>
      <ChatAvatar author={{ id: c.author_user_id ?? c.author_name, name: c.author_name, avatarUrl: c.author_avatar }} size={22} />
      <RNView style={styles.flex}>
        <RNView style={styles.commentHead}>
          <RNText style={styles.author} numberOfLines={1}>{c.author_name}</RNText>
          <RNText style={styles.age}>{pending ? 'sending' : mobileRelativeTime(c.created_at, now)}</RNText>
        </RNView>
        <RNText style={styles.body} selectable>{c.text}</RNText>
      </RNView>
    </RNView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: Theme.bg },
  dim: { color: Theme.textMuted, fontSize: 13 },
  pad: { padding: Spacing.lg, textAlign: 'center' },
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: Spacing.lg, paddingRight: Spacing.md, paddingTop: 8,
    backgroundColor: Theme.bgAlt, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.border,
  },
  barComments: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36 },
  barText: { color: Theme.textMuted, fontSize: 14, fontFamily: uiFace(Mono.semiBold) },
  browserBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 12, borderRadius: 17,
    backgroundColor: Theme.card, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.border,
  },
  browserText: { color: Theme.text, fontSize: 13, fontFamily: uiFace(Mono.semiBold) },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '62%',
    backgroundColor: Theme.bgAlt, borderTopLeftRadius: 14, borderTopRightRadius: 14,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: Theme.border,
    shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 12, shadowOffset: { width: 0, height: -3 }, elevation: 12,
  },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: Spacing.lg, paddingVertical: 12 },
  sheetTitle: { color: Theme.text, fontSize: 14, fontFamily: uiFace(Mono.semiBold) },
  sheetBody: { flexGrow: 0, flexShrink: 1 },
  sheetContent: { paddingHorizontal: Spacing.md, paddingBottom: Spacing.md, gap: 8 },
  card: { backgroundColor: Theme.card, borderRadius: 10, borderWidth: 1, borderColor: Theme.border, padding: 10, gap: 8 },
  cardResolved: { opacity: 0.7 },
  comment: { flexDirection: 'row', gap: 8 },
  commentHead: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  author: { color: Theme.text, fontSize: 13, fontFamily: uiFace(Mono.semiBold), flexShrink: 1 },
  age: { color: Theme.textMuted0, fontSize: 11 },
  body: { color: Theme.text, fontSize: 14, lineHeight: 20, marginTop: 2 },
  reply: { marginLeft: 30, paddingLeft: 8, borderLeftWidth: 2, borderLeftColor: Theme.border },
  actions: { flexDirection: 'row', gap: 18, marginLeft: 30 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  actionText: { color: Theme.textMuted, fontSize: 12, fontFamily: uiFace(Mono.medium) },
  foldRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 4 },
  foldText: { color: Theme.textMuted, fontSize: 12, fontFamily: uiFace(Mono.semiBold) },
  composerWrap: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.border, paddingHorizontal: Spacing.md, paddingTop: 8, gap: 6 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: {
    flex: 1, maxHeight: 110, minHeight: 38, color: Theme.text, fontSize: 14, backgroundColor: Theme.card,
    borderRadius: 10, borderWidth: 1, borderColor: Theme.border, paddingHorizontal: 10, paddingTop: 9, paddingBottom: 9,
  },
  sendBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginBottom: 3 },
  replyChip: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start' },
  replyChipText: { color: Theme.cyan, fontSize: 12, maxWidth: 220 },
}));
