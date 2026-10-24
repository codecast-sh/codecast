// Mobile twin of web's StructuredResultBlock: a workflow agent's
// StructuredOutput payload read as the session's result. The shared model
// (structuredResultModel) decides the view from the payload's shape, so both
// apps show the same pill, prose, rows and lists. Raw JSON is one tap away.

import { useMemo, useState } from 'react';
import { View as RNView, Pressable, StyleSheet } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { Text as RNText } from '@/components/Themed';
import { MarkdownContent } from '@/components/MarkdownRenderer';
import { useTheme } from '@/constants/Theme';
import { structuredResultModel, type StructuredField, type StructuredRecord, type StructuredSection, type StructuredTone } from '@codecast/shared/render';

type ThemeT = ReturnType<typeof useTheme>;

const toneColor = (Theme: ThemeT, tone: StructuredTone) =>
  tone === 'good' ? Theme.green : tone === 'warn' ? Theme.yellow : tone === 'bad' ? Theme.red : Theme.textMuted;

function Pill({ text, tone }: { text: string; tone: StructuredTone }) {
  const Theme = useTheme();
  const c = toneColor(Theme, tone);
  return (
    <RNView style={[styles.pill, { borderColor: c + '59', backgroundColor: tone === 'neutral' ? Theme.bgHighlight : c + '26' }]}>
      <RNText style={[styles.pillText, { color: c }]}>{text.replace(/_/g, ' ').toUpperCase()}</RNText>
    </RNView>
  );
}

function Fields({ fields }: { fields: StructuredField[] }) {
  const Theme = useTheme();
  return (
    <>
      {fields.map((f) => (
        <RNText key={f.label} style={styles.field}>
          <RNText style={{ color: Theme.textDim }}>{f.label} </RNText>
          <RNText style={{ color: f.tone ? toneColor(Theme, f.tone) : Theme.textMuted }}>{f.value}</RNText>
        </RNText>
      ))}
    </>
  );
}

function Prose({ text, muted }: { text: string; muted?: boolean }) {
  const Theme = useTheme();
  return <MarkdownContent text={text} baseStyle={[styles.prose, { color: muted ? Theme.textMuted : Theme.text }]} />;
}

function Row({ rec, first }: { rec: StructuredRecord; first: boolean }) {
  const Theme = useTheme();
  return (
    <RNView style={[styles.row, !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Theme.border }]}>
      {(rec.badge || rec.location) && (
        <RNView style={styles.rowHead}>
          {rec.badge && <Pill text={rec.badge.text} tone={rec.badge.tone} />}
          {rec.location && <RNText style={[styles.mono, { color: Theme.textDim, flexShrink: 1 }]} numberOfLines={1} ellipsizeMode="head">{rec.location.display}</RNText>}
        </RNView>
      )}
      {rec.title && <Prose text={rec.title} />}
      {rec.texts.map((t) => (
        <RNView key={t.label}>
          <RNText style={[styles.subLabel, { color: Theme.textDim }]}>{t.label}</RNText>
          <Prose text={t.text} muted />
        </RNView>
      ))}
      {rec.fields.length > 0 && <RNView style={styles.fields}><Fields fields={rec.fields} /></RNView>}
    </RNView>
  );
}

function Section({ section }: { section: StructuredSection }) {
  const Theme = useTheme();
  const count = section.kind === 'records' || section.kind === 'list' ? section.items.length : undefined;
  return (
    <RNView style={styles.section}>
      <RNText style={[styles.sectionLabel, { color: Theme.textMuted }]}>
        {section.label}
        {count !== undefined && <RNText style={{ color: Theme.textDim, fontWeight: '400' }}>{`  ${count || 'none'}`}</RNText>}
      </RNText>
      {section.kind === 'text' ? (
        <Prose text={section.text} />
      ) : section.kind === 'fields' ? (
        <RNView style={styles.fields}><Fields fields={section.fields} /></RNView>
      ) : section.kind === 'list' ? (
        section.items.map((item, i) =>
          section.paths
            ? <RNText key={i} style={[styles.mono, { color: Theme.textMuted }]} numberOfLines={1} ellipsizeMode="head">{item}</RNText>
            : <Prose key={i} text={`- ${item}`} />,
        )
      ) : (
        section.items.map((rec, i) => <Row key={i} rec={rec} first={i === 0} />)
      )}
    </RNView>
  );
}

export function StructuredResultBlock({ input, result }: { input: string; result?: { content?: string; is_error?: boolean } }) {
  const Theme = useTheme();
  const [showJson, setShowJson] = useState(false);
  const payload = useMemo(() => {
    try {
      const p = JSON.parse(input);
      return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }, [input]);
  const model = useMemo(() => (payload ? structuredResultModel(payload) : null), [payload]);
  const rejected = !!result?.is_error;
  const tone: StructuredTone = rejected ? 'bad' : model?.status?.tone ?? 'neutral';
  const accent = tone === 'neutral' ? Theme.cyan : toneColor(Theme, tone);

  return (
    <RNView style={[styles.card, { borderColor: accent + '4d', backgroundColor: accent + '0a' }]} testID="structured-result">
      <RNView style={styles.header}>
        <Feather name="check-square" size={13} color={accent} />
        <RNText style={[styles.title, { color: accent }]}>{rejected ? 'Result rejected' : 'Result'}</RNText>
        {model?.status && !rejected && <Pill text={model.status.text} tone={model.status.tone} />}
        {model && !rejected && <Fields fields={model.fields} />}
        {!payload && !rejected && <RNText style={[styles.field, { color: Theme.textDim }]}>returning a result</RNText>}
        {payload && (
          <Pressable onPress={() => setShowJson((v) => !v)} hitSlop={8} style={[styles.jsonToggle, { borderColor: showJson ? Theme.cyan + '66' : Theme.border }]} accessibilityRole="button" accessibilityState={{ selected: showJson }}>
            <RNText style={[styles.mono, { color: showJson ? Theme.cyan : Theme.textDim }]}>JSON</RNText>
          </Pressable>
        )}
      </RNView>
      {rejected && !!result?.content && <RNText style={[styles.mono, styles.body, { color: Theme.red }]} selectable>{result.content}</RNText>}
      {showJson && payload ? (
        <RNText style={[styles.mono, styles.body, { color: Theme.textSecondary }]} selectable>{JSON.stringify(payload, null, 2)}</RNText>
      ) : model && !rejected && model.sections.length > 0 ? (
        <RNView style={styles.body}>
          {model.sections.map((s) => <Section key={s.label} section={s} />)}
        </RNView>
      ) : null}
    </RNView>
  );
}

const styles = StyleSheet.create({
  card: { marginVertical: 6, borderWidth: 1, borderRadius: 10, overflow: 'hidden' },
  header: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  title: { fontSize: 12, fontWeight: '600' },
  jsonToggle: { marginLeft: 'auto', borderWidth: 1, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1 },
  body: { paddingHorizontal: 12, paddingBottom: 12, gap: 12 },
  section: { gap: 4 },
  sectionLabel: { fontSize: 11, fontWeight: '600' },
  subLabel: { fontSize: 11, marginTop: 2 },
  prose: { fontSize: 13, lineHeight: 19 },
  row: { paddingVertical: 8, gap: 4 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fields: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 2 },
  field: { fontSize: 11 },
  mono: { fontSize: 11 },
  pill: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  pillText: { fontSize: 10, fontWeight: '600', letterSpacing: 0.4 },
});
