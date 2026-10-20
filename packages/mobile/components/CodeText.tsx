import React, { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Text as RNText } from '@/components/Themed';
import { copyToClipboard } from '@/lib/clipboard';
import { openLink } from '@/lib/links';
// The URL vocabulary is shared with the deep-link router and the plain-text
// surfaces (lib/linkRoutes) — markdown prose, bash output and a tapped link all
// recognise and normalise the same thing.
import { URL_SOURCE, urlPattern, trimUrlTail, shortenUrl } from '@/lib/linkRoutes';
import { Theme, themedStyles } from '@/constants/Theme';
import { ansiSpans } from '@codecast/web/lib/ansi';

// Links and highlighted code, shared by the markdown renderer, diffs and the
// plain-text tool output surfaces.

/**
 * A tapped link. Every link in the app is this component, so they all open the
 * same way (in-app for codecast objects, in-app browser otherwise) and all
 * carry the same long-press-to-copy affordance.
 */
export function LinkText({ url, label, isUser, style }: { url: string; label?: React.ReactNode; isUser?: boolean; style?: any }) {
  return (
    <RNText
      style={style ?? (isUser ? styles.linkTextUser : styles.linkText)}
      onPress={() => { void openLink(url); }}
      onLongPress={() => {
        copyToClipboard(url);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }}
    >
      {label ?? shortenUrl(url)}
    </RNText>
  );
}

/**
 * Plain text with its URLs made tappable — for the surfaces that are NOT
 * markdown (bash output, raw tool results, the verbatim prompt view). Those
 * used to render a `cast publish` link or a PR URL as dead text.
 */
export function linkifyPlainText(text: string, keyPrefix = '', isUser = false): React.ReactNode[] {
  const pattern = urlPattern();
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) out.push(<RNText key={`${keyPrefix}t${key++}`}>{text.slice(last, m.index)}</RNText>);
    const url = trimUrlTail(m[0]);
    out.push(<LinkText key={`${keyPrefix}u${key++}`} url={url} label={url} isUser={isUser} />);
    const tail = m[0].slice(url.length);
    if (tail) out.push(<RNText key={`${keyPrefix}p${key++}`}>{tail}</RNText>);
    last = m.index + m[0].length;
  }
  if (last === 0) return [text];
  if (last < text.length) out.push(<RNText key={`${keyPrefix}t${key++}`}>{text.slice(last)}</RNText>);
  return out;
}

// `link: true` spans are rendered pressable instead of merely colored. The URL
// pattern comes first so it wins the overlap merge — a URL contains `//`, `:`
// and digits, each of which another rule would otherwise claim a piece of.
const SYNTAX_PATTERNS: Array<{ regex: RegExp; color: string; link?: boolean }> = [
  { regex: new RegExp(URL_SOURCE, 'g'), color: Theme.blue, link: true },
  { regex: /\/\/.*$/gm, color: '#586e75' },
  { regex: /\/\*[\s\S]*?\*\//gm, color: '#586e75' },
  { regex: /#.*$/gm, color: '#586e75' },
  { regex: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, color: '#2aa198' },
  { regex: /\b(import|export|from|default|return|if|else|for|while|do|switch|case|break|continue|function|const|let|var|class|extends|new|this|try|catch|finally|throw|async|await|yield|typeof|instanceof|in|of|void|delete|true|false|null|undefined|enum|interface|type|implements|abstract|static|public|private|protected|readonly|override|declare|namespace|module|require|super|as|is)\b/g, color: '#859900' },
  { regex: /\b\d+(\.\d+)?\b/g, color: '#d33682' },
  { regex: /[{}()[\]]/g, color: '#657b83' },
  { regex: /=&gt;|=>|===|!==|==|!=|<=|>=|&&|\|\||[+\-*/%=<>!&|^~?:]/g, color: '#cb4b16' },
];

type CodeSpan = { text: string; color?: string; link?: boolean };

function highlightSyntax(code: string): CodeSpan[] {
  const spans: Array<{ start: number; end: number; color: string; link?: boolean }> = [];
  for (const { regex, color, link } of SYNTAX_PATTERNS) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(code)) !== null) {
      spans.push({ start: m.index, end: m.index + m[0].length, color, link });
    }
  }
  // Stable by start, so an equal-start tie keeps pattern order and the URL rule
  // (listed first) beats the rules that would carve it up.
  spans.sort((a, b) => a.start - b.start);
  const merged: typeof spans = [];
  for (const s of spans) {
    if (merged.length && s.start < merged[merged.length - 1].end) continue;
    merged.push(s);
  }
  const result: CodeSpan[] = [];
  let pos = 0;
  for (const s of merged) {
    if (s.start > pos) result.push({ text: code.slice(pos, s.start) });
    result.push({ text: code.slice(s.start, s.end), color: s.color, link: s.link });
    pos = s.end;
  }
  if (pos < code.length) result.push({ text: code.slice(pos) });
  return result;
}

export function HighlightedCodeText({ content, style }: { content: string; style: any }) {
  const parts = useMemo(() => highlightSyntax(content), [content]);
  return (
    <RNText style={style} selectable>
      {parts.map((p, i) => {
        if (p.link) {
          // A URL printed by a command — `cast publish`, a PR link, a dev
          // server — is the one thing in a code block a reader wants to follow.
          const url = trimUrlTail(p.text);
          return (
            <RNText key={i}>
              <LinkText url={url} label={url} style={{ color: p.color, textDecorationLine: 'underline' }} />
              {p.text.slice(url.length)}
            </RNText>
          );
        }
        return p.color ? <RNText key={i} style={{ color: p.color }}>{p.text}</RNText> : p.text;
      })}
    </RNText>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  linkText: {
    color: Theme.cyan,
    textDecorationLine: 'underline',
  },
  linkTextUser: {
    color: Theme.userBubble,
    textDecorationLine: 'underline',
  },
}));

/** Command output with its terminal colors, and its URLs tappable. */
export function AnsiText({ text, style }: { text: string; style: any }) {
  const spans = useMemo(() => ansiSpans(text), [text]);
  return (
    <RNText style={style} selectable>
      {spans.map((sp, i) => {
        const body = linkifyPlainText(sp.text, `a${i}`);
        return sp.color || sp.bold
          ? <RNText key={i} style={{ color: sp.color, fontWeight: sp.bold ? '700' : undefined }}>{body}</RNText>
          : <React.Fragment key={i}>{body}</React.Fragment>;
      })}
    </RNText>
  );
}
