import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/Themed';
import { useTheme } from '@/constants/Theme';
import { readConversationFence, replyPieces, type ConversationMessage } from '@codecast/web/lib/conversationFence';

// The `conversation` fence on a phone (web: components/ConversationFence):
// the thread as a back and forth, the agent on the right, then the agent's
// reply before and with a change, stacked, what matters marked.

const SHOWN = 3;

function Bubble({ m }: { m: ConversationMessage }) {
  const Theme = useTheme();
  const [open, setOpen] = useState(false);
  const long = m.text.length > 280 || m.text.split('\n').length > 4;
  return (
    <View style={[styles.msg, m.agent && styles.msgAgent]}>
      <Text style={[styles.meta, { color: Theme.textDim }]}>
        <Text style={{ color: Theme.textMuted, fontWeight: '600' }}>{m.from}</Text>
        {m.at ? `  ${m.at}` : ''}
      </Text>
      <Pressable disabled={!long} onPress={() => setOpen((o) => !o)}>
        <View
          style={[
            styles.bubble,
            m.agent
              ? { backgroundColor: Theme.blue + '1a', borderColor: Theme.blue + '40', borderTopRightRadius: 4 }
              : { backgroundColor: Theme.bgAlt, borderColor: Theme.borderLight, borderTopLeftRadius: 4 },
          ]}
        >
          <Text style={[styles.body, { color: Theme.text }]} numberOfLines={long && !open ? 4 : undefined}>
            {m.text}
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

function Reply({ label, text, other, marks, tone }: { label: string; text: string; other: string; marks: string[]; tone: 'before' | 'after' }) {
  const Theme = useTheme();
  const pieces = useMemo(() => replyPieces(text, other, marks), [text, other, marks]);
  const ink = tone === 'before' ? Theme.red : Theme.green;
  return (
    <View
      style={[
        styles.side,
        tone === 'before' ? { backgroundColor: Theme.bgAlt, borderColor: Theme.borderLight } : { backgroundColor: Theme.green + '1a', borderColor: Theme.green + '66' },
      ]}
    >
      <Text style={[styles.label, { color: ink }]}>{label}</Text>
      <Text style={[styles.body, { color: tone === 'before' ? Theme.textMuted : Theme.text }]}>
        {text
          ? pieces.map((p, i) => (p.changed ? <Text key={i} style={{ backgroundColor: ink + (tone === 'before' ? '24' : '2e'), color: Theme.text }}>{p.text}</Text> : p.text))
          : '(no reply)'}
      </Text>
    </View>
  );
}

export function ConversationFence({ code, fallback }: { code: string; fallback: React.ReactNode }) {
  const Theme = useTheme();
  const read = useMemo(() => readConversationFence(code), [code]);
  const [all, setAll] = useState(false);
  if (!read.ok) return <>{fallback}</>;
  const { spec } = read;
  const hidden = all ? 0 : Math.max(0, spec.thread.length - SHOWN);
  return (
    <View style={styles.wrap}>
      {spec.title ? <Text style={[styles.title, { color: Theme.textMuted }]}>{spec.title}</Text> : null}
      {hidden > 0 && (
        <Pressable onPress={() => setAll(true)} style={styles.earlier}>
          <Text style={[styles.meta, { color: Theme.textDim }]}>{hidden} earlier</Text>
        </Pressable>
      )}
      {spec.thread.slice(hidden).map((m, i) => (
        <Bubble key={hidden + i} m={m} />
      ))}
      <Reply label="Before the change" text={spec.before} other={spec.after} marks={spec.mark.before} tone="before" />
      <Reply label="With the change" text={spec.after} other={spec.before} marks={spec.mark.after} tone="after" />
      {spec.note ? <Text style={[styles.body, { color: Theme.textMuted }]}>{spec.note}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8, marginVertical: 8 },
  title: { fontSize: 12, fontWeight: '600' },
  earlier: { alignSelf: 'center', paddingHorizontal: 6, paddingVertical: 2 },
  msg: { maxWidth: '86%', alignSelf: 'flex-start', gap: 2 },
  msgAgent: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  meta: { fontSize: 11.5 },
  bubble: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 7 },
  body: { fontSize: 13, lineHeight: 19 },
  side: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 8, gap: 4 },
  label: { fontSize: 12, fontWeight: '600' },
});
