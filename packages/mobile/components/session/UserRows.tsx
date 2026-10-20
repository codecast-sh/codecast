// User-role rows that are not something a person typed into a bubble: a slash
// command and the prompt it expanded to, `!` bash mode, a skill's expansion,
// the brief that seats a role, a handoff from another session. Which row a
// message is comes from web's classifier (lib/userRowKinds), so both apps sort
// rows the same way; these are the phone's drawings of them.
import React, { useState } from 'react';
import { StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { Text as RNText } from '@/components/Themed';
import { CHROME_FONT_CAP, themedStyles, useTheme } from '@/constants/Theme';
import { MarkdownContent } from '@/components/MarkdownRenderer';
import { AnsiText } from '@/components/CodeText';
import { EntityPill } from '@/components/EntityPill';
import { CollapsibleBody } from '@/components/CollapsibleBody';
import { mobileRelativeTime } from '@codecast/shared/render/mobileSessionStyle';
import type { SessionHandoffPrompt } from '@codecast/web/lib/sessionHandoff';

type FeatherName = React.ComponentProps<typeof Feather>['name'];

/**
 * One line that names a machine-written prompt; a tap opens the prompt under
 * it. `body` is markdown; with none the row is a plain label.
 */
export function FoldedPromptRow({ icon, label, detail, body, timestamp }: {
  icon: FeatherName;
  label: string;
  detail?: string;
  body?: string;
  timestamp?: number;
}) {
  const Theme = useTheme();
  const [open, setOpen] = useState(false);
  const canOpen = !!body?.trim();
  return (
    <RNView style={styles.fold}>
      <TouchableOpacity activeOpacity={canOpen ? 0.6 : 1} disabled={!canOpen} onPress={() => setOpen((o) => !o)} style={styles.foldRow}>
        <Feather name={icon} size={12} color={Theme.textDim} />
        <RNText style={styles.foldLabel} maxFontSizeMultiplier={CHROME_FONT_CAP}>{label}</RNText>
        {!!detail && <RNText style={styles.foldDetail} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>{detail}</RNText>}
        {!detail && <RNView style={{ flex: 1 }} />}
        {timestamp != null && timestamp > 0 && (
          <RNText style={styles.time} maxFontSizeMultiplier={CHROME_FONT_CAP}>{mobileRelativeTime(timestamp)}</RNText>
        )}
        {canOpen && <Feather name={open ? 'chevron-up' : 'chevron-down'} size={12} color={Theme.textDim} />}
      </TouchableOpacity>
      {open && canOpen && (
        <RNView style={styles.foldBody}>
          <MarkdownContent text={body!} baseStyle={styles.foldBodyText} isUser={false} />
        </RNView>
      )}
    </RNView>
  );
}

const BASH_PREVIEW_LINES = 12;

/** `!` bash mode: the command a person ran in the agent's terminal and what it printed. */
export function BashModeBlock({ command, stdout, stderr, timestamp }: {
  command?: string;
  stdout?: string;
  stderr?: string;
  timestamp?: number;
}) {
  const Theme = useTheme();
  const [all, setAll] = useState(false);
  const out = (stdout ?? '').replace(/\s+$/, '');
  const err = (stderr ?? '').replace(/\s+$/, '');
  const lines = out ? out.split('\n') : [];
  const clipped = !all && lines.length > BASH_PREVIEW_LINES;
  return (
    <RNView style={styles.bash}>
      <RNView style={styles.bashHeader}>
        <Feather name="terminal" size={12} color={Theme.textDim} />
        <RNText style={styles.foldLabel} maxFontSizeMultiplier={CHROME_FONT_CAP}>Shell</RNText>
        <RNView style={{ flex: 1 }} />
        {timestamp != null && timestamp > 0 && (
          <RNText style={styles.time} maxFontSizeMultiplier={CHROME_FONT_CAP}>{mobileRelativeTime(timestamp)}</RNText>
        )}
      </RNView>
      {!!command && (
        <RNText style={styles.bashCommand} selectable>
          <RNText style={{ color: Theme.green }}>$ </RNText>{command}
        </RNText>
      )}
      {!!out && <AnsiText text={clipped ? lines.slice(0, BASH_PREVIEW_LINES).join('\n') : out} style={styles.bashOut} />}
      {!!err && <AnsiText text={err} style={[styles.bashOut, { color: Theme.red }]} />}
      {lines.length > BASH_PREVIEW_LINES && (
        <TouchableOpacity onPress={() => setAll((a) => !a)} activeOpacity={0.6} style={styles.bashMore}>
          <RNText style={[styles.bashMoreText, { color: Theme.blue }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>
            {all ? 'Show less' : `Show all ${lines.length} lines`}
          </RNText>
        </TouchableOpacity>
      )}
    </RNView>
  );
}

/** A session started from another session's handoff: who it came from, the direction, the brief. */
export function SessionHandoffCard({ handoff, timestamp }: { handoff: SessionHandoffPrompt; timestamp?: number }) {
  const Theme = useTheme();
  const [more, setMore] = useState(false);
  const tint = Theme.cyan + '0f';
  return (
    <RNView style={[styles.handoff, { borderColor: Theme.cyan + '40' }]}>
      <RNView style={[styles.handoffHead, { backgroundColor: tint, borderBottomColor: Theme.cyan + '26' }]}>
        <RNView style={styles.handoffTitleRow}>
          <Feather name="repeat" size={12} color={Theme.cyan} />
          <RNText style={[styles.kicker, { color: Theme.cyan }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>Session handoff</RNText>
          <RNView style={{ flex: 1 }} />
          {timestamp != null && timestamp > 0 && (
            <RNText style={styles.time} maxFontSizeMultiplier={CHROME_FONT_CAP}>{mobileRelativeTime(timestamp)}</RNText>
          )}
        </RNView>
        <RNView style={styles.handoffFrom}>
          <RNText style={styles.time} maxFontSizeMultiplier={CHROME_FONT_CAP}>From</RNText>
          <EntityPill shortId={handoff.sourceId} fallback={handoff.sourceTitle} />
        </RNView>
        {!!handoff.sourceAgent && <RNText style={styles.time} maxFontSizeMultiplier={CHROME_FONT_CAP}>{handoff.sourceAgent}</RNText>}
      </RNView>
      {!!handoff.direction && (
        <RNView style={[styles.handoffSection, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Theme.border }]}>
          <RNText style={[styles.kicker, { color: Theme.cyan, marginBottom: 4 }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>Direction</RNText>
          <MarkdownContent text={handoff.direction} baseStyle={styles.handoffText} isUser={false} />
        </RNView>
      )}
      <RNView style={styles.handoffSection}>
        <CollapsibleBody fadeColor={Theme.bg} height={220}>
          <MarkdownContent text={handoff.brief} baseStyle={styles.handoffText} isUser={false} />
        </CollapsibleBody>
      </RNView>
      {!!handoff.readMore?.trim() && (
        <>
          <TouchableOpacity onPress={() => setMore((m) => !m)} activeOpacity={0.6} style={[styles.handoffMore, { borderTopColor: Theme.border }]}>
            <Feather name={more ? 'chevron-down' : 'chevron-right'} size={12} color={Theme.textDim} />
            <RNText style={styles.foldDetail} maxFontSizeMultiplier={CHROME_FONT_CAP}>Transcript & context</RNText>
          </TouchableOpacity>
          {more && (
            <RNView style={[styles.handoffSection, { paddingTop: 0 }]}>
              <MarkdownContent text={handoff.readMore} baseStyle={styles.handoffText} isUser={false} />
            </RNView>
          )}
        </>
      )}
    </RNView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  fold: {
    marginHorizontal: 14,
    marginVertical: 3,
  },
  foldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 4,
  },
  foldLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: Theme.textMuted,
  },
  foldDetail: {
    flex: 1,
    fontSize: 11,
    color: Theme.textDim,
  },
  time: {
    fontSize: 10,
    color: Theme.textDim,
  },
  foldBody: {
    marginTop: 4,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
    backgroundColor: Theme.bgAlt,
  },
  foldBodyText: {
    fontSize: 13,
    lineHeight: 19,
    color: Theme.textSecondary,
  },
  bash: {
    marginHorizontal: 14,
    marginVertical: 4,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
    backgroundColor: Theme.bgAlt,
    overflow: 'hidden',
  },
  bashHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingTop: 6,
  },
  bashCommand: {
    paddingHorizontal: 10,
    paddingTop: 6,
    fontSize: 12,
    lineHeight: 17,
    color: Theme.text,
  },
  bashOut: {
    paddingHorizontal: 10,
    paddingTop: 4,
    paddingBottom: 8,
    fontSize: 11,
    lineHeight: 16,
    color: Theme.textSecondary,
  },
  bashMore: {
    paddingVertical: 7,
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Theme.border,
  },
  bashMoreText: {
    fontSize: 11,
    fontWeight: '600',
  },
  handoff: {
    marginHorizontal: 12,
    marginVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    overflow: 'hidden',
  },
  handoffHead: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  handoffTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  handoffFrom: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  kicker: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  handoffSection: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  handoffText: {
    fontSize: 13,
    lineHeight: 19,
    color: Theme.text,
  },
  handoffMore: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
}));
