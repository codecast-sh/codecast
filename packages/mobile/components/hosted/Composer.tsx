// The hosted assistant's composer on the phone: the first ask in the new
// conversation sheet and the reply box at the foot of a hosted conversation.
// Return breaks the line, as a phone keyboard expects; the round button sends.
import { useRef, useState } from 'react';
import { Pressable, View, type TextInput as RNTextInput } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import * as Haptics from 'expo-haptics';
import { TextInput } from '@/components/Themed';
import { LANE_COPY } from '@codecast/web/components/simple/lane';
import { HOSTED_RADIUS, useHostedTheme } from './hostedTheme';

const MAX_HEIGHT = 200;

export function Composer({
  placeholder,
  onSend,
  hero = false,
  seed,
  autoFocus = false,
}: {
  placeholder: string;
  onSend: (text: string) => void;
  /** The roomier first ask (the new conversation sheet). */
  hero?: boolean;
  /** Text to place in the box (a starter), applied when it changes. */
  seed?: { text: string; at: number } | null;
  autoFocus?: boolean;
}) {
  const { c } = useHostedTheme();
  const [text, setText] = useState('');
  const [seededAt, setSeededAt] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const ref = useRef<RNTextInput>(null);

  if (seed && seed.at !== seededAt) {
    setSeededAt(seed.at);
    setText(seed.text);
    queueMicrotask(() => ref.current?.focus());
  }

  const ready = text.trim().length > 0;
  const send = () => {
    const value = text.trim();
    if (!value) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onSend(value);
    setText('');
  };

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: 8,
        paddingVertical: 6,
        paddingLeft: 14,
        paddingRight: 6,
        borderRadius: HOSTED_RADIUS,
        backgroundColor: c.sheet,
        borderWidth: 1,
        borderColor: focused ? c.lineStrong : c.line,
      }}
    >
      <TextInput
        ref={ref}
        value={text}
        onChangeText={setText}
        placeholder={placeholder}
        placeholderTextColor={c.faint}
        accessibilityLabel={placeholder}
        multiline
        autoFocus={autoFocus}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          flex: 1,
          minHeight: hero ? 96 : 26,
          maxHeight: MAX_HEIGHT,
          paddingTop: 8,
          paddingBottom: 8,
          fontSize: 14.5,
          lineHeight: 21,
          color: c.ink,
          textAlignVertical: 'top',
        }}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={LANE_COPY.conversation.send}
        accessibilityState={{ disabled: !ready }}
        disabled={!ready}
        onPress={send}
        hitSlop={6}
        style={({ pressed }) => ({
          width: 36,
          height: 36,
          borderRadius: 18,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: !ready ? c.wash : pressed ? c.accentPressed : c.accent,
          transform: [{ scale: pressed ? 0.94 : 1 }],
        })}
      >
        <Feather name="arrow-up" size={18} color={ready ? c.onSolid : c.faint} />
      </Pressable>
    </View>
  );
}
