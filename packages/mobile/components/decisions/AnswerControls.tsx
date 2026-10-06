// A decision's answer controls on the phone, for every kind (web
// components/decisions/DecisionAnswerControls.tsx): single = tap an option;
// multi = tick options and send; rank = move the options into an order and
// send; form = one input per field and send. The draft lives in the store
// (useDecisionDraft), so a choice survives the screen closing and every
// surface answering the same decision sees the same ticks; the rules that
// turn it into an answer are lib/decisionAnswer's, shared with the web.
//
// The colours come from the caller (AnswerLook), so the decision screen
// draws them in the app's palette and a hosted conversation's approval card
// in its hosted colours (components/hosted).
import { useState } from 'react';
import { Pressable, StyleSheet, View, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import Feather from '@expo/vector-icons/Feather';
import { Text, TextInput } from '@/components/Themed';
import { Spacing, BorderRadius, type Palette } from '@/constants/Theme';
import { openLink } from '@/lib/links';
import { mixColor } from '@/lib/solColor';
import type { DecisionAnswerInput, SessionDecisionItem } from '@codecast/web/store/inboxStore';
import { useDecisionDraft } from '@codecast/web/hooks/useDecisionDraft';
import { ANSWER_WORDS, answerView, buildDecisionAnswer, moveInOrder, togglePicked, type AnswerDraft } from '@codecast/web/lib/decisionAnswer';

export interface AnswerLook {
  text: string;
  muted: string;
  faint: string;
  surface: string;
  border: string;
  /** A ticked option on a multi. */
  picked: string;
  /** Chosen chips, links and the send button. */
  accent: string;
  onAccent: string;
  danger: string;
  placeholder: string;
  radius: number;
  /** Number each option (1, 2, 3). A ranking always shows its order. */
  numbered?: boolean;
  /** The icon family the surrounding screen draws with. */
  icons?: 'fontawesome' | 'feather';
  /** How a press shows: a fade, or the slight shrink the hosted buttons use. */
  press?: 'fade' | 'shrink';
}

const ICON_NAMES = {
  checked: { fontawesome: 'check', feather: 'check-square' },
  unchecked: { fontawesome: 'square-o', feather: 'square' },
  up: { fontawesome: 'chevron-up', feather: 'chevron-up' },
  down: { fontawesome: 'chevron-down', feather: 'chevron-down' },
  page: { fontawesome: 'external-link', feather: 'external-link' },
} as const;

function LookIcon({ look, name, size, color }: { look: AnswerLook; name: keyof typeof ICON_NAMES; size: number; color: string }) {
  return look.icons === 'feather'
    ? <Feather name={ICON_NAMES[name].feather} size={size} color={color} />
    : <FontAwesome name={ICON_NAMES[name].fontawesome} size={size} color={color} />;
}

/** A pressable that shows its press the way the look asks. */
function Press({ look, style, children, ...rest }: Omit<PressableProps, 'style' | 'children'> & { look: AnswerLook; style?: StyleProp<ViewStyle>; children: React.ReactNode }) {
  return (
    <Pressable
      {...rest}
      style={({ pressed }) => [
        style,
        pressed && !rest.disabled && (look.press === 'shrink' ? { transform: [{ scale: 0.97 }] } : { opacity: 0.7 }),
      ]}
    >
      {children}
    </Pressable>
  );
}

/** The app palette's answer look, for the decision screen. */
export function appAnswerLook(t: Palette): AnswerLook {
  return {
    text: t.text,
    muted: t.textMuted,
    faint: t.textMuted0,
    surface: t.card,
    border: t.borderLight,
    picked: t.green,
    accent: t.blue,
    onAccent: '#fff',
    danger: t.red,
    placeholder: t.inputPlaceholder,
    radius: BorderRadius.lg,
  };
}

const pageUrl = (slug: string) => `https://codecast.sh/a/${slug}`;

export function AnswerControls({
  decisionId,
  decision,
  onAnswer,
  look,
  proceedingWith,
}: {
  decisionId: string;
  decision: Pick<SessionDecisionItem, 'options' | 'form' | 'kind'>;
  onAnswer: (input: DecisionAnswerInput) => void;
  look: AnswerLook;
  /** The option a non-blocking ask goes ahead with if nobody answers. */
  proceedingWith?: number;
}) {
  const [draft, patchDraft] = useDecisionDraft<AnswerDraft>(decisionId);
  const [error, setError] = useState<string | null>(null);
  const { options } = decision;
  const kind = decision.kind ?? 'single';
  const view = answerView(decision, draft);
  const setValue = (key: string, v: unknown) => patchDraft((cur) => ({ values: { ...cur.values, [key]: v } }));

  const submit = () => {
    const built = buildDecisionAnswer(decision, view);
    if (!built) return;
    if ('error' in built) return setError(built.error);
    onAnswer(built.input);
  };

  return (
    <View style={{ gap: Spacing.md }}>
      <View style={styles.options}>
        {(kind === 'rank' ? view.order : options.map((_, i) => i)).map((i, pos) => {
          const o = options[i];
          if (!o) return null;
          const picked = kind === 'multi' && view.picked.includes(i);
          const onPress = kind === 'single' ? () => onAnswer({ index: i })
            : kind === 'multi' ? () => { void Haptics.selectionAsync().catch(() => {}); setError(null); patchDraft((cur) => togglePicked(cur, i)); }
            : undefined;
          return (
            <Press
              key={i}
              look={look}
              accessibilityRole={kind === 'multi' ? 'checkbox' : 'button'}
              accessibilityState={kind === 'multi' ? { checked: picked } : undefined}
              disabled={!onPress}
              onPress={onPress}
              style={[
                styles.option,
                { borderRadius: look.radius, borderColor: look.border, backgroundColor: look.surface },
                picked && { borderColor: look.picked, backgroundColor: mixColor(look.picked, 8, 'transparent') },
              ]}
            >
              {kind === 'multi' ? (
                look.icons === 'feather' ? (
                  <View style={styles.tick}><LookIcon look={look} name={picked ? 'checked' : 'unchecked'} size={19} color={picked ? look.picked : look.faint} /></View>
                ) : (
                  <View style={[styles.badge, { borderColor: picked ? look.picked : look.border }]}>
                    <LookIcon look={look} name={picked ? 'checked' : 'unchecked'} size={13} color={picked ? look.picked : look.faint} />
                  </View>
                )
              ) : kind === 'rank' || look.numbered !== false ? (
                <View style={[styles.badge, { borderColor: look.border }]}>
                  <Text style={[styles.badgeText, { color: look.muted }]}>{kind === 'rank' ? pos + 1 : i + 1}</Text>
                </View>
              ) : null}
              <View style={styles.optionBody}>
                <Text style={[styles.optionLabel, { color: look.text }]}>{o.label}</Text>
                {o.description ? <Text style={[styles.optionDesc, { color: look.muted }]}>{o.description}</Text> : null}
                {proceedingWith === i ? <Text style={[styles.tag, { color: look.faint }]}>{ANSWER_WORDS.proceeding}</Text> : null}
                {o.page_slug ? (
                  <Press look={look} accessibilityRole="link" onPress={() => openLink(pageUrl(o.page_slug!))} hitSlop={6} style={styles.linkRow}>
                    <Text style={[styles.link, { color: look.accent }]}>{ANSWER_WORDS.openPage}</Text>
                    <LookIcon look={look} name="page" size={12} color={look.accent} />
                  </Press>
                ) : null}
              </View>
              {kind === 'rank' ? (
                <View style={styles.rankBtns}>
                  <RankButton look={look} icon="chevron-up" label={`Move ${o.label} up`} disabled={pos === 0} onPress={() => { const n = moveInOrder(view.order, pos, -1); if (n) patchDraft({ order: n }); }} />
                  <RankButton look={look} icon="chevron-down" label={`Move ${o.label} down`} disabled={pos === view.order.length - 1} onPress={() => { const n = moveInOrder(view.order, pos, 1); if (n) patchDraft({ order: n }); }} />
                </View>
              ) : null}
            </Press>
          );
        })}
      </View>

      {kind === 'form' ? (
        <View style={styles.options}>
          {(decision.form?.fields ?? []).map((f) => (
            <View key={f.key} style={styles.field}>
              <Text style={[styles.fieldLabel, { color: look.muted }]}>{f.label}</Text>
              {f.type === 'bool' || f.type === 'select' ? (
                <View style={styles.chips}>
                  {(f.type === 'bool' ? [true, false] : f.options ?? []).map((v) => (
                    <Chip key={String(v)} look={look} label={v === true ? ANSWER_WORDS.yes : v === false ? ANSWER_WORDS.no : String(v)} on={view.values[f.key] === v} onPress={() => setValue(f.key, v)} />
                  ))}
                </View>
              ) : (
                <TextInput
                  style={[styles.input, { color: look.text, backgroundColor: look.surface, borderColor: look.border }]}
                  value={String(view.values[f.key] ?? '')}
                  keyboardType={f.type === 'number' ? 'numeric' : 'default'}
                  onChangeText={(v) => setValue(f.key, v)}
                  placeholderTextColor={look.placeholder}
                />
              )}
            </View>
          ))}
        </View>
      ) : null}

      {kind !== 'single' ? <AnswerButton look={look} label={ANSWER_WORDS.send} onPress={submit} /> : null}
      {error ? <Text style={{ fontSize: 13, color: look.danger }}>{error}</Text> : null}
    </View>
  );
}

/** The filled send button, in the caller's accent. */
export function AnswerButton({ label, onPress, look }: { label: string; onPress: () => void; look: AnswerLook }) {
  return (
    <Press look={look} accessibilityRole="button" style={[styles.primary, { borderRadius: look.radius, backgroundColor: look.accent }]} onPress={onPress}>
      <Text style={[styles.primaryText, { color: look.onAccent }]}>{label}</Text>
    </Press>
  );
}

function RankButton({ look, icon, label, disabled, onPress }: { look: AnswerLook; icon: 'chevron-up' | 'chevron-down'; label: string; disabled: boolean; onPress: () => void }) {
  return (
    <Press look={look} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={disabled} hitSlop={6} style={[styles.rankBtn, { borderColor: look.border }, disabled && { opacity: 0.3 }]}>
      <LookIcon look={look} name={icon === 'chevron-up' ? 'up' : 'down'} size={look.icons === 'feather' ? 15 : 12} color={look.muted} />
    </Press>
  );
}

function Chip({ look, label, on, onPress }: { look: AnswerLook; label: string; on: boolean; onPress: () => void }) {
  return (
    <Press
      look={look}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={[styles.chip, { borderColor: look.border, backgroundColor: look.surface }, on && { borderColor: look.accent, backgroundColor: mixColor(look.accent, 9, 'transparent') }]}
    >
      <Text style={[styles.chipText, { color: on ? look.accent : look.text }]}>{label}</Text>
    </Press>
  );
}

const styles = StyleSheet.create({
  options: { gap: Spacing.sm },
  option: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.md,
    minHeight: 56,
    paddingVertical: 14,
    paddingHorizontal: Spacing.lg,
    borderWidth: 1,
  },
  badge: { width: 24, height: 24, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  badgeText: { fontSize: 12, fontWeight: '600' },
  optionBody: { flex: 1, gap: 4 },
  optionLabel: { fontSize: 16, lineHeight: 22, fontWeight: '600' },
  optionDesc: { fontSize: 13, lineHeight: 19 },
  tag: { fontSize: 11 },
  link: { fontSize: 13 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
  tick: { width: 24, alignItems: 'center', marginTop: 1 },
  rankBtns: { gap: 6 },
  rankBtn: { padding: 6, borderRadius: BorderRadius.sm, borderWidth: StyleSheet.hairlineWidth },
  field: { gap: 6 },
  fieldLabel: { fontSize: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  chip: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: BorderRadius.pill, borderWidth: 1 },
  chipText: { fontSize: 14 },
  input: { fontSize: 15, borderWidth: 1, borderRadius: BorderRadius.md, paddingHorizontal: Spacing.md, paddingVertical: 10 },
  primary: { paddingVertical: 14, alignItems: 'center' },
  primaryText: { fontSize: 15, fontWeight: '600' },
});
