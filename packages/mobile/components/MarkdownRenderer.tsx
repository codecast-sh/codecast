import React, { useState, useMemo } from 'react';
import {
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  View as RNView,
  Text as RNText,
  Linking,
  Clipboard,
  Modal,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Theme } from '@/constants/Theme';

const SYNTAX_PATTERNS: Array<{ regex: RegExp; color: string }> = [
  { regex: /\/\/.*$/gm, color: '#586e75' },
  { regex: /\/\*[\s\S]*?\*\//gm, color: '#586e75' },
  { regex: /#.*$/gm, color: '#586e75' },
  { regex: /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, color: '#2aa198' },
  { regex: /\b(import|export|from|default|return|if|else|for|while|do|switch|case|break|continue|function|const|let|var|class|extends|new|this|try|catch|finally|throw|async|await|yield|typeof|instanceof|in|of|void|delete|true|false|null|undefined|enum|interface|type|implements|abstract|static|public|private|protected|readonly|override|declare|namespace|module|require|super|as|is)\b/g, color: '#859900' },
  { regex: /\b\d+(\.\d+)?\b/g, color: '#d33682' },
  { regex: /[{}()[\]]/g, color: '#657b83' },
  { regex: /=&gt;|=>|===|!==|==|!=|<=|>=|&&|\|\||[+\-*/%=<>!&|^~?:]/g, color: '#cb4b16' },
];

function highlightSyntax(code: string): Array<{ text: string; color?: string }> {
  const spans: Array<{ start: number; end: number; color: string }> = [];
  for (const { regex, color } of SYNTAX_PATTERNS) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(code)) !== null) {
      spans.push({ start: m.index, end: m.index + m[0].length, color });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  const merged: typeof spans = [];
  for (const s of spans) {
    if (merged.length && s.start < merged[merged.length - 1].end) continue;
    merged.push(s);
  }
  const result: Array<{ text: string; color?: string }> = [];
  let pos = 0;
  for (const s of merged) {
    if (s.start > pos) result.push({ text: code.slice(pos, s.start) });
    result.push({ text: code.slice(s.start, s.end), color: s.color });
    pos = s.end;
  }
  if (pos < code.length) result.push({ text: code.slice(pos) });
  return result;
}

export function HighlightedCodeText({ content, style }: { content: string; style: any }) {
  const parts = useMemo(() => highlightSyntax(content), [content]);
  return (
    <RNText style={style} selectable>
      {parts.map((p, i) => p.color ? <RNText key={i} style={{ color: p.color }}>{p.text}</RNText> : p.text)}
    </RNText>
  );
}

const MENTION_COLORS: Record<string, string> = {
  ct: '#cb4b16',
  pl: '#6c71c4',
  doc: Theme.cyan,
};

export function renderInlineMarkdown(text: string, baseStyle: any, keyPrefix = '', isUser = false): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*(.+?)\*\*|\*(.+?)\*|~~(.+?)~~|\[([^\]]+)\]\(([^)]+)\)|(https?:\/\/[^\s<>\])"',]+)|@\[([^\]]+)\]|@(\w+)|((?:ct|pl|doc)-[a-z0-9]{4,}))/g;
  let lastIndex = 0;
  let match;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result.push(<RNText key={`${keyPrefix}t${key++}`}>{text.slice(lastIndex, match.index)}</RNText>);
    }

    if (match[0].startsWith('`')) {
      const code = match[0].slice(1, -1);
      result.push(
        <RNText key={`${keyPrefix}c${key++}`} style={isUser ? mdStyles.inlineCodeUser : mdStyles.inlineCode}>{code}</RNText>
      );
    } else if (match[2] !== undefined) {
      result.push(
        <RNText key={`${keyPrefix}b${key++}`} style={{ fontWeight: '700' }}>{match[2]}</RNText>
      );
    } else if (match[3] !== undefined) {
      result.push(
        <RNText key={`${keyPrefix}i${key++}`} style={{ fontStyle: 'italic' }}>{match[3]}</RNText>
      );
    } else if (match[4] !== undefined) {
      result.push(
        <RNText key={`${keyPrefix}s${key++}`} style={{ textDecorationLine: 'line-through', color: Theme.textMuted0 }}>{match[4]}</RNText>
      );
    } else if (match[5] && match[6]) {
      const url = match[6];
      result.push(
        <RNText key={`${keyPrefix}l${key++}`} style={isUser ? mdStyles.linkTextUser : mdStyles.linkText} onPress={() => Linking.openURL(url)}>
          {match[5]}
        </RNText>
      );
    } else if (match[7]) {
      const url = match[7];
      let displayUrl = url;
      if (url.length > 50) {
        try {
          const parsed = new URL(url);
          const path = parsed.pathname.length > 1 ? parsed.pathname.slice(0, 20) + '...' : '';
          displayUrl = parsed.hostname + path;
        } catch { displayUrl = url.slice(0, 40) + '...'; }
      }
      result.push(
        <RNText key={`${keyPrefix}u${key++}`} style={isUser ? mdStyles.linkTextUser : mdStyles.linkText} onPress={() => Linking.openURL(url)}>
          {displayUrl}
        </RNText>
      );
    } else if (match[8]) {
      // @[Bracket mention] syntax
      const name = match[8];
      result.push(
        <RNText key={`${keyPrefix}m${key++}`} style={mdStyles.mentionPill}>@{name}</RNText>
      );
    } else if (match[9]) {
      // @word mention
      result.push(
        <RNText key={`${keyPrefix}m${key++}`} style={mdStyles.mentionPill}>@{match[9]}</RNText>
      );
    } else if (match[10]) {
      // Entity ID (ct-xxxx, pl-xxxx, doc-xxxx)
      const id = match[10];
      const prefix = id.split('-')[0];
      const color = MENTION_COLORS[prefix] || Theme.cyan;
      result.push(
        <RNText key={`${keyPrefix}e${key++}`} style={[mdStyles.entityPill, { backgroundColor: color + '20', color }]}>{id}</RNText>
      );
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    result.push(<RNText key={`${keyPrefix}t${key++}`}>{text.slice(lastIndex)}</RNText>);
  }

  return result;
}

export function CodeBlockFullscreen({ content, language, visible, onClose }: { content: string; language: string; visible: boolean; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const lines = content.split('\n');
  if (!visible) return null;
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <RNView style={{ flex: 1, backgroundColor: '#002b36' }}>
        <RNView style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 60, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.1)' }}>
          <RNView style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <RNText style={{ fontSize: 12, color: '#93a1a1', fontFamily: 'SpaceMono', fontWeight: '500' }}>{language}</RNText>
            <RNText style={{ fontSize: 10, color: '#657b83' }}>{lines.length} lines</RNText>
          </RNView>
          <RNView style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <TouchableOpacity onPress={() => { Clipboard.setString(content); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setCopied(true); setTimeout(() => setCopied(false), 1500); }} activeOpacity={0.6}>
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
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const handleCopy = () => {
    Clipboard.setString(content);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const lines = content.split('\n');
  const showLineNumbers = lines.length > 3;
  const isTall = lines.length > 15;
  const displayLines = isTall ? lines.slice(0, CODE_BLOCK_PREVIEW_LINES) : lines;
  const displayContent = isTall ? displayLines.join('\n') : content;

  return (
    <RNView style={{ marginVertical: 2 }}>
      <RNView style={{ backgroundColor: Theme.bgAlt, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: Theme.borderLight, overflow: 'hidden' }}>
        <ScrollView horizontal showsHorizontalScrollIndicator nestedScrollEnabled>
          <RNView style={{ padding: 6 }}>
            {showLineNumbers ? (
              <RNView style={{ flexDirection: 'row' }}>
                <RNView style={{ paddingRight: 8, marginRight: 8, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: Theme.borderLight }}>
                  {displayLines.map((_, i) => (
                    <RNText key={i} style={{ fontSize: 10, fontFamily: 'SpaceMono', lineHeight: 16, color: Theme.textDim, textAlign: 'right', minWidth: 20 }}>{i + 1}</RNText>
                  ))}
                </RNView>
                <HighlightedCodeText content={displayContent} style={{ fontSize: 11, fontFamily: 'SpaceMono', lineHeight: 16, color: Theme.textSecondary }} />
              </RNView>
            ) : (
              <HighlightedCodeText content={displayContent} style={{ fontSize: 11, fontFamily: 'SpaceMono', lineHeight: 16, color: Theme.textSecondary }} />
            )}
          </RNView>
        </ScrollView>
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

export function MarkdownTextBlock({ text, baseStyle, blockKey, isUser = false }: { text: string; baseStyle: any; blockKey: string; isUser?: boolean }) {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;
  let elKey = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) { i++; continue; }

    const headerMatch = trimmed.match(/^(#{1,3})\s+(.+)/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const fontSize = level === 1 ? 18 : level === 2 ? 16 : 15;
      elements.push(
        <RNText key={`${blockKey}h${elKey++}`} style={[baseStyle, { fontSize, fontWeight: '700', marginTop: 8, marginBottom: 4 }]}>
          {renderInlineMarkdown(headerMatch[2], baseStyle, `${blockKey}h${elKey}`, isUser)}
        </RNText>
      );
      i++;
      continue;
    }

    if (trimmed.match(/^[-*]\s/) || trimmed.match(/^\d+[.)]\s/)) {
      const listItems: { text: string; ordered: boolean; num?: number; checked?: boolean }[] = [];
      while (i < lines.length) {
        const l = lines[i].trim();
        const checkMatch = l.match(/^[-*]\s+\[([ xX])\]\s+(.*)/);
        const ulMatch = l.match(/^[-*]\s+(.*)/);
        const olMatch = l.match(/^(\d+)[.)]\s+(.*)/);
        if (checkMatch) {
          listItems.push({ text: checkMatch[2], ordered: false, checked: checkMatch[1] !== ' ' });
          i++;
        } else if (ulMatch) {
          listItems.push({ text: ulMatch[1], ordered: false });
          i++;
        } else if (olMatch) {
          listItems.push({ text: olMatch[2], ordered: true, num: parseInt(olMatch[1]) });
          i++;
        } else break;
      }
      elements.push(
        <RNView key={`${blockKey}li${elKey++}`} style={mdStyles.listContainer}>
          {listItems.map((item, j) => (
            <RNView key={j} style={mdStyles.listItem}>
              <RNText style={[baseStyle, mdStyles.listBullet]}>
                {item.checked !== undefined ? (item.checked ? '\u2611' : '\u2610') : item.ordered ? `${item.num}.` : '\u2022'}
              </RNText>
              <RNText style={[baseStyle, { flex: 1 }, item.checked === true && { textDecorationLine: 'line-through', color: Theme.textMuted0 }]}>
                {renderInlineMarkdown(item.text, baseStyle, `${blockKey}li${j}`, isUser)}
              </RNText>
            </RNView>
          ))}
        </RNView>
      );
      continue;
    }

    if (trimmed.match(/^[-*_]{3,}$/)) {
      elements.push(
        <RNView key={`${blockKey}hr${elKey++}`} style={mdStyles.horizontalRule} />
      );
      i++;
      continue;
    }

    if (trimmed.startsWith('> ')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('> ')) {
        quoteLines.push(lines[i].trim().slice(2));
        i++;
      }
      elements.push(
        <RNView key={`${blockKey}q${elKey++}`} style={isUser ? mdStyles.blockquoteUser : mdStyles.blockquote}>
          <RNText style={[baseStyle, mdStyles.blockquoteText]}>
            {renderInlineMarkdown(quoteLines.join('\n'), baseStyle, `${blockKey}q${elKey}`, isUser)}
          </RNText>
        </RNView>
      );
      continue;
    }

    if (trimmed.includes('|') && i + 1 < lines.length && lines[i + 1]?.trim().match(/^\|?\s*[-:]+[-| :]*$/)) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().includes('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }
      const headerCells = tableLines[0].split('|').map(c => c.trim()).filter(Boolean);
      const bodyRows = tableLines.slice(2).map(row => row.split('|').map(c => c.trim()).filter(Boolean));
      elements.push(
        <ScrollView
          key={`${blockKey}tbl${elKey++}`}
          horizontal
          showsHorizontalScrollIndicator
          style={[mdStyles.hScroll, { marginVertical: 6 }]}
        >
          <RNView>
            <RNView style={mdStyles.tableRow}>
              {headerCells.map((cell, ci) => (
                <RNView key={ci} style={mdStyles.tableHeaderCell}>
                  <RNText style={[baseStyle, mdStyles.tableHeaderText]}>{cell}</RNText>
                </RNView>
              ))}
            </RNView>
            {bodyRows.map((row, ri) => (
              <RNView key={ri} style={[mdStyles.tableRow, ri % 2 === 1 && mdStyles.tableRowAlt]}>
                {row.map((cell, ci) => (
                  <RNView key={ci} style={mdStyles.tableCell}>
                    <RNText style={[baseStyle, mdStyles.tableCellText]}>
                      {renderInlineMarkdown(cell, baseStyle, `${blockKey}tbl${ri}${ci}`, isUser)}
                    </RNText>
                  </RNView>
                ))}
              </RNView>
            ))}
          </RNView>
        </ScrollView>
      );
      continue;
    }

    const paraLines: string[] = [];
    while (i < lines.length) {
      const l = lines[i].trim();
      if (!l || l.match(/^#{1,3}\s/) || l.match(/^[-*]\s/) || l.match(/^\d+[.)]\s/) || l.startsWith('> ') || (l.includes('|') && i + 1 < lines.length && lines[i + 1]?.trim().match(/^\|?\s*[-:]+[-| :]*$/))) break;
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      elements.push(
        <RNText key={`${blockKey}p${elKey++}`} style={[baseStyle, { marginBottom: 6 }]} selectable>
          {renderInlineMarkdown(paraLines.join('\n'), baseStyle, `${blockKey}p${elKey}`, isUser)}
        </RNText>
      );
    }
  }

  return <>{elements}</>;
}

export function MarkdownContent({ text, baseStyle, isUser = false }: { text: string; baseStyle: any; isUser?: boolean }) {
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
  const blocks: Array<{ type: 'text' | 'code'; content: string; language?: string }> = [];
  let lastIndex = 0;
  let match;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const t = text.slice(lastIndex, match.index);
      if (t.trim()) blocks.push({ type: 'text', content: t });
    }
    blocks.push({ type: 'code', content: match[2].trimEnd(), language: match[1] || 'plaintext' });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    const t = text.slice(lastIndex);
    if (t.trim()) blocks.push({ type: 'text', content: t });
  }

  if (blocks.length === 0) blocks.push({ type: 'text', content: text });

  return (
    <RNView>
      {blocks.map((block, idx) => {
        if (block.type === 'code') {
          return (
            <CodeBlockWithCopy key={idx} content={block.content} language={block.language || 'plaintext'} />
          );
        }

        return <MarkdownTextBlock key={idx} text={block.content} baseStyle={baseStyle} blockKey={`b${idx}`} isUser={isUser} />;
      })}
    </RNView>
  );
}

export const mdStyles = StyleSheet.create({
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
    backgroundColor: 'rgba(0,0,0,0.07)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
    color: Theme.red,
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
    backgroundColor: '#b5890020',
    color: '#b58900',
    fontWeight: '600',
    fontSize: 13,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    overflow: 'hidden',
  },
  entityPill: {
    fontFamily: 'SpaceMono',
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    overflow: 'hidden',
  },
  listContainer: {
    marginVertical: 4,
    paddingLeft: 4,
  },
  listItem: {
    flexDirection: 'row',
    marginBottom: 3,
  },
  listBullet: {
    width: 20,
    textAlign: 'center',
    opacity: 0.6,
  },
  blockquote: {
    borderLeftWidth: 3,
    borderLeftColor: Theme.accent,
    paddingLeft: 10,
    marginVertical: 6,
    opacity: 0.85,
  },
  blockquoteUser: {
    borderLeftWidth: 3,
    borderLeftColor: 'rgba(255,255,255,0.5)',
    paddingLeft: 10,
    marginVertical: 6,
    opacity: 0.85,
  },
  blockquoteText: {
    fontStyle: 'italic',
  },
  horizontalRule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Theme.borderLight,
    marginVertical: 12,
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
  tableRow: {
    flexDirection: 'row',
  },
  tableRowAlt: {
    backgroundColor: Theme.bgHighlight,
  },
  tableHeaderCell: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: Theme.borderLight,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: Theme.borderLight,
    minWidth: 80,
    backgroundColor: Theme.bgAlt,
  },
  tableHeaderText: {
    fontWeight: '700',
    fontSize: 11,
  },
  tableCell: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: Theme.borderLight,
    minWidth: 80,
  },
  tableCellText: {
    fontSize: 11,
  },
});
