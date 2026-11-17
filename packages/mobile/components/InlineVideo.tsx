import React, { useState } from 'react';
import { Modal, StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text as RNText } from '@/components/Themed';
import { Theme, themedStyles, useTheme } from '@/constants/Theme';
import { castPlayerScript } from '@codecast/convex/convex/lib/castPlayer';
import { formatCallTime } from '@codecast/shared/contracts';
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

/** Timed words to play beside the video (a screen recording's transcript):
 *  each a seek, the one under playback marked. */
export type PlayerLine = { t0: number; text: string };

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function playerDocument(src: string, accent: string, opts: { startMs?: number; lines?: PlayerLine[] } = {}): string {
  const lines = opts.lines ?? [];
  const start = Math.max(0, (opts.startMs ?? 0) / 1000);
  const list = lines.length
    ? `<ol id="lines">${lines.map((l, i) => `<li data-t="${l.t0 / 1000}" data-i="${i}"><span class="t">${formatCallTime(l.t0)}</span><span>${esc(l.text)}</span></li>`).join('')}</ol>`
    : '';
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
html,body{margin:0;height:100%;background:#000;font-family:ui-monospace,Menlo,monospace;color:#fff}
body{display:flex;flex-direction:column;align-items:center;justify-content:center}
cast-player{--cast-accent:${accent};--cast-radius:0px;--cast-bg:#000;width:min(100vw, calc(${lines.length ? '58vh' : '100vh'} * var(--cast-aspect, 16/9)));flex:0 0 auto}
#lines{list-style:none;margin:0;padding:8px 0 24px;width:100%;flex:1 1 0;overflow-y:auto;font-size:14px;line-height:1.4}
#lines li{display:flex;gap:10px;padding:7px 16px}
#lines li .t{color:#8a8f98;width:38px;flex:0 0 auto;text-align:right;font-variant-numeric:tabular-nums}
#lines li.on{background:${accent}33}
#lines li.on .t{color:${accent}}
</style>
<script>${PLAYER_JS}</script>
</head><body>
<cast-player src="${esc(src)}" data-auto-aspect></cast-player>
${list}
<script>
customElements.whenDefined("cast-player").then(function () {
  var p = document.querySelector("cast-player");
  var items = [].slice.call(document.querySelectorAll("#lines li"));
  var on = -1;
  function mark() {
    var t = p.currentTime || 0, k = -1;
    for (var i = 0; i < items.length; i++) if (t >= parseFloat(items[i].dataset.t) - 0.05) k = i;
    if (k === on) return;
    if (on >= 0) items[on].classList.remove("on");
    on = k;
    if (k >= 0) { items[k].classList.add("on"); items[k].scrollIntoView({ block: "nearest" }); }
  }
  items.forEach(function (li) { li.addEventListener("click", function () { p.seek(parseFloat(li.dataset.t)); p.play(); mark(); }); });
  p.addEventListener("timeupdate", mark);
  setTimeout(function () { if (${start} > 0) p.seek(${start}); p.play(); mark(); }, 0);
});
</script>
</body></html>`;
}

/** The full-screen player: a video, and optionally its timed lines under it. */
export function VideoPlayerModal({ src, visible, onClose, caption, startMs, lines }: {
  src: string;
  visible: boolean;
  onClose: () => void;
  caption?: string;
  startMs?: number;
  lines?: PlayerLine[];
}) {
  const Theme = useTheme();
  const insets = useSafeAreaInsets();
  if (!WebViewComp) return null;
  // The player document is ours; any other navigation leaves for the browser.
  const onShouldStart = (req: any) => {
    const url: string = req?.url ?? '';
    if (url === 'about:blank' || url.startsWith('about:') || url.startsWith('data:')) return true;
    if (/^https?:/i.test(url)) void openLink(url);
    return false;
  };
  return (
    <Modal
      visible={visible}
      animationType="fade"
      onRequestClose={onClose}
      supportedOrientations={['portrait', 'landscape-left', 'landscape-right']}
    >
      <RNView style={[styles.modal, lines?.length ? { paddingTop: insets.top + 44 } : null]}>
        {visible && (
          <WebViewComp
            originWhitelist={['*']}
            source={{ html: playerDocument(src, Theme.blue, { startMs, lines }) }}
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
          <TouchableOpacity onPress={onClose} hitSlop={10} accessibilityLabel="Close video" style={styles.close}>
            <FontAwesome name="close" size={16} color="#fff" />
          </TouchableOpacity>
        </RNView>
      </RNView>
    </Modal>
  );
}

/** Whether the app can play a video itself; without the WebView module a
 *  video opens in the browser. */
export const canPlayInApp = !!WebViewComp;

export function InlineVideo({ src, caption, tiled }: { src: string; caption?: string; tiled?: boolean }) {
  const [open, setOpen] = useState(false);
  const onPress = () => (WebViewComp ? setOpen(true) : void openLink(src));
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
      <VideoPlayerModal src={src} visible={open} onClose={() => setOpen(false)} caption={caption} />
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
