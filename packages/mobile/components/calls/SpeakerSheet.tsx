// Who said it: the sheet a speaker chip, a turn's name and a line's "Said by…"
// open. One list for both jobs, in the web's order: search, teammates, this
// recording's voices, someone else (the search box is their name), unknown.
// Naming a voice renames every line it said; a line's pick moves that line
// only (moveLineTarget decides which voice it joins).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity, View as RNView, useWindowDimensions, type TextInput as RNTextInput } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import type { RosterIdentity } from '@codecast/web/hooks/useTeamRoster';
import { speakerLabel, speakerNameMatches, shareLabel, type SpeakerChip, type SpeakerChoice } from '@codecast/shared/contracts';
import { peopleOf } from '@codecast/shared/team/memberKind';
import { BottomSheet } from '@/components/BottomSheet';
import { ChatAvatar } from '@/components/chat/MessageRow';
import { Text as RNText, TextInput } from '@/components/Themed';
import { FontSize, Spacing, BorderRadius, themedStyles, useTheme } from '@/constants/Theme';
import { speakerTint } from './speakerTint';

export type SpeakerSheetTarget = { kind: 'voice'; key: string } | { kind: 'line'; key: string; seq: number; text: string };

const named = (c: SpeakerChip) => !!c.user_id || c.name !== speakerLabel(c.key);

export function SpeakerSheet({
  target,
  chips,
  teammates,
  onPick,
  onConfirm,
  onClose,
}: {
  target: SpeakerSheetTarget | null;
  chips: SpeakerChip[];
  teammates: RosterIdentity[];
  onPick: (target: SpeakerSheetTarget, choice: SpeakerChoice) => void;
  onConfirm: (key: string) => void;
  onClose: () => void;
}) {
  const Theme = useTheme();
  const { height } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [naming, setNaming] = useState(false);
  const input = useRef<RNTextInput>(null);
  useEffect(() => {
    if (!target) return;
    setQuery('');
    setNaming(false);
  }, [target]);

  const current = target ? chips.find((c) => c.key === target.key) : undefined;
  const people = peopleOf(teammates).filter((m) => speakerNameMatches(m.name ?? m.email, query));
  // The recording's other voices that are not teammates (those are in the
  // list above, and a line given to one joins their voice): typed names, and
  // for a line, unknown voices too.
  const voices = chips.filter(
    (c) => c.key !== target?.key && !c.user_id && (target?.kind === 'line' || named(c)) && speakerNameMatches(c.name, query),
  );
  const typed = query.trim();
  const pick = (choice: SpeakerChoice) => {
    if (!target) return;
    onPick(target, choice);
    onClose();
  };

  return (
    <BottomSheet visible={!!target} onClose={onClose}>
      {target ? (
        <RNView style={{ maxHeight: height * 0.8 }}>
          <RNText style={styles.title} numberOfLines={1}>
            {target.kind === 'line' ? 'Said by…' : `Who is ${current?.name ?? 'this'}?`}
          </RNText>
          {target.kind === 'line' ? (
            <RNText style={styles.quote} numberOfLines={2}>
              {target.text}
            </RNText>
          ) : null}

          <RNView style={styles.search}>
            <FontAwesome name={naming ? 'pencil' : 'search'} size={13} color={Theme.textMuted0} />
            <TextInput
              ref={input}
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder={naming ? 'Their name' : 'Search people'}
              placeholderTextColor={Theme.textMuted0}
              autoCorrect={false}
              autoCapitalize={naming ? 'words' : 'none'}
              returnKeyType="done"
              onSubmitEditing={() => (naming && typed ? pick({ name: typed }) : undefined)}
            />
          </RNView>

          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
            {target.kind === 'voice' && current?.suggested && !typed ? (
              <Row
                onPress={() => {
                  onConfirm(target.key);
                  onClose();
                }}
                lead={<FontAwesome name="check-circle" size={22} color={Theme.green} />}
                label={`Yes, it's ${current.name}`}
                strong
              />
            ) : null}

            {people.length ? <RNText style={styles.section}>TEAMMATES</RNText> : null}
            {people.map((m) => (
              <Row
                key={m._id}
                onPress={() => pick({ user_id: m._id })}
                lead={<ChatAvatar author={{ id: m._id, name: m.name || m.email || '?', avatarUrl: m.image || m.github_avatar_url }} size={28} />}
                label={m.name || m.email || 'Teammate'}
                selected={current?.user_id === m._id && !current.suggested}
              />
            ))}

            {voices.length ? <RNText style={styles.section}>IN THIS RECORDING</RNText> : null}
            {voices.map((c) => (
              <Row
                key={c.key}
                onPress={() => pick({ key: c.key })}
                lead={<RNView style={[styles.dot, { backgroundColor: speakerTint(Theme, c.key) }]} />}
                label={c.suggested ? `${c.name}?` : c.name}
                detail={shareLabel(c.share)}
              />
            ))}

            <RNText style={styles.section}>OTHER</RNText>
            <Row
              onPress={() => {
                if (typed) return pick({ name: typed });
                setNaming(true);
                input.current?.focus();
              }}
              lead={<FontAwesome name="user-plus" size={16} color={Theme.textMuted} style={styles.icon} />}
              label={typed ? `Someone else: “${typed}”` : 'Someone else'}
            />
            <Row
              onPress={() => pick({ clear: true })}
              lead={<FontAwesome name="question" size={16} color={Theme.textMuted} style={styles.icon} />}
              label="Unknown"
              selected={target.kind === 'voice' && !!current && !named(current)}
            />
          </ScrollView>
        </RNView>
      ) : null}
    </BottomSheet>
  );
}

function Row({
  onPress,
  lead,
  label,
  detail,
  selected,
  strong,
}: {
  onPress: () => void;
  lead: ReactNode;
  label: string;
  detail?: string;
  selected?: boolean;
  strong?: boolean;
}) {
  const Theme = useTheme();
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.6} accessibilityRole="button" accessibilityLabel={label}>
      <RNView style={styles.lead}>{lead}</RNView>
      <RNText style={[styles.rowLabel, strong && styles.strong]} numberOfLines={1}>
        {label}
      </RNText>
      {detail ? <RNText style={styles.detail}>{detail}</RNText> : null}
      {selected ? <FontAwesome name="check" size={14} color={Theme.accentAmber} /> : null}
    </TouchableOpacity>
  );
}

const styles = themedStyles((Theme) =>
  StyleSheet.create({
    title: { fontSize: FontSize.lg, fontWeight: '600', color: Theme.text, marginBottom: Spacing.xs },
    quote: { fontSize: FontSize.sm, color: Theme.textMuted, marginBottom: Spacing.sm, lineHeight: 18 },
    search: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Spacing.sm,
      backgroundColor: Theme.bgHighlight,
      borderRadius: BorderRadius.md,
      paddingHorizontal: Spacing.md,
      marginVertical: Spacing.sm,
    },
    searchInput: { flex: 1, fontSize: FontSize.md, color: Theme.text, paddingVertical: 10 },
    list: { flexGrow: 0 },
    section: { fontSize: FontSize.xs, color: Theme.textMuted0, letterSpacing: 1, paddingTop: Spacing.md, paddingBottom: Spacing.xs },
    row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingVertical: 10, minHeight: 44 },
    lead: { width: 28, alignItems: 'center' },
    icon: { width: 20, textAlign: 'center' },
    dot: { width: 12, height: 12, borderRadius: 6 },
    rowLabel: { flex: 1, fontSize: FontSize.md, color: Theme.text },
    strong: { fontWeight: '600' },
    detail: { fontSize: FontSize.sm, color: Theme.textMuted0, fontVariant: ['tabular-nums'] },
  }),
);
