import React, { useState } from 'react';
import { Modal, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text as RNText } from '@/components/Themed';
import { Theme, themedStyles, useTheme } from '@/constants/Theme';
import { castPlayerScript } from '@codecast/convex/convex/lib/castPlayer';
import { openLink } from '@/lib/links';
import { optionalNative } from '@/lib/optionalNative';

// `![caption](clip.mp4)` on the phone: the web's inline video. The player is
// the same <cast-player> (speed, scrubbing, captions under it), run inside a
// WebView. A WebView cannot mount in the message list (an inverted FlatList,
// see CastCanvas), so the row is a card and the player opens full screen.
// Binaries without the WebView module open the file in the browser instead.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const WebViewComp: any = optionalNative('RNCWebViewModule', () => require('react-native-webview').WebView);

// The player's own source, bundled with the app, so the phone plays with the
// player it shipped with. Escaped so no "</script" inside closes the tag.
const PLAYER_JS = castPlayerScript({ upgradeVideos: false }).replace(/<\/(script)/gi, '<\\/$1');

function playerDocument(src: string, accent: string): string {
  const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
html,body{margin:0;height:100%;background:#000;font-family:ui-monospace,Menlo,monospace}
body{display:flex;align-items:center;justify-content:center}
cast-player{--cast-accent:${accent};--cast-radius:0px;--cast-bg:#000;width:min(100vw, calc(100vh * var(--cast-aspect, 16/9)))}
</style>
<script>${PLAYER_JS}</script>
</head><body>
<cast-player src="${attr(src)}" data-auto-aspect></cast-player>
<script>
customElements.whenDefined("cast-player").then(function () {
  var p = document.querySelector("cast-player");
  setTimeout(function () { p.play(); }, 0);
});
</script>
</body></html>`;
}

export function InlineVideo({ src, caption, tiled }: { src: string; caption?: string; tiled?: boolean }) {
  const Theme = useTheme();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);

  const onPress = () => (WebViewComp ? setOpen(true) : void openLink(src));
  // The player document is ours; any other navigation leaves for the browser.
  const onShouldStart = (req: any) => {
    const url: string = req?.url ?? '';
    if (url === 'about:blank' || url.startsWith('about:') || url.startsWith('data:')) return true;
    if (/^https?:/i.test(url)) void openLink(url);
    return false;
  };

  return (
    <RNView style={tiled ? styles.tile : undefined}>
      <TouchableOpacity
        onPress={onPress}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={caption ? `Play ${caption}` : 'Play video'}
        style={[styles.frame, tiled && styles.frameTiled]}
      >
        <RNView style={styles.play}>
          <FontAwesome name="play" size={tiled ? 16 : 20} color="#fff" style={{ marginLeft: 3 }} />
        </RNView>
      </TouchableOpacity>
      {caption ? <RNText style={styles.caption}>{caption}</RNText> : null}
      {WebViewComp && (
        <Modal
          visible={open}
          animationType="fade"
          onRequestClose={() => setOpen(false)}
          supportedOrientations={['portrait', 'landscape-left', 'landscape-right']}
        >
          <RNView style={styles.modal}>
            {open && (
              <WebViewComp
                originWhitelist={['*']}
                source={{ html: playerDocument(src, Theme.blue) }}
                onShouldStartLoadWithRequest={onShouldStart}
                javaScriptEnabled
                domStorageEnabled={false}
                allowsInlineMediaPlayback
                mediaPlaybackRequiresUserAction={false}
                allowsFullscreenVideo
                setSupportMultipleWindows={false}
                style={styles.web}
              />
            )}
            <RNView style={[styles.header, { paddingTop: insets.top + 6 }]} pointerEvents="box-none">
              {caption ? <RNText style={styles.headerTitle} numberOfLines={1}>{caption}</RNText> : <RNView style={{ flex: 1 }} />}
              <TouchableOpacity onPress={() => setOpen(false)} hitSlop={10} accessibilityLabel="Close video" style={styles.close}>
                <FontAwesome name="close" size={16} color="#fff" />
              </TouchableOpacity>
            </RNView>
          </RNView>
        </Modal>
      )}
    </RNView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  tile: { width: '48.5%' },
  frame: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: 10,
    marginTop: 6,
    marginBottom: 2,
    backgroundColor: '#0c0b10',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  frameTiled: { aspectRatio: undefined, height: 120 },
  play: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  caption: { fontSize: 11, color: Theme.textMuted, marginBottom: 6 },
  modal: { flex: 1, backgroundColor: '#000' },
  web: { flex: 1, backgroundColor: '#000' },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingBottom: 8,
  },
  headerTitle: { flex: 1, color: '#fff', fontSize: 13 },
  close: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
