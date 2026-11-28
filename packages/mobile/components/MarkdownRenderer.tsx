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
import { isTrustedImageSrc, isTrustedVideoSrc } from '@/lib/convex';
import { InlineVideo } from './InlineVideo';
import { Text as RNText } from '@/components/Themed';
import * as Haptics from 'expo-haptics';
import { copyToClipboard } from '@/lib/clipboard';
import { openLink } from '@/lib/links';
// The URL vocabulary is shared with the deep-link router and the plain-text
// surfaces (lib/linkRoutes) — markdown prose, bash output and a tapped link all
// recognise and normalise the same thing.
import { URL_SOURCE, trimUrlTail, isMentionStart } from '@/lib/linkRoutes';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Theme, themedStyles, useTheme } from '@/constants/Theme';
import { CastCanvas, canvasAvailable } from './CastCanvas';
import { CastDiff } from './CastDiff';
import { DIFF_FENCE } from '@codecast/web/lib/castDiff';
import { FLOW_FENCE_LANG, readFlowFence } from '@codecast/web/lib/line/flowFence';
import { FlowCard, FlowEditCard, FlowPipelineCard, FlowRunCard } from './session/FlowCard';
import { CONVERSATION_FENCE_LANG } from '@codecast/web/lib/conversationFence';
import { ConversationFence } from './ConversationFence';
import { EntityPill } from './EntityPill';
import { MentionedCode } from './ChangeText';
import { PageEmbed } from './PageEmbed';
import { pushRunRefs, runOrLink } from './DeployRunRefs';
import { ProposalCard } from './org/ProposalCard';
import { DecisionCard } from './decisions/DecisionCard';
import { SearchHighlightContext, markedRuns } from './search/highlight';
import { parseMarkdown, plainText, planTable } from '@/lib/markdown';
import type { Nodes, Paragraph, Image, List, Root, Table } from 'mdast';
import { parseEntityUrl, parseSharedEntityUrl, isEntityId, entityTypeFromId, parseProposalChangeRef, parsePublishedPageUrl, parseClaudeArtifactUrl, BARE_ID_AFTER, BARE_ID_BEFORE, BARE_ID_SOURCE, MENTION_ID_SOURCE, type EntityType } from '@codecast/shared/entities';
// Canonical "★ Insight ─────" parser shared with web (pure string/regex module,
// Hermes-safe). Mobile used to carry its own narrower copy in session/[id].tsx
// which silently missed most real-world insight forms — one parser, one truth.
import { parseInsightBlocks } from '@codecast/web/components/insightBlocks';
import { replaceShortcodes } from '@codecast/shared/chat';
import { resolveDateDisplay } from '@codecast/web/lib/dateMention';

import { LinkText, HighlightedCodeText, useLinkLongPress } from './CodeText';
import { MessageTapContext, OutsideMessage, useMessageLongPress, type MessageLongPress } from './MessageLongPress';
import { CommentAnchorContext, CommentBubble } from './comments/CommentBubble';
import { messageUnits, placeComments, quotedSpans, quotesWholeUnit, type CommentUnit } from '@/lib/messageComments';
import { mixColor } from '@/lib/solColor';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import type { PendingComment } from '@codecast/web/lib/quoteFormat';

export { LinkText, linkifyPlainText, HighlightedCodeText } from './CodeText';
import { CodeBlockFullscreen } from './CodeBlockFullscreen';
export { CodeBlockFullscreen } from './CodeBlockFullscreen';

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
  /** The message's comments, when comments can be made on it (CommentLayer). */
  comments?: CommentLayer;
  /** The unit these blocks are: a long press on its text offers a comment on it. */
  unit?: CommentUnit;
  /** The words of this unit that comments quote, marked where they fall. */
  quoted?: string[];
};

/** A message body's comment layer: which units hold comments, and the row's
 *  long press and tap that a unit's text takes over. */
type CommentLayer = {
  conversationId: string;
  placed: Map<number, PendingComment[]>;
  longPress: MessageLongPress;
  tap: (() => void) | null;
};

/** The text of a unit takes its own long press (naming the unit) and passes taps on. */
function unitPress(ctx: MdCtx) {
  if (!ctx.unit || !ctx.comments) return null;
  const { longPress, tap } = ctx.comments;
  const unit = ctx.unit;
  // No press highlight: a touch that starts a scroll would flash the block.
  return { onLongPress: () => longPress(undefined, unit), onPress: tap ?? undefined, suppressHighlighting: true };
}

/** A unit's context: it, and the part-quotes of its comments to mark. */
function unitCtx(ctx: MdCtx, unit: CommentUnit): MdCtx {
  const quoted = (ctx.comments?.placed.get(unit.index) ?? [])
    .filter((c) => !quotesWholeUnit(c.quote, unit.text))
    .map((c) => c.quote);
  return { ...ctx, unit, quoted: quoted.length ? quoted : undefined };
}

/** A unit's comments, drawn under it; nothing when it has none. */
function unitBubble(ctx: MdCtx, unit: CommentUnit | undefined): React.ReactNode {
  const list = unit && ctx.comments?.placed.get(unit.index);
  return list?.length ? <CommentBubble conversationId={ctx.comments!.conversationId} comments={list} unitText={unit!.text} /> : null;
}

/** `text` as runs with the quoted words marked. */
function quotedRuns(text: string, quotes: string[], keyPrefix: string): React.ReactNode {
  const spans = quotedSpans(text, quotes);
  if (!spans.length) return text;
  const mark = { backgroundColor: mixColor(Theme.accent, 24, 'transparent') };
  const parts: React.ReactNode[] = [];
  let at = 0;
  spans.forEach(([start, end], i) => {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<RNText key={`${keyPrefix}q${i}`} style={mark}>{text.slice(start, end)}</RNText>);
    at = end;
  });
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/** A run of plain words, marked for the search or the comments on it. */
function markRun(text: string, ctx: MdCtx, keyPrefix: string): React.ReactNode {
  return ctx.quoted ? quotedRuns(text, ctx.quoted, keyPrefix) : markedRuns(text, ctx.found, keyPrefix);
}

// The references a writer did not mark up, inside a run of plain text: bare
// URLs, @mentions and entity ids. Emphasis, code and links come from the
// parser (lib/markdown), so this never reads markdown syntax itself.
const TEXT_REF_SOURCE =
  `(${URL_SOURCE})|@\\[([^\\]]+)\\]|@(\\w+)`
  // Bounded as the shared scanner is, so "5-in-1" stays prose.
  + `|${BARE_ID_BEFORE}(${BARE_ID_SOURCE})${BARE_ID_AFTER}`;

/** The codecast object a URL names, as the pill to draw. A link carrying its
 *  share token is the same object; its pill opens through the link itself, so
 *  the token reaches the screen (web's EntityAwareLink does the same). */
function linkedEntity(url: string): { type: EntityType; id: string; to?: string } | null {
  const ref = parseEntityUrl(url);
  if (ref) return ref;
  const shared = parseSharedEntityUrl(url);
  return shared ? { type: shared.type, id: shared.id, to: url } : null;
}

function renderTextRefs(text: string, ctx: MdCtx, kp: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const words = (s: string) => out.push(markRun(s, ctx, `${kp}h${out.length}-`));
  // Prose between references may name a run by its bare id ("Deploy 44822506482").
  const plain = (s: string) => pushRunRefs(s, out, words, (w, key) => markRun(w, ctx, key), kp);
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
      const entityRef = linkedEntity(url);
      const link = <LinkText key={k} url={url} isUser={ctx.isUser} />;
      out.push(entityRef
        ? <EntityPill key={k} type={entityRef.type} id={entityRef.id} to={entityRef.to} />
        : runOrLink(url, link, k));
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
        const lower = entityId.toLowerCase();
        if (lower.startsWith('date:')) {
          const { label, resolved } = resolveDateDisplay(entityId.slice(5), em[1]);
          out.push(
            <RNText key={k} style={mdStyles.dateChip}>
              <FontAwesome name="calendar" size={11} color={Theme.orange} />{' '}{label}{resolved ? <RNText style={mdStyles.dateChipResolved}>{`  ${resolved}`}</RNText> : null}
            </RNText>,
          );
          last = re.lastIndex;
          continue;
        }
        if (lower.startsWith('label:')) {
          out.push(<RNText key={k} style={mdStyles.mentionPill}>#{entityId.slice(6)}</RNText>);
          last = re.lastIndex;
          continue;
        }
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
      // A branch the conversation's repository knows draws as its change, as on the web (changes.md CH4).
      return <MentionedCode key={k} value={node.value}><RNText style={style}>{markedRuns(node.value, ctx.found, `${k}h`)}</RNText></MentionedCode>;
    }
    case 'link': {
      // A codecast object URL becomes a rich in-app pill, not an external link
      // (web's EntityAwareLink parity).
      const entityRef = linkedEntity(node.url);
      if (entityRef) return <EntityPill key={k} type={entityRef.type} id={entityRef.id} to={entityRef.to} />;
      // An autolink (<https://…>) reads as its shortened URL.
      const label = plainText(node) === node.url ? undefined : renderInline(node.children, ctx, k);
      const link = <LinkText key={k} url={node.url} label={label} isUser={ctx.isUser} />;
      return runOrLink(node.url, link, k);
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
              <RNText style={{ fontSize: 10, fontFamily: 'JetBrainsMono-Regular', lineHeight: 16, color: Theme.textDim, textAlign: 'right', minWidth: 22, marginRight: 8 }}>{i + 1}</RNText>
            )}
            <HighlightedCodeText content={line || ' '} style={{ flex: 1, fontSize: 11, fontFamily: 'JetBrainsMono-Regular', lineHeight: 16, color: Theme.textSecondary }} />
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

function captionFromAlt(alt: string): string | undefined {
  const t = alt.trim();
  return t && !/^(image|img)$/i.test(t) ? t : undefined;
}

/** One image or video from a trusted paragraph; a video plays in the cast player. */
function MarkdownMedia({ img, tiled }: { img: Image; tiled?: boolean }) {
  const alt = img.alt ?? '';
  if (isTrustedVideoSrc(img.url)) return <InlineVideo src={img.url} caption={captionFromAlt(alt)} tiled={tiled} />;
  return <MarkdownImage src={img.url} alt={alt} tiled={tiled} />;
}

function MarkdownImage({ src, alt, tiled }: { src: string; alt: string; tiled?: boolean }) {
  const Theme = useTheme();
  const messageLongPress = useMessageLongPress();
  const [full, setFull] = useState(false);
  const [failed, setFailed] = useState(false);
  const caption = captionFromAlt(alt);
  if (failed) return null;
  return (
    <RNView style={tiled ? mdStyles.imageTile : undefined}>
      <TouchableOpacity onPress={() => setFull(true)} onLongPress={messageLongPress ? () => messageLongPress() : undefined} activeOpacity={0.85}>
        <RNImage
          source={{ uri: src }}
          style={[mdStyles.image, tiled && mdStyles.imageTiled]}
          resizeMode="cover"
          accessibilityLabel={alt}
          onError={() => setFailed(true)}
        />
      </TouchableOpacity>
      {caption ? <RNText style={mdStyles.imageCaption}>{caption}</RNText> : null}
<OutsideMessage>
      <Modal visible={full} transparent animationType="fade" onRequestClose={() => setFull(false)}>
        <TouchableOpacity style={mdStyles.imageModal} activeOpacity={1} onPress={() => setFull(false)}>
          <RNImage source={{ uri: src }} style={mdStyles.imageFull} resizeMode="contain" />
        </TouchableOpacity>
      </Modal>
      </OutsideMessage>
    </RNView>
  );
}

// A paragraph of nothing but images, every one from a trusted source
// (storage-origin `cast image` uploads, pasted transcript images, videos on
// our media host): web draws these inline with the alt as a caption, side by
// side when adjacent. A mixed
// or untrusted paragraph keeps text semantics, where an image is a link.
function trustedImages(p: Paragraph): Image[] | null {
  const imgs: Image[] = [];
  for (const c of p.children) {
    if (c.type === 'image') imgs.push(c);
    else if (c.type === 'break' || (c.type === 'text' && !c.value.trim())) continue;
    else return null;
  }
  return imgs.length > 0 && imgs.every((img) => isTrustedImageSrc(img.url) || isTrustedVideoSrc(img.url)) ? imgs : null;
}

// Box-drawing/em-dash rule runs (optionally `code`/**bold**-wrapped) — the
// residue of insight fences the block parser deliberately doesn't match (e.g.
// the open-ended titled form). A clean rule beats a wrapping line of ─ glyphs.
// A reference alone on its line is a thing to open, so it draws as a card
// (web's entity cards, doc embeds and page embeds): an object, a doc embed
// (`![[doc:<id>]]`), or a page URL with the caption a writer gave it.
type SoloRef =
  | { kind: 'entity'; shortId?: string; type?: EntityType; id?: string; to?: string }
  | { kind: 'url'; url: string; caption?: string };

const DOC_EMBED_RE = /^!\[\[doc:([a-z0-9]{32})\]\]$/i;
const SOLO_URL_RE = new RegExp(`^(?:${URL_SOURCE})$`, 'i');

function soloReference(p: Paragraph): SoloRef | null {
  if (p.children.length !== 1) return null;
  const only = p.children[0];
  let url: string | null = null;
  let caption: string | undefined;
  if (only.type === 'text') {
    const t = only.value.trim();
    const doc = t.match(DOC_EMBED_RE);
    if (doc) return { kind: 'entity', type: 'doc', id: doc[1] };
    if (SOLO_URL_RE.test(t)) url = trimUrlTail(t);
    else if (isEntityId(t) && !/^[a-z0-9]{32}$/i.test(t)) return { kind: 'entity', shortId: t };
  } else if (only.type === 'link' && /^https?:/i.test(only.url)) {
    url = only.url;
    const label = plainText(only).trim();
    if (label && label.replace(/^https?:\/\//, '') !== url.replace(/^https?:\/\//, '')) caption = label;
  }
  if (!url) return null;
  const entity = linkedEntity(url);
  if (entity && !caption) return { kind: 'entity', type: entity.type, id: entity.id, to: entity.to };
  return { kind: 'url', url, caption };
}

function SoloRefCard({ solo, isUser }: { solo: SoloRef; isUser: boolean }) {
  const Theme = useTheme();
  const onLinkLongPress = useLinkLongPress(solo.kind === 'url' ? solo.url : '');
  if (solo.kind === 'entity') {
    // A proposal and a decision read as the cards the web transcript draws,
    // with their answers right there. One change of a proposal (`op-55#3`)
    // stays its pill, as on the web.
    const ref = solo.shortId ?? solo.id;
    const type = solo.type ?? (solo.shortId ? entityTypeFromId(solo.shortId) : null);
    if (ref && type === 'proposal' && !parseProposalChangeRef(ref)) return <ProposalCard refId={ref} />;
    if (ref && type === 'decision') return <DecisionCard decisionRef={ref} />;
    return (
      <RNView style={mdStyles.refCard}>
        <EntityPill shortId={solo.shortId} type={solo.type} id={solo.id} to={solo.to} />
      </RNView>
    );
  }
  let host = solo.url;
  let path = '';
  try {
    const u = new URL(solo.url);
    host = u.hostname.replace(/^www\./, '');
    path = (u.pathname + u.search).replace(/\/$/, '');
  } catch {}
  // A published page shows itself, live, rather than a link to it.
  const published = parsePublishedPageUrl(solo.url);
  if (published) return <PageEmbed slug={published.slug} caption={solo.caption} kicker="Published page" />;
  const kicker = parseClaudeArtifactUrl(solo.url) ? 'Claude artifact' : null;
  const card = (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={() => { void openLink(solo.url); }}
      onLongPress={onLinkLongPress}
      style={mdStyles.refCard}
    >
      <FontAwesome name={kicker ? 'window-maximize' : 'globe'} size={13} color={isUser ? Theme.userBubble : Theme.cyan} />
      <RNView style={{ flex: 1, minWidth: 0 }}>
        {!!kicker && <RNText style={mdStyles.refKicker}>{kicker}</RNText>}
        <RNText style={mdStyles.refTitle} numberOfLines={2}>{solo.caption ?? host}</RNText>
        <RNText style={mdStyles.refPath} numberOfLines={1}>{solo.caption ? `${host}${path}` : path || host}</RNText>
      </RNView>
      <FontAwesome name="external-link" size={11} color={Theme.textDim} />
    </TouchableOpacity>
  );
  // An Actions run that carries a deploy is the deploy's pill; any other run keeps its card.
  return runOrLink(solo.url, card);
}

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
            {imgs.map((img, j) => <MarkdownMedia key={j} img={img} tiled />)}
          </RNView>
        ) : <MarkdownMedia key={k} img={imgs[0]} />;
      }
      if (RULE_RESIDUE_RE.test(plainText(node).trim())) return <RNView key={k} style={mdStyles.horizontalRule} />;
      const solo = soloReference(node);
      if (solo) return <SoloRefCard key={k} solo={solo} isUser={ctx.isUser} />;
      return <RNText key={k} style={ctx.baseStyle} selectable={ctx.selectable} {...unitPress(ctx)}>{renderInline(node.children, ctx, k)}</RNText>;
    }
    case 'heading': {
      // A heading never sets smaller than the text around it: a reply set at
      // a reading size keeps its headings at body size.
      const fontSize = Math.max(HEADING_SIZES[node.depth - 1], StyleSheet.flatten(ctx.baseStyle)?.fontSize ?? 0);
      return (
        <RNText key={k} style={[ctx.baseStyle, { fontSize, fontWeight: '700', marginTop: first ? 0 : 6 }]} selectable={ctx.selectable} {...unitPress(ctx)}>
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
      if (language === FLOW_FENCE_LANG) {
        const read = readFlowFence(node.value);
        if (read.ok) {
          if (read.spec.edit) return <FlowEditCard key={k} edit={read.spec.edit} />;
          if (read.spec.pipeline) return <FlowPipelineCard key={k} repository={read.spec.pipeline} />;
          return read.spec.run ? <FlowRunCard key={k} runId={read.spec.run} /> : <FlowCard key={k} slug={read.spec.flow!} />;
        }
      }
      if (language === CONVERSATION_FENCE_LANG) return <ConversationFence key={k} code={node.value} fallback={<CodeBlockWithCopy content={node.value} language="json" />} />;
      if (language === DIFF_FENCE) return <CastDiff key={k} raw={node.value} fallback={<CodeBlockWithCopy content={node.value} language="diff" />} />;
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

function MarkdownList({ node, ctx, k, units }: { node: List; ctx: MdCtx; k: string; units?: CommentUnit[] }) {
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
        // A top-level list's items are each a unit of the message's comments.
        const unit = units?.[j];
        const base = unit ? unitCtx(ctx, unit) : ctx;
        const itemCtx = {
          ...base,
          listDepth: ctx.listDepth + 1,
          baseStyle: item.checked === true ? [ctx.baseStyle, { textDecorationLine: 'line-through', color: Theme.textMuted0 }] : ctx.baseStyle,
        };
        return (
          <RNView key={j} style={mdStyles.listItem}>
            <RNText style={[ctx.baseStyle, mdStyles.listBullet, { width: markerWidth }]}>{markers[j]}</RNText>
            <RNView style={{ flex: 1 }}>
              {renderBlocks(item.children, itemCtx, `${k}.${j}`, gap)}
              {unitBubble(ctx, unit)}
            </RNView>
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
function MarkdownBlocks({ text, tree: parsed, units, comments, baseStyle, isUser, knownMentionHandles, selectable = true, plainTextFences = false }: { text: string; tree?: Root; units?: CommentUnit[]; comments?: CommentLayer; baseStyle: any; isUser: boolean; knownMentionHandles?: Set<string>; selectable?: boolean; plainTextFences?: boolean }) {
  // Under a search (components/search/highlight), every text run marks the
  // words found; pills and links pass through.
  const found = useContext(SearchHighlightContext);
  const own = useMemo(() => (parsed ? null : parseMarkdown(text)), [parsed, text]);
  const tree = parsed ?? own!;
  const ctx: MdCtx = { baseStyle, isUser, knownMentionHandles, found, selectable, plainTextFences, listDepth: 0 };
  if (!comments || !units) return <>{renderBlocks(tree.children, ctx, 'b')}</>;
  // Each top-level block is a unit of the message's comments (a list, one
  // per item), drawn with its comments under it.
  const withComments = { ...ctx, comments };
  let u = 0;
  const out = (tree.children as Nodes[]).map((node, i) => {
    const k = `b.${i}`;
    if (node.type === 'list') {
      const items = units.slice(u, u + node.children.length);
      u += node.children.length;
      return <MarkdownList key={k} node={node} ctx={withComments} k={k} units={items} />;
    }
    const unit = units[u++];
    const el = renderBlock(node, unit ? unitCtx(withComments, unit) : withComments, k, i === 0);
    const bubble = unitBubble(withComments, unit);
    return bubble && el != null ? <RNView key={k}>{el}{bubble}</RNView> : el;
  }).filter((el) => el != null);
  return out.length === 1 ? <>{out[0]}</> : <RNView style={{ gap: BLOCK_GAP }}>{out}</RNView>;
}

/** The message's comments, laid over its text parts: one subscription to the
 *  batch, and one placement across every part, so a quote lands on one unit. */
function useCommentLayer(textParts: string[]): { trees: Root[]; units: CommentUnit[][]; layer: CommentLayer } | null {
  const anchor = useContext(CommentAnchorContext);
  const longPress = useMessageLongPress();
  const tap = useContext(MessageTapContext);
  // A signature of this message's text comments, so a write to another
  // message's (or to a note's words while typed elsewhere) changes nothing here.
  const sig = useInboxStore((s) => {
    if (!anchor) return '';
    const list = s.reviewComments[anchor.conversationId];
    if (!list?.length) return '';
    return JSON.stringify(list.filter((c) => c.messageId === anchor.messageId && !c.image && !c.page && !c.proposal).map((c) => [c.id, c.quote, c.body, c.blockIndex, c.createdAt]));
  });
  const key = textParts.join('\u0000');
  const parsed = useMemo(() => {
    if (!anchor || !longPress) return null;
    let base = 0;
    const trees = textParts.map((t) => parseMarkdown(t));
    const units = trees.map((t) => {
      const list = messageUnits(t, base);
      base += list.length;
      return list;
    });
    return { trees, units };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, !!anchor, !!longPress]);
  return useMemo(() => {
    if (!anchor || !longPress || !parsed) return null;
    const comments = sig ? (JSON.parse(sig) as [string, string, string, number, number][]).map(([id, quote, body, blockIndex, createdAt]): PendingComment => ({ id, quote, body, blockIndex, createdAt, messageId: anchor.messageId })) : [];
    const placed = placeComments(comments, parsed.units.flat().map((x) => x.text));
    return { ...parsed, layer: { conversationId: anchor.conversationId, placed, longPress, tap } };
  }, [anchor, longPress, tap, parsed, sig]);
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
export function MarkdownContent({ text, baseStyle, isUser = false, knownMentionHandles, selectable: selectableProp, plainTextFences = false }: { text: string; baseStyle: any; isUser?: boolean; knownMentionHandles?: Set<string>; selectable?: boolean; plainTextFences?: boolean }) {
  // Inside a message a long press is the message's menu, so its text is not
  // natively selectable there (Select text in that menu opens a view that is).
  const selectable = selectableProp ?? !useMessageLongPress();
  // Insight extraction runs on every assistant text (same placement as web's
  // assistant-message flat run) so cards show up on ALL surfaces that render
  // markdown — message bubbles, tool results, plan/teammate cards.
  const parts = useMemo(
    () => (isUser ? [{ type: 'text' as const, content: text }] : parseInsightBlocks(text)),
    [text, isUser],
  );
  const textParts = useMemo(() => parts.flatMap((p) => (p.type === 'insight' ? [] : [p.content])), [parts]);
  const comments = useCommentLayer(textParts);
  let textPart = 0;

  const body = (
    <RNView>
      {parts.map((part, pIdx) =>
        part.type === 'insight' ? (
          <InsightCard key={pIdx} label={part.label} content={part.content} baseStyle={baseStyle} knownMentionHandles={knownMentionHandles} />
        ) : (
          (() => {
            const t = textPart++;
            return <MarkdownBlocks key={pIdx} text={part.content} tree={comments?.trees[t]} units={comments?.units[t]} comments={comments?.layer} baseStyle={baseStyle} isUser={isUser} knownMentionHandles={knownMentionHandles} selectable={selectable} plainTextFences={plainTextFences} />;
          })()
        )
      )}
    </RNView>
  );
  // A card drawn inside this body (a decision, a proposal) is not its words.
  return comments ? <CommentAnchorContext.Provider value={null}>{body}</CommentAnchorContext.Provider> : body;
}

export const mdStyles = themedStyles((Theme) => StyleSheet.create({
  dateChip: {
    color: Theme.text,
    backgroundColor: Theme.orange + '1a',
    fontWeight: '600',
  },
  dateChipResolved: {
    color: Theme.textDim,
    fontWeight: '400',
    fontSize: 11,
  },
  refCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
    backgroundColor: Theme.bgAlt,
  },
  refKicker: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: Theme.textDim,
  },
  refTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: Theme.text,
  },
  refPath: {
    fontFamily: 'JetBrainsMono-Regular',
    fontSize: 11,
    color: Theme.textDim,
  },
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
  inlineCode: {
    fontFamily: 'JetBrainsMono-Regular',
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
    fontFamily: 'JetBrainsMono-Regular',
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
