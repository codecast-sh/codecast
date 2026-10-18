import React, { useContext, useState, useMemo } from 'react';
import {
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  View as RNView,
  Image as RNImage,
  Modal,
  useWindowDimensions,
} from 'react-native';
import { isTrustedImageSrc } from '@/lib/convex';
import { Text as RNText } from '@/components/Themed';
import * as Haptics from 'expo-haptics';
import { copyToClipboard } from '@/lib/clipboard';
import { openLink } from '@/lib/links';
// The URL vocabulary is shared with the deep-link router and the plain-text
// surfaces (lib/linkRoutes) — markdown prose, bash output and a tapped link all
// recognise and normalise the same thing.
import { URL_SOURCE, urlPattern, trimUrlTail, shortenUrl, isMentionStart } from '@/lib/linkRoutes';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Theme, themedStyles, useTheme } from '@/constants/Theme';
import { CastCanvas, canvasAvailable } from './CastCanvas';
import { EntityPill, isEntityId } from './EntityPill';
import { SearchHighlightContext, markedRuns } from './search/highlight';
import { parseMarkdown, plainText, planTable } from '@/lib/markdown';
import type { Nodes, Paragraph, Image, List, Table } from 'mdast';
import { parseEntityUrl, BARE_ID_AFTER, BARE_ID_BEFORE, BARE_ID_SOURCE, MENTION_ID_SOURCE } from '@codecast/shared/entities';
// Canonical "★ Insight ─────" parser shared with web (pure string/regex module,
// Hermes-safe). Mobile used to carry its own narrower copy in session/[id].tsx
// which silently missed most real-world insight forms — one parser, one truth.
import { parseInsightBlocks } from '@codecast/web/components/insightBlocks';
import { replaceShortcodes } from '@codecast/shared/chat';

/**
 * A tapped link. Every link in the app is this component, so they all open the
 * same way (in-app for codecast objects, in-app browser otherwise) and all
 * carry the same long-press-to-copy affordance.
 */
export function LinkText({ url, label, isUser, style }: { url: string; label?: React.ReactNode; isUser?: boolean; style?: any }) {
  const Theme = useTheme();
  return (
    <RNText
      style={style ?? (isUser ? mdStyles.linkTextUser : mdStyles.linkText)}
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

// Trailing "<name> <entity-id>" inside an @[…] mention — same shape web's
// MENTION_RE extracts (the id renders as a pill; the name is its fallback).
// Both id vocabularies come from @codecast/shared/entities: mobile used to keep
// its own copies here, and they drifted (no "tr-" triggers, plus a "doc-…" form
// that never existed).
const MENTION_ENTITY_RE = new RegExp(`^(.*?)\\s*\\b(${MENTION_ID_SOURCE})$`, 'i');

// What one markdown body renders under: the text style of the current run (a
// quote adds italics, a checked task strikes through), who wrote it, and the
// active search's words.
type MdCtx = {
  baseStyle: any;
  isUser: boolean;
  knownMentionHandles?: Set<string>;
  found?: string;
  selectable: boolean;
  plainTextFences: boolean;
  listDepth: number;
};

// The references a writer did not mark up, inside a run of plain text: bare
// URLs, @mentions and entity ids. Emphasis, code and links come from the
// parser (lib/markdown), so this never reads markdown syntax itself.
const TEXT_REF_SOURCE =
  `(${URL_SOURCE})|@\\[([^\\]]+)\\]|@(\\w+)`
  // Bounded as the shared scanner is, so "5-in-1" stays prose.
  + `|${BARE_ID_BEFORE}(${BARE_ID_SOURCE})${BARE_ID_AFTER}`;

function renderTextRefs(text: string, ctx: MdCtx, kp: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const plain = (s: string) => out.push(markedRuns(s, ctx.found, `${kp}h${out.length}-`));
  const re = new RegExp(TEXT_REF_SOURCE, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) plain(text.slice(last, m.index));
    const k = `${kp}r${m.index}`;
    if (m[1]) {
      // Bare URL. Sentence punctuation glued to the end is prose, so it is
      // pushed back as plain text instead of ending up inside the target.
      const url = trimUrlTail(m[1]);
      const entityRef = parseEntityUrl(url);
      out.push(entityRef
        ? <EntityPill key={k} type={entityRef.type} id={entityRef.id} />
        : <LinkText key={k} url={url} isUser={ctx.isUser} />);
      const tail = m[1].slice(url.length);
      if (tail) plain(tail);
    } else if (m[2]) {
      // @[Bracket mention] syntax — a trailing entity id ("@[Title jx7c6zk]")
      // renders as that object's pill; a plain name stays a mention chip.
      const name = m[2];
      const em = name.match(MENTION_ENTITY_RE);
      if (em && em[2]) {
        const entityId = em[2];
        // If the id resolves to nothing, fall back to the mention chip so
        // "@[Title <staleId>]" still reads as a mention, not a bare id.
        const chip = <RNText style={mdStyles.mentionPill}>@{em[1] || name}</RNText>;
        out.push(entityId.toLowerCase().startsWith('doc:')
          ? <EntityPill key={k} type="doc" id={entityId.slice(4)} />
          : <EntityPill key={k} shortId={entityId} fallback={chip} />);
      } else {
        out.push(<RNText key={k} style={mdStyles.mentionPill}>@{name}</RNText>);
      }
    } else if (m[3]) {
      // @word mention. When the caller supplies the resolvable-handle set
      // (chat does — the same vocabulary the server notifies on), an unknown
      // @word stays plain text: a chip that lights up but notifies nobody is
      // worse than no chip. Callers that pass nothing keep the liberal
      // highlight (session transcripts, where @words are prose). An address
      // (the "@github" in a git remote) is never a mention.
      const word = m[3];
      if (!isMentionStart(text, m.index) || (ctx.knownMentionHandles && !ctx.knownMentionHandles.has(word.toLowerCase()))) {
        plain(`@${word}`);
      } else {
        out.push(<RNText key={k} style={mdStyles.mentionPill}>@{word}</RNText>);
      }
    } else if (m[4]) {
      // Entity ID (jx… session, ct-/pl- task/plan, doc reference)
      const id = m[4];
      const lower = id.toLowerCase();
      out.push(lower.startsWith('doc:')
        ? <EntityPill key={k} type="doc" id={id.slice(4)} />
        : lower.startsWith('doc-')
          ? <EntityPill key={k} type="doc" id={id} />
          : <EntityPill key={k} shortId={id} />);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) plain(text.slice(last));
  return out;
}

const BR_RE = /^<br\s*\/?>$/i;

function renderInline(nodes: readonly Nodes[], ctx: MdCtx, kp: string): React.ReactNode[] {
  return nodes.map((n, i) => renderInlineNode(n, ctx, `${kp}.${i}`));
}

function renderInlineNode(node: Nodes, ctx: MdCtx, k: string): React.ReactNode {
  switch (node.type) {
    case 'text':
      return <React.Fragment key={k}>{renderTextRefs(replaceShortcodes(node.value), ctx, k)}</React.Fragment>;
    case 'strong':
      return <RNText key={k} style={{ fontWeight: '700' }}>{renderInline(node.children, ctx, k)}</RNText>;
    case 'emphasis':
      return <RNText key={k} style={{ fontStyle: 'italic' }}>{renderInline(node.children, ctx, k)}</RNText>;
    case 'delete':
      return <RNText key={k} style={{ textDecorationLine: 'line-through', color: Theme.textMuted0 }}>{renderInline(node.children, ctx, k)}</RNText>;
    case 'break':
      return '\n';
    case 'inlineCode': {
      const style = ctx.isUser ? mdStyles.inlineCodeUser : mdStyles.inlineCode;
      // `jx…`/`ct-…` in backticks is an object reference, not code — pill it
      // (web's EntityAwareCode does the same). The fallback keeps a non-entity
      // Convex-shaped string (message id, hash) rendered as inline code.
      if (isEntityId(node.value)) {
        return <EntityPill key={k} shortId={node.value} fallback={<RNText style={style}>{node.value}</RNText>} />;
      }
      return <RNText key={k} style={style}>{markedRuns(node.value, ctx.found, `${k}h`)}</RNText>;
    }
    case 'link': {
      // A codecast object URL becomes a rich in-app pill, not an external link
      // (web's EntityAwareLink parity).
      const entityRef = parseEntityUrl(node.url);
      if (entityRef) return <EntityPill key={k} type={entityRef.type} id={entityRef.id} />;
      // An autolink (<https://…>) reads as its shortened URL.
      const label = plainText(node) === node.url ? undefined : renderInline(node.children, ctx, k);
      return <LinkText key={k} url={node.url} label={label} isUser={ctx.isUser} />;
    }
    case 'image':
      // Inline among text, or from a source that is not ours: a link, never an
      // auto-fetch. Trusted image-only paragraphs draw as images (renderBlock).
      return <LinkText key={k} url={node.url} label={node.alt || node.url} isUser={ctx.isUser} />;
    case 'html':
      // Mobile shows a literal tag rather than dropping the words around it.
      return BR_RE.test(node.value.trim()) ? '\n' : node.value;
    default:
      if ('children' in node) return <React.Fragment key={k}>{renderInline(node.children as Nodes[], ctx, k)}</React.Fragment>;
      return 'value' in node && typeof node.value === 'string' ? node.value : null;
  }
}

export function CodeBlockFullscreen({ content, language, visible, onClose }: { content: string; language: string; visible: boolean; onClose: () => void }) {
  const Theme = useTheme();
  const [copied, setCopied] = useState(false);
  const lines = content.split('\n');
  if (!visible) return null;
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <RNView style={{ flex: 1, backgroundColor: '#002b36' }}>
        <RNView style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 60, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.1)' }}>
          <RNView style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <RNText style={{ fontSize: 12, color: '#93a1a1', fontFamily: 'SpaceMono', fontWeight: '500' }}>{language}</RNText>
            <RNText style={{ fontSize: 10, color: Theme.textDim }}>{lines.length} lines</RNText>
          </RNView>
          <RNView style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <TouchableOpacity onPress={() => { copyToClipboard(content); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setCopied(true); setTimeout(() => setCopied(false), 1500); }} activeOpacity={0.6}>
              {copied ? <FontAwesome name="check" size={14} color={Theme.green} /> : <FontAwesome name="clipboard" size={14} color="#657b83" />}
            </TouchableOpacity>
            <TouchableOpacity onPress={onClose} activeOpacity={0.6}>
              <FontAwesome name="close" size={16} color="#93a1a1" />
            </TouchableOpacity>
          </RNView>
        </RNView>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator nestedScrollEnabled>
            <RNView style={{ flexDirection: 'row' }}>
              <RNView style={mdStyles.lineNumberGutter}>
                {lines.map((_, i) => (
                  <RNText key={i} style={[mdStyles.lineNumber, { lineHeight: 20, color: '#657b83' }]}>{i + 1}</RNText>
                ))}
              </RNView>
              <HighlightedCodeText content={content} style={[mdStyles.codeText, { lineHeight: 20 }]} />
            </RNView>
          </ScrollView>
        </ScrollView>
      </RNView>
    </Modal>
  );
}

const CODE_BLOCK_PREVIEW_LINES = 12;

export function CodeBlockWithCopy({ content, language }: { content: string; language: string }) {
  const Theme = useTheme();
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const handleCopy = () => {
    copyToClipboard(content);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const lines = content.split('\n');
  const showLineNumbers = lines.length > 3;
  const isTall = lines.length > 15;
  const displayLines = isTall ? lines.slice(0, CODE_BLOCK_PREVIEW_LINES) : lines;
  return (
    <RNView style={{ marginVertical: 2 }}>
      {/* Code WRAPS instead of scrolling horizontally so long lines stay readable
          on a phone rather than clipping off-screen. Each line is its own row: the
          line number sits at the top of a wrapped line (standard soft-wrap layout)
          and the code fills the remaining width. Dropping the nested horizontal
          ScrollView also removes the phantom vertical band it reserved in the list. */}
      <RNView style={{ backgroundColor: Theme.bgAlt, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight, overflow: 'hidden', padding: 6 }}>
        {displayLines.map((line, i) => (
          <RNView key={i} style={{ flexDirection: 'row' }}>
            {showLineNumbers && (
              <RNText style={{ fontSize: 10, fontFamily: 'SpaceMono', lineHeight: 16, color: Theme.textDim, textAlign: 'right', minWidth: 22, marginRight: 8 }}>{i + 1}</RNText>
            )}
            <HighlightedCodeText content={line || ' '} style={{ flex: 1, fontSize: 11, fontFamily: 'SpaceMono', lineHeight: 16, color: Theme.textSecondary }} />
          </RNView>
        ))}
      </RNView>
      <RNView style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 }}>
        {isTall && (
          <TouchableOpacity onPress={() => setFullscreen(true)} activeOpacity={0.6} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <FontAwesome name="expand" size={10} color={Theme.textDim} />
            <RNText style={{ fontSize: 9, color: Theme.textDim }}>{lines.length} lines</RNText>
          </TouchableOpacity>
        )}
        {!isTall && (
          <TouchableOpacity onPress={() => setFullscreen(true)} activeOpacity={0.6} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <FontAwesome name="expand" size={10} color={Theme.textDim} />
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={handleCopy} activeOpacity={0.6} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          {copied ? <FontAwesome name="check" size={10} color={Theme.green} /> : <FontAwesome name="clipboard" size={11} color={Theme.textDim} />}
        </TouchableOpacity>
      </RNView>
      <CodeBlockFullscreen content={content} language={language} visible={fullscreen} onClose={() => setFullscreen(false)} />
    </RNView>
  );
}

function MarkdownImage({ src, alt, tiled }: { src: string; alt: string; tiled?: boolean }) {
  const Theme = useTheme();
  const [full, setFull] = useState(false);
  const [failed, setFailed] = useState(false);
  const caption = alt.trim() && !/^(image|img)$/i.test(alt.trim()) ? alt.trim() : undefined;
  if (failed) return null;
  return (
    <RNView style={tiled ? mdStyles.imageTile : undefined}>
      <TouchableOpacity onPress={() => setFull(true)} activeOpacity={0.85}>
        <RNImage
          source={{ uri: src }}
          style={[mdStyles.image, tiled && mdStyles.imageTiled]}
          resizeMode="cover"
          accessibilityLabel={alt}
          onError={() => setFailed(true)}
        />
      </TouchableOpacity>
      {caption ? <RNText style={mdStyles.imageCaption}>{caption}</RNText> : null}
      <Modal visible={full} transparent animationType="fade" onRequestClose={() => setFull(false)}>
        <TouchableOpacity style={mdStyles.imageModal} activeOpacity={1} onPress={() => setFull(false)}>
          <RNImage source={{ uri: src }} style={mdStyles.imageFull} resizeMode="contain" />
        </TouchableOpacity>
      </Modal>
    </RNView>
  );
}

// A paragraph of nothing but images, every one from a trusted source
// (storage-origin `cast image` uploads, pasted transcript images): web draws
// these inline with the alt as a caption, side by side when adjacent. A mixed
// or untrusted paragraph keeps text semantics, where an image is a link.
function trustedImages(p: Paragraph): Image[] | null {
  const imgs: Image[] = [];
  for (const c of p.children) {
    if (c.type === 'image') imgs.push(c);
    else if (c.type === 'break' || (c.type === 'text' && !c.value.trim())) continue;
    else return null;
  }
  return imgs.length > 0 && imgs.every((img) => isTrustedImageSrc(img.url)) ? imgs : null;
}

// Box-drawing/em-dash rule runs (optionally `code`/**bold**-wrapped) — the
// residue of insight fences the block parser deliberately doesn't match (e.g.
// the open-ended titled form). A clean rule beats a wrapping line of ─ glyphs.
const RULE_RESIDUE_RE = /^[─━═—–]{3,}$/;
const HEADING_SIZES = [18, 16, 15, 14, 13, 13];
const BLOCK_GAP = 6;

function renderBlocks(nodes: readonly Nodes[], ctx: MdCtx, kp: string, gap = BLOCK_GAP): React.ReactNode {
  const out = nodes.map((n, i) => renderBlock(n, ctx, `${kp}.${i}`, i === 0)).filter((el) => el != null);
  if (out.length === 1) return out[0];
  return <RNView style={{ gap }}>{out}</RNView>;
}

function renderBlock(node: Nodes, ctx: MdCtx, k: string, first: boolean): React.ReactNode {
  switch (node.type) {
    case 'paragraph': {
      const imgs = trustedImages(node);
      if (imgs) {
        return imgs.length > 1 ? (
          <RNView key={k} style={mdStyles.imageRow}>
            {imgs.map((img, j) => <MarkdownImage key={j} src={img.url} alt={img.alt ?? ''} tiled />)}
          </RNView>
        ) : <MarkdownImage key={k} src={imgs[0].url} alt={imgs[0].alt ?? ''} />;
      }
      if (RULE_RESIDUE_RE.test(plainText(node).trim())) return <RNView key={k} style={mdStyles.horizontalRule} />;
      return <RNText key={k} style={ctx.baseStyle} selectable={ctx.selectable}>{renderInline(node.children, ctx, k)}</RNText>;
    }
    case 'heading': {
      // A heading never sets smaller than the text around it: a reply set at
      // a reading size (hosted mode's 17px letter) keeps its headings at body
      // size, as the web's hosted replies do.
      const fontSize = Math.max(HEADING_SIZES[node.depth - 1], StyleSheet.flatten(ctx.baseStyle)?.fontSize ?? 0);
      return (
        <RNText key={k} style={[ctx.baseStyle, { fontSize, fontWeight: '700', marginTop: first ? 0 : 6 }]} selectable={ctx.selectable}>
          {renderInline(node.children, ctx, k)}
        </RNText>
      );
    }
    case 'list':
      return <MarkdownList key={k} node={node} ctx={ctx} k={k} />;
    case 'blockquote':
      return (
        <RNView key={k} style={ctx.isUser ? mdStyles.blockquoteUser : mdStyles.blockquote}>
          {renderBlocks(node.children, { ...ctx, baseStyle: [ctx.baseStyle, mdStyles.blockquoteText] }, k)}
        </RNView>
      );
    case 'code': {
      const language = node.lang || 'plaintext';
      // Keep the fence name in sync with web's HtmlSnippet.CANVAS_FENCE
      // ("cast-canvas") — importing the web module would drag DOM-only code
      // into the Hermes bundle. Binaries without the WebView native module
      // fall through to the plain code block.
      if (language === 'cast-canvas' && canvasAvailable) return <CastCanvas key={k} code={node.value} />;
      // Words quoted exactly (an approval's draft): plain lines, with no
      // highlighting, expand or copy, because they are not code.
      if (ctx.plainTextFences && language === 'text') {
        return <RNText key={k} selectable={ctx.selectable} style={ctx.baseStyle}>{node.value}</RNText>;
      }
      return <CodeBlockWithCopy key={k} content={node.value} language={language} />;
    }
    case 'thematicBreak':
      return <RNView key={k} style={mdStyles.horizontalRule} />;
    case 'table':
      return <MarkdownTable key={k} node={node} ctx={ctx} k={k} />;
    case 'html':
      // A literal tag block stays visible: it is usually pasted code or
      // markup the writer meant to show.
      return <RNText key={k} style={ctx.baseStyle} selectable={ctx.selectable}>{node.value}</RNText>;
    case 'definition':
      return null;
    default:
      return 'children' in node ? <RNView key={k}>{renderBlocks(node.children as Nodes[], ctx, k)}</RNView> : null;
  }
}

const BULLETS = ['•', '◦', '▪'];

function MarkdownList({ node, ctx, k }: { node: List; ctx: MdCtx; k: string }) {
  const start = node.start ?? 1;
  const markers = node.children.map((item, j) =>
    item.checked != null ? (item.checked ? '☑' : '☐')
      : node.ordered ? `${start + j}.` : BULLETS[ctx.listDepth % BULLETS.length]);
  // The marker column is as wide as its widest marker, so "9." and "10."
  // items start their text at the same place.
  const fontSize = StyleSheet.flatten(ctx.baseStyle)?.fontSize ?? 14;
  const markerWidth = Math.max(16, Math.max(...markers.map((m) => m.length)) * fontSize * 0.6 + 6);
  const gap = node.spread ? BLOCK_GAP : 3;
  return (
    <RNView style={[mdStyles.listContainer, { gap }]}>
      {node.children.map((item, j) => {
        const itemCtx = {
          ...ctx,
          listDepth: ctx.listDepth + 1,
          baseStyle: item.checked === true ? [ctx.baseStyle, { textDecorationLine: 'line-through', color: Theme.textMuted0 }] : ctx.baseStyle,
        };
        return (
          <RNView key={j} style={mdStyles.listItem}>
            <RNText style={[ctx.baseStyle, mdStyles.listBullet, { width: markerWidth }]}>{markers[j]}</RNText>
            <RNView style={{ flex: 1 }}>{renderBlocks(item.children, itemCtx, `${k}.${j}`, gap)}</RNView>
          </RNView>
        );
      })}
    </RNView>
  );
}

// Tables are laid out for the width they get (lib/markdown planTable): a grid
// when it fits or wraps cleanly, a sideways-scrolling grid for short data
// cells, and one card per row when several columns of prose would otherwise
// be cut off. Cells are measured in characters, which is exact in the app's
// monospace face.
const TABLE_CELL_PAD_X = 8;
const MONO_ADVANCE = 0.6;
const CARD_INLINE_LABEL_CHARS = 14;

function MarkdownTable({ node, ctx, k }: { node: Table; ctx: MdCtx; k: string }) {
  const Theme = useTheme();
  const screen = useWindowDimensions();
  const [measured, setMeasured] = useState<number | null>(null);
  const base = StyleSheet.flatten(ctx.baseStyle) ?? {};
  const fontSize = Math.min(15, Math.max(12, Math.round((base.fontSize ?? 14) * 0.9)));
  const lineHeight = Math.round(fontSize * 1.45);
  const textStyle = [ctx.baseStyle, { fontSize, lineHeight }];
  const labelStyle = [ctx.baseStyle, { fontSize: fontSize - 1, lineHeight, color: Theme.textMuted, fontStyle: 'normal' as const, textDecorationLine: 'none' as const }];
  const rows = node.children;
  const cols = rows[0]?.children.length ?? 0;
  const cells = useMemo(() => rows.map((r) => Array.from({ length: cols }, (_, c) => (r.children[c] ? plainText(r.children[c]) : ''))), [rows, cols]);
  // Until the first layout pass reports the real width, assume the screen
  // minus a message's usual inset; the hairline border takes the 2 points.
  const avail = (measured ?? screen.width - 48) - 2;
  const plan = useMemo(() => planTable(cells, avail, fontSize * MONO_ADVANCE, TABLE_CELL_PAD_X), [cells, avail, fontSize]);
  const cell = (ri: number, ci: number) => {
    const c = rows[ri].children[ci];
    return c ? renderInline(c.children, ctx, `${k}.${ri}.${ci}`) : null;
  };

  let body: React.ReactNode;
  if (plan.kind === 'grid') {
    const grid = (
      <RNView style={mdStyles.tableBox}>
        {rows.map((row, ri) => (
          <RNView
            key={ri}
            style={[
              mdStyles.tableRow,
              ri === 0 ? mdStyles.tableHeaderRow : ri % 2 === 0 && mdStyles.tableRowAlt,
              ri < rows.length - 1 && mdStyles.tableRowDivider,
            ]}
          >
            {Array.from({ length: cols }, (_, ci) => (
              <RNView key={ci} style={[mdStyles.tableCell, { width: plan.widths[ci] }, ci < cols - 1 && mdStyles.tableCellDivider]}>
                <RNText
                  style={[textStyle, ri === 0 && { fontWeight: '600' }, node.align?.[ci] ? { textAlign: node.align[ci]! } : null]}
                  selectable={ctx.selectable}
                >
                  {cell(ri, ci)}
                </RNText>
              </RNView>
            ))}
          </RNView>
        ))}
      </RNView>
    );
    // The grid claims its own touches: a transcript row is a long-press
    // Pressable, and on iOS that responder otherwise wins the drag and the
    // table never scrolls.
    body = plan.scroll ? (
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator style={mdStyles.hScroll}>
        <RNView onStartShouldSetResponder={() => true}>{grid}</RNView>
      </ScrollView>
    ) : grid;
  } else {
    const labels = cells[0] ?? [];
    // Short headers sit in a column beside their values (a definition list);
    // a long one goes above its value so the value keeps the full width.
    const inlineLabels = labels.slice(1).every((l) => l.length <= CARD_INLINE_LABEL_CHARS);
    const labelWidth = Math.ceil(Math.max(1, ...labels.slice(1).map((l) => l.length)) * (fontSize - 1) * MONO_ADVANCE) + 12;
    body = (
      <RNView style={mdStyles.tableBox}>
        {rows.slice(1).map((_, bi) => {
          const ri = bi + 1;
          return (
            <RNView key={ri} style={[mdStyles.tableCard, bi > 0 && mdStyles.tableCardDivider]}>
              {cells[ri][0] ? <RNText style={[textStyle, { fontWeight: '700' }]} selectable={ctx.selectable}>{cell(ri, 0)}</RNText> : null}
              {Array.from({ length: cols - 1 }, (_, i) => i + 1).filter((ci) => cells[ri][ci].trim()).map((ci) => (
                <RNView key={ci} style={inlineLabels ? mdStyles.tableField : undefined}>
                  <RNText style={[labelStyle, inlineLabels && { width: labelWidth }]}>{cell(0, ci)}</RNText>
                  <RNText style={[textStyle, inlineLabels && { flex: 1 }]} selectable={ctx.selectable}>{cell(ri, ci)}</RNText>
                </RNView>
              ))}
            </RNView>
          );
        })}
      </RNView>
    );
  }
  return (
    <RNView onLayout={(e) => setMeasured(Math.round(e.nativeEvent.layout.width))}>
      {body}
    </RNView>
  );
}

// The parsed body as native blocks. Internal: MarkdownContent wraps this with
// insight-block extraction; InsightCard bodies reuse it.
function MarkdownBlocks({ text, baseStyle, isUser, knownMentionHandles, selectable = true, plainTextFences = false }: { text: string; baseStyle: any; isUser: boolean; knownMentionHandles?: Set<string>; selectable?: boolean; plainTextFences?: boolean }) {
  // Under a search (components/search/highlight), every text run marks the
  // words found; pills and links pass through.
  const found = useContext(SearchHighlightContext);
  const tree = useMemo(() => parseMarkdown(text), [text]);
  return <>{renderBlocks(tree.children, { baseStyle, isUser, knownMentionHandles, found, selectable, plainTextFences, listDepth: 0 }, 'b')}</>;
}

// "★ Insight ─────" callout — mirrors web's InsightCard (ConversationView):
// violet-tinted card, star + uppercase label header, markdown body.
function InsightCard({ label, content, baseStyle, knownMentionHandles }: { label: string; content: string; baseStyle: any; knownMentionHandles?: Set<string> }) {
  const Theme = useTheme();
  return (
    <RNView style={mdStyles.insightCard}>
      <RNView style={mdStyles.insightHeader}>
        <FontAwesome name="star" size={11} color={Theme.violet} />
        <RNText style={mdStyles.insightLabel}>{label}</RNText>
      </RNView>
      <RNView style={mdStyles.insightBody}>
        <MarkdownBlocks text={content} baseStyle={baseStyle} isUser={false} knownMentionHandles={knownMentionHandles} />
      </RNView>
    </RNView>
  );
}

/** `plainTextFences` draws a fence marked `text` as plain lines: the shape an
 *  approval's draft arrives in (@platform/assistant approvalContext quotes
 *  long text exactly, in a fence so nothing in it renders as markdown). */
export function MarkdownContent({ text, baseStyle, isUser = false, knownMentionHandles, selectable = true, plainTextFences = false }: { text: string; baseStyle: any; isUser?: boolean; knownMentionHandles?: Set<string>; selectable?: boolean; plainTextFences?: boolean }) {
  // Insight extraction runs on every assistant text (same placement as web's
  // assistant-message flat run) so cards show up on ALL surfaces that render
  // markdown — message bubbles, tool results, plan/teammate cards.
  const parts = useMemo(
    () => (isUser ? [{ type: 'text' as const, content: text }] : parseInsightBlocks(text)),
    [text, isUser],
  );

  return (
    <RNView>
      {parts.map((part, pIdx) =>
        part.type === 'insight' ? (
          <InsightCard key={pIdx} label={part.label} content={part.content} baseStyle={baseStyle} knownMentionHandles={knownMentionHandles} />
        ) : (
          <MarkdownBlocks key={pIdx} text={part.content} baseStyle={baseStyle} isUser={isUser} knownMentionHandles={knownMentionHandles} selectable={selectable} plainTextFences={plainTextFences} />
        )
      )}
    </RNView>
  );
}

export const mdStyles = themedStyles((Theme) => StyleSheet.create({
  image: {
    width: '100%',
    height: 200,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    marginTop: 6,
    marginBottom: 2,
    backgroundColor: Theme.bgAlt,
  },
  imageTiled: {
    height: 120,
  },
  imageTile: {
    width: '48.5%',
  },
  imageRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 8,
    marginBottom: 4,
  },
  imageCaption: {
    fontSize: 11,
    color: Theme.textMuted,
    marginBottom: 6,
  },
  imageModal: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    justifyContent: 'center',
  },
  imageFull: {
    width: '100%',
    height: '85%',
  },
  linkText: {
    color: Theme.cyan,
    textDecorationLine: 'underline',
  },
  linkTextUser: {
    color: Theme.userBubble,
    textDecorationLine: 'underline',
  },
  inlineCode: {
    fontFamily: 'SpaceMono',
    fontSize: 13,
    // Neutral text on a subtle surface, matching web (--tw-prose-code = --sol-text
    // on --sol-bg-alt). The old red read like an error/warning on every snippet.
    backgroundColor: Theme.bgAlt,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
    color: Theme.text,
  },
  inlineCodeUser: {
    fontFamily: 'SpaceMono',
    fontSize: 13,
    backgroundColor: Theme.bgHighlight,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
    color: Theme.text,
  },
  mentionPill: {
    backgroundColor: Theme.accent + '20',
    color: Theme.accent,
    fontWeight: '600',
    fontSize: 13,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    overflow: 'hidden',
  },
  listContainer: {
    paddingLeft: 2,
  },
  listItem: {
    flexDirection: 'row',
  },
  listBullet: {
    textAlign: 'center',
    opacity: 0.6,
  },
  blockquote: {
    borderLeftWidth: 3,
    borderLeftColor: Theme.accent,
    paddingLeft: 10,
    opacity: 0.85,
  },
  blockquoteUser: {
    borderLeftWidth: 3,
    borderLeftColor: 'rgba(255,255,255,0.5)',
    paddingLeft: 10,
    opacity: 0.85,
  },
  blockquoteText: {
    fontStyle: 'italic',
  },
  horizontalRule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Theme.borderLight,
    marginVertical: 6,
  },
  lineNumberGutter: {
    paddingRight: 8,
    marginRight: 8,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: 'rgba(255,255,255,0.1)',
  },
  lineNumber: {
    fontSize: 10,
    fontFamily: 'SpaceMono',
    textAlign: 'right',
    minWidth: 24,
  },
  codeText: {
    fontSize: 12,
    fontFamily: 'SpaceMono',
    color: '#93a1a1',
  },
  hScroll: {
    flexGrow: 0,
  },
  tableBox: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.borderLight,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: Theme.bg,
  },
  tableRow: {
    flexDirection: 'row',
  },
  tableHeaderRow: {
    backgroundColor: Theme.bgAlt,
  },
  tableRowAlt: {
    backgroundColor: Theme.bgAlt,
  },
  tableRowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
  },
  tableCell: {
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  tableCellDivider: {
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: Theme.borderLight,
  },
  tableCard: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  tableCardDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Theme.borderLight,
  },
  tableField: {
    flexDirection: 'row',
  },
  insightCard: {
    marginVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Theme.violet + '4d',
    backgroundColor: Theme.violet + '0d',
    overflow: 'hidden',
  },
  insightHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.violet + '33',
    backgroundColor: Theme.violet + '14',
  },
  insightLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: Theme.violet,
  },
  insightBody: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
}));
