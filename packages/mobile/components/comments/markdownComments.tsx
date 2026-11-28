// The markdown renderer's side of comments on a message (MarkdownRenderer):
// which unit each block is, what its text does on a long press, the quoted
// words to mark, and the bubble under a unit that holds comments.
import React, { useContext, useMemo } from 'react';
import type { Root } from 'mdast';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import type { PendingComment } from '@codecast/web/lib/quoteFormat';
import { Text as RNText } from '@/components/Themed';
import { Theme } from '@/constants/Theme';
import { parseMarkdown } from '@/lib/markdown';
import { mixColor } from '@/lib/solColor';
import { messageUnits, placeComments, quotedSpans, quotesWholeUnit, type CommentUnit } from '@/lib/messageComments';
import { MessageTapContext, useMessageLongPress, type MessageLongPress } from '../MessageLongPress';
import { CommentAnchorContext, CommentBubble } from './CommentBubble';

/** A message body's comment layer: which units hold comments, and the row's
 *  long press and tap that a unit's text takes over. */
export type CommentLayer = {
  conversationId: string;
  placed: Map<number, PendingComment[]>;
  longPress: MessageLongPress;
  tap: (() => void) | null;
};

/** The comment fields of the renderer's context. */
export type CommentCtx = {
  /** The message's comments, when comments can be made on it. */
  comments?: CommentLayer;
  /** The unit these blocks are: a long press on its text offers a comment on it. */
  unit?: CommentUnit;
  /** The words of this unit that comments quote, marked where they fall. */
  quoted?: string[];
};

/** The text of a unit takes its own long press (naming the unit) and passes taps on. */
export function unitPress(ctx: CommentCtx) {
  if (!ctx.unit || !ctx.comments) return null;
  const { longPress, tap } = ctx.comments;
  const unit = ctx.unit;
  // No press highlight: a touch that starts a scroll would flash the block.
  return { onLongPress: () => longPress(undefined, unit), onPress: tap ?? undefined, suppressHighlighting: true };
}

/** A unit's context: it, and the part-quotes of its comments to mark. */
export function unitCtx<T extends CommentCtx>(ctx: T, unit: CommentUnit): T {
  const quoted = (ctx.comments?.placed.get(unit.index) ?? [])
    .filter((c) => !quotesWholeUnit(c.quote, unit.text))
    .map((c) => c.quote);
  return { ...ctx, unit, quoted: quoted.length ? quoted : undefined };
}

/** A unit's comments, drawn under it; nothing when it has none. */
export function unitBubble(ctx: CommentCtx, unit: CommentUnit | undefined): React.ReactNode {
  const list = unit && ctx.comments?.placed.get(unit.index);
  return list?.length ? <CommentBubble conversationId={ctx.comments!.conversationId} comments={list} unitText={unit!.text} /> : null;
}

/** `text` as runs with the quoted words marked. */
export function quotedRuns(text: string, quotes: string[], keyPrefix: string): React.ReactNode {
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

/** The message's comments, laid over its text parts: one subscription to the
 *  batch, and one placement across every part, so a quote lands on one unit. */
export function useCommentLayer(textParts: string[]): { trees: Root[]; units: CommentUnit[][]; layer: CommentLayer } | null {
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
