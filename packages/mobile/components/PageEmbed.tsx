// A published page (cast publish) drawn where it is named: a decision's
// report, a page link alone on its line. The page itself renders live in a
// WebView framed through the viewer's own gate keys (artifacts.embedInfo, the
// same feed the page screen reads), clipped to a preview height; a tap opens
// the page's own screen (app/page/[slug]) with its comments. The web draws
// the same thing as an iframe (PublishedPageEmbed).
//
// The preview does not take touches: a page that scrolls inside a scrolling
// transcript fights it, so reading the whole page is the page screen's job.
import { useMemo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import Feather from '@expo/vector-icons/Feather';
import { useConvexAuth } from 'convex/react';
import { pageEmbedUrl } from '@codecast/shared/contracts';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { pageGateKeys, usePageEmbedQuery, type PageInfo } from '@codecast/web/hooks/pageEmbedQuery';
import { Text } from '@/components/Themed';
import { getActiveScheme, themedStyles, useTheme } from '@/constants/Theme';
import { CONVEX_ORIGIN } from '@/lib/convex';
import { optionalNative } from '@/lib/optionalNative';
import { FadeGradient } from '@/components/CollapsibleBody';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const WebViewComp: any = optionalNative('RNCWebViewModule', () => require('react-native-webview').WebView);

export function PageEmbed({ slug, decision, caption, kicker = 'Page', height = 280 }: {
  slug: string;
  /** The decision the page is attached to: a report gated to the decision's readers opens for them through it. */
  decision?: string;
  /** What the writer called it, over the page's own title. */
  caption?: string;
  kicker?: string;
  height?: number;
}) {
  const Theme = useTheme();
  const router = useRouter();
  const { isAuthenticated } = useConvexAuth();
  usePageEmbedQuery(useMemo(() => (isAuthenticated ? { pages: [{ slug, ...(decision ? { decision } : {}) }] } : 'skip' as const), [slug, decision, isAuthenticated]));
  const info = useInboxStore((s) => (s as any).pageEmbeds?.[slug]) as PageInfo | undefined;
  const open = () => router.push(`/page/${slug}` as never);
  const title = caption || info?.title || 'Published page';
  // Nothing to frame: a binary without the WebView, a page this viewer cannot open, or one that is gone.
  const framed = !!WebViewComp && !!info && !info.missing && !info.locked;
  const src = framed ? pageEmbedUrl(CONVEX_ORIGIN, slug, getActiveScheme(), pageGateKeys(info), info!.version, true) : null;

  return (
    <Pressable onPress={open} accessibilityRole="button" accessibilityLabel={`${kicker}: ${title}`} accessibilityHint="Opens the page" style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]} testID="page-embed">
      <View style={styles.head}>
        <Feather name="layout" size={13} color={Theme.cyan} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.kicker}>{kicker}</Text>
          <Text style={styles.title} numberOfLines={2}>{title}</Text>
        </View>
        <View style={styles.openPill}>
          <Text style={styles.openText}>Open</Text>
          <Feather name="maximize-2" size={11} color={Theme.text} />
        </View>
      </View>
      {src ? (
        <View style={[styles.frame, { height }]} pointerEvents="none">
          <WebViewComp
            key={src}
            source={{ uri: src }}
            scrollEnabled={false}
            javaScriptEnabled
            startInLoadingState
            renderLoading={() => <View style={[styles.loading, StyleSheet.absoluteFill]}><ActivityIndicator color={Theme.textMuted} /></View>}
            setSupportMultipleWindows={false}
            style={{ backgroundColor: Theme.bg }}
          />
          <FadeGradient colors={[Theme.card + '00', Theme.card]} style={styles.fade} pointerEvents="none" />
        </View>
      ) : info?.locked ? (
        <View style={styles.note}><Feather name="lock" size={12} color={Theme.textMuted0} /><Text style={styles.noteText}>Locked for this account</Text></View>
      ) : info?.missing ? (
        <View style={styles.note}><Text style={styles.noteText}>This page is gone</Text></View>
      ) : !info && isAuthenticated ? (
        <View style={[styles.frame, styles.loading, { height: 72 }]}><ActivityIndicator color={Theme.textMuted} /></View>
      ) : null}
    </Pressable>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  card: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    backgroundColor: Theme.card,
    overflow: 'hidden',
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 9 },
  kicker: { fontSize: 10.5, letterSpacing: 0.4, textTransform: 'uppercase', color: Theme.textMuted0 },
  title: { fontSize: 13.5, fontWeight: '600', color: Theme.text, marginTop: 1 },
  openPill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 7, backgroundColor: Theme.bgAlt },
  openText: { fontSize: 12, fontWeight: '500', color: Theme.text },
  frame: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.borderLight, backgroundColor: Theme.bg },
  fade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 40 },
  loading: { alignItems: 'center', justifyContent: 'center' },
  note: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingBottom: 10 },
  noteText: { fontSize: 12, color: Theme.textMuted },
}));
