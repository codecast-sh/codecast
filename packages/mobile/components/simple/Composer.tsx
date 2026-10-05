// The lane's one composer on the phone: home's "What can I take off your
// plate?" and the reply box at the foot of a conversation (web
// components/simple/Composer.tsx). Return breaks the line, as a phone
// keyboard expects; the round teal button sends.
import { useRef, useState } from 'react';
import { Pressable, View, type TextInput as RNTextInput } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import * as Haptics from 'expo-haptics';
import { TextInput } from '@/components/Themed';
import { LANE_COPY } from '@codecast/web/components/simple/lane';
import { useLaneTheme } from './laneTheme';

const MAX_HEIGHT = 224;

export function Composer({
  placeholder,
  onSend,
  hero = false,
  seed,
}: {
  placeholder: string;
  onSend: (text: string) => void;
  hero?: boolean;
  /** Text to place in the box (an idea chip), applied when it changes. */
  seed?: { text: string; at: number } | null;
}) {
  const { c } = useLaneTheme();
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
        paddingVertical: hero ? 10 : 8,
        paddingLeft: hero ? 20 : 17,
        paddingRight: hero ? 10 : 8,
        borderRadius: hero ? 28 : 26,
        backgroundColor: c.sheet,
        borderWidth: 1,
        borderColor: focused ? c.tideWash2 : c.line,
        shadowColor: c.ink,
        shadowOffset: { width: 0, height: focused ? 14 : 8 },
        shadowOpacity: focused ? 0.14 : 0.08,
        shadowRadius: focused ? 22 : 16,
        elevation: 2,
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
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          flex: 1,
          minHeight: hero ? 56 : 28,
          maxHeight: MAX_HEIGHT,
          paddingTop: hero ? 8 : 9,
          paddingBottom: 8,
          fontSize: hero ? 18 : 16.5,
          lineHeight: hero ? 26 : 24,
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
          width: 42,
          height: 42,
          borderRadius: 21,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: pressed ? c.tideSolidPressed : c.tideSolid,
          opacity: ready ? 1 : 0.32,
          transform: [{ scale: pressed ? 0.94 : 1 }],
        })}
      >
        <Feather name="arrow-up" size={20} color={c.onTide} />
      </Pressable>
    </View>
  );
}
