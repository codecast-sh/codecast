// The first ask to the hosted assistant on the phone, in the new conversation
// sheet. Return breaks the line, as a phone keyboard expects; the round
// button sends. A reply in an open conversation is the session screen's own
// composer (app/session/[id]).
import { useRef, useState } from 'react';
import { Pressable, View, type TextInput as RNTextInput } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import * as Haptics from 'expo-haptics';
import { TextInput } from '@/components/Themed';
import { LANE_COPY } from '@codecast/web/components/simple/lane';
import { HOSTED_RADIUS, sendDisc, useHostedTheme } from './hostedTheme';
import { useActiveLook } from '@/constants/Theme';

const MAX_HEIGHT = 200;

export function Composer({
  placeholder,
  onSend,
  seed,
  autoFocus = false,
  held = false,
}: {
  placeholder: string;
  onSend: (text: string) => void;
  /** Text to place in the box (a starter), applied when it changes. */
  seed?: { text: string; at: number } | null;
  autoFocus?: boolean;
  /** A new ask cannot run now (useHostedAskGate): the words stay editable
   *  and send waits. */
  held?: boolean;
}) {
  const { c } = useHostedTheme();
  const look = useActiveLook();
  const [text, setText] = useState('');
  const [seededAt, setSeededAt] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const ref = useRef<RNTextInput>(null);

  if (seed && seed.at !== seededAt) {
    setSeededAt(seed.at);
    setText(seed.text);
    queueMicrotask(() => ref.current?.focus());
  }

  const ready = text.trim().length > 0 && !held;
  const send = () => {
    const value = text.trim();
    if (!value || held) return;
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
          minHeight: 96,
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
          ...sendDisc(c, look, ready, pressed).style,
          transform: [{ scale: pressed ? 0.94 : 1 }],
        })}
      >
        <Feather name="arrow-up" size={18} color={sendDisc(c, look, ready).icon} />
      </Pressable>
    </View>
  );
}
