// A `cast …` command an agent ran, drawn as what it did rather than as a shell
// line: a message sent to another session, a decision put to the person, the
// pinned thread state, a task created, a comment and its text. The command is
// parsed by web's castCommand (one grammar for both apps); a tap on the row
// shows the raw command and what it printed.
import React, { useMemo, useState } from 'react';
import { StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { Text as RNText } from '@/components/Themed';
import { CHROME_FONT_CAP, themedStyles, useTheme } from '@/constants/Theme';
import { MarkdownContent } from '@/components/MarkdownRenderer';
import { AnsiText } from '@/components/CodeText';
import { EntityPill } from '@/components/EntityPill';
import { CollapsibleBody, blendOver } from '@/components/CollapsibleBody';
import {
  extractCastBodyParts,
  extractChatSendArgs,
  extractDecideArgs,
  extractSendBody,
  extractStateArgs,
  normalizeCastCategory,
  type ParsedCastCommand,
} from '@codecast/web/components/castCommand';
import { decideOutputId } from '@codecast/web/components/conversation/classify';
import { stripAnsiCodes } from '@codecast/web/lib/ansi';
import { THREAD_STATE_STATUS_META } from '@codecast/web/lib/threadState';
import { parseThreadStateStatus } from '@codecast/shared/contracts';

type FeatherName = React.ComponentProps<typeof Feather>['name'];
type Tone = 'yellow' | 'cyan' | 'blue' | 'violet' | 'green' | 'orange' | 'magenta' | 'textDim';

const CATEGORY: Record<string, { icon: FeatherName; tone: Tone }> = {
  task: { icon: 'check-square', tone: 'yellow' },
  plan: { icon: 'target', tone: 'cyan' },
  doc: { icon: 'file-text', tone: 'blue' },
  search: { icon: 'search', tone: 'violet' },
  feed: { icon: 'list', tone: 'green' },
  trigger: { icon: 'zap', tone: 'orange' },
  browser: { icon: 'globe', tone: 'cyan' },
  sim: { icon: 'smartphone', tone: 'cyan' },
  spawn: { icon: 'git-branch', tone: 'violet' },
  fork: { icon: 'git-branch', tone: 'violet' },
  read: { icon: 'book-open', tone: 'violet' },
  state: { icon: 'map-pin', tone: 'cyan' },
  decide: { icon: 'help-circle', tone: 'yellow' },
  chat: { icon: 'message-circle', tone: 'blue' },
  publish: { icon: 'upload-cloud', tone: 'magenta' },
  diff: { icon: 'git-commit', tone: 'magenta' },
  summary: { icon: 'align-left', tone: 'magenta' },
  handoff: { icon: 'repeat', tone: 'magenta' },
  context: { icon: 'compass', tone: 'magenta' },
};

const STATUS_VERBS = new Set(['start', 'done', 'drop', 'pause', 'activate', 'bind', 'unbind']);
const LIST_VERBS = new Set(['ls', 'list']);
// Tasks and plans a command named or made; a list's output names dozens, so
// output is read only for commands that make or change one.
const ENTITY_RE = /\b(?:ct|pl)-[a-z0-9]+\b/gi;
const WRITES_ENTITY = new Set(['create', 'add', 'start', 'done', 'drop', 'update', 'edit', 'comment']);
const SESSION_ID_RE = /^jx[a-z0-9]{5,}$/i;

/** Ids the command named or printed, in order, once each. */
function entityIds(subcommand: string, args: string, output: string): string[] {
  const ids: string[] = [];
  for (const src of WRITES_ENTITY.has(subcommand) ? [args, stripAnsiCodes(output)] : [args]) {
    for (const m of src.matchAll(ENTITY_RE)) {
      const id = m[0].toLowerCase();
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids.slice(0, 4);
}

function firstArgOf(args: string): string {
  const m = args.match(/^"([^"]*)"/) || args.match(/^'([^']*)'/) || args.match(/^(\S+)/);
  return m && m[1] !== '-' ? m[1] : '';
}

export function CastCommandBlock({ cast, output, isError, image }: {
  cast: ParsedCastCommand;
  output: string;
  isError?: boolean;
  /** A screenshot the command produced (`cast browser shot`), drawn under the row. */
  image?: React.ReactNode;
}) {
  const Theme = useTheme();
  const [open, setOpen] = useState(false);
  const { category, subcommand, args } = cast;
  const cat = normalizeCastCategory(category);
  const meta = CATEGORY[cat] ?? { icon: 'terminal' as FeatherName, tone: 'textDim' as Tone };
  const color = Theme[meta.tone];
  const body = useMemo(() => extractCastBodyParts(category, subcommand, args), [category, subcommand, args]);

  const raw = open && (
    <RNView style={styles.raw}>
      <RNText style={styles.rawCmd} selectable>$ {cast.raw}</RNText>
      {output.trim()
        ? <AnsiText text={output.replace(/\s+$/, '')} style={[styles.rawOut, isError && { color: Theme.red }]} />
        : <RNText style={styles.rawOut}>No output</RNText>}
    </RNView>
  );
  const status = isError ? <RNText style={[styles.small, { color: Theme.red }]}>failed</RNText> : null;

  // `cast send <session> "…"`: the outgoing twin of a received session message.
  if (cat === 'send' && SESSION_ID_RE.test(subcommand)) {
    const sent = extractSendBody(args);
    const accent = Theme.blue;
    return (
      <RNView style={[styles.rail, { borderLeftColor: accent + '99', backgroundColor: accent + '0d' }]}>
        <TouchableOpacity activeOpacity={0.6} onPress={() => setOpen((o) => !o)} style={styles.railHead}>
          <Feather name="corner-up-right" size={13} color={accent + 'b3'} />
          <RNText style={[styles.kicker, { color: accent + 'b3' }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>Message to</RNText>
          <EntityPill shortId={subcommand} />
          <RNView style={{ flex: 1 }} />
          {status ?? <RNText style={[styles.small, { color: Theme.green }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>sent</RNText>}
        </TouchableOpacity>
        {sent.kind === 'dynamic' ? (
          // The shell filled in the real message ($(…), $VAR, a pipe); the
          // transcript holds only the recipe, so it is shown as typed.
          <RNText style={styles.recipe} selectable>{sent.body}</RNText>
        ) : (
          <CollapsibleBody fadeColor={blendOver(accent + '0d', Theme.bg)}>
            <MarkdownContent text={sent.body} baseStyle={styles.bodyText} isUser={false} />
          </CollapsibleBody>
        )}
        {raw}
      </RNView>
    );
  }

  // `cast chat reply|send "…"`: the agent's side of a team chat thread.
  const chat = cat === 'chat' ? extractChatSendArgs(subcommand, args) : null;
  if (chat) {
    const accent = Theme.blue;
    return (
      <RNView style={[styles.rail, { borderLeftColor: accent + '99', backgroundColor: accent + '0d' }]}>
        <TouchableOpacity activeOpacity={0.6} onPress={() => setOpen((o) => !o)} style={styles.railHead}>
          <Feather name="message-circle" size={13} color={accent + 'b3'} />
          <RNText style={[styles.kicker, { color: accent + 'b3' }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{subcommand === 'reply' ? 'Chat reply' : 'Chat message'}</RNText>
          <RNView style={{ flex: 1 }} />
          {status}
        </TouchableOpacity>
        {chat.kind === 'dynamic'
          ? <RNText style={styles.recipe} selectable>{chat.body}</RNText>
          : !!chat.body && (
            <CollapsibleBody fadeColor={blendOver(accent + '0d', Theme.bg)}>
              <MarkdownContent text={chat.body} baseStyle={styles.bodyText} isUser={false} />
            </CollapsibleBody>
          )}
        {raw}
      </RNView>
    );
  }

  // `cast decide "…"`: the question put to the person, its options, and the
  // decision itself as a pill that opens it (where it is answered).
  const decide = cat === 'decide' ? extractDecideArgs(subcommand, args) : null;
  if (decide && decide.verb !== 'ls') {
    const ref = decide.ref ?? decide.decisionId ?? (output ? decideOutputId(output, decide.verb, decide.question) : null);
    const accent = Theme.yellow;
    const verbLabel = decide.verb === 'ask' ? 'Asked you' : decide.verb === 'edit' ? 'Edited decision' : decide.verb === 'cancel' ? 'Withdrew decision'
      : decide.verb === 'answer' ? 'Answered decision' : decide.verb === 'recommend' ? 'Recommended on' : 'Read decision';
    return (
      <RNView style={[styles.rail, { borderLeftColor: accent + '99', backgroundColor: accent + '0a' }]}>
        <TouchableOpacity activeOpacity={0.6} onPress={() => setOpen((o) => !o)} style={styles.railHead}>
          <Feather name="help-circle" size={13} color={accent} />
          <RNText style={[styles.kicker, { color: accent }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{verbLabel}</RNText>
          {!!ref && <EntityPill shortId={ref} type="decision" />}
          <RNView style={{ flex: 1 }} />
          {status}
        </TouchableOpacity>
        {!!decide.question && <RNText style={styles.question}>{decide.question}</RNText>}
        {decide.options.map((o, i) => (
          <RNView key={i} style={styles.option}>
            <RNText style={[styles.optionNum, { color: accent }]}>{i + 1}</RNText>
            <RNView style={{ flex: 1 }}>
              <RNText style={styles.optionLabel}>{o.label}</RNText>
              {!!o.description && <RNText style={styles.optionDesc}>{o.description}</RNText>}
            </RNView>
          </RNView>
        ))}
        {!!decide.context && (
          <CollapsibleBody fadeColor={blendOver(accent + '0a', Theme.bg)} height={96}>
            <MarkdownContent text={decide.context} baseStyle={styles.contextText} isUser={false} />
          </CollapsibleBody>
        )}
        {raw}
      </RNView>
    );
  }

  // `cast state …`: the status chip and the state's first line; the pinned
  // panel already shows the whole text.
  let summary: React.ReactNode = null;
  if (cat === 'state') {
    const verb = subcommand === 'clear' || subcommand === 'show' ? subcommand : null;
    const st = verb ? null : extractStateArgs(subcommand ? `${subcommand} ${args}`.trim() : args);
    const parsed = parseThreadStateStatus(st?.status ?? null);
    const sm = parsed ? THREAD_STATE_STATUS_META[parsed] : null;
    const tone = sm?.color.match(/--sol-(\w+)/)?.[1] as Tone | undefined;
    summary = (
      <>
        {verb && <RNText style={styles.summaryMuted}>{verb}</RNText>}
        {sm && tone && (
          <RNText style={[styles.chip, { color: Theme[tone], borderColor: Theme[tone] + '55', backgroundColor: Theme[tone] + '14' }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{sm.label}</RNText>
        )}
        {!!st?.headline && <RNText style={styles.summaryText} numberOfLines={1}>{st.headline}</RNText>}
      </>
    );
  } else {
    const ids = entityIds(subcommand, args, output);
    const first = firstArgOf(args);
    const isCreate = subcommand === 'create' || subcommand === 'add';
    const lines = output.trim() ? output.trim().split('\n').filter((l) => l.trim()).length : 0;
    summary = (
      <>
        {ids.map((id) => <EntityPill key={id} shortId={id} />)}
        {STATUS_VERBS.has(subcommand) && subcommand !== 'done' && subcommand !== 'drop' && (
          <RNText style={[styles.chip, { color: color, borderColor: color + '55', backgroundColor: color + '14' }]}>{subcommand}</RNText>
        )}
        {!ids.length && first && (isCreate || cat === 'search' || subcommand === 'search') && (
          <RNText style={styles.summaryText} numberOfLines={1}>{cat === 'search' || subcommand === 'search' ? `“${first}”` : first}</RNText>
        )}
        {!ids.length && first && !isCreate && cat !== 'search' && subcommand !== 'search' && (
          <RNText style={styles.summaryMuted} numberOfLines={1}>{first}</RNText>
        )}
        {LIST_VERBS.has(subcommand) && lines > 0 && <RNText style={styles.summaryMuted}>{lines} items</RNText>}
      </>
    );
  }

  const label = cat === 'read' && SESSION_ID_RE.test(subcommand) ? 'read' : `${cat}${subcommand && !SESSION_ID_RE.test(subcommand) && cat !== 'state' ? ` ${subcommand.replace(/-/g, ' ')}` : ''}`;
  return (
    <RNView style={styles.row}>
      <TouchableOpacity activeOpacity={0.6} onPress={() => setOpen((o) => !o)} style={styles.head}>
        <Feather name={meta.icon} size={12} color={color} />
        <RNText style={[styles.label, { color }]} maxFontSizeMultiplier={CHROME_FONT_CAP}>{label}</RNText>
        {cat === 'read' && SESSION_ID_RE.test(subcommand) && <EntityPill shortId={subcommand} />}
        {summary}
        {status}
      </TouchableOpacity>
      {image}
      {body.length > 0 && (
        <RNView style={[styles.bodyRule, { borderLeftColor: color + '40' }]}>
          {body.map((part, i) => (
            <RNView key={i} style={i > 0 ? { marginTop: 6 } : undefined}>
              {!!part.label && <RNText style={styles.partLabel} maxFontSizeMultiplier={CHROME_FONT_CAP}>{part.label}</RNText>}
              <CollapsibleBody fadeColor={Theme.bg} height={96}>
                <MarkdownContent text={part.text} baseStyle={styles.bodyText} isUser />
              </CollapsibleBody>
            </RNView>
          ))}
        </RNView>
      )}
      {raw}
    </RNView>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  row: {
    paddingVertical: 2,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    paddingVertical: 2,
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
  },
  summaryText: {
    flexShrink: 1,
    fontSize: 11,
    color: Theme.textMuted,
  },
  summaryMuted: {
    flexShrink: 1,
    fontSize: 11,
    color: Theme.textDim,
  },
  small: {
    fontSize: 10,
  },
  chip: {
    fontSize: 9,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  bodyRule: {
    marginTop: 3,
    marginLeft: 4,
    paddingLeft: 9,
    borderLeftWidth: 2,
  },
  partLabel: {
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: Theme.textDim,
    marginBottom: 2,
  },
  bodyText: {
    fontSize: 13,
    lineHeight: 19,
    color: Theme.text,
  },
  raw: {
    marginTop: 4,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Theme.border,
    backgroundColor: Theme.bgAlt,
    overflow: 'hidden',
  },
  rawCmd: {
    fontSize: 11,
    lineHeight: 16,
    color: Theme.green,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.border,
  },
  rawOut: {
    fontSize: 11,
    lineHeight: 16,
    color: Theme.textSecondary,
    padding: 8,
  },
  rail: {
    marginVertical: 6,
    borderLeftWidth: 2,
    borderRadius: 4,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  railHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  kicker: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  recipe: {
    fontSize: 11,
    lineHeight: 16,
    color: Theme.textSecondary,
  },
  question: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '600',
    color: Theme.text,
    marginBottom: 6,
  },
  option: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 4,
  },
  optionNum: {
    width: 14,
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'right',
  },
  optionLabel: {
    fontSize: 13,
    color: Theme.text,
  },
  optionDesc: {
    fontSize: 12,
    lineHeight: 17,
    color: Theme.textMuted,
  },
  contextText: {
    fontSize: 12,
    lineHeight: 18,
    color: Theme.textSecondary,
  },
}));
