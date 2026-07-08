import React, { useMemo, useState } from 'react';
import {
  Linking,
  Modal,
  StyleSheet,
  TouchableOpacity,
  View as RNView,
  Text as RNText,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { copyToClipboard } from '@/lib/clipboard';
import { Theme, CHROME_FONT_CAP } from '@/constants/Theme';
import { DOMPURIFY_SOURCE } from '@/lib/vendor/dompurifySource';

// Inline visual canvas — the mobile twin of web's HtmlSnippet. The agent emits a
// ```cast-canvas fenced block of static HTML/CSS/SVG; we render it in a WebView
// whose document sanitizes the content with a vendored DOMPurify BEFORE it
// touches the DOM (scripts, event handlers, and risky embeds are stripped — the
// same config as web). JavaScript stays enabled ONLY for our own shell script
// (sanitize + height/title report); agent script can never execute because
// sanitized markup is inert and all navigation is blocked.
//
// react-native-webview is a NATIVE module first bundled after some production
// binaries shipped. Requiring it eagerly on such a binary throws during JS
// evaluation (TurboModuleRegistry.getEnforcing) — which on an OTA-updated app
// means a silent rollback loop (see the gesture-handler saga in _layout.tsx).
// Probe the native module without throwing and fall back to a plain code block
// when it's absent; canvases light up automatically on the next native build.
let WebViewComp: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { TurboModuleRegistry, NativeModules } = require('react-native');
  const available = !!(
    TurboModuleRegistry?.get?.('RNCWebViewModule') || NativeModules?.RNCWebViewModule
  );
  if (available) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    WebViewComp = require('react-native-webview').WebView;
  }
} catch {
  WebViewComp = null;
}

// Callers (MarkdownRenderer) check this to fall back to a plain code block on
// binaries without the WebView native module — keeping the fallback at the
// call site avoids a require cycle with the code-block renderer.
export const canvasAvailable = !!WebViewComp;

// Matches web HtmlSnippet's PURIFY_CONFIG.
const PURIFY_CONFIG = JSON.stringify({
  FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base', 'form', 'meta', 'link'],
  FORBID_ATTR: ['ping', 'formaction', 'onclick'],
  ADD_ATTR: ['target'],
});

// --sol-* tokens bridged from the app theme so canvases authored against
// codecast's palette render native-looking, same as web.
function solTokensCss(): string {
  const t = Theme as Record<string, string>;
  const map: Record<string, string> = {
    '--sol-bg': t.bg,
    '--sol-bg-alt': t.bgAlt,
    '--sol-bg-highlight': t.bgHighlight,
    '--sol-card': t.cardBg,
    '--sol-border': t.border,
    '--sol-border-light': t.borderLight,
    '--sol-text': t.text,
    '--sol-text-secondary': t.textSecondary,
    '--sol-text-muted': t.textMuted,
    '--sol-text-dim': t.textDim,
    '--sol-accent': t.accent,
    '--sol-blue': t.blue,
    '--sol-cyan': t.cyan,
    '--sol-green': t.green,
    '--sol-red': t.red,
    '--sol-orange': t.orange,
    '--sol-violet': t.violet,
    '--sol-magenta': t.magenta,
    '--sol-yellow': t.accent,
  };
  return Object.entries(map)
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
}

// The document shell: tokens + base styles, vendored DOMPurify, then our
// injector script. Raw agent HTML rides in as a JSON string literal — it is
// never parsed as markup until DOMPurify has cleaned it.
function buildShell(code: string): string {
  // Escape "<" so a literal "</script>" (or "<!--") inside the agent HTML can't
  // terminate the shell's script block — the HTML parser doesn't know about JS
  // string boundaries.
  const raw = JSON.stringify(code).replace(/</g, '\\u003C');
  return `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<style>
  :root{${solTokensCss()}}
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;background:transparent}
  body{color:var(--sol-text);font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:1.5;padding:12px;overflow-wrap:break-word}
  a{color:var(--sol-blue)}
  img,svg,video{max-width:100%}
  .cast-chart{border:1px dashed var(--sol-border-light);border-radius:6px;padding:14px;color:var(--sol-text-dim);font-size:12px;text-align:center}
</style>
<script>${DOMPURIFY_SOURCE}</script>
</head><body><div id="root"></div>
<script>
(function(){
  var clean = DOMPurify.sanitize(${raw}, ${PURIFY_CONFIG});
  var root = document.getElementById('root');
  root.innerHTML = clean;
  // Charts need Observable Plot (web-only for now); show what they are instead
  // of an empty hole.
  root.querySelectorAll('.cast-chart').forEach(function(el){
    el.textContent = 'chart \\u2014 view on web';
  });
})();
</script></body></html>`;
}

// A message whose ENTIRE body is raw HTML (emitted without the cast-canvas
// fence) — web's looksLikeHtml twin, minus the DOMParser confirmation pass
// (no DOM on RN). Codecast's own structured envelopes (skill/context/image and
// hyphenated custom tags) are excluded by the tag regex.
export function looksLikeHtmlMessage(content: string): boolean {
  const t = content.trim();
  if (t.length < 12 || t[0] !== '<' || !t.endsWith('>')) return false;
  if (/^<(skill|context|image)\b/i.test(t)) return false;
  return /^<(!doctype\s|[a-z][a-z0-9]*[\s/>])/i.test(t);
}

// Cheap JS-side title/excerpt extraction for the inline card (no DOM here).
function extractCanvasTitle(code: string): string | null {
  const explicit = code.match(/data-canvas-title\s*=\s*"([^"]{1,120})"/i)?.[1]?.trim();
  if (explicit) return explicit;
  const heading = code.match(/<h[1-6][^>]*>([\s\S]{1,200}?)<\/h[1-6]>/i)?.[1];
  if (heading) {
    const t = heading.replace(/<[^>]+>/g, '').trim();
    if (t) return t.length > 80 ? t.slice(0, 79) + '…' : t;
  }
  return null;
}

function extractExcerpt(code: string): string {
  const text = code
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 140 ? text.slice(0, 139) + '…' : text;
}

// The message list is an INVERTED FlatList — every cell lives under scaleY(-1)
// transforms, and mounting a WKWebView there blanks the whole list surface
// (WebKit compositing under flipped ancestors). So inline we render a light
// summary card, and the real WebView document only mounts inside the
// fullscreen Modal, outside the transformed hierarchy. That also keeps the
// virtualized list cheap when a conversation holds many canvases.
export function CastCanvas({ code }: { code: string }) {
  const [fullscreen, setFullscreen] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const insets = useSafeAreaInsets();

  const title = useMemo(() => extractCanvasTitle(code), [code]);
  const excerpt = useMemo(() => extractExcerpt(code), [code]);
  // Build the document only when the modal opens.
  const shell = useMemo(() => (fullscreen ? buildShell(code) : null), [fullscreen, code]);

  if (!code.trim() || !WebViewComp) return null;

  const handleCopy = () => {
    copyToClipboard(code);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Initial data/blank load is ours; anything else (link taps) opens
  // externally and never navigates the canvas.
  const onShouldStart = (req: any) => {
    const url: string = req?.url ?? '';
    if (url === 'about:blank' || url.startsWith('data:') || url.startsWith('about:')) return true;
    if (/^https?:/i.test(url)) Linking.openURL(url).catch(() => {});
    return false;
  };

  return (
    <>
      <TouchableOpacity style={styles.card} onPress={() => setFullscreen(true)} activeOpacity={0.7}>
        <RNView style={styles.cardIconWrap}>
          <FontAwesome name="object-group" size={13} color={Theme.violet} />
        </RNView>
        <RNView style={{ flex: 1, minWidth: 0 }}>
          <RNText style={styles.cardTitle} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>
            {title ?? 'Canvas'}
          </RNText>
          {!!excerpt && (
            <RNText style={styles.cardExcerpt} numberOfLines={2} maxFontSizeMultiplier={CHROME_FONT_CAP}>
              {excerpt}
            </RNText>
          )}
        </RNView>
        <FontAwesome name="expand" size={12} color={Theme.textDim} />
      </TouchableOpacity>

      <Modal
        visible={fullscreen}
        animationType="slide"
        onRequestClose={() => setFullscreen(false)}
        supportedOrientations={['portrait', 'landscape-left', 'landscape-right']}
      >
        <RNView style={[styles.fullscreenWrap, { paddingTop: insets.top }]}>
          <RNView style={styles.fullscreenHeader}>
            <RNText style={styles.headerTitle} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>
              {title ?? 'Canvas'}
            </RNText>
            <RNView style={styles.headerActions}>
              <TouchableOpacity onPress={() => setShowSource((v) => !v)} hitSlop={8} activeOpacity={0.6}>
                <FontAwesome name={showSource ? 'eye' : 'code'} size={13} color={Theme.textDim} />
              </TouchableOpacity>
              <TouchableOpacity onPress={handleCopy} hitSlop={8} activeOpacity={0.6}>
                {copied ? (
                  <FontAwesome name="check" size={14} color={Theme.green} />
                ) : (
                  <FontAwesome name="clipboard" size={14} color={Theme.textDim} />
                )}
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setFullscreen(false)} hitSlop={8} activeOpacity={0.6}>
                <FontAwesome name="close" size={16} color={Theme.textMuted} />
              </TouchableOpacity>
            </RNView>
          </RNView>
          {showSource ? (
            <RNView style={styles.sourceWrap}>
              <RNText style={styles.sourceText} selectable>{code}</RNText>
            </RNView>
          ) : (
            shell != null && (
              <WebViewComp
                originWhitelist={['about:blank']}
                source={{ html: shell }}
                onShouldStartLoadWithRequest={onShouldStart}
                javaScriptEnabled={true}
                domStorageEnabled={false}
                allowsInlineMediaPlayback={false}
                setSupportMultipleWindows={false}
                style={{ backgroundColor: 'transparent' }}
              />
            )
          )}
        </RNView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginVertical: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.violet + '40',
    borderRadius: 6,
    backgroundColor: Theme.violet + '0d',
  },
  cardIconWrap: {
    width: 26,
    height: 26,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Theme.violet + '1a',
  },
  cardTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: Theme.text,
  },
  cardExcerpt: {
    fontSize: 11,
    color: Theme.textMuted,
    marginTop: 1,
  },
  headerTitle: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    color: Theme.textMuted,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  sourceWrap: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  sourceText: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    lineHeight: 16,
    color: Theme.textSecondary,
  },
  fullscreenWrap: {
    flex: 1,
    backgroundColor: Theme.bg,
  },
  fullscreenHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
  },
});
